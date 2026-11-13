import { zstdCompressSync } from 'node:zlib';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import {
	BuildLogInfo_Source,
	BuildLogInfoSchema,
	GetBuildLogChunkSchema
} from '#lib/gen/nix_remote_pb.ts';
import type { LogBackend, LogCall, LogRequest } from '#lib/source/types.ts';
import { endsEarly, LogClient, type LogTarget } from './client.svelte.ts';
import { LogEngine } from './engine.ts';
import { MiB } from './limits.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

const enc = new TextEncoder();

/** A log of about `mib` MiB, one numbered line after another. */
function makeLog(mib: number): Uint8Array {
	const out: string[] = [];
	for (let i = 0, size = 0; size < mib * MiB; i++) {
		const l = `cc -O2 -c src/file${i}.c -o file${i}.o ${'x'.repeat(40)}`;
		out.push(l);
		size += l.length + 1;
	}
	return enc.encode(out.join('\n') + '\n');
}

const newlines = (log: Uint8Array, to: number) => {
	let n = 0;
	for (let i = 0; i < to; i++) if (log[i] === 10) n++;
	return n;
};

/** A worker that runs the engine in this thread, answering as worker.ts does. */
function engineWorker(e: LogEngine): Worker {
	const w = {
		onmessage: null as ((ev: { data: FromWorker }) => void) | null,
		postMessage(m: ToWorker) {
			const answer = (r: FromWorker) => queueMicrotask(() => w.onmessage?.({ data: r }));
			if (m.t === 'call') e.beginCall(m.call, m.part, m.info, m);
			else if (m.t === 'zstd') e.zstd(m.call, m.data);
			else if (m.t === 'restart') e.restart();
			else if (m.t === 'end') {
				e.endCall(m.call, m.complete);
				e.settle();
				answer({ t: 'progress', p: e.progress() });
			} else if (m.t === 'decoded')
				answer({
					t: 'decoded',
					req: m.req,
					bytes: e.decodedBy(m.call),
					headComplete: e.headComplete
				});
		},
		terminate() {}
	};
	return w as unknown as Worker;
}

/** How the farm answers call `n`: from which source, and whether it breaks after some bytes. */
type Answer = { source?: BuildLogInfo_Source; breakAfter?: number };

/** A builder that serves `log` as GetBuildLog does: offset, limit, tail and follow. */
function farm(log: Uint8Array, answer: (req: LogRequest, n: number) => Answer) {
	const reqs: LogRequest[] = [];
	const backend: LogBackend = {
		kind: 'grpc',
		open(req: LogRequest): LogCall {
			const a = answer(req, reqs.push(req) - 1);
			let start = Math.max(req.offset, req.tail ? log.length - req.tail : 0);
			if (req.tail) while (start > 0 && start < log.length && log[start - 1] !== 10) start++;
			const end = req.limit ? Math.min(log.length, start + req.limit) : log.length;
			const stop = a.breakAfter === undefined ? end : Math.min(end, start + a.breakAfter);
			const info = create(BuildLogInfoSchema, {
				source: a.source ?? BuildLogInfo_Source.KEPT,
				size: BigInt(log.length),
				offset: BigInt(start),
				firstLine: BigInt(newlines(log, start))
			});
			const chunks = async function* () {
				const ended = a.breakAfter === undefined && req.follow;
				yield create(GetBuildLogChunkSchema, {
					info,
					data: zstdCompressSync(log.subarray(start, stop)),
					ended
				});
				if (a.breakAfter !== undefined) throw new ConnectError('lost', Code.Unavailable);
			};
			return Object.assign(chunks(), {
				node: Promise.resolve(null),
				rebuilding: Promise.resolve(null)
			});
		}
	};
	return { backend, reqs };
}

const target = (over: Partial<LogTarget>): LogTarget => ({
	drvPath: 'aaaa-hello.drv',
	name: 'hello',
	worker: 'builder-1:7000',
	system: 'x86_64-linux',
	assignId: 1,
	running: false,
	finishedMs: 1,
	state: 'built',
	...over
});

async function loaded(c: LogClient) {
	for (let i = 0; i < 300 && !c.loaded; i++) await new Promise((ok) => setTimeout(ok, 20));
	expect(c.loaded).toBe(true);
}

describe('LogClient', () => {
	it("keeps a followed build's log, which comes in one call, as head and ring", async () => {
		const log = makeLog(1);
		const { backend } = farm(log, () => ({ source: BuildLogInfo_Source.LIVE }));
		const e = new LogEngine();
		const c = new LogClient(target({ running: true, state: 'assigned' }), backend, {}, () =>
			engineWorker(e)
		);
		await loaded(c);
		c.stop();
		expect(e.store.ring).toBe(true);
		expect(e.progress().lines).toBe(newlines(log, log.length));
	});

	it('loads a finished log in parts, with no ring', async () => {
		const log = makeLog(1);
		const { backend } = farm(log, () => ({}));
		const e = new LogEngine();
		const c = new LogClient(target({}), backend, {}, () => engineWorker(e));
		await loaded(c);
		c.stop();
		expect(e.store.ring).toBe(false);
		expect(e.progress().lines).toBe(newlines(log, log.length));
	});
});

describe('LogClient, after a break', () => {
	it('places the rest of a finished log after a head that went on in another call', async () => {
		const log = makeLog(20);
		const { backend, reqs } = farm(log, (_, n) => (n === 0 ? { breakAfter: MiB } : {}));
		const e = new LogEngine();
		const c = new LogClient(target({}), backend, {}, () => engineWorker(e));
		await loaded(c);
		c.stop();
		expect(reqs.map((r) => r.offset)).toEqual([0, MiB, expect.any(Number)]);
		expect(e.store.gap).toBeNull();
		expect(e.progress().lines).toBe(newlines(log, log.length));
		expect(e.store.raw(e.store.slots - 1)).toBe(
			new TextDecoder().decode(log.subarray(log.lastIndexOf(10, log.length - 2) + 1, -1))
		);
	}, 20_000);

	it('reads a log from its start when a call after the break answers from another source', async () => {
		const log = makeLog(4);
		// The build ends during the backoff, so the next call answers from the kept file.
		const { backend, reqs } = farm(log, (_, n) =>
			n === 0 ? { source: BuildLogInfo_Source.LIVE, breakAfter: MiB } : {}
		);
		const e = new LogEngine();
		const c = new LogClient(target({ running: true, state: 'assigned' }), backend, {}, () =>
			engineWorker(e)
		);
		await loaded(c);
		c.stop();
		expect(reqs.map((r) => r.offset)).toEqual([0, MiB, 0]);
		expect(e.progress().lines).toBe(newlines(log, log.length));
		expect(e.store.raw(0)).toBe(new TextDecoder().decode(log.subarray(0, log.indexOf(10))));
	}, 20_000);
});

describe('endsEarly', () => {
	// A short log of a stopped build is not a damaged file.
	it('is true for a cancelled or dropped build', () => {
		expect(endsEarly('cancelled', false)).toBe(true);
		expect(endsEarly('dropped', true)).toBe(true);
	});
});
