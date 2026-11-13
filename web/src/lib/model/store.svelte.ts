// FarmStore: the reducer's state, published to the UI through $state.raw at
// most once per animation frame. Sources write through `sink`; the UI only
// reads. Hidden tabs get no frames, so nothing is published until the tab
// is visible again; the reducer keeps applying events meanwhile.
//
// Only a complete state is shown. From a Reset until its SnapshotDone the
// store keeps the last complete picture, and drill-down queries repeat
// their last answer, even when the stream dies before the snapshot ends.

import { tick } from 'svelte';
import {
	EMPTY_SHAPE,
	FarmReducer,
	type FarmViews,
	type ReducerOptions,
	type TopologyShape
} from './reducer.ts';
import { emptyMap, reconcile, reconcileMap } from './reconcile.ts';
import type {
	BuildQuery,
	BuildRow,
	BuildsView,
	CacheView,
	FinishedBuildView,
	ClientGroupView,
	ConnectionStatus,
	Coverage,
	DrvView,
	EdgeDetailView,
	EdgeView,
	FarmMeta,
	FarmStore,
	PoolView,
	BuilderSubstituterView,
	SchedulerView,
	Topology,
	Totals,
	UpstreamView,
	WorkerView
} from './types.ts';
import { Code, ConnectError } from '@connectrpc/connect';
import type { RecentBuildsFn, RecentBuildsRequest, SourceSink } from '#lib/source/types.ts';

export interface FrameScheduler {
	/** Call `cb` once before the next paint. Returns a cancel function. */
	request(cb: () => void): () => void;
}

type FrameEnv = {
	document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
	requestAnimationFrame: (cb: FrameRequestCallback) => number;
	cancelAnimationFrame: (id: number) => void;
};

/**
 * requestAnimationFrame, except in a hidden tab: there it waits for the
 * tab to become visible, so a returning tab publishes at once.
 */
export function browserFrameScheduler(env: FrameEnv = globalThis): FrameScheduler {
	return {
		request(cb) {
			const doc = env.document;
			if (doc?.hidden) {
				const onChange = () => {
					if (doc.hidden) return;
					doc.removeEventListener('visibilitychange', onChange);
					cb();
				};
				doc.addEventListener('visibilitychange', onChange);
				return () => doc.removeEventListener('visibilitychange', onChange);
			}
			const id = env.requestAnimationFrame(() => cb());
			return () => env.cancelAnimationFrame(id);
		}
	};
}

/**
 * Set globalThis.__farmProfile = true before a store is created to record
 * performance measures: farm:apply (reducer), farm:publish (views and
 * reconcile) and farm:render (Svelte's DOM updates after a publish). Off by
 * default: user timing entries pile up.
 */
function profiling(): boolean {
	return (globalThis as { __farmProfile?: unknown }).__farmProfile === true;
}

export type FarmStoreOptions = {
	reducer?: ReducerOptions;
	frames?: FrameScheduler;
	/** Minimum time between publishes. Default 33 ms (30 per second). */
	minPublishMs?: number;
};

/** Publish at least this often while there is data, so rates decay and windows move. */
const TICK_MS = 500;
/** Initial header totals window. */
const WINDOW_MINUTES = 15;

const EMPTY_TOPOLOGY: Topology = Object.freeze({ version: 0, ...EMPTY_SHAPE });

/** The first history load: the newest of the builds ring, and the failures with their text. */
const HISTORY_BUILDS = 1000;
const HISTORY_FAILURES = 256;
/** A first page that failed is asked again after this, doubling up to the longest, with jitter. */
const HISTORY_RETRY_MS = 2_000;
const HISTORY_RETRY_MAX_MS = 60_000;

/** Rows a reconnect's top-up asks for at a time, since a cut usually covers a few builds. */
const TOP_UP_PAGE = 64;

/** What one RecentBuilds call read. */
type HistoryPage = {
	/** The scheduler instance changed or the call was stopped, so there is nothing more to do. */
	gone: boolean;
	/** A row finished at or before the floor the caller asked to read back to. */
	reachedFloor: boolean;
	/** The ring holds nothing older than the last row sent. */
	complete: boolean;
	oldestMs: number | null;
	/** Why the call failed. */
	error?: unknown;
};

/** One page of the build history: every build, or the failures with their text. */
const historyRequest = (failedOnly: boolean, beforeMs = 0): RecentBuildsRequest => ({
	beforeMs,
	limit: failedOnly ? HISTORY_FAILURES : HISTORY_BUILDS,
	failedOnly,
	withError: failedOnly
});

const EMPTY_BUILDS: BuildsView = Object.freeze({
	rows: [],
	counts: { failed: 0, assigned: 0, built: 0, other: 0 },
	facets: { systems: [], builders: [], clients: [] },
	coverage: {
		sinceMs: null,
		source: 'page',
		complete: false,
		full: false,
		loading: false,
		restartMs: null
	}
});

function queryKey(q: BuildQuery): string {
	return JSON.stringify([
		[...q.states].sort(),
		q.system,
		q.builder,
		q.pool,
		q.client,
		q.q,
		q.withinMs,
		q.sort
	]);
}

/** Drill-down answers kept for the time between a Reset and its SnapshotDone. */
const ANSWERS_KEPT = 16;

const EMPTY_SCHEDULER: SchedulerView = Object.freeze({
	queued: 0,
	unplaceable: 0,
	assigned: 0,
	workersUp: 0,
	clients: 0,
	slots: 0,
	free: 0,
	assignedPerSec: 0,
	queuedPerMin: null,
	systems: []
});

export class ReducerFarmStore implements FarmStore {
	#status = $state.raw<ConnectionStatus>({ kind: 'connecting', attempt: 1 });
	#meta = $state.raw<FarmMeta | null>(null);
	#topology = $state.raw<Topology>(EMPTY_TOPOLOGY);
	// Published maps are replaced, never mutated, so plain read-only maps are right here.
	#workers = $state.raw<ReadonlyMap<string, WorkerView>>(emptyMap());
	#pools = $state.raw<ReadonlyMap<string, PoolView>>(emptyMap());
	#clientGroups = $state.raw<ReadonlyMap<string, ClientGroupView>>(emptyMap());
	#scheduler = $state.raw<SchedulerView>(EMPTY_SCHEDULER);
	#cache = $state.raw<CacheView | null>(null);
	#upstream = $state.raw<UpstreamView | null>(null);
	#edges = $state.raw<ReadonlyMap<string, EdgeView>>(emptyMap());
	#totals = $state.raw<Totals>({
		windowMinutes: WINDOW_MINUTES,
		queued: 0,
		running: 0,
		built: 0,
		failed: 0,
		cached: 0,
		// Nothing is partial before there is data.
		since: null
	});
	#linesSince = $state.raw<Coverage | null>(null);
	#frame = $state.raw(0);

	/** Where a source delivers events and status. */
	readonly sink: SourceSink;

	readonly #reducer: FarmReducer;
	readonly #frames: FrameScheduler;
	readonly #minPublishMs: number;
	readonly #tick: ReturnType<typeof setInterval>;
	#window = WINDOW_MINUTES;
	#cancelFrame: (() => void) | null = null;
	#delay: ReturnType<typeof setTimeout> | undefined = undefined;
	#lastPublish = -Infinity;
	#shape: TopologyShape | null = null;
	#publishedVersion = -1;
	#destroyed = false;
	/** Last complete answer per query, oldest first. A cache, not state. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	readonly #answers = new Map<string, unknown>();
	readonly #profile = profiling();
	/** The source's Events.RecentBuilds, when it has one. */
	#history: RecentBuildsFn | null = null;
	/** History calls running. */
	#loading = 0;
	readonly #historyAbort = new AbortController();
	/** First pages waiting to be asked again. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	readonly #retries = new Set<ReturnType<typeof setTimeout>>();
	/** The top-up after the last reconnect, until the next stream begins. */
	#topUpAbort: AbortController | null = null;
	/** The instance that answered a top-up with UNIMPLEMENTED, and so gets no more. */
	#unimplemented = '';

	constructor(options: FarmStoreOptions = {}) {
		this.#reducer = new FarmReducer(options.reducer);
		this.#frames = options.frames ?? browserFrameScheduler();
		this.#minPublishMs = options.minPublishMs ?? 33;
		this.#tick = setInterval(() => {
			if (this.#reducer.complete) this.#request();
		}, TICK_MS);
		this.sink = {
			beginStream: () => {
				// A top-up still running stops here; the next snapshot's reads back to its cut.
				this.#topUpAbort?.abort();
				this.#topUpAbort = null;
				this.#reducer.beginStream();
			},
			events: (batch) => {
				const t0 = this.#profile ? performance.now() : 0;
				const r = this.#reducer.apply(batch, Date.now());
				if (this.#profile) performance.measure('farm:apply', { start: t0 });
				if (r.ok && r.snapshotDone) this.#topUp();
				this.#request();
				return r;
			},
			status: (s) => {
				if (!this.#destroyed) this.#status = s;
			}
		};
	}

	get status() {
		return this.#status;
	}
	get meta() {
		return this.#meta;
	}
	get topology() {
		return this.#topology;
	}
	get workers() {
		return this.#workers;
	}
	get pools() {
		return this.#pools;
	}
	get clientGroups() {
		return this.#clientGroups;
	}
	get scheduler() {
		return this.#scheduler;
	}
	get cache() {
		return this.#cache;
	}
	get upstream() {
		return this.#upstream;
	}
	get edges() {
		return this.#edges;
	}
	get totals() {
		return this.#totals;
	}
	get linesSince() {
		return this.#linesSince;
	}
	get frame() {
		return this.#frame;
	}

	setWindowMinutes(minutes: number): void {
		if (!(minutes > 0) || minutes === this.#window) return;
		this.#window = minutes;
		this.#request();
	}

	drv(drvPath: string, via?: string): DrvView | undefined {
		return this.#query(`drv\0${drvPath}\0${via ?? ''}`, undefined, () =>
			this.#reducer.drv(drvPath, via)
		);
	}
	edgeDetail(edgeIds: readonly string[], itemsLimit?: number): EdgeDetailView | undefined {
		// The window is part of the key: an answer for 15 minutes never stands in for 60.
		const minutes = this.#window;
		return this.#query(`edge\0${minutes}\0${itemsLimit}\0${edgeIds.join('\0')}`, undefined, () =>
			this.#reducer.edgeDetail(edgeIds, Date.now(), minutes, itemsLimit)
		);
	}
	drvsForWorker(addr: string, limit?: number): DrvView[] {
		return this.#query(`worker\0${addr}\0${limit}`, [], () =>
			this.#reducer.drvsForWorker(addr, limit)
		);
	}
	drvsForClientGroup(group: string, limit?: number): DrvView[] {
		return this.#query(`clients\0${group}\0${limit}`, [], () =>
			this.#reducer.drvsForClientGroup(group, limit)
		);
	}
	clientGroup(group: string): ClientGroupView | undefined {
		return this.#query(`group\0${group}`, undefined, () =>
			this.#reducer.clientGroup(group, Date.now())
		);
	}
	drvsQueued(limit?: number): DrvView[] {
		return this.#query(`queued\0${limit}`, [], () => this.#reducer.drvsQueued(limit));
	}
	drvsForCache(limit?: number): DrvView[] {
		return this.#query(`cache\0${limit}`, [], () => this.#reducer.drvsForCache(limit));
	}
	substitutersOf(addr: string): readonly BuilderSubstituterView[] {
		return this.#query(`subs\0${addr}`, [], () => this.#reducer.substitutersOf(addr, Date.now()));
	}

	/** The source's Events.RecentBuilds, for the build list's history. */
	attachHistory(fn: RecentBuildsFn | undefined): void {
		this.#history = fn ?? null;
	}

	builds(query: BuildQuery): BuildsView {
		const loading = this.#loading > 0;
		return this.#query(`builds\0${queryKey(query)}\0${loading}`, EMPTY_BUILDS, () => {
			const v = this.#reducer.builds(query, Date.now());
			return { ...v, coverage: { ...v.coverage, loading } };
		});
	}

	browserMs(serverMs: number): number {
		return serverMs + this.#reducer.serverOffsetMs;
	}

	build(drvPath: string, assignId: number): BuildRow | undefined {
		return this.#query(`build\0${drvPath}\0${assignId}`, undefined, () =>
			this.#reducer.build(drvPath, assignId)
		);
	}

	ensureHistory(): void {
		if (!this.#history || !this.#reducer.complete || !this.#reducer.startHistory()) return;
		void this.#load(historyRequest(false));
		void this.#load(historyRequest(true));
	}

	loadOlderBuilds(failedOnly: boolean): void {
		const r = this.#reducer;
		const h = r.history;
		if (!this.#history || !r.complete || this.#loading > 0 || !h.served || h.full) return;
		if (failedOnly ? h.failuresComplete : h.complete) return;
		// The scheduler pages strictly before before_ms: one past the oldest row, so
		// rows of that same millisecond come again, and the merge drops repeats.
		const oldest = r.oldestBuildMs(failedOnly);
		if (!oldest) return;
		const beforeMs = oldest + 1;
		void this.#load(historyRequest(failedOnly, beforeMs));
	}

	async finishedBuild(drvPath: string, signal: AbortSignal): Promise<FinishedBuildView | null> {
		const fn = this.#history;
		if (!fn) return null;
		try {
			for await (const batch of fn(
				{ beforeMs: 0, limit: 1, failedOnly: false, withError: true, drvPaths: [drvPath] },
				signal
			)) {
				const f = batch.builds.find((b) => b.drvPath === drvPath);
				if (f) return this.#reducer.finishedBuildOf(f);
			}
		} catch (e) {
			if (signal.aborted) throw e;
			// A scheduler without RecentBuilds, or one that failed: nothing to add.
		}
		return null;
	}

	/**
	 * After a reconnect to the same instance, the newest builds of each ring
	 * that was cut, down to the newest finish the page held before the cut:
	 * usually a few rows. It reads small pages back from now until it reaches
	 * the cut, at most a first page's worth. mergeHistory drops the rows the
	 * page has.
	 */
	#topUp() {
		const fn = this.#history;
		const r = this.#reducer;
		const cut = r.history.cutMs;
		if (!fn || this.#unimplemented === r.instance || (cut.builds === null && cut.failures === null))
			return;
		const ctl = new AbortController();
		this.#topUpAbort = ctl;
		const instance = r.instance;
		const one = async (failedOnly: boolean, floorMs: number) => {
			const most = historyRequest(failedOnly).limit;
			let beforeMs = 0;
			for (let read = 0; read < most; read += TOP_UP_PAGE) {
				const req = { ...historyRequest(failedOnly, beforeMs), limit: TOP_UP_PAGE };
				const page = await this.#read(fn, req, ctl.signal, floorMs);
				if (page.error !== undefined) {
					if (ctl.signal.aborted || this.#destroyed) return;
					// The cut stays for the next reconnect's top-up. After UNIMPLEMENTED there is none.
					if (ConnectError.from(page.error).code === Code.Unimplemented)
						this.#unimplemented = instance;
					else console.warn('recent builds:', page.error);
					return;
				}
				if (page.gone) return;
				if (page.reachedFloor || page.complete || page.oldestMs === null) break;
				// Strictly before, one past the oldest row, so rows of that millisecond come again.
				beforeMs = page.oldestMs + 1;
			}
			// Read back to the cut, or a first page's worth of builds that finished during it.
			if (!ctl.signal.aborted && r.instance === instance) r.closeCut(failedOnly);
		};
		if (cut.builds !== null) void one(false, cut.builds);
		if (cut.failures !== null) void one(true, cut.failures);
	}

	async #load(req: RecentBuildsRequest, tries = 0) {
		const fn = this.#history;
		if (!fn) return;
		const instance = this.#reducer.instance;
		const page = await this.#read(fn, req, this.#historyAbort.signal);
		if (page.error === undefined) return;
		const code = ConnectError.from(page.error).code;
		// UNIMPLEMENTED means an older scheduler. The list then starts when the page connected.
		if (code === Code.Unimplemented || this.#destroyed) return;
		console.warn('recent builds:', page.error);
		// Nothing else asks for a first page again, and without it the list lacks the
		// scheduler's rings. So ask again with backoff, as after the scheduler's cap on
		// calls per caller refused it, but not once the source stopped.
		if (req.beforeMs === 0 && code !== Code.Canceled && this.#reducer.instance === instance) {
			const base = Math.min(HISTORY_RETRY_MAX_MS, HISTORY_RETRY_MS * 2 ** tries);
			const t = setTimeout(
				() => {
					this.#retries.delete(t);
					if (this.#reducer.instance === instance) void this.#load(req, tries + 1);
				},
				base / 2 + (Math.random() * base) / 2
			);
			this.#retries.add(t);
		}
	}

	/**
	 * One RecentBuilds call merged into the reducer, batch by batch, while the
	 * scheduler instance holds. With `floorMs`, it stops after the first batch
	 * that reaches a finish at or before it.
	 */
	async #read(
		fn: RecentBuildsFn,
		req: RecentBuildsRequest,
		signal: AbortSignal,
		floorMs = -Infinity
	): Promise<HistoryPage> {
		const r = this.#reducer;
		const instance = r.instance;
		const page: HistoryPage = { gone: false, reachedFloor: false, complete: false, oldestMs: null };
		this.#loading++;
		this.#request();
		try {
			for await (const batch of fn(req, signal)) {
				// A new scheduler took over: its rings start empty, and this answer is the old one's.
				if (signal.aborted || r.instance !== instance) return { ...page, gone: true };
				r.mergeHistory(batch, req.failedOnly);
				this.#request();
				for (const b of batch.builds) {
					const at = Number(b.finishedMs);
					if (page.oldestMs === null || at < page.oldestMs) page.oldestMs = at;
					if (at <= floorMs) page.reachedFloor = true;
				}
				page.complete = batch.complete;
				if (page.reachedFloor) break;
			}
			return page;
		} catch (error) {
			return { ...page, error };
		} finally {
			this.#loading--;
			this.#request();
		}
	}

	/**
	 * Answer from the reducer while its state is complete, and remember the
	 * answer. Otherwise repeat the last one, or `none` if there is none.
	 */
	#query<T>(key: string, none: T, compute: () => T): T {
		const answers = this.#answers;
		if (!this.#reducer.complete) return answers.has(key) ? (answers.get(key) as T) : none;
		const v = compute();
		answers.delete(key);
		answers.set(key, v);
		if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
		return v;
	}

	destroy(): void {
		this.#destroyed = true;
		this.#historyAbort.abort();
		this.#topUpAbort?.abort();
		for (const t of this.#retries) clearTimeout(t);
		this.#retries.clear();
		this.#cancelFrame?.();
		this.#cancelFrame = null;
		clearTimeout(this.#delay);
		this.#delay = undefined;
		clearInterval(this.#tick);
	}

	#request() {
		if (this.#destroyed || this.#cancelFrame || this.#delay !== undefined) return;
		const wait = this.#lastPublish + this.#minPublishMs - Date.now();
		if (wait > 0) {
			this.#delay = setTimeout(() => {
				this.#delay = undefined;
				this.#request();
			}, wait);
			return;
		}
		this.#cancelFrame = this.#frames.request(() => {
			this.#cancelFrame = null;
			this.#publish();
		});
	}

	#publish() {
		if (!this.#profile) return this.#publishViews();
		const t0 = performance.now();
		this.#publishViews();
		const t1 = performance.now();
		performance.measure('farm:publish', { start: t0, end: t1 });
		void tick().then(() => performance.measure('farm:render', { start: t1 }));
	}

	#publishViews() {
		if (this.#destroyed) return;
		const r = this.#reducer;
		if (!r.complete) return;
		const now = Date.now();
		this.#lastPublish = now;
		const v: FarmViews = r.views(now, this.#window);
		let changed = false;
		const put = <T>(prev: T, next: T, set: (x: T) => void) => {
			const x = reconcile(prev, next);
			if (x !== prev) {
				set(x);
				changed = true;
			}
		};
		put(this.#meta, v.meta, (x) => (this.#meta = x));
		// The reducer hands out a new shape only when the topology changed.
		if (v.topology !== this.#shape) {
			this.#topology = Object.freeze({ version: this.#topology.version + 1, ...v.topology });
			this.#shape = v.topology;
			changed = true;
		}
		const putMap = <V>(
			prev: ReadonlyMap<string, V>,
			next: Map<string, V>,
			set: (x: ReadonlyMap<string, V>) => void
		) => {
			const x = reconcileMap(prev, next);
			if (x !== prev) {
				set(x);
				changed = true;
			}
		};
		putMap(this.#workers, v.workers, (x) => (this.#workers = x));
		putMap(this.#pools, v.pools, (x) => (this.#pools = x));
		putMap(this.#clientGroups, v.clientGroups, (x) => (this.#clientGroups = x));
		putMap(this.#edges, v.edges, (x) => (this.#edges = x));
		put(this.#scheduler, v.scheduler, (x) => (this.#scheduler = x));
		put(this.#cache, v.cache, (x) => (this.#cache = x));
		put(this.#upstream, v.upstream, (x) => (this.#upstream = x));
		put(this.#totals, v.totals, (x) => (this.#totals = x));
		put(this.#linesSince, v.linesSince, (x) => (this.#linesSince = x));
		if (changed || r.version !== this.#publishedVersion) {
			this.#publishedVersion = r.version;
			this.#frame++;
		}
	}
}
