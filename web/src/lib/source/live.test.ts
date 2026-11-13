import { create, toBinary } from '@bufbuild/protobuf';
import {
	Code,
	ConnectError,
	createRouterTransport,
	type HandlerContext,
	type Interceptor
} from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	Events,
	WatchEventsSchema,
	type WatchEvent,
	type WatchEvents
} from '#lib/gen/events_pb.ts';
import {
	GetBuildLogChunkSchema,
	NixRemote,
	type GetBuildLogChunk
} from '#lib/gen/nix_remote_pb.ts';
import { E, Stream, T0, reducerSink } from '#lib/model/fixtures.ts';
import { FarmReducer } from '#lib/model/reducer.ts';
import type { ConnectionStatus } from '#lib/model/types.ts';
import { grpcWebFrame as frame } from '#lib/test-helpers.ts';
import { SignedOut, createDashboardTransport, startLiveSource } from './live.ts';
import type { LogCall } from './types.ts';

const A = '10.0.0.1:50051';

const msg = (events: WatchEvent[]) => create(WatchEventsSchema, { msgs: events });

/** Block until the client cancels the call. */
function hang(ctx: HandlerContext): Promise<never> {
	return new Promise((_, reject) => {
		if (ctx.signal.aborted) reject(ctx.signal.reason);
		ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stats once a second, for `ms` or until the client cancels. */
async function* stats(s: Stream, ctx: HandlerContext, ms = Infinity) {
	for (let t = 0; t < ms && !ctx.signal.aborted; t += 1000) {
		await wait(1000);
		yield msg(s.next(E.stats()));
	}
}

type Handler = (call: number, ctx: HandlerContext) => AsyncIterable<WatchEvents>;

type Recorded = ConnectionStatus & { at: number };

/**
 * A live source on an in-memory farm. `proxy401` answers an attempt before
 * the scheduler does, as the auth proxy in front of the farm would once its
 * session ended: 401 when it returns true.
 */
function setup(handler: Handler, opts: { proxy401?: (call: number) => boolean } = {}) {
	const calls: { auth: string | null; refused: boolean }[] = [];
	const proxy: Interceptor = (next) => async (req) => {
		const refused = opts.proxy401?.(calls.length + 1) ?? false;
		calls.push({ auth: req.header.get('authorization'), refused });
		if (refused) throw new SignedOut();
		return next(req);
	};
	const transport = createRouterTransport(
		({ service }) => {
			service(Events, {
				watch(_req, ctx) {
					return handler(calls.length, ctx);
				}
			});
		},
		{ transport: { interceptors: [proxy] } }
	);
	const reducer = new FarmReducer();
	const statuses: Recorded[] = [];
	const src = startLiveSource({
		transport,
		sink: reducerSink(reducer, { status: (s) => statuses.push({ ...s, at: Date.now() }) }),
		random: () => 0.5
	});
	return {
		calls,
		reducer,
		statuses,
		src,
		kinds: () => statuses.map((s) => s.kind),
		delays: () =>
			statuses.flatMap((s) => (s.kind === 'retrying' ? [Math.round(s.retryAtMs - s.at)] : []))
	};
}

const settle = () => vi.advanceTimersByTimeAsync(1);

describe('startLiveSource', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('connects with no authorization header, syncs and goes live', async () => {
		const s = new Stream();
		const t = setup(async function* (_call, ctx) {
			yield msg(s.snapshot(E.reset(), E.worker(A)));
			yield msg(s.next(E.stats()));
			await hang(ctx);
		});
		await settle();
		expect(t.kinds()).toEqual(['connecting', 'syncing', 'live']);
		expect(t.statuses[0]).toMatchObject({ kind: 'connecting', attempt: 1 });
		// The page has no token: whatever is in front of the farm names the viewer.
		expect(t.calls).toEqual([{ auth: null, refused: false }]);
		expect(t.reducer.phase).toBe('live');
		expect(t.reducer.counts().workers).toBe(1);
		t.src.stop();
		await settle();
		expect(t.kinds().at(-1)).toBe('stopped');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.calls).toHaveLength(1);
	});

	it('backs off from 0.5 s, doubling to 30 s, with jitter', async () => {
		const t = setup(async function* () {
			yield* [];
			throw new ConnectError('connection refused', Code.Unavailable);
		});
		await settle();
		expect(t.statuses[1]).toMatchObject({
			kind: 'retrying',
			attempt: 1,
			error: 'The farm is unavailable: connection refused'
		});
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(30_000);
		// random() = 0.5: three quarters of each step.
		expect(t.delays().slice(0, 9)).toEqual([
			375, 750, 1500, 3000, 6000, 12000, 22500, 22500, 22500
		]);
		const attempts = t.statuses
			.filter((s) => s.kind === 'connecting')
			.map((s) => s.kind === 'connecting' && s.attempt);
		expect(attempts.slice(0, 4)).toEqual([1, 2, 3, 4]);
		t.src.stop();
	});

	it('resets the backoff after a complete snapshot', async () => {
		const s = new Stream();
		const t = setup(async function* (call, ctx) {
			if (call <= 2) throw new ConnectError('down', Code.Unavailable);
			// The fourth attempt waits, so the test sees three backoffs.
			if (call > 3) await hang(ctx);
			yield msg(s.snapshot(E.reset()));
			throw new ConnectError('stepping down', Code.Unavailable);
		});
		await vi.advanceTimersByTimeAsync(5000);
		expect(t.kinds().slice(0, 8)).toEqual([
			'connecting',
			'retrying',
			'connecting',
			'retrying',
			'connecting',
			'syncing',
			'live',
			'retrying'
		]);
		const [first, second, afterSnapshot] = t.delays();
		expect(t.delays()).toHaveLength(3);
		expect(second).toBe(2 * first);
		// The backoff starts again from its first step.
		expect(afterSnapshot).toBe(first);
		t.src.stop();
	});

	it('treats a stream the server ends as a failure', async () => {
		const s = new Stream();
		const t = setup(async function* () {
			yield msg(s.snapshot(E.reset()));
		});
		await settle();
		expect(t.statuses.at(-1)).toMatchObject({
			kind: 'retrying',
			attempt: 1,
			error: 'The farm closed the stream.'
		});
		t.src.stop();
	});

	it('reconnects when nothing arrives for 10 s', async () => {
		const s = new Stream();
		const t = setup(async function* (_call, ctx) {
			yield msg(s.snapshot(E.reset()));
			await hang(ctx);
		});
		await vi.advanceTimersByTimeAsync(9_000);
		expect(t.kinds()).toEqual(['connecting', 'syncing', 'live']);
		await vi.advanceTimersByTimeAsync(1_100);
		expect(t.statuses.at(-1)).toMatchObject({
			kind: 'retrying',
			error: 'No data from the farm for 10s.'
		});
		await vi.advanceTimersByTimeAsync(400);
		expect(t.calls).toHaveLength(2);
		t.src.stop();
	});

	it('stays connected while Stats arrive every second', async () => {
		const s = new Stream();
		const t = setup(async function* (_call, ctx) {
			yield msg(s.snapshot(E.reset()));
			while (!ctx.signal.aborted) {
				await new Promise((r) => setTimeout(r, 1000));
				yield msg(s.next(E.stats()));
			}
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.kinds()).toEqual(['connecting', 'syncing', 'live']);
		expect(t.calls).toHaveLength(1);
		t.src.stop();
	});

	it('reconnects at once after a seq gap in a live stream', async () => {
		const s = new Stream();
		const t = setup(async function* (call, ctx) {
			yield msg(s.snapshot(E.reset(), E.worker(A)));
			if (call === 1) yield msg([s.raw(s.seq + 5n, E.stats())]);
			await hang(ctx);
		});
		await settle();
		expect(t.calls).toHaveLength(2);
		expect(t.kinds()).toEqual(['connecting', 'syncing', 'live', 'connecting', 'syncing', 'live']);
		expect(t.reducer.phase).toBe('live');
		t.src.stop();
	});

	it('backs off after a gap inside the snapshot', async () => {
		const t = setup(async function* () {
			const s = new Stream(10n);
			const [reset] = s.snapshot(E.reset());
			yield msg([reset, s.raw(12n, E.worker(A))]);
		});
		await settle();
		expect(t.kinds()).toEqual(['connecting', 'syncing', 'retrying']);
		expect(t.statuses.at(-1)).toMatchObject({ error: expect.stringMatching(/skipped events/) });
		t.src.stop();
	});

	it('a 401 at connect signs out without retrying', async () => {
		const t = setup(
			async function* () {
				yield* [];
			},
			{ proxy401: () => true }
		);
		await settle();
		expect(t.kinds()).toEqual(['connecting', 'signed-out']);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(t.calls).toHaveLength(1);
	});

	it('a 401 on a reconnect signs out and keeps the last picture', async () => {
		// The proxy's session ends while the page watches.
		const s = new Stream();
		const t = setup(
			async function* () {
				yield msg(s.snapshot(E.reset(), E.worker(A)));
				throw new ConnectError('reset', Code.Unavailable);
			},
			{ proxy401: (call) => call > 1 }
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.kinds()).toEqual([
			'connecting',
			'syncing',
			'live',
			'retrying',
			'connecting',
			'signed-out'
		]);
		expect(t.reducer.counts().workers).toBe(1);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(t.calls).toHaveLength(2);
	});

	it('a scheduler refusal at connect backs off and never signs out', async () => {
		const t = setup(async function* () {
			yield* [];
			throw new ConnectError('caller not trusted', Code.Unauthenticated);
		});
		await settle();
		expect(t.statuses.at(-1)).toMatchObject({
			kind: 'retrying',
			attempt: 1,
			reason: 'refused',
			error:
				"The farm's scheduler does not accept the viewers its balancer names (caller not " +
				'trusted). Its node likely lacks trustedProxies for the balancer (docs/operators.md).'
		});
		await vi.advanceTimersByTimeAsync(10_000);
		const d = t.delays().slice(0, 4);
		expect(d).toHaveLength(4);
		expect(d.slice(1)).toEqual(d.slice(0, -1).map((x) => 2 * x));
		expect(t.kinds()).not.toContain('signed-out');
		t.src.stop();
	});

	it('stops on PERMISSION_DENIED', async () => {
		const t = setup(async function* () {
			yield* [];
			throw new ConnectError("no access rule matches 'dashboard-user-abc'", Code.PermissionDenied);
		});
		await settle();
		expect(t.statuses.at(-1)).toMatchObject({
			kind: 'denied',
			error: "no access rule matches 'dashboard-user-abc'"
		});
		await vi.advanceTimersByTimeAsync(120_000);
		expect(t.calls).toHaveLength(1);
	});

	it('UNAUTHENTICATED after the stream started is an ordinary failure, with backoff', async () => {
		const s = new Stream();
		const t = setup(async function* (_call, ctx) {
			yield msg(s.snapshot(E.reset()));
			yield* stats(s, ctx, 3000);
			throw new ConnectError('stream ended', Code.Unauthenticated);
		});
		await vi.advanceTimersByTimeAsync(3500);
		expect(t.statuses.find((x) => x.kind === 'retrying')).toEqual({
			kind: 'retrying',
			attempt: 1,
			retryAtMs: T0 + 3000 + 375,
			error: 'Connection failed: stream ended',
			at: T0 + 3000
		});
		expect(t.calls).toHaveLength(2);
		expect(t.kinds()).not.toContain('signed-out');
		t.src.stop();
	});

	it('says the farm is busy when it caps streams', async () => {
		const t = setup(async function* () {
			yield* [];
			throw new ConnectError('8 streams per caller', Code.ResourceExhausted);
		});
		await settle();
		expect(t.statuses.at(-1)).toMatchObject({
			kind: 'retrying',
			reason: 'busy',
			error: 'The farm is busy: 8 streams per caller'
		});
		t.src.stop();
	});

	it('can skip the wait, and stops during a backoff', async () => {
		const t = setup(async function* () {
			yield* [];
			throw new ConnectError('down', Code.Unavailable);
		});
		await settle();
		expect(t.calls).toHaveLength(1);
		t.src.retryNow();
		await settle();
		expect(t.calls).toHaveLength(2);
		t.src.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(t.calls).toHaveLength(2);
		expect(t.kinds().at(-1)).toBe('stopped');
	});
});

// GetBuildLog on a farm whose stream is live.
describe('logs.open', () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: T0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	type LogHandler = (call: number, ctx: HandlerContext) => AsyncIterable<GetBuildLogChunk>;

	/** `[call, n]`: the n-th chunk of the call-th log call. */
	const chunk = (call: number, n: number) =>
		create(GetBuildLogChunkSchema, { data: new Uint8Array([call, n]) });

	function setupLog(handler: LogHandler) {
		const s = new Stream();
		const offsets: number[] = [];
		const transport = createRouterTransport(({ service }) => {
			service(Events, {
				async *watch(_req, ctx) {
					yield msg(s.snapshot(E.reset()));
					yield* stats(s, ctx);
				}
			});
			service(NixRemote, {
				getBuildLog(req, ctx) {
					offsets.push(Number(req.offset));
					return handler(offsets.length, ctx);
				}
			});
		});
		const src = startLiveSource({
			transport,
			sink: reducerSink(new FarmReducer()),
			random: () => 0.5
		});
		const logs = src.logs;
		if (logs.kind !== 'grpc') throw new Error('no grpc logs');
		const open = () =>
			logs.open(
				{
					drvPath: 'x.drv',
					worker: A,
					system: '',
					assignId: 1,
					offset: 100,
					follow: true,
					limit: 0,
					tail: 0
				},
				new AbortController().signal
			);
		return { src, open, offsets };
	}

	/** Each chunk's data, and the error that ended the call. */
	async function drain(call: LogCall) {
		const got: number[][] = [];
		try {
			for await (const c of call) got.push([...c.data]);
			return { got, error: null };
		} catch (e) {
			return { got, error: ConnectError.from(e) };
		}
	}

	it('a call that fails after chunks went out throws, for the caller to resume', async () => {
		const t = setupLog(async function* (call) {
			yield chunk(call, 1);
			yield chunk(call, 2);
			throw new ConnectError('reset', Code.Unavailable);
		});
		await settle();
		const done = drain(t.open());
		await vi.advanceTimersByTimeAsync(1000);
		const r = await done;
		// Sent again from its first offset, the call would put a second zstd
		// stream in the middle of the first.
		expect(t.offsets).toEqual([100]);
		expect(r.got).toEqual([
			[1, 1],
			[1, 2]
		]);
		expect(r.error?.code).toBe(Code.Unavailable);
		t.src.stop();
	});

	it('a call that answers names its node, and is sent once, with no lock or retry', async () => {
		const t = setupLog(async function* (call, ctx) {
			ctx.responseHeader.set('x-nix-node', 'builder-b');
			yield chunk(call, 1);
		});
		const call = t.open();
		const done = drain(call);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await done).toEqual({ got: [[1, 1]], error: null });
		expect(t.offsets).toEqual([100]);
		expect(await call.node).toBe('builder-b');
		t.src.stop();
	});

	it('UNAUTHENTICATED at connect throws, without a second try', async () => {
		const t = setupLog(async function* () {
			yield* [];
			throw new ConnectError('caller not trusted', Code.Unauthenticated);
		});
		await settle();
		const r = await drain(t.open());
		expect(t.offsets).toEqual([100]);
		expect(r.error?.code).toBe(Code.Unauthenticated);
		t.src.stop();
	});

	it('a NOT_FOUND names the assignment that replaced the log', async () => {
		const t = setupLog(async function* () {
			yield* [];
			throw new ConnectError('no log', Code.NotFound, { 'x-nix-rebuilding': '7' });
		});
		await settle();
		const call = t.open();
		const r = await drain(call);
		expect(r.error?.code).toBe(Code.NotFound);
		expect(await call.rebuilding).toBe(7);
		expect(await call.node).toBeNull();
		t.src.stop();
	});
});

// The real gRPC-web transport against a fake fetch: the request, and how the
// proxies in front of the farm and its scheduler answer, told apart by the
// HTTP status.
describe('createDashboardTransport', () => {
	const grpcWeb = { 'content-type': 'application/grpc-web+proto' };
	const trailer = (text: string) => frame(0x80, new TextEncoder().encode(text));

	function run(respond: (call: number) => Response) {
		let calls = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async () => respond(++calls));
		const transport = createDashboardTransport('http://localhost:8443/dash/', { fetch });
		const reducer = new FarmReducer();
		const statuses: ConnectionStatus[] = [];
		const src = startLiveSource({
			transport,
			sink: reducerSink(reducer, { status: (s) => statuses.push(s) })
		});
		return { fetch, reducer, statuses, src };
	}

	/** A trailers-only answer from the scheduler, through Envoy: HTTP 200. */
	const schedulerStatus = (code: number, message: string) =>
		new Response(new Uint8Array(0), {
			status: 200,
			headers: { ...grpcWeb, 'grpc-status': String(code), 'grpc-message': message }
		});

	it('connects with no authorization header, at <base>nix.remote.Events/Watch', async () => {
		const s = new Stream();
		const body = new Uint8Array([
			...frame(0, toBinary(WatchEventsSchema, msg(s.snapshot(E.reset(), E.worker(A))))),
			...trailer('grpc-status: 0\r\n')
		]);
		const t = run(() => new Response(body, { status: 200, headers: grpcWeb }));
		await vi.waitFor(() => expect(t.statuses.map((x) => x.kind)).toContain('retrying'));
		t.src.stop();
		const [url, init] = t.fetch.mock.calls[0];
		expect(String(url)).toBe('http://localhost:8443/dash/nix.remote.Events/Watch');
		expect(init?.method).toBe('POST');
		// A redirect, such as to a sign-in page, must not be followed.
		expect(init?.redirect).toBe('manual');
		const h = new Headers(init?.headers);
		expect(h.get('content-type')).toBe('application/grpc-web+proto');
		expect(h.get('x-grpc-web')).toBe('1');
		expect(h.has('authorization')).toBe(false);
		expect(t.statuses.map((x) => x.kind)).toEqual([
			'connecting',
			'syncing',
			'live',
			'retrying',
			'stopped'
		]);
		expect(t.reducer.counts().workers).toBe(1);
	});

	it('HTTP 401 as plain text and as 401 with grpc-status 16 both mean signed out', async () => {
		const plain = run(
			() =>
				new Response('Unauthorized', {
					status: 401,
					headers: { 'content-type': 'text/plain' }
				})
		);
		await vi.waitFor(() => expect(plain.statuses.at(-1)?.kind).toBe('signed-out'));
		// From a proxy that answers in gRPC-web.
		const grpc = run(
			() =>
				new Response(new Uint8Array(0), {
					status: 401,
					headers: { ...grpcWeb, 'grpc-status': '16', 'grpc-message': 'Unauthorized' }
				})
		);
		await vi.waitFor(() => expect(grpc.statuses.at(-1)?.kind).toBe('signed-out'));
		expect(plain.fetch).toHaveBeenCalledOnce();
		expect(grpc.fetch).toHaveBeenCalledOnce();
	});

	it('a redirect means signed out, without a retry', async () => {
		// What fetch gives for a 302 to the proxy's sign-in with redirect: 'manual'.
		const redirect = () => {
			const r = Response.error();
			Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
			return r;
		};
		const t = run(redirect);
		await vi.waitFor(() => expect(t.statuses.at(-1)?.kind).toBe('signed-out'));
		expect(t.statuses.map((x) => x.kind)).toEqual(['connecting', 'signed-out']);
		expect(t.fetch).toHaveBeenCalledOnce();
	});

	it('UNAUTHENTICATED in the trailers of a live stream backs off like any failure', async () => {
		const s = new Stream();
		const t = run((call) => {
			if (call > 1) return schedulerStatus(14, 'stop');
			const body = new Uint8Array([
				...frame(0, toBinary(WatchEventsSchema, msg(s.snapshot(E.reset())))),
				...trailer('grpc-status: 16\r\ngrpc-message: stream%20ended\r\n')
			]);
			return new Response(body, { status: 200, headers: grpcWeb });
		});
		await vi.waitFor(() => expect(t.fetch).toHaveBeenCalledTimes(2));
		t.src.stop();
		expect(t.statuses.map((x) => x.kind)).not.toContain('signed-out');
		expect(t.statuses.find((x) => x.kind === 'retrying')).toMatchObject({
			attempt: 1,
			error: 'Connection failed: stream ended'
		});
	});

	const forbidden = (body: string, headers: Record<string, string> = {}) =>
		new Response(body, { status: 403, headers: { 'content-type': 'text/plain', ...headers } });
	const refusedWith = (why: string) =>
		`A proxy in front of the farm refused this page (${why}). It checks the page's origin ` +
		'and who the viewer is. Ask the farm operator (docs/operators.md).';

	it.each(['Invalid origin', 'RBAC: access denied'])(
		'HTTP 403 without grpc-status shows its text "%s", backs off and never shows the denied card',
		async (text) => {
			const t = run(() => forbidden(`${text}\n`));
			await vi.waitFor(() => expect(t.statuses.at(-1)?.kind).toBe('retrying'));
			t.src.stop();
			expect(t.statuses[1]).toMatchObject({
				kind: 'retrying',
				reason: 'refused',
				error: refusedWith(text)
			});
			expect(t.statuses.map((x) => x.kind)).not.toContain('denied');
		}
	);

	it.each([
		['a long text', forbidden('x'.repeat(121))],
		['more than one line', forbidden('access denied\nsee the logs')],
		['HTML', forbidden('<p>Forbidden</p>', { 'content-type': 'text/html' })],
		['no body', new Response(null, { status: 403 })]
	])('HTTP 403 with %s says HTTP 403', async (_name, res) => {
		const t = run(() => res.clone());
		await vi.waitFor(() => expect(t.statuses.at(-1)?.kind).toBe('retrying'));
		t.src.stop();
		expect(t.statuses[1]).toMatchObject({ reason: 'refused', error: refusedWith('HTTP 403') });
	});

	it('a 503 with x-envoy-overloaded says the farm is busy and backs off', async () => {
		const t = run(
			() =>
				new Response('upstream connect error or disconnect/reset before headers', {
					status: 503,
					headers: {
						'content-type': 'text/plain',
						'x-envoy-overloaded': 'true',
						'grpc-status': '14'
					}
				})
		);
		await vi.waitFor(() => expect(t.statuses.at(-1)?.kind).toBe('retrying'));
		t.src.stop();
		expect(t.statuses[1]).toMatchObject({
			kind: 'retrying',
			attempt: 1,
			reason: 'busy',
			error: 'The farm is busy: its proxy has as many streams open as it allows.'
		});
	});
});
