// The viewer's side of a log: one worker per open log, the calls that feed
// it, and reactive state for the UI. The client opens calls only for the
// build the viewer shows. A follow call closes when the viewer goes, another
// build opens, or the page has been hidden for 10 s, and resumes from its
// last byte when the page shows again.

import { Code, ConnectError } from '@connectrpc/connect';
import { BuildLogInfo_Source, type BuildLogInfo } from '#lib/gen/nix_remote_pb.ts';
import type { LogEnding } from '#lib/source/mock-log.ts';
import type { LogBackend, LogCall, LogRequest } from '#lib/source/types.ts';
import type { BuildState } from '#lib/model/types.ts';
import { HEAD_MAX, TAIL_MAX, WHOLE_MAX } from './limits.ts';
import type {
	ErrorsInfo,
	FromWorker,
	GroupView,
	Moved,
	Progress,
	RenderedRow,
	SearchInfo,
	ToWorker
} from './protocol.ts';

/** The build whose log the viewer shows. */
export type LogTarget = Readonly<{
	drvPath: string;
	name: string;
	/** The builder that ran or runs it. */
	worker: string;
	system: string;
	assignId: number;
	/** Running builds follow. */
	running: boolean;
	/** When it finished, browser ms. */
	finishedMs: number | null;
	/** How it stands or ended, since a damaged file and a stopped build read differently. */
	state: BuildState;
}>;

/** Why there is no log, or why it stopped. */
export type LogProblem =
	| { kind: 'none' }
	| { kind: 'not-found' }
	| { kind: 'left' }
	| { kind: 'rebuilding'; assignId: number }
	| { kind: 'damaged' }
	| { kind: 'ended-early' }
	| { kind: 'denied' }
	| { kind: 'busy' }
	| { kind: 'lost'; retryAtMs: number }
	/** The builder answered, but a log store or cache it reads cannot be read now. */
	| { kind: 'unreadable' }
	| { kind: 'no-follow' }
	| { kind: 'no-route' };

export type LogSource = 'live' | 'kept' | 'store' | 'cache' | 'demo';

/**
 * After 10 s hidden, close follow calls, and reopen them when the page shows
 * again. Demo ticks stop with the page.
 */
const HIDDEN_CLOSE_MS = 10_000;
/** Retries when a store the builder reads cannot be read: from 2 s, doubling to 30 s. */
const UNREADABLE_FIRST_MS = 2_000;
const UNREADABLE_MAX_MS = 30_000;

export type LogClientOptions = Readonly<{
	/**
	 * Whether a builder is in the farm's topology. If it is, a NOT_FOUND from
	 * another node is EDS lag.
	 */
	inFarm?: (addr: string) => boolean;
}>;

class Misrouted extends Error {}
/** Another source answered from where the last call stopped, so the log starts over from 0. */
class StartOver extends Error {}

/**
 * DATA_LOSS: a cancelled or dropped build's log ends early, a built or
 * failed build's file is damaged. A followed build that
 * breaks after its first bytes was stopped.
 */
export function endsEarly(state: BuildState, started: boolean): boolean {
	if (state === 'cancelled' || state === 'dropped') return true;
	return state === 'assigned' && started;
}

export class LogClient {
	progress = $state.raw<Progress | null>(null);
	groups = $state.raw<readonly GroupView[]>([]);
	/** Groups still open at the end of what arrived, outermost first. */
	openGroups = $state.raw<readonly number[]>([]);
	/** The failed group once a failed build ends, by GroupTree.failedGroup. */
	failedGroup = $state<number | null>(null);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
	folded = $state.raw<ReadonlySet<number>>(new Set());
	errors = $state.raw<ErrorsInfo | null>(null);
	search = $state.raw<SearchInfo | null>(null);
	/** Rows to draw. A bump of `version` means drawn rows may have changed. */
	total = $state(0);
	version = $state(0);
	/** Every call ended: the log is complete, or as complete as it gets. */
	loaded = $state(false);
	/**
	 * A failed build's tail is in while its head may still be on its way, so
	 * the view can go to the end and the first error now.
	 */
	endIn = $state(false);
	/** A running build, whose log the viewer follows as it grows. */
	following = $state(false);
	/** It started on its builder. */
	started = $state(false);
	/** How the build ended, when it ended while the viewer followed it. */
	ended = $state.raw<{ ending: LogEnding; atMs: number } | null>(null);
	problem = $state.raw<LogProblem | null>(null);
	/** Who answered, as x-nix-node says. */
	node = $state<string | null>(null);
	source = $state<LogSource | null>(null);
	/** The decoded size when the builder knows it. */
	size = $state(0);

	readonly target: LogTarget;
	readonly #worker: Worker;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
	readonly #pending = new Map<number, (m: FromWorker) => void>();
	#req = 0;
	#stopped = false;
	/** The source sends a finite log, loaded once the worker is idle. */
	#settles = false;
	/** Streams still running, retries included. */
	#streaming = 0;

	/** A finished build's log is loaded once nothing more is on its way. */
	#maybeLoaded() {
		if (this.progress?.idle && this.#settles && !this.following && this.#streaming === 0)
			this.loaded = true;
	}
	readonly #cleanups: (() => void)[] = [];

	/** When a later build of the derivation wrote the log, in browser ms. */
	rebuiltAt = $state<number | null>(null);
	/** It cannot tell whose build the log is, as after a builder restart, or from a store. */
	maybeReplaced = $state(false);
	/** Waiting before the next try, after a break or a busy answer. */
	retryAtMs = $state<number | null>(null);

	readonly #inFarm: (addr: string) => boolean;

	constructor(
		target: LogTarget,
		readonly backend: LogBackend,
		options: LogClientOptions = {},
		makeWorker: () => Worker = () =>
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
			new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
	) {
		this.target = target;
		this.#inFarm = options.inFarm ?? (() => true);
		this.#worker = makeWorker();
		this.#worker.onmessage = (e: MessageEvent<FromWorker>) => this.#onMessage(e.data);
		this.#start();
	}

	#post(m: ToWorker, transfer: Transferable[] = []) {
		if (!this.#stopped) this.#worker.postMessage(m, transfer);
	}

	#ask<T extends FromWorker>(m: ToWorker & { req: number }): Promise<T> {
		return new Promise((resolve) => {
			this.#pending.set(m.req, (r) => resolve(r as T));
			this.#post(m);
		});
	}

	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: listeners
	readonly #moved = new Set<(m: Moved) => void>();
	/** Group ids moved, because the head of a log whose tail came first went in above the view, or the ring dropped lines. */
	onMoved(fn: (m: Moved) => void): () => void {
		this.#moved.add(fn);
		return () => this.#moved.delete(fn);
	}

	#onMessage(m: FromWorker) {
		switch (m.t) {
			case 'moved':
				// Listeners first, so the view reads where it is before the rows change.
				for (const fn of this.#moved) fn(m);
				this.total = m.total;
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
				this.folded = new Set(m.folded);
				this.version++;
				return;
			case 'progress':
				this.progress = m.p;
				this.#maybeLoaded();
				if (m.p.rows !== this.total) this.total = m.p.rows;
				this.version++;
				return;
			case 'groups':
				this.groups = m.groups;
				this.openGroups = m.open;
				this.failedGroup = m.failed;
				return;
			case 'errors':
				this.errors = m.e;
				this.version++;
				return;
			case 'search':
				this.search = m.s;
				this.version++;
				return;
		}
		if ('req' in m) {
			if (m.t === 'folded' || m.t === 'revealed' || m.t === 'hit') {
				this.total = m.total;
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
				this.folded = new Set(m.folded);
				this.version++;
			}
			const done = this.#pending.get(m.req);
			this.#pending.delete(m.req);
			done?.(m);
		}
	}

	// ------------------------------------------------------------ sources

	#start() {
		const b = this.backend;
		if (b.kind === 'none') {
			this.problem = { kind: 'none' };
			this.loaded = true;
			return;
		}
		if (b.kind === 'demo') this.#startDemo(b);
		else void this.#startGrpc(b);
	}

	// ----------------------------------------------------------------- grpc

	#calls = 0;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: the open calls
	readonly #active = new Set<AbortController>();
	#wake: (() => void) | null = null;
	/** Where a follow call stopped, to resume from when the page shows again. */
	#followFrom: { offset: number; source: number } | null = null;
	#hiddenTimer: ReturnType<typeof setTimeout> | undefined;

	/** Skip the wait before the next try. */
	retryNow() {
		this.#wake?.();
	}

	#sleep(ms: number): Promise<void> {
		this.retryAtMs = Date.now() + ms;
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.#wake = done;
		}).then(() => {
			this.#wake = null;
			this.retryAtMs = null;
		});
	}

	/**
	 * A finished build loads the head, the first 16 MiB or all of a smaller log,
	 * then the rest. Past 64 MiB the rest is the tail, its last 48 MiB, placed
	 * by the line the builder counted, and it loads at once. Up to 64 MiB it
	 * follows the head from where the head ends. A running build gets one
	 * follow call.
	 */
	async #startGrpc(b: Extract<LogBackend, { kind: 'grpc' }>) {
		const t = this.target;
		if (t.running) {
			this.following = true;
			this.#watchVisibility(b);
			await this.#stream(b, 'head', { offset: 0, follow: true, limit: 0, tail: 0 });
			return;
		}
		this.#settles = true;
		// Not loaded between the head and the rest.
		this.#streaming++;
		try {
			await this.#finished(b);
		} finally {
			this.#streaming--;
			this.#maybeLoaded();
		}
	}

	async #finished(b: Extract<LogBackend, { kind: 'grpc' }>) {
		let tailStarted = false;
		const head = this.#stream(
			b,
			'head',
			{ offset: 0, follow: false, limit: HEAD_MAX, tail: 0 },
			(info) => {
				// With the size known up front, past 64 MiB both parts load at once.
				if (info && Number(info.size) > WHOLE_MAX) {
					tailStarted = true;
					const tail = this.#stream(b, 'tail', {
						offset: HEAD_MAX,
						follow: false,
						limit: 0,
						tail: TAIL_MAX
					}).then(async (r) => {
						if (!r) return;
						this.endIn = true;
						// The view goes to the end first, then the head's bytes go in.
						await Promise.race([this.#shown, new Promise((ok) => setTimeout(ok, 2000))]);
					});
					// A failed build's view opens at its end, so the worker decodes the
					// tail first, and the head's bytes wait until the view shows it.
					if (this.target.state === 'failed') this.#headWait = tail;
				}
			}
		);
		const r = await head;
		if (!r || tailStarted || this.#stopped) return;
		// The rest follows the head. A known size up to 64 MiB gets all of it from
		// where the head ends, so there is no gap. An unknown size, when the head
		// used its whole limit, gets at most its last 48 MiB.
		const size = r.info ? Number(r.info.size) : -1;
		if (size > HEAD_MAX || (size === 0 && r.decoded >= HEAD_MAX)) {
			const from = await this.#headComplete();
			const tail = size > 0 ? 0 : TAIL_MAX;
			await this.#stream(b, 'tail', { offset: from, follow: false, limit: 0, tail });
		}
	}

	/** The tail a failed build's head waits for, while both load. */
	#headWait: Promise<void> | null = null;
	#showEnd: () => void = () => {};
	readonly #shown = new Promise<void>((ok) => (this.#showEnd = ok));

	/** The view shows the end of a failed build, so the head's bytes can go in now. */
	endShown() {
		this.#showEnd();
	}

	/** Follow calls close 10 s after the page hides and resume from their last byte. */
	#watchVisibility(b: Extract<LogBackend, { kind: 'grpc' }>) {
		if (typeof document === 'undefined') return;
		const onchange = () => {
			clearTimeout(this.#hiddenTimer);
			if (document.hidden) {
				this.#hiddenTimer = setTimeout(() => {
					for (const c of this.#active) c.abort();
				}, HIDDEN_CLOSE_MS);
			} else if (this.#followFrom && this.following) {
				const from = this.#followFrom;
				this.#followFrom = null;
				void this.#stream(b, 'more', { offset: from.offset, follow: true, limit: 0, tail: 0 });
			}
		};
		document.addEventListener('visibilitychange', onchange);
		this.#cleanups.push(() => {
			document.removeEventListener('visibilitychange', onchange);
			clearTimeout(this.#hiddenTimer);
		});
	}

	async #headComplete(): Promise<number> {
		const req = ++this.#req;
		const r = await this.#ask<Extract<FromWorker, { t: 'decoded' }>>({
			t: 'decoded',
			req,
			call: 0
		});
		return r.headComplete;
	}

	async #decodedBy(call: number): Promise<number> {
		const req = ++this.#req;
		const r = await this.#ask<Extract<FromWorker, { t: 'decoded' }>>({ t: 'decoded', req, call });
		return r.bytes;
	}

	/**
	 * One part of the log, through breaks: a call, and after a break another
	 * from where it stopped, with backoff from 0.5 s to 10 s. An answer from
	 * another node while the builder is in the farm is a break too, up to 4
	 * times, for EDS lag or a retry on another host.
	 */
	async #stream(
		b: Extract<LogBackend, { kind: 'grpc' }>,
		part: 'head' | 'tail' | 'more',
		spec: { offset: number; follow: boolean; limit: number; tail: number },
		onInfo?: (info: BuildLogInfo | null) => void
	): Promise<{ info: BuildLogInfo | null; decoded: number } | null> {
		this.#streaming++;
		try {
			return await this.#streamOnce(b, part, spec, onInfo);
		} finally {
			this.#streaming--;
			this.#maybeLoaded();
		}
	}

	async #streamOnce(
		b: Extract<LogBackend, { kind: 'grpc' }>,
		part: 'head' | 'tail' | 'more',
		spec: { offset: number; follow: boolean; limit: number; tail: number },
		onInfo?: (info: BuildLogInfo | null) => void
	): Promise<{ info: BuildLogInfo | null; decoded: number } | null> {
		const t = this.target;
		let offset = spec.offset;
		let limit = spec.limit;
		let tail = spec.tail;
		let backoff = 500;
		let misroutes = 0;
		let first: BuildLogInfo | null | undefined;
		let total = 0;
		let kind = part;
		/** The last call the worker heard of, whose part a 'more' call goes on with. */
		let last: number | undefined;
		for (;;) {
			if (this.#stopped) return null;
			const ctl = new AbortController();
			this.#active.add(ctl);
			const call = ++this.#calls;
			const req = this.#request({ offset, follow: spec.follow, limit, tail });
			let lc: LogCall | null = null;
			let started = false;
			let info: BuildLogInfo | null = null;
			// A failed build's head, held while its tail loads.
			const held: Uint8Array[] = [];
			const holds = () => kind === 'head' && part === 'head' && this.#headWait !== null;
			const release = () => {
				for (const data of held.splice(0)) this.#post({ t: 'zstd', call, data }, [data.buffer]);
			};
			try {
				lc = b.open(req, ctl.signal);
				for await (const chunk of lc) {
					if (!started) {
						started = true;
						info = chunk.info ?? null;
						const node = await Promise.race([lc.node, Promise.resolve(null)]);
						if (this.#otherNode(node, misroutes)) {
							misroutes++;
							throw new Misrouted();
						}
						if (node) this.node = node;
						if (first === undefined) {
							first = info;
							onInfo?.(info);
						} else if (info && first && info.source !== first.source) {
							// The answer comes from another source than the first call's, so start over at 0.
							this.#post({ t: 'restart' });
							first = info;
							kind = 'head';
							offset = 0;
							total = 0;
							limit = spec.limit;
							// This answer starts where the last call stopped, so ask again from 0.
							if (info.offset > 0n) throw new StartOver();
						} else if (!info && kind === 'more') {
							// An old server ignored the offset: start over.
							this.#post({ t: 'restart' });
							kind = 'head';
						}
						this.#applyInfo(info);
						this.#post({
							t: 'call',
							call,
							part: kind,
							// A failed build's end shows first; its head goes in front when it ends.
							tailFirst: kind === 'tail' && t.state === 'failed',
							of: kind === 'more' ? last : undefined,
							// No limit means the whole log, which past 16 MiB the worker keeps as head and ring.
							whole: kind === 'head' && limit === 0,
							info: info
								? {
										offset: Number(info.offset),
										firstLine: Number(info.firstLine),
										size: Number(info.size)
									}
								: null
						});
						last = call;
						this.problem = null;
					}
					if (chunk.data.length) {
						const data = chunk.data.slice();
						if (holds()) held.push(data);
						else this.#post({ t: 'zstd', call, data }, [data.buffer]);
					}
					if (chunk.ended) this.following = false;
				}
				if (!started) {
					// An answer without a message is an empty log.
					this.#post({
						t: 'call',
						call,
						part: kind,
						info: null,
						of: kind === 'more' ? last : undefined
					});
				}
				if (holds()) await this.#headWait;
				release();
				this.#post({ t: 'end', call, complete: true });
				total += await this.#decodedBy(call);
				if (spec.follow) {
					this.following = false;
					this.#settles = true;
				}
				return { info: first ?? null, decoded: total };
			} catch (e) {
				if (e instanceof StartOver) continue;
				release();
				if (started) this.#post({ t: 'end', call, complete: false });
				const decoded = started ? await this.#decodedBy(call) : 0;
				if (this.#stopped) return null;
				if (ctl.signal.aborted && spec.follow) {
					// Hidden for 10 s, so resume from here when the page shows again.
					this.#followFrom = {
						offset: (info ? Number(info.offset) : offset) + decoded,
						source: info?.source ?? 0
					};
					return null;
				}
				const node = lc ? await Promise.race([lc.node, Promise.resolve(null)]) : null;
				if (
					e instanceof Misrouted ||
					(ConnectError.from(e).code === Code.NotFound && this.#otherNode(node, misroutes))
				) {
					if (!(e instanceof Misrouted)) misroutes++;
					await this.#sleep(backoff);
					backoff = Math.min(backoff * 2, 10_000);
					continue;
				}
				const err = ConnectError.from(e);
				const next = await this.#problemOf(err, lc, info, started);
				if (next === 'stop') return null;
				// A store that cannot be read is down for longer than a network blip, so wait longer.
				const cap = next === 'retry-slow' ? UNREADABLE_MAX_MS : 10_000;
				if (next === 'retry-slow') backoff = Math.max(backoff, UNREADABLE_FIRST_MS);
				// After a break, go on from where it stopped, with backoff.
				if (started && info) {
					offset = Number(info.offset) + decoded;
					total += decoded;
					if (limit) limit = Math.max(1, limit - decoded);
					tail = 0;
					kind = 'more';
				} else if (started && !info) {
					// From an old server, read the whole log again from 0.
					this.#post({ t: 'restart' });
					kind = 'head';
					offset = 0;
				}
				await this.#sleep(backoff);
				backoff = Math.min(backoff * 2, cap);
			} finally {
				this.#active.delete(ctl);
			}
		}
	}

	/** Another node answered for a builder in the farm. That is EDS lag, retried up to 4 times. */
	#otherNode(node: string | null, tries: number): boolean {
		const w = this.target.worker;
		return !!node && !!w && node !== w && this.#inFarm(w) && tries < 4;
	}

	/** A request for the target's log with `spec`'s offset, follow, limit and tail. */
	#request(spec: { offset: number; follow: boolean; limit: number; tail: number }): LogRequest {
		const t = this.target;
		return {
			drvPath: t.drvPath,
			worker: t.worker,
			system: t.system,
			assignId: t.assignId,
			...spec
		};
	}

	#applyInfo(info: BuildLogInfo | null) {
		const t = this.target;
		if (!info) {
			this.source = this.source ?? 'kept';
			return;
		}
		this.source =
			info.source === BuildLogInfo_Source.LIVE
				? 'live'
				: info.source === BuildLogInfo_Source.STORE
					? 'store'
					: info.source === BuildLogInfo_Source.CACHE
						? 'cache'
						: 'kept';
		if (info.size > 0n) this.size = Number(info.size);
		if (info.startedMs > 0n) this.started = true;
		if (this.source === 'live') {
			this.started = info.startedMs > 0n;
			return;
		}
		// A later build of the derivation wrote this log.
		const id = Number(info.assignId);
		const modified = Number(info.modifiedMs);
		if (id && t.assignId && id !== t.assignId) this.rebuiltAt = modified || Date.now();
		else if (!id && t.finishedMs !== null && modified > t.finishedMs + 60_000)
			this.rebuiltAt = modified;
		else if (!id) this.maybeReplaced = true;
	}

	/** What an error means for the viewer: a sentence and a stop, or a retry. */
	async #problemOf(
		err: ConnectError,
		lc: LogCall | null,
		info: BuildLogInfo | null,
		started: boolean
	): Promise<'stop' | 'retry' | 'retry-slow'> {
		const t = this.target;
		const http = (err.cause as { status?: number } | undefined)?.status;
		switch (err.code) {
			case Code.NotFound: {
				const rb = lc ? await Promise.race([lc.rebuilding, Promise.resolve(null)]) : null;
				if (rb) this.problem = { kind: 'rebuilding', assignId: rb };
				else this.problem = { kind: this.#inFarm(t.worker) ? 'not-found' : 'left' };
				this.#done();
				return 'stop';
			}
			case Code.Unimplemented:
				this.problem = { kind: http === 404 ? 'no-route' : 'none' };
				this.#done();
				return 'stop';
			case Code.PermissionDenied:
				this.problem = { kind: 'denied' };
				this.#done();
				return 'stop';
			case Code.DataLoss:
				// An old builder cannot follow, because a running build's .bz2 is not complete.
				if (t.running && !info) this.problem = { kind: 'no-follow' };
				else this.problem = { kind: endsEarly(t.state, started) ? 'ended-early' : 'damaged' };
				this.#done();
				return 'stop';
			case Code.ResourceExhausted:
				this.problem = { kind: 'busy' };
				return 'retry';
			case Code.Canceled:
				return 'stop';
			case Code.Unavailable:
				// The builder's own answer, from nix_remote.proto, when a log store or cache it reads failed.
				if (/cannot be read/.test(err.rawMessage)) {
					this.problem = { kind: 'unreadable' };
					return 'retry-slow';
				}
				this.problem = { kind: 'lost', retryAtMs: Date.now() };
				return 'retry';
			default:
				this.problem = { kind: 'lost', retryAtMs: Date.now() };
				return 'retry';
		}
	}

	/** Nothing more comes. */
	#done() {
		this.following = false;
		this.#settles = true;
		this.loaded = true;
	}

	#startDemo(b: Extract<LogBackend, { kind: 'demo' }>) {
		const t = this.target;
		const plan = b.plan(t.drvPath, t.assignId);
		this.source = 'demo';
		this.node = plan.worker || t.worker;
		this.#post({ t: 'demo', plan });
		if (plan.ending) {
			this.#settles = true;
			this.started = true;
			return;
		}
		this.following = true;
		this.started = plan.startedMs !== null;
		const off = b.subscribe(t.drvPath, plan.assignId, (e) => {
			if (e.kind === 'tick') this.#post({ t: 'demo-tick', nowMs: e.nowMs });
			else if (e.kind === 'started') {
				this.started = true;
				this.#post({ t: 'demo-started', startedMs: e.startedMs });
			} else {
				this.following = false;
				this.#settles = true;
				this.ended = { ending: e.ending, atMs: e.nowMs };
				this.#post({ t: 'demo-ended', ending: e.ending, nowMs: e.nowMs });
			}
		});
		this.#cleanups.push(off);
	}

	// ------------------------------------------------------------- queries

	setLayout(cols: number, wrap: boolean) {
		this.#post({ t: 'layout', cols, wrap });
	}

	rows(from: number, to: number): Promise<{ rows: readonly RenderedRow[]; total: number }> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'rows' }>>({ t: 'rows', req, from, to });
	}

	fold(ids: number[], open: boolean, anchor: number | null): Promise<number | null> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'folded' }>>({
			t: 'fold',
			req,
			ids,
			open,
			anchor
		}).then((r) => r.anchorRow);
	}

	foldAll(open: boolean, anchor: number | null): Promise<number | null> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'folded' }>>({
			t: 'foldAll',
			req,
			open,
			anchor
		}).then((r) => r.anchorRow);
	}

	/** Open the groups that hold a line. The row it is on, 'gap' when it is in the part not shown. */
	reveal(line: number): Promise<number | 'gap' | null> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'revealed' }>>({ t: 'reveal', req, line }).then((r) =>
			r.gap ? 'gap' : r.row
		);
	}

	setSearch(text: string, caseSensitive: boolean, onlyMatching: boolean) {
		this.#post({ t: 'search', text, caseSensitive, onlyMatching });
	}

	gotoHit(index: number): Promise<{ row: number | null; line: number | null }> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'hit' }>>({ t: 'hit', req, index });
	}

	range(from: number, to: number): Promise<string> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'range' }>>({ t: 'range', req, from, to }).then(
			(r) => r.text
		);
	}

	blob(kind: 'raw' | 'text'): Promise<Blob> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'blob' }>>({ t: 'blob', req, kind }).then(
			(r) => r.blob
		);
	}

	/**
	 * The whole log as the builder sends it, compressed. It makes one more call
	 * from the start with no limit and keeps its data as it arrives, never decoded.
	 * For a log larger than what the viewer keeps, as "Raw download" offers it.
	 * null when the source has no stream to give, or the call failed.
	 */
	async zstdBlob(): Promise<Blob | null> {
		const b = this.backend;
		if (b.kind !== 'grpc' || this.#stopped) return null;
		const ctl = new AbortController();
		this.#active.add(ctl);
		const parts: Uint8Array[] = [];
		try {
			const call = b.open(
				this.#request({ offset: 0, follow: false, limit: 0, tail: 0 }),
				ctl.signal
			);
			for await (const chunk of call) if (chunk.data.length) parts.push(chunk.data.slice());
		} catch {
			return null;
		} finally {
			this.#active.delete(ctl);
		}
		return new Blob(parts as BlobPart[], { type: 'application/zstd' });
	}

	lineText(slot: number): Promise<string> {
		const req = ++this.#req;
		return this.#ask<Extract<FromWorker, { t: 'line' }>>({ t: 'line', req, slot }).then(
			(r) => r.text
		);
	}

	/** Close every call and the worker. */
	stop() {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const c of this.#active) c.abort();
		this.#wake?.();
		for (const c of this.#cleanups) c();
		this.#worker.terminate();
		this.#pending.clear();
	}
}
