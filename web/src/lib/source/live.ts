// The live Watch stream over gRPC-web, with reconnects. It backs off from
// 0.5 s, doubling to 30 s with jitter, and resets on a complete snapshot. A
// watchdog aborts a stream that sends nothing for 10 s. It reconnects at once
// on a seq gap, and stops for good on PERMISSION_DENIED and when the auth
// proxy in front of the farm no longer lets this browser through.
//
// The page holds no token. Whatever is in front of the farm signs users in
// and names the viewer to the scheduler, so the page sends nothing but the
// browser's own requests.

import { Code, ConnectError, createClient, type Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { Events } from '#lib/gen/events_pb.ts';
import { NixRemote } from '#lib/gen/nix_remote_pb.ts';
import type { ConnectionStatus } from '#lib/model/types.ts';
import type {
	LogBackend,
	LogCall,
	LogRequest,
	RecentBuildsRequest,
	Source,
	SourceSink
} from './types.ts';

/**
 * HTTP 401 or a redirect: the auth proxy in front of the farm no longer lets
 * this browser through, most likely because its session ended. The farm's
 * Envoy never answers 401 itself.
 */
export class SignedOut extends Error {
	override name = 'SignedOut';
	constructor(why = 'HTTP 401') {
		super(`${why}: not signed in`);
	}
}

/**
 * HTTP 403 without a gRPC status, from in front of the scheduler: Envoy's
 * CSRF filter refused the page's origin, its RBAC filter refused a peer that
 * named no viewer, or the auth proxy refused. `text` is the reply's body
 * when it is one short line of plain text. Envoy's 403 for an identity header
 * with characters it does not allow comes as PERMISSION_DENIED instead.
 */
export class Refused extends Error {
	override name = 'Refused';
	readonly text: string | undefined;
	constructor(text?: string) {
		super(text ? `HTTP 403: ${text}` : 'HTTP 403');
		this.text = text;
	}
}

/** x-envoy-overloaded: Envoy's cap on streams is full, the one for all viewers of a balancer. */
export class Overloaded extends Error {
	override name = 'Overloaded';
	constructor() {
		super('the farm is overloaded');
	}
}

/** The longest reply text shown as it is. */
const MAX_TEXT = 120;

/** A reply body worth showing: one short line of plain text, or undefined. */
async function shortText(res: Response): Promise<string | undefined> {
	if (!/^text\/plain\b/i.test(res.headers.get('content-type') ?? '')) return undefined;
	const length = Number(res.headers.get('content-length'));
	if (length > 4 * MAX_TEXT) return undefined;
	let text: string;
	try {
		text = (await res.text()).trim();
	} catch {
		return undefined;
	}
	return text && text.length <= MAX_TEXT && !/[\r\n]/.test(text) ? text : undefined;
}

/** Replies from in front of the scheduler, told apart from its own, which always come with HTTP 200. */
async function refusal(res: Response): Promise<Error | null> {
	if (res.type === 'opaqueredirect') return new SignedOut('a redirect');
	// Plain text, or 401 with grpc-status 16 from a proxy that speaks gRPC-web.
	if (res.status === 401) return new SignedOut();
	if (res.headers.get('x-envoy-overloaded') === 'true') return new Overloaded();
	if (res.status === 403 && !res.headers.has('grpc-status'))
		return new Refused(await shortText(res));
	return null;
}

/**
 * The gRPC-web transport to <baseUrl>nix.remote.Events/Watch. Replies from
 * in front of the scheduler throw the errors above, which ConnectError.from
 * keeps as `cause`: a 401, a redirect, a 403 and the overload 503.
 */
export function createDashboardTransport(
	baseUrl: string,
	options: { fetch?: typeof globalThis.fetch } = {}
): Transport {
	const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	return createGrpcWebTransport({
		baseUrl,
		// Envoy's grpc_web filter only transcodes the binary and text formats.
		useBinaryFormat: true,
		fetch: async (input, init) => {
			// Never follow a redirect, such as to a sign-in page: say what happened instead.
			const res = await doFetch(input, { ...init, redirect: 'manual' });
			const refused = await refusal(res);
			if (!refused) return res;
			void res.body?.cancel().catch(() => {});
			throw refused;
		}
	});
}

export type LiveSourceOptions = {
	transport: Transport;
	sink: SourceSink;
	/** Jitter source, [0, 1). */
	random?: () => number;
};

/** Abort when nothing arrives for this long. */
const WATCHDOG_MS = 10_000;
/** Reconnect backoff: the first wait, doubling up to the longest. */
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface LiveSource extends Source {
	readonly logs: LogBackend;
	/** Skip the current backoff wait. */
	retryNow(): void;
}

type Outcome =
	| { next: 'retry'; error: string; reason?: 'busy' | 'refused' }
	| { next: 'now' }
	| { next: 'stop' };

export function startLiveSource(o: LiveSourceOptions): LiveSource {
	const client = createClient(Events, o.transport);
	const random = o.random ?? Math.random;
	const sink = o.sink;

	let stopped = false;
	let current: AbortController | null = null;
	let wake: (() => void) | null = null;
	// Failed attempts since the last complete snapshot.
	let failures = 0;

	const status = (s: ConnectionStatus) => sink.status(s);

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				wake = null;
				resolve();
			}, ms);
			wake = () => {
				clearTimeout(t);
				wake = null;
				resolve();
			};
		});

	async function once(): Promise<Outcome> {
		const ctl = new AbortController();
		current = ctl;
		// Set when the watchdog aborts the stream. An object, because the
		// timer sets it and TypeScript does not track that.
		const dog = { barked: false };
		let live = false;
		let first = true;
		// One watchdog timer at a time, not one per message: when it fires
		// early it sleeps until WATCHDOG_MS after the last message.
		let lastMsg = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watch = (ms: number) => {
			timer = setTimeout(() => {
				const quiet = Date.now() - lastMsg;
				if (quiet < WATCHDOG_MS) {
					watch(WATCHDOG_MS - quiet);
					return;
				}
				dog.barked = true;
				ctl.abort();
			}, ms);
		};
		status({ kind: 'connecting', attempt: failures + 1 });
		sink.beginStream();
		try {
			watch(WATCHDOG_MS);
			const call = client.watch({}, { signal: ctl.signal });
			for await (const msg of call) {
				lastMsg = Date.now();
				// Syncing from the first message: a call that fails at once
				// still gets response headers.
				if (first) {
					first = false;
					status({ kind: 'syncing' });
				}
				const r = sink.events(msg.msgs);
				// Leaving the loop cancels the call.
				if (!r.ok) return afterGap(live, r.error);
				if (r.snapshotDone) {
					live = true;
					failures = 0;
					status({ kind: 'live', sinceMs: lastMsg });
				}
			}
			return { next: 'retry', error: 'The farm closed the stream.' };
		} catch (e) {
			if (stopped) return { next: 'stop' };
			if (dog.barked)
				return { next: 'retry', error: `No data from the farm for ${WATCHDOG_MS / 1000}s.` };
			return outcome(ConnectError.from(e), !first);
		} finally {
			clearTimeout(timer);
			if (current === ctl) current = null;
		}
	}

	// `started`: the stream sent a message.
	function outcome(err: ConnectError, started: boolean): Outcome {
		const cause = err.cause;
		if (cause instanceof SignedOut) {
			status({ kind: 'signed-out' });
			return { next: 'stop' };
		}
		if (cause instanceof Refused) {
			return {
				next: 'retry',
				reason: 'refused',
				error:
					`A proxy in front of the farm refused this page (${cause.text ?? 'HTTP 403'}). It ` +
					"checks the page's origin and who the viewer is. Ask the farm operator " +
					'(docs/operators.md).'
			};
		}
		if (cause instanceof Overloaded)
			return {
				next: 'retry',
				error: 'The farm is busy: its proxy has as many streams open as it allows.',
				reason: 'busy'
			};
		// After the stream started, an ordinary failure.
		if (err.code === Code.Unauthenticated && !started) {
			// The scheduler refused the viewer that the balancer named. Signing in again would not help.
			const why = err.rawMessage || 'unauthenticated';
			return {
				next: 'retry',
				reason: 'refused',
				error:
					`The farm's scheduler does not accept the viewers its balancer names (${why}). Its ` +
					'node likely lacks trustedProxies for the balancer (docs/operators.md).'
			};
		}
		if (err.code === Code.ResourceExhausted)
			return { next: 'retry', error: describe(err), reason: 'busy' };
		if (err.code === Code.PermissionDenied) {
			status({
				kind: 'denied',
				error: err.rawMessage || 'The farm does not let this account watch it.'
			});
			return { next: 'stop' };
		}
		return { next: 'retry', error: describe(err) };
	}

	// A gap after a complete snapshot reconnects at once. A gap inside a
	// snapshot is a server problem, so it backs off like any failure.
	function afterGap(live: boolean, error: string): Outcome {
		return live
			? { next: 'now' }
			: { next: 'retry', error: `The stream skipped events (${error}).` };
	}

	async function run() {
		while (!stopped) {
			const out = await once();
			if (stopped || out.next === 'stop') return;
			if (out.next === 'now') continue;
			const base = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** failures);
			const delay = base / 2 + (random() * base) / 2;
			failures++;
			status({
				kind: 'retrying',
				attempt: failures,
				retryAtMs: Date.now() + delay,
				error: out.error,
				...(out.reason && { reason: out.reason })
			});
			await sleep(delay);
		}
	}

	void run();

	function stop() {
		if (stopped) return;
		stopped = true;
		current?.abort();
		wake?.();
		status({ kind: 'stopped' });
	}

	const remote = createClient(NixRemote, o.transport);

	/** GetBuildLog on the builder that ran the build, through the farm's Envoy. */
	function openLog(req: LogRequest, signal: AbortSignal): LogCall {
		let setNode: (n: string | null) => void = () => {};
		let setRebuilding: (n: number | null) => void = () => {};
		const node = new Promise<string | null>((r) => (setNode = r));
		const rebuilding = new Promise<number | null>((r) => (setRebuilding = r));
		const fromHeaders = (h: Headers) => {
			const n = h.get('x-nix-node');
			if (n) setNode(n);
			const rb = h.get('x-nix-rebuilding');
			if (rb && /^\d+$/.test(rb)) setRebuilding(Number(rb));
		};
		async function* run() {
			try {
				const headers: Record<string, string> = { 'x-nix-worker': req.worker };
				if (req.system) headers['x-nix-system'] = req.system;
				const call = remote.getBuildLog(
					{
						drvPath: req.drvPath,
						offset: BigInt(Math.max(0, Math.round(req.offset))),
						follow: req.follow,
						assignId: BigInt(req.assignId),
						limit: BigInt(req.limit),
						tail: BigInt(req.tail)
					},
					{ signal, headers, onHeader: fromHeaders, onTrailer: fromHeaders }
				);
				yield* call;
			} catch (e) {
				const err = ConnectError.from(e);
				fromHeaders(err.metadata);
				throw err;
			} finally {
				setNode(null);
				setRebuilding(null);
			}
		}
		const it = run();
		return Object.assign(it, { node, rebuilding });
	}

	/** Events.RecentBuilds, for the build list's history. */
	async function* recentBuilds(req: RecentBuildsRequest, signal: AbortSignal) {
		yield* client.recentBuilds(
			{
				beforeMs: BigInt(Math.max(0, Math.round(req.beforeMs))),
				limit: req.limit,
				failedOnly: req.failedOnly,
				withError: req.withError,
				drvPaths: req.drvPaths ? [...req.drvPaths] : []
			},
			{ signal }
		);
	}

	return {
		recentBuilds,
		logs: { kind: 'grpc', open: openLog },
		stop,
		retryNow() {
			wake?.();
		}
	};
}

function describe(err: ConnectError): string {
	const msg = err.rawMessage;
	switch (err.code) {
		case Code.Unavailable:
			return msg ? `The farm is unavailable: ${msg}` : 'The farm is unavailable.';
		case Code.Unimplemented:
			return 'The farm does not offer the dashboard stream. Its scheduler may need an update.';
		case Code.ResourceExhausted:
			return msg ? `The farm is busy: ${msg}` : 'The farm is busy.';
		case Code.DeadlineExceeded:
			return 'The connection timed out.';
		default:
			return msg ? `Connection failed: ${msg}` : 'Connection failed.';
	}
}
