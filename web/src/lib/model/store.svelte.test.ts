import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
	DrvGone_Outcome as Outcome,
	DrvState_Cause as Cause,
	DrvState_Phase as Phase,
	FinishedBuildSchema,
	RecentBuildsBatchSchema,
	SubstituterTrafficSchema
} from '#lib/gen/events_pb.ts';
import type { RecentBuildsFn, RecentBuildsRequest } from '#lib/source/types.ts';
import { ANY_QUERY } from './builds.ts';
import { E, Stream, T0, drvPath, type Ev } from './fixtures.ts';
import { ReducerFarmStore, browserFrameScheduler, type FrameScheduler } from './store.svelte.ts';

const A = '10.0.0.1:50051';
const B = '10.0.0.2:50051';
const Q = drvPath('q');

function manualFrames() {
	const queue: (() => void)[] = [];
	const frames: FrameScheduler = {
		request(cb) {
			queue.push(cb);
			return () => {
				const i = queue.indexOf(cb);
				if (i >= 0) queue.splice(i, 1);
			};
		}
	};
	return {
		frames,
		pending: () => queue.length,
		flush() {
			for (const cb of queue.splice(0)) cb();
		}
	};
}

function setup(options: { minPublishMs?: number } = {}) {
	const f = manualFrames();
	const store = new ReducerFarmStore({ frames: f.frames, minPublishMs: options.minPublishMs ?? 0 });
	const s = new Stream();
	return { store, s, ...f };
}

function live(store: ReducerFarmStore, s: Stream) {
	store.sink.beginStream();
	return store.sink.events(
		s.snapshot(
			E.reset(),
			E.worker(A),
			E.worker(B, { systems: ['aarch64-linux'] }),
			E.client(1, 'ci-runner-1'),
			E.drv(Q, { clientIds: [1n] })
		)
	);
}

describe('ReducerFarmStore', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('publishes once per frame, and only complete snapshots', () => {
		const { store, s, flush, pending } = setup();
		store.sink.beginStream();
		const [reset, w, done] = s.snapshot(E.reset(), E.worker(A));
		store.sink.events([reset, w]);
		expect(pending()).toBe(1);
		flush();
		expect(store.topology.version).toBe(0);
		expect(store.frame).toBe(0);
		expect(store.meta).toBeNull();

		store.sink.events([done]);
		flush();
		expect(store.topology).toMatchObject({ version: 1, workers: [A] });
		expect(store.meta).toMatchObject({ instance: 'inst-a' });
		expect(store.frame).toBe(1);

		for (let i = 0; i < 3; i++) store.sink.events(s.next(E.stats()));
		expect(pending()).toBe(1);
		flush();
		expect(store.frame).toBe(2);
		store.destroy();
	});

	it('replaces only what changed and keeps identity of the rest', () => {
		const { store, s, flush } = setup();
		live(store, s);
		flush();
		const before = {
			workers: store.workers,
			a: store.workers.get(A),
			b: store.workers.get(B),
			topology: store.topology,
			groups: store.clientGroups,
			meta: store.meta,
			edges: store.edges,
			publishB: store.edges.get(`publish:${B}`),
			systems: store.scheduler.systems,
			totals: store.totals
		};

		vi.advanceTimersByTime(100);
		store.sink.events(
			s.next(
				E.drv(Q, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A, clientIds: [1n] })
			)
		);
		flush();
		expect(store.workers).not.toBe(before.workers);
		expect(store.workers.get(A)).not.toBe(before.a);
		expect(store.workers.get(A)!.running).toBe(1);
		expect(store.workers.get(B)).toBe(before.b);
		expect(store.topology).toBe(before.topology);
		expect(store.clientGroups).toBe(before.groups);
		expect(store.meta).toBe(before.meta);
		expect(store.edges).not.toBe(before.edges);
		expect(store.edges.get(`publish:${B}`)).toBe(before.publishB);
		expect(store.scheduler.systems).toBe(before.systems);
		expect(store.scheduler).toMatchObject({ queued: 0, assigned: 1 });
		store.destroy();
	});

	it('bumps the topology version only when the topology changes', () => {
		const { store, s, flush } = setup();
		live(store, s);
		flush();
		expect(store.topology.version).toBe(1);
		store.sink.events(s.next(E.worker(A, { draining: true })));
		flush();
		expect(store.topology.version).toBe(1);
		expect(store.workers.get(A)!.draining).toBe(true);
		store.sink.events(s.next(E.worker('10.0.0.3:50051')));
		flush();
		expect(store.topology.version).toBe(2);
		expect(store.topology.workers).toHaveLength(3);
		// Same order, but B moves to another system group in the layout.
		const order = store.topology.workers;
		store.sink.events(s.next(E.worker(B, { systems: ['riscv64-linux'] })));
		flush();
		expect(store.topology.workers).toEqual(order);
		expect(store.topology.version).toBe(3);
		store.destroy();
	});

	it('re-runs only what reads a changed part', () => {
		const { store, s, flush } = setup();
		live(store, s);
		flush();
		let runsA = 0;
		let runsTopology = 0;
		const stop = $effect.root(() => {
			const a = $derived(store.workers.get(A));
			const version = $derived(store.topology.version);
			$effect(() => {
				void a;
				runsA++;
			});
			$effect(() => {
				void version;
				runsTopology++;
			});
		});
		flushSync();
		expect([runsA, runsTopology]).toEqual([1, 1]);
		store.sink.events(s.next(E.worker(B, { systems: ['aarch64-linux'], draining: true })));
		flush();
		flushSync();
		expect(store.workers.get(B)!.draining).toBe(true);
		expect([runsA, runsTopology]).toEqual([1, 1]);
		store.sink.events(s.next(E.worker(A, { draining: true })));
		flush();
		flushSync();
		expect([runsA, runsTopology]).toEqual([2, 1]);
		store.sink.events(s.next(E.worker('10.0.0.3:50051')));
		flush();
		flushSync();
		expect([runsA, runsTopology]).toEqual([2, 2]);
		stop();
		store.destroy();
	});

	/** Two client groups, and ten derivations that one of them waits on. */
	const body = () => [
		E.client(1, 'ci'),
		E.client(2, 'alice'),
		...Array.from({ length: 10 }, (_, i) => E.drv(drvPath(`d${i}`), { clientIds: [1n] }))
	];

	it.each<[string, (store: ReducerFarmStore) => void]>([
		[
			'the stream dies',
			(store) => {
				store.sink.beginStream();
				const snap = new Stream(7n).snapshot(
					E.reset({ instance: 'inst-b' }),
					E.worker(B),
					...body()
				);
				store.sink.events(snap.slice(0, 5));
				store.sink.beginStream();
			}
		],
		[
			'a seq error ends it',
			(store) => {
				store.sink.beginStream();
				const s2 = new Stream(7n);
				const [reset, w] = s2.snapshot(E.reset({ instance: 'inst-b' }), E.worker(B));
				expect(store.sink.events([reset, w, s2.raw(99n, E.worker(A))]).ok).toBe(false);
			}
		]
	])('keeps the last complete state when a new snapshot never finishes: %s', (_, end) => {
		const { store, s, flush } = setup();
		store.sink.beginStream();
		store.sink.events(s.snapshot(E.reset(), E.worker(A), ...body()));
		flush();
		expect(store.scheduler.queued).toBe(10);
		const before = {
			meta: store.meta,
			workers: store.workers,
			topology: store.topology,
			frame: store.frame
		};

		// A failover: the new leader's stream ends inside its snapshot.
		vi.advanceTimersByTime(5000);
		end(store);
		vi.advanceTimersByTime(2000);
		flush();
		expect(store.meta).toBe(before.meta);
		expect(store.workers).toBe(before.workers);
		expect(store.topology).toBe(before.topology);
		expect(store.frame).toBe(before.frame);
		expect(store.scheduler.queued).toBe(10);

		// The next stream completes.
		store.sink.beginStream();
		store.sink.events(
			new Stream(20n).snapshot(E.reset({ instance: 'inst-b' }), E.worker(B), ...body())
		);
		flush();
		expect(store.meta).toMatchObject({ instance: 'inst-b' });
		expect([...store.workers.keys()]).toEqual([B]);
		store.destroy();
	});

	describe('drill-down while a new snapshot streams in', () => {
		const P = drvPath('p');
		const Q2 = drvPath('q2');
		const reports = (nar: bigint) => ({
			version: '0.4.0',
			substituters: [
				create(SubstituterTrafficSchema, { url: 'https://cache.nixos.org', narBytes: nar })
			]
		});
		type Ask = (store: ReducerFarmStore) => unknown;

		// Each new question has an answer in the old state, and none while the new one streams in.
		it.each<[string, Ask, Ask, unknown]>([
			['drvsQueued', (st) => st.drvsQueued(100), (st) => st.drvsQueued(1), []],
			[
				'drvsForClientGroup',
				(st) => st.drvsForClientGroup('ci'),
				(st) => st.drvsForClientGroup('alice'),
				[]
			],
			['clientGroup', (st) => st.clientGroup('ci'), (st) => st.clientGroup('alice'), undefined],
			['drv', (st) => st.drv(Q), (st) => st.drv(Q2), undefined],
			['drv on a line', (st) => st.drv(P, `assign:${A}`), (st) => st.drv(P, 'want:ci'), undefined],
			['drvsForWorker', (st) => st.drvsForWorker(A), (st) => st.drvsForWorker(A, 1), []],
			['drvsForCache', (st) => st.drvsForCache(), (st) => st.drvsForCache(1), []],
			[
				'edgeDetail',
				(st) => st.edgeDetail([`assign:${A}`]),
				(st) => st.edgeDetail([`assign:${A}`], 1),
				undefined
			],
			['substitutersOf', (st) => st.substitutersOf(A), (st) => st.substitutersOf(B), []]
		])('%s repeats its last answer, and has none for a new question', (_, ask, askNew, none) => {
			const { store, s, flush } = setup();
			store.sink.beginStream();
			store.sink.events(
				s.snapshot(
					E.reset(),
					E.worker(A, reports(0n)),
					E.worker(B, reports(0n)),
					E.client(1, 'ci'),
					E.client(2, 'alice'),
					E.drv(Q, { clientIds: [1n] }),
					E.drv(Q2, { clientIds: [2n] })
				)
			);
			store.sink.events(
				s.next(
					E.drv(P, { cause: Cause.WANTED, clientIds: [1n] }),
					E.drv(P, {
						cause: Cause.ASSIGNED,
						phase: Phase.ASSIGNED,
						workerAddr: A,
						clientIds: [1n]
					}),
					E.cached(drvPath('hit'), 1),
					E.worker(A, reports(4096n)),
					E.worker(B, reports(4096n))
				)
			);
			flush();
			const answer = ask(store);
			expect(answer).not.toEqual(none);

			vi.advanceTimersByTime(1000);
			store.sink.beginStream();
			const [reset, w] = new Stream(900n).snapshot(E.reset({ instance: 'inst-b' }), E.worker(B));
			store.sink.events([reset, w]);
			flush();
			expect(ask(store)).toBe(answer);
			expect(askNew(store)).toEqual(none);
			store.destroy();
		});
	});

	it('edgeDetail does not reuse an answer from another window', () => {
		const { store, s, flush } = setup();
		live(store, s);
		flush();
		const ids = [`assign:${A}`];
		const at15 = store.edgeDetail(ids)!;
		expect(at15.windowMinutes).toBe(15);
		store.setWindowMinutes(60);
		flush();
		const at60 = store.edgeDetail(ids)!;
		expect(at60.windowMinutes).toBe(60);

		// While a new snapshot streams in, each window repeats only its own answer.
		store.sink.beginStream();
		store.sink.events(new Stream(900n).snapshot(E.reset(), E.worker(A)).slice(0, 2));
		expect(store.edgeDetail(ids)).toBe(at60);
		store.setWindowMinutes(15);
		expect(store.edgeDetail(ids)).toBe(at15);
		store.setWindowMinutes(5);
		expect(store.edgeDetail(ids)).toBeUndefined();
		store.destroy();
	});

	it('keeps publishing while idle so rates decay', () => {
		const { store, s, flush } = setup();
		live(store, s);
		store.sink.events(
			s.next(
				E.drv(Q, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A, clientIds: [1n] })
			)
		);
		flush();
		expect(store.edges.get(`assign:${A}`)!.rate).toBe(0.1);
		vi.advanceTimersByTime(30_000);
		flush();
		expect(store.edges.get(`assign:${A}`)!.rate).toBe(0);
		store.destroy();
	});

	it('waits between publishes', () => {
		const { store, s, flush, pending } = setup({ minPublishMs: 33 });
		live(store, s);
		flush();
		store.sink.events(s.next(E.stats()));
		expect(pending()).toBe(0);
		vi.advanceTimersByTime(40);
		expect(pending()).toBe(1);
		flush();
		expect(store.frame).toBe(2);
		store.destroy();
	});

	it('says whether line counts cover the whole window', () => {
		const { store, s, flush } = setup();
		// Nothing is partial before there is data.
		expect(store.linesSince).toBeNull();
		live(store, s);
		flush();
		expect(store.linesSince).toMatchObject({ cause: 'page' });
		store.setWindowMinutes(5);
		vi.advanceTimersByTime(300_000);
		flush();
		expect(store.linesSince).toBeNull();
		store.setWindowMinutes(15);
		flush();
		expect(store.linesSince).toMatchObject({ cause: 'page' });
		store.destroy();
	});

	it('passes status straight through', () => {
		const { store } = setup();
		expect(store.status).toEqual({ kind: 'connecting', attempt: 1 });
		store.sink.status({ kind: 'live', sinceMs: T0 });
		expect(store.status).toEqual({ kind: 'live', sinceMs: T0 });
		store.destroy();
	});

	it('publishes nothing and takes no status after destroy', () => {
		const { store, s, flush, pending } = setup();
		store.sink.status({ kind: 'live', sinceMs: T0 });
		live(store, s);
		flush();
		store.destroy();
		store.sink.events(s.next(E.stats()));
		vi.advanceTimersByTime(5000);
		expect(pending()).toBe(0);
		store.sink.status({ kind: 'stopped' });
		expect(store.status.kind).toBe('live');
	});
});

describe('browserFrameScheduler', () => {
	function env(hidden: boolean) {
		const listeners = new Set<() => void>();
		const doc = {
			hidden,
			addEventListener: (_: string, fn: () => void) => listeners.add(fn),
			removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
		};
		const raf = vi.fn((cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		});
		const caf = vi.fn();
		return {
			doc,
			raf,
			caf,
			listeners,
			frames: browserFrameScheduler({
				document: doc as unknown as Document,
				requestAnimationFrame: raf,
				cancelAnimationFrame: caf
			})
		};
	}

	it('uses requestAnimationFrame in a visible tab', () => {
		const e = env(false);
		const cb = vi.fn();
		e.frames.request(cb);
		expect(e.raf).toHaveBeenCalledOnce();
		expect(cb).toHaveBeenCalledOnce();
	});

	it('waits for a hidden tab to come back', () => {
		const e = env(true);
		const cb = vi.fn();
		e.frames.request(cb);
		expect(e.raf).not.toHaveBeenCalled();
		expect(cb).not.toHaveBeenCalled();
		for (const fn of e.listeners) fn();
		expect(cb).not.toHaveBeenCalled();
		e.doc.hidden = false;
		for (const fn of [...e.listeners]) fn();
		expect(cb).toHaveBeenCalledOnce();
		expect(e.listeners.size).toBe(0);
	});

	it('can cancel a wait', () => {
		const e = env(true);
		const cancel = e.frames.request(vi.fn());
		cancel();
		expect(e.listeners.size).toBe(0);
	});
});

describe('build history', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Lets the fake calls' async generators run to their end. */
	const settle = async () => {
		for (let i = 0; i < 200; i++) await Promise.resolve();
	};
	/** `sent`: the batches the caller took before it stopped reading, `paths`: their builds. */
	type Call = { req: RecentBuildsRequest; sent: number; paths: string[] };
	/** A fake RecentBuilds that answers each call from `answer`. */
	function history(answer: (req: RecentBuildsRequest) => FinishedBuildInit[][]) {
		const calls: Call[] = [];
		const fn: RecentBuildsFn = async function* (req) {
			const call: Call = { req, sent: 0, paths: [] };
			calls.push(call);
			const batches = answer(req);
			// Complete: the ring had fewer than asked for.
			const total = batches.reduce((n, b) => n + b.length, 0);
			for (let i = 0; i < batches.length; i++) {
				call.sent++;
				call.paths.push(...batches[i].map((b) => b.drvPath));
				yield create(RecentBuildsBatchSchema, {
					builds: batches[i].map((b) => create(FinishedBuildSchema, b)),
					complete: i === batches.length - 1 && total < req.limit
				});
			}
		};
		return { fn, calls };
	}
	type FinishedBuildInit = {
		drvPath: string;
		finishedMs: bigint;
		outcome?: Outcome;
		error?: string;
	};
	const built = (name: string, ago: number): FinishedBuildInit => ({
		drvPath: drvPath(name),
		finishedMs: BigInt(T0 - ago),
		outcome: Outcome.BUILT
	});
	type Rings = { builds: FinishedBuildInit[]; failures: FinishedBuildInit[] };
	/** Answers from the scheduler's two rings, newest first, in batches of 256. */
	const fromRings = (rings: Rings) => (req: RecentBuildsRequest) => {
		const page = (req.failedOnly ? rings.failures : rings.builds)
			.filter((b) => !req.beforeMs || Number(b.finishedMs) < req.beforeMs)
			.slice(0, req.limit);
		const out: FinishedBuildInit[][] = [];
		for (let i = 0; i < page.length; i += 256) out.push(page.slice(i, i + 256));
		return out.length ? out : [[]];
	};
	/** A build that finishes live on A. */
	const gone = (name: string) => E.gone(drvPath(name), Outcome.BUILT, { workerAddr: A });
	/** A reconnect to the same instance at `timeMs`; `after` comes live in the same message. */
	function reconnect(store: ReducerFarmStore, s: Stream, timeMs: number, ...after: Ev[]) {
		vi.setSystemTime(timeMs);
		s.timeMs = timeMs;
		s.seq += 10n;
		store.sink.beginStream();
		store.sink.events([...s.snapshot(E.reset(), E.worker(A)), ...s.next(...after)]);
	}

	it('ensureHistory loads once per instance however often it is called', async () => {
		const { store, s, flush } = setup();
		const h = history(() => [[built('a', 1000)]]);
		store.attachHistory(h.fn);
		// Nothing before the first snapshot: the instance is not known yet.
		store.ensureHistory();
		expect(h.calls).toHaveLength(0);
		live(store, s);
		store.ensureHistory();
		store.ensureHistory();
		await settle();
		flush();
		// A first page of each ring. Only the failures come with their text.
		const first = h.calls.map((c) => c.req);
		expect(first.map((req) => [req.failedOnly, req.withError])).toEqual([
			[false, false],
			[true, true]
		]);
		store.ensureHistory();
		await settle();
		expect(h.calls).toHaveLength(first.length);
		// A reconnect to the same instance keeps what it loaded, and asks only for
		// the newest page of each ring, for builds that finished during the cut.
		store.sink.beginStream();
		store.sink.events(new Stream(s.seq + 10n).snapshot(E.reset(), E.worker(A)));
		store.ensureHistory();
		await settle();
		expect(h.calls.slice(first.length).map((c) => [c.req.beforeMs, c.req.failedOnly])).toEqual([
			[0, false],
			[0, true]
		]);
		// A new instance loads again, as the first time.
		const asked = h.calls.length;
		store.sink.beginStream();
		store.sink.events(new Stream(1n).snapshot(E.reset({ instance: 'inst-b' }), E.worker(A)));
		store.ensureHistory();
		await settle();
		expect(h.calls.slice(asked).map((c) => c.req)).toEqual(first);
		store.destroy();
	});

	it('asks again for a first page that failed, but not an older scheduler', async () => {
		const { store, s } = setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let refusals = 2;
		const h = history((req) => {
			// Another tab's calls fill the scheduler's cap of 4 per caller.
			if (req.failedOnly) return [[]];
			if (refusals-- > 0) throw new ConnectError('too many calls', Code.ResourceExhausted);
			return [[built('a', 1000)]];
		});
		store.attachHistory(h.fn);
		live(store, s);
		store.ensureHistory();
		await settle();
		expect(h.calls).toHaveLength(2);
		expect(store.builds({ ...ANY_QUERY }).coverage.source).toBe('page');
		// From 2 s, doubling, with jitter.
		await vi.advanceTimersByTimeAsync(2000);
		expect(h.calls).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(4000);
		expect(h.calls).toHaveLength(4);
		expect(store.builds({ ...ANY_QUERY }).coverage.source).toBe('scheduler');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(h.calls).toHaveLength(4);
		store.destroy();

		const old = setup();
		const none = history(() => {
			throw new ConnectError('no RecentBuilds', Code.Unimplemented);
		});
		old.store.attachHistory(none.fn);
		live(old.store, old.s);
		old.store.ensureHistory();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(none.calls).toHaveLength(2);
		old.store.destroy();
		warn.mockRestore();
	});

	it('a reconnect to the same instance adds the builds that finished during the cut', async () => {
		const { store, s } = setup();
		// 1,500 builds in the scheduler's ring, one a second, and a failure.
		const rings: Rings = {
			builds: Array.from({ length: 1500 }, (_, i) => built(`b${i}`, (i + 1) * 1000)),
			failures: [{ ...built('f0', 1500), outcome: Outcome.FAILED, error: '> error: f0' }]
		};
		const h = history(fromRings(rings));
		store.attachHistory(h.fn);
		live(store, s);
		store.ensureHistory();
		await settle();
		const firstLimit = h.calls.find((c) => !c.req.failedOnly)!.req.limit;
		// One build finishes live, at T0.
		store.sink.events(s.next(gone('l0')));
		rings.builds.unshift(built('l0', 0));
		const all = { ...ANY_QUERY };
		const coverage = store.builds(all).coverage;
		expect(coverage).toMatchObject({ source: 'scheduler', complete: false });
		const loaded = store.builds(all).rows.filter((r) => r.state !== 'assigned').length;
		const asked = h.calls.length;
		// While the stream is down, 300 builds and a failure finish, more than a batch.
		const cut = Array.from({ length: 300 }, (_, i) => built(`c${i}`, -1000 - i * 10)).reverse();
		const failed = {
			...built('cut-failed', -4500),
			outcome: Outcome.FAILED,
			error: '> error: cut'
		};
		rings.builds.unshift(failed, ...cut);
		rings.failures.unshift(failed);
		// The reconnect's first message also brings a build that finished after it.
		rings.builds.unshift(built('after', -5000));
		reconnect(store, s, T0 + 5000, gone('after'));
		await settle();
		// Pages smaller than a first page, from now back, each one past the last's oldest
		// row. They stop at l0, the newest finish the page had before the cut, not at the
		// build that came live after it. The failures take one page.
		const topUp = h.calls.slice(asked);
		const builds = topUp.filter((c) => !c.req.failedOnly);
		const page = builds[0].req.limit;
		expect(page).toBeLessThan(firstLimit);
		expect(builds.every((c) => c.req.limit === page)).toBe(true);
		expect(builds[0].req.beforeMs).toBe(0);
		for (let i = 1; i < builds.length; i++)
			expect(builds[i].req.beforeMs).toBeLessThan(builds[i - 1].req.beforeMs || Infinity);
		expect(builds.findIndex((c) => c.paths.includes(drvPath('l0')))).toBe(builds.length - 1);
		expect(topUp.filter((c) => c.req.failedOnly).map((c) => [c.req.beforeMs, c.sent])).toEqual([
			[0, 1]
		]);
		const rows = store.builds(all).rows.filter((r) => r.state !== 'assigned');
		const paths = new Set(rows.map((r) => r.drvPath));
		expect(cut.filter((b) => !paths.has(b.drvPath))).toEqual([]);
		expect(rows.find((r) => r.drvPath === failed.drvPath)).toMatchObject({
			state: 'failed',
			from: 'history',
			errorLine: 'error: cut'
		});
		// What the page had, the cut's builds, its failure and the build after it.
		expect(rows).toHaveLength(loaded + cut.length + 2);
		// Nothing older, and the coverage stays.
		expect(store.builds(all).coverage).toEqual(coverage);
		// Another reconnect with nothing new reads one page of each.
		const before = h.calls.length;
		reconnect(store, s, T0 + 9000);
		await settle();
		expect(h.calls.slice(before).map((c) => [c.req.beforeMs, c.sent])).toEqual([
			[0, 1],
			[0, 1]
		]);
		store.destroy();
	});

	it('a cut stays until a top-up reads back to it, and UNIMPLEMENTED ends them', async () => {
		const { store, s } = setup();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const rings: Rings = { builds: [built('b0', 1000)], failures: [] };
		let refuse: Code | null = null;
		const h = history((req) => {
			if (refuse !== null) throw new ConnectError('refused', refuse);
			return fromRings(rings)(req);
		});
		store.attachHistory(h.fn);
		live(store, s);
		store.ensureHistory();
		await settle();
		const loaded = h.calls.length;
		// 300 builds finish while the stream is down, and the top-up fails.
		const cut = Array.from({ length: 300 }, (_, i) => built(`c${i}`, -1000 - i * 10)).reverse();
		rings.builds.unshift(...cut);
		refuse = Code.Unavailable;
		reconnect(store, s, T0 + 5000);
		await settle();
		// Each ring's top-up stops at its first refusal.
		expect(h.calls.slice(loaded).map((c) => [c.req.failedOnly, c.sent])).toEqual([
			[false, 0],
			[true, 0]
		]);
		expect(warn).toHaveBeenCalledTimes(2);
		// One more finishes live, then the next reconnect's top-up reads back to the first cut.
		refuse = null;
		vi.setSystemTime(T0 + 6000);
		s.timeMs = T0 + 6000;
		store.sink.events(s.next(gone('y')));
		rings.builds.unshift(built('y', -6000));
		const next = h.calls.length;
		reconnect(store, s, T0 + 7000);
		await settle();
		// The builds pages stop at b0, the newest build the page had before the first cut,
		// not at y. The failures take one page.
		const topUp = h.calls.slice(next);
		const builds = topUp.filter((c) => !c.req.failedOnly);
		expect(builds.findIndex((c) => c.paths.includes(drvPath('b0')))).toBe(builds.length - 1);
		expect(topUp.filter((c) => c.req.failedOnly)).toHaveLength(1);
		const paths = new Set(store.builds({ ...ANY_QUERY }).rows.map((r) => r.drvPath));
		expect(cut.filter((b) => !paths.has(b.drvPath))).toEqual([]);
		// An older scheduler behind the same name. Each ring asks once, and no
		// top-ups follow UNIMPLEMENTED.
		refuse = Code.Unimplemented;
		const before = h.calls.length;
		reconnect(store, s, T0 + 8000);
		await settle();
		expect(h.calls.slice(before).map((c) => c.req.failedOnly)).toEqual([false, true]);
		const refused = h.calls.length;
		reconnect(store, s, T0 + 9000);
		await settle();
		expect(h.calls).toHaveLength(refused);
		expect(warn).toHaveBeenCalledTimes(2);
		store.destroy();
		warn.mockRestore();
	});

	it('loadOlderBuilds pages by the oldest row and stops at complete', async () => {
		const { store, s } = setup();
		// 1,500 rows in the scheduler's builds ring, one a second.
		const ring = Array.from({ length: 1500 }, (_, i) => built(`b${i}`, (i + 1) * 1000));
		const h = history((req) => {
			if (req.failedOnly) return [[]];
			const older = ring.filter((b) => !req.beforeMs || Number(b.finishedMs) < req.beforeMs);
			const page = older.slice(0, req.limit);
			const out: FinishedBuildInit[][] = [];
			for (let i = 0; i < page.length; i += 256) out.push(page.slice(i, i + 256));
			return out.length ? out : [[]];
		});
		store.attachHistory(h.fn);
		live(store, s);
		store.ensureHistory();
		await settle();
		const all = { ...ANY_QUERY };
		const limit = h.calls.find((c) => !c.req.failedOnly)!.req.limit;
		expect(ring.length).toBeGreaterThan(limit);
		expect(store.builds(all).rows.filter((r) => r.state !== 'assigned')).toHaveLength(limit);
		expect(store.builds(all).coverage).toMatchObject({ source: 'scheduler', complete: false });
		store.loadOlderBuilds(false);
		await settle();
		// The scheduler pages strictly before beforeMs, which is one past the oldest row the page has.
		expect(h.calls.at(-1)!.req.beforeMs).toBe(Number(ring[limit - 1].finishedMs) + 1);
		expect(store.builds(all).rows.filter((r) => r.state !== 'assigned')).toHaveLength(ring.length);
		expect(store.builds(all).coverage.complete).toBe(true);
		const n = h.calls.length;
		store.loadOlderBuilds(false);
		await settle();
		expect(h.calls).toHaveLength(n);
		store.destroy();
	});

	it('loadOlderBuilds stops when the ring is full', async () => {
		const { store, s } = setup();
		// Every call returns 256 failures older than the last: the failures ring fills.
		let next = 0;
		const h = history((req) => {
			if (!req.failedOnly) return [[]];
			const out = Array.from({ length: req.limit }, () => ({
				...built(`f${next}`, (++next + 1) * 1000),
				outcome: Outcome.FAILED
			}));
			return [out];
		});
		store.attachHistory(h.fn);
		live(store, s);
		store.ensureHistory();
		await settle();
		let callsWhenFull: number | null = null;
		for (let i = 0; i < 20; i++) {
			store.loadOlderBuilds(true);
			await settle();
			if (callsWhenFull === null && store.builds({ ...ANY_QUERY }).coverage.full)
				callsWhenFull = h.calls.length;
		}
		// The call that went past what the ring holds was the last.
		expect(callsWhenFull).not.toBeNull();
		expect(h.calls).toHaveLength(callsWhenFull!);
		store.destroy();
	});

	it('finishedBuild asks by derivation path', async () => {
		const { store, s } = setup();
		const path = drvPath('hello');
		const h = history((req) =>
			req.drvPaths?.includes(path)
				? [[{ ...built('hello', 5000), outcome: Outcome.FAILED, error: 'error: x\n> boom' }]]
				: [[]]
		);
		store.attachHistory(h.fn);
		live(store, s);
		const v = await store.finishedBuild(path, new AbortController().signal);
		expect(h.calls.at(-1)!.req.drvPaths).toEqual([path]);
		expect(v).toMatchObject({ drvPath: path, state: 'failed', errorText: 'error: x\n> boom' });
		expect(await store.finishedBuild(drvPath('nope'), new AbortController().signal)).toBeNull();
		store.destroy();
	});
});
