// Pure reducer: WatchEvents into plain Maps, and the views the store
// publishes. No Svelte here.
//
// Every event costs O(1) map work plus O(clients of that drv). The reducer
// updates its indexes by worker, client and client group with each event, so
// nothing rescans the in-flight set per event. views() is O(workers + groups
// + edges + queue keys per distinct builder offer); drill-down queries sort
// only the set they return.

import {
	DrvGone_Outcome,
	DrvGone_Status,
	DrvState_Cause,
	DrvState_Phase,
	WorkerState_DrainReason,
	type ClientState,
	type DrvCached,
	type DrvGone,
	type DrvState,
	type FinishedBuild,
	type RecentBuildsBatch,
	type Reset,
	type Stats,
	type SystemStats,
	type WatchEvent,
	type WorkerState
} from '#lib/gen/events_pb.ts';
import { firstErrorLine } from '#lib/logs/errors.ts';
import { queryBuilds } from './builds.ts';
import { RateMeter } from './rates.ts';
import { Ring } from './ring.ts';
import {
	NO_SUBS,
	ZERO_COUNTERS,
	ZERO_SUBSTITUTER,
	countersFromProto,
	offers,
	priority as schedPriority,
	reduceSubstituterUrl,
	substitutersFromProto,
	type CounterSample,
	type CounterValues,
	type SubstituterCounts
} from './sched.ts';
import {
	BUILDS_KEPT,
	ERRORS_KEPT,
	FAILURES_KEPT,
	OTHER_CLIENTS,
	POOL_CHURN_MINUTES,
	QUEUE_TREND_SAMPLES,
	SCHEDULER_ID,
	UPSTREAM_CARD_ROWS,
	WORKER_LINGER_MS,
	buildKey,
	compareCode,
	compareNatural,
	drvName,
	edgeId,
	parseEdgeId,
	parseNodeId,
	poolNodeId,
	poolOf,
	type BuildQuery,
	type BuildRow,
	type BuildState,
	type BuildStatus,
	type BuildsView,
	type BuilderSubstituterView,
	type FinishedBuildView,
	type CacheView,
	type Coverage,
	type ClientGroupView,
	type DrainReason,
	type DrvPhase,
	type DrvView,
	type EdgeDetailView,
	type EdgeItemView,
	type EdgeRowView,
	type EdgeSeries,
	type EdgeView,
	type FarmMeta,
	type FlowKind,
	type InputSourceView,
	type PoolView,
	type RateUnit,
	type SchedulerView,
	type SubstituterView,
	type SystemQueueView,
	type Topology,
	type Totals,
	type UpstreamView,
	type WorkerView
} from './types.ts';

export type ApplyResult =
	| { ok: true; /** This batch completed a snapshot. */ snapshotDone: boolean }
	/** Seq gap or protocol violation: drop the stream and reconnect. */
	| { ok: false; error: string };

/** idle: waiting for Reset. snapshot: between Reset and SnapshotDone. */
export type StreamPhase = 'idle' | 'snapshot' | 'live';

/**
 * Topology without its version: the store owns versioning. The reducer
 * replaces this object exactly when its content changes.
 */
export type TopologyShape = Omit<Topology, 'version'>;

/** The topology before any worker or client group. */
export const EMPTY_SHAPE: TopologyShape = Object.freeze({
	clientGroups: [],
	workers: [],
	workerSystems: [],
	retired: [],
	hasCache: false,
	upstreamWorkers: [],
	upstreamRows: 0
});

/** Everything FarmStore publishes, freshly computed. */
export type FarmViews = {
	meta: FarmMeta | null;
	topology: TopologyShape;
	workers: Map<string, WorkerView>;
	pools: Map<string, PoolView>;
	clientGroups: Map<string, ClientGroupView>;
	scheduler: SchedulerView;
	cache: CacheView | null;
	upstream: UpstreamView | null;
	edges: Map<string, EdgeView>;
	totals: Totals;
	/** Set while the window starts before this page's first live data, so line counts cover less of it. */
	linesSince: Coverage | null;
};

export type ReducerOptions = {
	/** Window of the edge and per-second rates. Default 10 s. */
	rateWindowMs?: number;
	/** Recently finished or cached drvs kept for drill-down. Default 2000. */
	recentLimit?: number;
	/** Recent finished drvs kept per worker. Default 32. */
	workerRecentLimit?: number;
	/** Recent cache hits, publishes and fetches kept. Default 500. */
	cacheRecentLimit?: number;
	/**
	 * Client cards at most, "other clients" included. Default 10, the rows of a
	 * builder column (MAX_ROWS in flow/layout.ts).
	 */
	maxCards?: number;
	/** How often the client group order may change. Default 30 s. */
	rerankMs?: number;
	/** An idle client group stays shown this long. Default 60 s. */
	groupLingerMs?: number;
	/** A disconnected worker stays shown this long. Default 10 min. */
	workerLingerMs?: number;
};

type InputSourceRec = { workerAddr: string; paths: number; narBytes: number };

type DrvRec = {
	path: string;
	/** Parsed on first view; most drvs are never looked at. */
	name: string | null;
	phase: DrvPhase;
	system: string;
	/**
	 * Queue index key: system (the default system when empty) and required
	 * features. Set while queued or unplaceable.
	 */
	sysKey: string;
	features: readonly string[];
	clientIds: readonly number[];
	/** Server clock, 0 when unknown. */
	queuedMs: number;
	assignedMs: number;
	finishedMs: number;
	cpHintMs: number;
	inputs: number;
	inputSources: readonly InputSourceRec[];
	inputsUnknown: number;
	cacheChecked: boolean;
	outputs: readonly Readonly<{ path: string; narSize: number }>[];
	reason: string;
	/** Built and failed: Nix's status, when the builder reported it. */
	status: BuildStatus | null;
	/**
	 * Failed: the builder sent error text. The text itself lives in
	 * #errors, since builder and line rings keep DrvRecs much longer.
	 */
	errorSent: boolean;
	worker: string;
	/** DrvState.assign_id of the current or last assignment, 0 when none. */
	assignId: number;
	/**
	 * Assigned only, as the builder last reported them (DrvState fields 17
	 * to 19). '' and 0 until then. Builder clock, which the page treats as
	 * the scheduler's.
	 */
	buildPhase: string;
	buildPhaseStartedMs: number;
	buildStartedMs: number;
	/** Fixed once the drv left the scheduler. */
	identities: readonly string[] | null;
	view: DrvView | null;
	viewOffset: number;
};

/** A build that finished on a builder, in the build list's rings. Server clock, 0 when unknown. */
type BuildRec = {
	key: string;
	path: string;
	system: string;
	worker: string;
	assignId: number;
	state: Exclude<BuildState, 'assigned'>;
	status: BuildStatus | null;
	/** Failed only: the row's error line, found once when the row arrived. */
	errorLine: string | null;
	assignedMs: number;
	startedMs: number;
	finishedMs: number;
	requestedBy: readonly string[];
	from: 'live' | 'history';
	/** The rings that hold it: IN_BUILDS, IN_FAILURES or both. */
	rings: number;
	row: BuildRow | null;
	rowOffset: number;
};

const IN_BUILDS = 1;
const IN_FAILURES = 2;

/** The build list's history from the scheduler, for one scheduler instance. */
type HistoryState = {
	/** The first load ran, or runs. */
	requested: boolean;
	/** The scheduler answered RecentBuilds: its rings are the list's source. */
	served: boolean;
	/** The builds ring holds nothing older than what the page has. */
	complete: boolean;
	/** The failures ring holds nothing older than what the page has. */
	failuresComplete: boolean;
	/** A merge dropped rows it had just added, because the page's rings are full. */
	full: boolean;
	/**
	 * Per ring, the newest finish the page held, server clock, when a stream
	 * to this instance was cut. A snapshot has no DrvGone, so what finished
	 * after it comes only from RecentBuilds. null once a top-up read back to it.
	 */
	cutMs: { builds: number | null; failures: number | null };
};

const freshHistory = (): HistoryState => ({
	requested: false,
	served: false,
	complete: false,
	failuresComplete: false,
	full: false,
	cutMs: { builds: null, failures: null }
});

type WorkerRec = {
	addr: string;
	systems: readonly string[];
	features: readonly string[];
	/** Systems and features as one key: builders with the same offer can take the same drvs. */
	offer: string;
	maxJobs: number;
	up: boolean;
	draining: boolean;
	/** Set while draining. */
	drainReason: DrainReason | null;
	diskFree: number | null;
	diskTotal: number | null;
	minFree: number;
	version: string;
	/** Every URL of its last WorkerState, in its order. */
	listed: readonly string[];
	/** Of those, the upstream ones: not the farm cache, not "other". */
	upstream: readonly string[];
	/** The last cumulative counts per URL, the base for the next deltas. */
	subs: ReadonlyMap<string, SubstituterCounts>;
	/**
	 * Went down while draining, other than for low disk, so it left on
	 * purpose. Cleared when it comes back.
	 */
	retired: boolean;
	/** Browser clock when it went down, or was first seen down, 0 while up. For the linger. */
	goneAt: number;
	/**
	 * Browser clock when this page saw it go down, live. 0 while up, and
	 * when it was down in the first snapshot or went down between streams:
	 * how long it has been offline is then unknown.
	 */
	seenGoneAt: number;
};

/** Line histories: an hour in 30 s buckets, Float32 to halve their size. */
const LINE_HISTORY = { windowMs: 3_600_000, buckets: 120, compact: true };
const LINE_BUCKET_MS = LINE_HISTORY.windowMs / LINE_HISTORY.buckets;

/** Buckets a window of `minutes` reads with recent(): the current one and every whole one. */
function windowBuckets(minutes: number): number {
	return Math.ceil((minutes * 60_000) / LINE_BUCKET_MS) + 1;
}

/** History of the lines of a builder or a pool. */
type LineHist = {
	assign: RateMeter;
	built: RateMeter;
	failed: RateMeter;
	publish: RateMeter;
	fetch: RateMeter;
	/** NAR bytes from upstream substituters. */
	subst: RateMeter;
};

/** Window counts for EdgeView, kept until the bucket, the window or an outcome changes them. */
type WinCounts = {
	bucket: number;
	minutes: number;
	dirty: boolean;
	finished: number;
	failed: number;
};

/** Builds that ended within a window, built or failed, and how many failed. */
type Counts = Readonly<{ finished: number; failed: number }>;

function lineHist(): LineHist {
	return {
		assign: new RateMeter(LINE_HISTORY),
		built: new RateMeter(LINE_HISTORY),
		failed: new RateMeter(LINE_HISTORY),
		publish: new RateMeter(LINE_HISTORY),
		fetch: new RateMeter(LINE_HISTORY),
		subst: new RateMeter(LINE_HISTORY)
	};
}

function winCounts(): WinCounts {
	return { bucket: -1, minutes: 0, dirty: true, finished: 0, failed: 0 };
}

/** Traffic history of a worker; survives a reconnect to the same scheduler. */
type WorkerTraffic = {
	assign: RateMeter;
	publish: RateMeter;
	fetch: RateMeter;
	/** NAR bytes from upstream substituters, all of them together. */
	subst: RateMeter;
	/** The same per URL, made on a URL's first traffic. The farm cache is left out. */
	byUrl: Map<string, RateMeter>;
	built: RateMeter;
	failed: RateMeter;
	recent: DrvRec[];
	hist: LineHist;
	win: WinCounts;
};

/**
 * A pool's own line history. Its lines read this, not the sum of their
 * members, so failures stay after a builder that left is deleted.
 */
type PoolLine = { hist: LineHist; win: WinCounts };

/** Counts `n` on a builder's line, its history and its pool's history. */
function countLine(
	tr: WorkerTraffic,
	pool: PoolLine | undefined,
	kind: keyof LineHist,
	n: number,
	now: number
) {
	tr[kind].add(n, now);
	tr.hist[kind].add(n, now);
	pool?.hist[kind].add(n, now);
}

/** Builders of one native system that connected and disconnected, over POOL_CHURN_MINUTES. */
type Churn = { joined: RateMeter; left: RateMeter };

/** A pool's sums while views() walks the builders. */
type PoolAcc = {
	builders: number;
	up: number;
	draining: number;
	drainingLowDisk: number;
	drainingStopping: number;
	drainingLocalDaemon: number;
	offline: number;
	running: number;
	slots: number;
	/** Builders per distinct offer of systems and features, for features and the queue count. */
	offers: Map<string, { w: WorkerRec; n: number }>;
	assign: number;
	publish: number;
	fetch: number;
	subst: number;
	/** A builder of the pool lists an upstream substituter. */
	upstream: boolean;
};

const CHURN_MS = POOL_CHURN_MINUTES * 60_000;

type ClientRec = { id: number; identity: string; connectedMs: number };

type GroupRec = {
	id: string;
	clients: number;
	/** Number of this group's clients waiting on each in-flight drv. */
	waits: Map<string, number>;
	/** Browser clock when it went idle, 0 while active. */
	idleSince: number;
	wants: RateMeter;
	/** Wants, and the builds it waited on that ended built or failed. */
	hist: { wants: RateMeter; built: RateMeter; failed: RateMeter };
	/**
	 * The last RECENT_WANTS Wants, new waits and cache hits alike, newest
	 * last. Browser clock. Queries drop repeats.
	 */
	recent: { rec: DrvRec; at: number }[];
	win: WinCounts;
};

/** Queued drvs per system and required feature set. */
type SysCount = {
	system: string;
	features: readonly string[];
	queued: number;
	unplaceable: number;
};

const EMPTY_IDS: readonly number[] = Object.freeze([]);
const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const EMPTY_SOURCES: readonly InputSourceRec[] = Object.freeze([]);
const EMPTY_OUTPUTS: DrvRec['outputs'] = Object.freeze([]);
const OFFSET_WINDOW_MS = 60_000;
const HISTORY_KEEP = 90;
/** Wants a client group keeps for its line's latest list. */
const RECENT_WANTS = 32;
/** Cache hits kept for the cache hits line's latest list. */
const HITS_KEPT = 64;
const NO_COUNTS: Counts = Object.freeze({ finished: 0, failed: 0 });
/** The counter that adds up URLs past the scheduler's limits. Not a substituter. */
const OTHER_URL = 'other';

function drainReasonOf(w: WorkerState): DrainReason | null {
	if (!w.draining) return null;
	return w.drainReason === WorkerState_DrainReason.STOPPING
		? 'stopping'
		: w.drainReason === WorkerState_DrainReason.LOW_DISK
			? 'low-disk'
			: w.drainReason === WorkerState_DrainReason.LOCAL_DAEMON
				? 'local-daemon'
				: 'unknown';
}

/**
 * Whether a builder that went down while up left on purpose: it was draining,
 * and not for low disk, which is a fault, not a scale-in.
 */
function leftOnPurpose(w: Pick<WorkerRec, 'draining' | 'drainReason'>): boolean {
	return w.draining && w.drainReason !== 'low-disk';
}

const bytesOrNull = (x: bigint | undefined) => (x === undefined ? null : Number(x));

/** Without repeats, keeping each first occurrence. The same array when it has none. */
function unique(xs: readonly string[]): readonly string[] {
	for (let i = 1; i < xs.length; i++)
		if (xs.lastIndexOf(xs[i], i - 1) >= 0) return [...new Set(xs)];
	return xs;
}

/** Three significant digits: keeps tiny rate changes from replacing views. */
function round3(x: number): number {
	return x > 0 ? Number(x.toPrecision(3)) : 0;
}

function phaseOf(p: DrvState_Phase): DrvPhase {
	return p === DrvState_Phase.ASSIGNED
		? 'assigned'
		: p === DrvState_Phase.UNPLACEABLE
			? 'unplaceable'
			: 'queued';
}

const STATUS: Partial<Record<DrvGone_Status, BuildStatus>> = {
	[DrvGone_Status.BUILT]: 'built',
	[DrvGone_Status.SUBSTITUTED]: 'substituted',
	[DrvGone_Status.ALREADY_VALID]: 'already-valid',
	[DrvGone_Status.PERMANENT_FAILURE]: 'build-failed',
	[DrvGone_Status.INPUT_REJECTED]: 'input-rejected',
	[DrvGone_Status.OUTPUT_REJECTED]: 'output-rejected',
	[DrvGone_Status.TRANSIENT_FAILURE]: 'transient',
	[DrvGone_Status.CACHED_FAILURE]: 'cached-failure',
	[DrvGone_Status.TIMED_OUT]: 'timed-out',
	[DrvGone_Status.MISC_FAILURE]: 'misc',
	[DrvGone_Status.DEPENDENCY_FAILED]: 'dependency-failed',
	[DrvGone_Status.LOG_LIMIT_EXCEEDED]: 'log-limit',
	[DrvGone_Status.NOT_DETERMINISTIC]: 'not-deterministic',
	[DrvGone_Status.NO_SUBSTITUTERS]: 'no-substituters',
	[DrvGone_Status.WORKER_ERROR]: 'worker-error'
};

/** CSI and OSC escapes. The scheduler strips them; text from elsewhere may not be. */
// eslint-disable-next-line no-control-regex -- escapes are what it matches
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** Characters of error text kept: the scheduler cuts at 4096 bytes. */
const ERROR_CHARS = 4096;

/** Error text as the dashboard keeps it: no ANSI escapes, at most the last 4096 characters. */
function cleanError(text: string): string {
	const t = text.replace(ANSI, '');
	return t.length > ERROR_CHARS ? t.slice(-ERROR_CHARS) : t;
}

/** The phase a derivation ends in: the log viewer's "Build finished" says it too. */
export function outcomePhase(o: DrvGone_Outcome): DrvPhase {
	switch (o) {
		case DrvGone_Outcome.BUILT:
			return 'built';
		case DrvGone_Outcome.FAILED:
			return 'failed';
		case DrvGone_Outcome.CANCELLED:
			return 'cancelled';
		default:
			return 'dropped';
	}
}

function newDrv(path: string): DrvRec {
	return {
		path,
		name: null,
		phase: 'queued',
		system: '',
		sysKey: '',
		features: EMPTY_STRINGS,
		clientIds: EMPTY_IDS,
		queuedMs: 0,
		assignedMs: 0,
		finishedMs: 0,
		cpHintMs: 0,
		inputs: 0,
		inputSources: EMPTY_SOURCES,
		inputsUnknown: 0,
		cacheChecked: false,
		outputs: EMPTY_OUTPUTS,
		reason: '',
		status: null,
		errorSent: false,
		worker: '',
		assignId: 0,
		buildPhase: '',
		buildPhaseStartedMs: 0,
		buildStartedMs: 0,
		identities: null,
		view: null,
		viewOffset: 0
	};
}

function priority(d: DrvRec): number {
	return schedPriority(d.cpHintMs, d.clientIds.length, d.queuedMs);
}

/** Input bytes built on other workers than `worker`: what the drv fetches. */
function fetchedBytes(sources: readonly InputSourceRec[], worker: string | null): number {
	let bytes = 0;
	for (const s of sources) if (s.workerAddr !== worker) bytes += s.narBytes;
	return bytes;
}

function outputBytes(outputs: DrvRec['outputs']): number {
	let bytes = 0;
	for (const o of outputs) bytes += o.narSize;
	return bytes;
}

/** Queue order, highest priority first. */
function byPriority(a: DrvRec, b: DrvRec): number {
	return priority(b) - priority(a) || compareCode(a.path, b.path);
}

/** Assigned first, newest assignment first; then the queue by priority. */
function byActivity(a: DrvRec, b: DrvRec): number {
	const aa = a.phase === 'assigned' ? 1 : 0;
	const ba = b.phase === 'assigned' ? 1 : 0;
	if (aa !== ba) return ba - aa;
	if (aa) return b.assignedMs - a.assignedMs || (a.path < b.path ? -1 : 1);
	return byPriority(a, b);
}

export class FarmReducer {
	readonly #o: Required<ReducerOptions>;

	// Stream position.
	#phase: StreamPhase = 'idle';
	#seq = 0n;
	#complete = false;
	#version = 0;

	// Farm state, dropped on every Reset.
	#meta: Omit<FarmMeta, 'servingSinceMs'> & { servingSinceServer: number } = {
		instance: '',
		version: '',
		defaultSystem: '',
		cacheUrl: '',
		cacheSubstituterUrl: '',
		servingSinceServer: 0
	};
	#hasMeta = false;
	readonly #drvs = new Map<string, DrvRec>();
	readonly #queued = new Set<string>();
	/** Assigned drvs per worker addr. */
	readonly #byWorker = new Map<string, Set<DrvRec>>();
	readonly #sys = new Map<string, SysCount>();
	#nQueued = 0;
	/** The queue size once a second, oldest first, for queuedPerMin. */
	#queueSamples: { t: number; n: number }[] = [];
	#nUnplaceable = 0;
	#nAssigned = 0;
	readonly #clients = new Map<number, ClientRec>();
	/**
	 * Builders that reported the start of some build since the page
	 * connected to this instance. A builder without the report never says
	 * when a build starts, so its builds read "Assigned", never "Waiting to start".
	 */
	readonly #reportsStarts = new Set<string>();
	/** The drvs each client id waits on, known clients or not. */
	readonly #follows = new Map<number, Set<string>>();

	// Kept across a reconnect to the same scheduler instance.
	readonly #workers = new Map<string, WorkerRec>();
	readonly #traffic = new Map<string, WorkerTraffic>();
	/** Keyed by pool, by its native system. */
	readonly #churn = new Map<string, Churn>();
	/** Keyed by pool, by its native system. */
	readonly #poolHist = new Map<string, PoolLine>();
	/** Browser clock of the first complete snapshot of this instance, 0 before. */
	#watchingSince = 0;
	/** When the line meters got their first live data, 0 before any. */
	#liveFrom = 0;
	/** The page has seen another scheduler instance before this one. */
	#restarted = false;
	/** Workers up before a Reset to the same instance, to count the changes the snapshot shows. */
	#upBefore: Set<string> | null = null;
	readonly #groups = new Map<string, GroupRec>();
	readonly #identityOf = new Map<number, string>();
	readonly #goneClients: number[] = [];
	readonly #recent: Ring<DrvRec>;
	readonly #recentByPath = new Map<string, DrvRec>();
	readonly #cacheRing: Ring<DrvRec>;
	/** The last HITS_KEPT DrvCached recs. #cacheRing mixes them with publishes and fetches. */
	readonly #hits = new Ring<DrvRec>(HITS_KEPT);
	/**
	 * Error text of the newest ERRORS_KEPT failed builds, oldest first. Keyed
	 * by run, not path: a path that fails again keeps each run's own text.
	 */
	readonly #errors = new Map<DrvRec, string>();
	/**
	 * Builds that finished on a builder, and the failures among them, oldest
	 * finish first, apart from #recent, which cache hits flood. A failed
	 * build is in both, as one record. Kept across a reconnect to the same
	 * instance; a new instance starts empty.
	 */
	#builds: BuildRec[] = [];
	#failures: BuildRec[] = [];
	readonly #buildKeys = new Map<string, BuildRec>();
	#history: HistoryState = freshHistory();
	/** Farm-level line history: cache hits from the counters. */
	#hist!: { hits: RateMeter };
	/**
	 * Coverage: 1 per batch applied while live. Stats arrive every second,
	 * so a bucket at 0 had no live stream, before the page connected or
	 * during a reconnect.
	 */
	#live!: RateMeter;
	#samples: CounterSample[] = [];
	#current: CounterSample | null = null;
	/** Totals of the last Stats since the last Reset, for per-second cache rates. */
	#lastTotals: CounterValues | null = null;
	/** Per-URL counts of the same Stats, for the upstream card's rates. */
	#lastSubs: ReadonlyMap<string, SubstituterCounts> | null = null;
	/** NAR bytes per second per substituter URL, farm cache included, from Stats. */
	#subMeters = new Map<string, RateMeter>();
	/** Set when a WorkerState changed a list, a version or `up`: the upstream counts are stale. */
	#subsDirty = true;
	/** Per URL, connected builders that list it; then the builder counts of UpstreamView. */
	#subCounts: {
		byUrl: Map<string, number>;
		builders: number;
		unreported: number;
	} = { byUrl: new Map(), builders: 0, unreported: 0 };
	#systems: SystemQueueView[] = [];
	#meters!: {
		assign: RateMeter;
		hits: RateMeter;
		misses: RateMeter;
		publish: RateMeter;
		fetch: RateMeter;
	};

	// Clock offset, browser minus server.
	#offset = 0;
	readonly #offsetSamples: { at: number; off: number }[] = [];

	// Topology state.
	#workersDirty = true;
	#workerOrder: string[] = [];
	#workerSystems: string[] = [];
	#retired: string[] = [];
	#upstreamWorkers: string[] = [];
	#upstreamRows = 0;
	#lastPrune = -Infinity;
	#newGroups: string[] = [];
	#shown: string[] = [];
	#hasOther = false;
	#otherIds: string[] = [];
	#lastRank = -Infinity;
	#topology: TopologyShape = EMPTY_SHAPE;

	constructor(options: ReducerOptions = {}) {
		this.#o = {
			rateWindowMs: options.rateWindowMs ?? 10_000,
			recentLimit: options.recentLimit ?? 2000,
			workerRecentLimit: options.workerRecentLimit ?? 32,
			cacheRecentLimit: options.cacheRecentLimit ?? 500,
			maxCards: options.maxCards ?? 10,
			rerankMs: options.rerankMs ?? 30_000,
			groupLingerMs: options.groupLingerMs ?? 60_000,
			workerLingerMs: options.workerLingerMs ?? WORKER_LINGER_MS
		};
		this.#recent = new Ring(this.#o.recentLimit);
		this.#cacheRing = new Ring(this.#o.cacheRecentLimit);
		this.#resetMeters();
	}

	get phase(): StreamPhase {
		return this.#phase;
	}

	/**
	 * True from SnapshotDone to the next Reset: the state is a complete
	 * snapshot plus the deltas after it. Views and queries mean something
	 * only then. A stream that dies mid-snapshot leaves it false.
	 */
	get complete(): boolean {
		return this.#complete;
	}

	/** Bumped by every applied batch. */
	get version(): number {
		return this.#version;
	}

	/** Browser clock minus scheduler clock, ms. */
	get serverOffsetMs(): number {
		return this.#offset;
	}

	/** Sizes of the internal indexes, for tests and debugging. */
	counts() {
		return {
			drvs: this.#drvs.size,
			queued: this.#nQueued,
			unplaceable: this.#nUnplaceable,
			assigned: this.#nAssigned,
			clients: this.#clients.size,
			workers: this.#workers.size,
			groups: this.#groups.size,
			follows: this.#follows.size,
			recent: this.#recentByPath.size
		};
	}

	/** A new stream starts: its first event must be a Reset. */
	beginStream(): void {
		this.#phase = 'idle';
	}

	apply(events: readonly WatchEvent[], now: number): ApplyResult {
		let snapshotDone = false;
		let maxTime = 0;
		try {
			for (const ev of events) {
				const t = Number(ev.timeMs);
				if (t > maxTime) maxTime = t;
				const e = ev.event;
				if (e.case === 'reset') {
					this.#reset(ev.seq, e.value, now);
					continue;
				}
				if (this.#phase === 'idle') return this.#fail('the stream did not start with Reset');
				if (this.#phase === 'snapshot') {
					if (ev.seq !== this.#seq)
						return this.#fail(`snapshot event has seq ${ev.seq}, expected ${this.#seq}`);
				} else {
					if (ev.seq !== this.#seq + 1n)
						return this.#fail(`seq jumped from ${this.#seq} to ${ev.seq}`);
					this.#seq = ev.seq;
				}
				const live = this.#phase === 'live';
				switch (e.case) {
					case 'snapshotDone':
						if (!live) {
							this.#phase = 'live';
							this.#complete = true;
							snapshotDone = true;
							this.#finishSnapshot(now);
						}
						break;
					case 'worker':
						this.#worker(e.value, live, now);
						break;
					case 'client':
						this.#client(e.value, now);
						break;
					case 'clientGone':
						this.#clientGone(Number(e.value.id), now);
						break;
					case 'drv':
						this.#drv(e.value, live, now);
						break;
					case 'drvGone':
						this.#drvGone(e.value, t, live, now);
						break;
					case 'cached':
						this.#cached(e.value, t, live, now);
						break;
					case 'stats':
						this.#stats(e.value, t, live, now);
						break;
					default:
						// Skip an unknown oneof from a newer server. Its seq still counts.
						break;
				}
			}
		} finally {
			if (maxTime > 0) this.#sampleOffset(now - maxTime, now);
			if (this.#phase === 'live') {
				this.#live.add(1, now);
				if (!this.#liveFrom) this.#liveFrom = now;
			}
			this.#version++;
		}
		return { ok: true, snapshotDone };
	}

	#fail(error: string): ApplyResult {
		this.#phase = 'idle';
		return { ok: false, error };
	}

	// ------------------------------------------------------------- handlers

	#reset(seq: bigint, r: Reset, now: number) {
		const same = this.#hasMeta && this.#meta.instance === r.instance;
		if (this.#hasMeta && !same) this.#restarted = true;
		// A new instance has a queue of its own. The same one keeps its trend:
		// views sample only complete snapshots, so the recount here never shows.
		if (!same) this.#queueSamples = [];
		this.#complete = false;
		this.#lastTotals = null;
		this.#lastSubs = null;
		this.#drvs.clear();
		this.#queued.clear();
		this.#byWorker.clear();
		this.#sys.clear();
		this.#nQueued = this.#nUnplaceable = this.#nAssigned = 0;
		this.#clients.clear();
		this.#follows.clear();
		if (same) {
			// The snapshot lists connected workers only; the rest went away.
			// Only after a complete snapshot, and a Reset that interrupts a
			// snapshot keeps the first set.
			if (this.#watchingSince && !this.#upBefore) {
				this.#upBefore = new Set();
				for (const w of this.#workers.values()) if (w.up) this.#upBefore.add(w.addr);
			}
			for (const w of this.#workers.values()) {
				// A builder that was draining and is missing from the snapshot left
				// on purpose; one that is in it comes back up below.
				if (w.up) {
					w.goneAt = now;
					// Some time since the last stream: not a time to show.
					w.seenGoneAt = 0;
					w.retired = leftOnPurpose(w);
				}
				w.up = false;
				w.draining = false;
				w.drainReason = null;
			}
			this.#workersDirty = true;
			for (const g of this.#groups.values()) {
				g.clients = 0;
				g.waits.clear();
				if (!g.idleSince) g.idleSince = now;
			}
			// The snapshot has no DrvGone. Builds that finished while the stream was
			// down come from RecentBuilds, back to the newest finish the page holds.
			// A cut that no top-up read back to yet keeps its older time.
			const h = this.#history;
			if (h.served) {
				h.cutMs.builds = Math.min(h.cutMs.builds ?? Infinity, this.#newestBuildMs(false));
				h.cutMs.failures = Math.min(h.cutMs.failures ?? Infinity, this.#newestBuildMs(true));
			}
		} else {
			this.#workers.clear();
			this.#traffic.clear();
			this.#churn.clear();
			this.#poolHist.clear();
			this.#watchingSince = 0;
			this.#upBefore = null;
			this.#groups.clear();
			this.#identityOf.clear();
			this.#goneClients.length = 0;
			this.#recent.clear();
			this.#recentByPath.clear();
			this.#cacheRing.clear();
			this.#hits.clear();
			this.#errors.clear();
			this.#reportsStarts.clear();
			this.#builds = [];
			this.#failures = [];
			this.#buildKeys.clear();
			this.#history = freshHistory();
			this.#systems = [];
			this.#subMeters = new Map();
			this.#resetMeters();
			// The group ranking starts over with the new instance's groups.
			this.#newGroups.length = 0;
			this.#shown = [];
			this.#otherIds = [];
			this.#hasOther = false;
			this.#lastRank = -Infinity;
			// Another process, maybe on another host with another clock.
			this.#offsetSamples.length = 0;
		}
		const cacheSubstituterUrl = reduceSubstituterUrl(r.cacheSubstituterUrl);
		const farmCacheChanged = this.#meta.cacheSubstituterUrl !== cacheSubstituterUrl;
		this.#meta = {
			instance: r.instance,
			version: r.version,
			defaultSystem: r.defaultSystem,
			cacheUrl: r.cacheUrl,
			cacheSubstituterUrl,
			servingSinceServer: Number(r.servingSinceMs)
		};
		this.#hasMeta = true;
		if (farmCacheChanged) {
			// Which URLs count as upstream depends on the farm cache.
			for (const w of this.#workers.values()) w.upstream = this.#upstreamOf(w.listed);
			this.#subsDirty = true;
		}
		this.#samples = r.history
			.map((s) => ({
				t: Number(s.timeMs),
				c: countersFromProto(s.counters),
				subs: substitutersFromProto(s.counters?.substituters)
			}))
			.sort((a, b) => a.t - b.t);
		this.#current = this.#samples.at(-1) ?? null;
		this.#phase = 'snapshot';
		this.#seq = seq;
		this.#workersDirty = true;
		this.#subsDirty = true;
	}

	#finishSnapshot(now: number) {
		// Builders that came or went while the stream was down.
		const before = this.#upBefore;
		this.#upBefore = null;
		if (before) {
			for (const w of this.#workers.values()) {
				if (w.up && !before.has(w.addr)) this.#churnOf(w).joined.add(1, now);
				else if (!w.up && before.has(w.addr)) this.#churnOf(w).left.add(1, now);
			}
		}
		if (!this.#watchingSince) this.#watchingSince = now;
		// Groups whose clients did not come back go idle from here.
		for (const g of this.#groups.values()) {
			if (g.clients > 0 || g.waits.size > 0) g.idleSince = 0;
			else if (!g.idleSince) g.idleSince = now;
		}
		this.#lastRank = -Infinity;
	}

	#worker(w: WorkerState, live: boolean, now: number) {
		// A builder can list a system twice, through extra-platforms and --extra-system.
		const systems = unique(w.systems);
		const features = unique(w.features);
		let rec = this.#workers.get(w.addr);
		const listed = unique(w.substituters.map((x) => reduceSubstituterUrl(x.url)));
		if (!rec) {
			const upstream = this.#upstreamOf(listed);
			rec = {
				addr: w.addr,
				systems,
				features,
				offer: offerKey(systems, features),
				maxJobs: w.maxJobs,
				up: w.up,
				draining: w.draining,
				drainReason: drainReasonOf(w),
				diskFree: bytesOrNull(w.diskFreeBytes),
				diskTotal: bytesOrNull(w.diskTotalBytes),
				minFree: Number(w.minFreeBytes),
				version: w.version,
				listed,
				upstream,
				// The first counts only set the base.
				subs: substitutersFromProto(w.substituters),
				retired: false,
				goneAt: w.up ? 0 : now,
				seenGoneAt: 0
			};
			this.#workers.set(w.addr, rec);
			this.#workersDirty = true;
			this.#subsDirty = true;
			if (live && w.up) this.#churnOf(rec).joined.add(1, now);
			return;
		}
		if ((rec.systems[0] ?? '') !== (systems[0] ?? '')) this.#workersDirty = true;
		// Joins and leaves count in the pool the builder is in afterwards.
		if (live && w.up !== rec.up) {
			const c = this.#churnOf({ systems });
			(w.up ? c.joined : c.left).add(1, now);
		}
		if (!sameStrings(rec.systems, systems) || !sameStrings(rec.features, features))
			rec.offer = offerKey(systems, features);
		rec.systems = systems;
		rec.features = features;
		rec.maxJobs = w.maxJobs;
		if (w.up) rec.goneAt = rec.seenGoneAt = 0;
		else if (rec.up) {
			rec.goneAt = now;
			rec.seenGoneAt = live ? now : 0;
		}
		// Down after draining: taken out on purpose, as an autoscaler does.
		// Low disk is a fault, so that builder keeps its pool cell.
		const retired = w.up ? false : rec.up ? leftOnPurpose(rec) : rec.retired;
		if (retired !== rec.retired) this.#workersDirty = true;
		rec.retired = retired;
		if (rec.version !== w.version || rec.up !== w.up) this.#subsDirty = true;
		rec.up = w.up;
		rec.draining = w.draining;
		rec.drainReason = drainReasonOf(w);
		// A builder keeps its last report while it is down.
		if (w.diskFreeBytes !== undefined) rec.diskFree = Number(w.diskFreeBytes);
		if (w.diskTotalBytes !== undefined) rec.diskTotal = Number(w.diskTotalBytes);
		rec.minFree = Number(w.minFreeBytes);
		rec.version = w.version;
		if (!sameStrings(rec.listed, listed)) {
			rec.listed = listed;
			const upstream = this.#upstreamOf(listed);
			if (!sameStrings(rec.upstream, upstream)) {
				rec.upstream = upstream;
				this.#workersDirty = true;
			}
			this.#subsDirty = true;
		}
		this.#substituted(rec, w, live, now);
	}

	/** A builder's upstream substituters among `listed`: not the farm cache, not "other". */
	#upstreamOf(listed: readonly string[]): readonly string[] {
		const farm = this.#meta.cacheSubstituterUrl;
		let out: string[] | null = null;
		for (let i = 0; i < listed.length; i++) {
			const u = listed[i];
			const keep = u !== OTHER_URL && (farm === '' || u !== farm);
			if (!keep) out ??= listed.slice(0, i);
			else out?.push(u);
		}
		return out ?? (listed.length ? listed : EMPTY_STRINGS);
	}

	/**
	 * Substituter counts are cumulative: a live WorkerState adds what grew
	 * since the last one to the builder's lines. A snapshot event, a builder
	 * seen for the first time, and counts that went down, as in a new term,
	 * only set the base.
	 */
	#substituted(rec: WorkerRec, w: WorkerState, live: boolean, now: number) {
		if (w.substituters.length === 0 && rec.subs.size === 0) return;
		const next = substitutersFromProto(w.substituters);
		const old = rec.subs;
		rec.subs = next;
		if (!live) return;
		const farm = this.#meta.cacheSubstituterUrl;
		let tr: WorkerTraffic | undefined;
		let pool: PoolLine | undefined;
		for (const [url, c] of next) {
			const before = old.get(url)?.nar ?? 0;
			const delta = c.nar >= before ? c.nar - before : 0;
			if (delta <= 0 || (farm !== '' && url === farm)) continue;
			if (!tr) {
				tr = this.#trafficOf(rec.addr);
				pool = this.#poolLineOf(rec.addr);
			}
			countLine(tr, pool, 'subst', delta, now);
			let m = tr.byUrl.get(url);
			if (!m) tr.byUrl.set(url, (m = new RateMeter({ windowMs: this.#o.rateWindowMs })));
			m.add(delta, now);
		}
	}

	#client(c: ClientState, now: number) {
		const id = Number(c.id);
		const prev = this.#clients.get(id);
		if (prev) {
			prev.connectedMs = Number(c.connectedMs);
			if (prev.identity === c.identity) return;
			this.#detach(prev, now);
		}
		const rec: ClientRec = { id, identity: c.identity, connectedMs: Number(c.connectedMs) };
		this.#clients.set(id, rec);
		this.#identityOf.set(id, c.identity);
		const g = this.#group(c.identity, now);
		g.clients++;
		g.idleSince = 0;
		const f = this.#follows.get(id);
		if (f) for (const p of f) g.waits.set(p, (g.waits.get(p) ?? 0) + 1);
	}

	#clientGone(id: number, now: number) {
		const rec = this.#clients.get(id);
		if (!rec) return;
		this.#detach(rec, now);
		this.#clients.delete(id);
		this.#follows.delete(id);
		// Keep the identity for drill-down of drvs it waited on, for a while.
		this.#goneClients.push(id);
		if (this.#goneClients.length > 4096) {
			const old = this.#goneClients.shift()!;
			if (!this.#clients.has(old)) this.#identityOf.delete(old);
		}
	}

	#detach(rec: ClientRec, now: number) {
		const g = this.#groups.get(rec.identity);
		if (!g) return;
		g.clients--;
		const f = this.#follows.get(rec.id);
		if (f) for (const p of f) this.#groupDec(g, p);
		this.#maybeIdle(g, now);
	}

	#group(identity: string, now: number): GroupRec {
		let g = this.#groups.get(identity);
		if (!g) {
			g = {
				id: identity,
				clients: 0,
				waits: new Map(),
				idleSince: now,
				wants: new RateMeter({ windowMs: this.#o.rateWindowMs }),
				hist: {
					wants: new RateMeter(LINE_HISTORY),
					built: new RateMeter(LINE_HISTORY),
					failed: new RateMeter(LINE_HISTORY)
				},
				recent: [],
				win: winCounts()
			};
			this.#groups.set(identity, g);
			this.#newGroups.push(identity);
		}
		return g;
	}

	#groupDec(g: GroupRec, path: string) {
		const n = g.waits.get(path);
		if (n === undefined) return;
		if (n <= 1) g.waits.delete(path);
		else g.waits.set(path, n - 1);
	}

	#maybeIdle(g: GroupRec, now: number) {
		if (g.clients <= 0 && g.waits.size === 0 && !g.idleSince) g.idleSince = now;
	}

	#follow(id: number, path: string) {
		let f = this.#follows.get(id);
		if (!f) this.#follows.set(id, (f = new Set()));
		f.add(path);
		const c = this.#clients.get(id);
		if (c) {
			const g = this.#groups.get(c.identity);
			if (g) {
				g.waits.set(path, (g.waits.get(path) ?? 0) + 1);
				g.idleSince = 0;
			}
		}
	}

	#unfollow(id: number, path: string, now: number) {
		const f = this.#follows.get(id);
		if (f) {
			f.delete(path);
			const c = this.#clients.get(id);
			if (!c) {
				if (f.size === 0) this.#follows.delete(id);
				return;
			}
			const g = this.#groups.get(c.identity);
			if (g) {
				this.#groupDec(g, path);
				this.#maybeIdle(g, now);
			}
		}
	}

	/** A Want of `rec` by client `id`: a new wait or a cache hit. */
	#want(id: number, rec: DrvRec, now: number) {
		const c = this.#clients.get(id);
		const identity = c?.identity ?? this.#identityOf.get(id);
		if (identity === undefined) return;
		const g = this.#groups.get(identity);
		if (!g) return;
		g.wants.add(1, now);
		g.hist.wants.add(1, now);
		// Several clients of the group wanting one drv take one slot.
		const recent = g.recent;
		const last = recent[recent.length - 1];
		if (last && last.rec.path === rec.path) {
			last.rec = rec;
			last.at = now;
			return;
		}
		recent.push({ rec, at: now });
		if (recent.length > RECENT_WANTS) recent.shift();
	}

	#indexAdd(
		rec: DrvRec,
		phase: DrvPhase,
		worker: string,
		system: string,
		features: readonly string[]
	) {
		rec.phase = phase;
		rec.worker = worker;
		rec.system = system;
		rec.features = features;
		if (phase === 'assigned') {
			let s = this.#byWorker.get(worker);
			if (!s) this.#byWorker.set(worker, (s = new Set()));
			s.add(rec);
			this.#nAssigned++;
			return;
		}
		const sys = system || this.#meta.defaultSystem;
		const sorted = features.length > 1 ? [...features].sort() : features;
		rec.sysKey = `${sys}\0${sorted.join('\0')}`;
		this.#queued.add(rec.path);
		this.#nQueued++;
		let sc = this.#sys.get(rec.sysKey);
		if (!sc) {
			sc = { system: sys, features: sorted, queued: 0, unplaceable: 0 };
			this.#sys.set(rec.sysKey, sc);
		}
		sc.queued++;
		if (phase === 'unplaceable') {
			sc.unplaceable++;
			this.#nUnplaceable++;
		}
	}

	#indexRemove(rec: DrvRec) {
		if (rec.phase === 'assigned') {
			const s = this.#byWorker.get(rec.worker);
			if (s) {
				s.delete(rec);
				if (s.size === 0) this.#byWorker.delete(rec.worker);
			}
			this.#nAssigned--;
			return;
		}
		this.#queued.delete(rec.path);
		this.#nQueued--;
		const sc = this.#sys.get(rec.sysKey);
		if (sc) {
			sc.queued--;
			if (rec.phase === 'unplaceable') sc.unplaceable--;
		}
		if (rec.phase === 'unplaceable') this.#nUnplaceable--;
	}

	#drv(ds: DrvState, live: boolean, now: number) {
		const phase = phaseOf(ds.phase);
		const worker = phase === 'assigned' ? ds.workerAddr : '';
		let rec = this.#drvs.get(ds.drvPath);
		if (worker && ds.buildStartedMs > 0n) this.#reportsStarts.add(worker);
		// A builder's progress report: only the phase and the start times
		// change, and nothing is counted.
		if (
			ds.cause === DrvState_Cause.PROGRESS &&
			rec?.phase === 'assigned' &&
			rec.worker === worker
		) {
			this.#progress(rec, ds);
			return;
		}
		let oldIds = EMPTY_IDS;
		if (!rec) {
			rec = newDrv(ds.drvPath);
			this.#drvs.set(rec.path, rec);
			this.#indexAdd(rec, phase, worker, ds.system, ds.features);
		} else {
			oldIds = rec.clientIds;
			if (
				rec.phase !== phase ||
				rec.worker !== worker ||
				rec.system !== ds.system ||
				!sameStrings(rec.features, ds.features)
			) {
				this.#indexRemove(rec);
				this.#indexAdd(rec, phase, worker, ds.system, ds.features);
			}
		}
		rec.queuedMs = Number(ds.queuedMs);
		rec.cpHintMs = Number(ds.cpHintMs);
		rec.inputs = ds.inputs;
		rec.cacheChecked = ds.cacheChecked;
		rec.reason = ds.reason;
		rec.view = null;
		this.#progress(rec, ds);
		if (phase === 'assigned') {
			rec.assignId = Number(ds.assignId);
			rec.assignedMs = Number(ds.assignedMs);
			rec.inputSources = ds.inputSources.map((s) => ({
				workerAddr: s.workerAddr,
				paths: s.paths,
				narBytes: Number(s.narBytes)
			}));
			rec.inputsUnknown = ds.inputsUnknown;
		} else {
			rec.assignedMs = 0;
			rec.inputSources = EMPTY_SOURCES;
			rec.inputsUnknown = 0;
		}

		// Followers: diff old and new ids. Lists are short, so O(n*m) is fine.
		const ids = ds.clientIds;
		let newIds: readonly number[];
		if (ids.length === oldIds.length && ids.every((v, i) => Number(v) === oldIds[i])) {
			newIds = oldIds;
		} else {
			const next = ids.map(Number);
			newIds = next;
			for (const id of oldIds) if (!next.includes(id)) this.#unfollow(id, rec.path, now);
			for (const id of next) {
				if (oldIds.includes(id)) continue;
				this.#follow(id, rec.path);
				if (live && (ds.cause === DrvState_Cause.WANTED || ds.cause === DrvState_Cause.FOLLOWERS))
					this.#want(id, rec, now);
			}
		}
		rec.clientIds = newIds;

		if (!live) return;
		if (ds.cause === DrvState_Cause.ASSIGNED && worker) {
			const tr = this.#trafficOf(worker);
			const pool = this.#poolLineOf(worker);
			countLine(tr, pool, 'assign', 1, now);
			this.#meters.assign.add(1, now);
			const bytes = fetchedBytes(rec.inputSources, worker);
			if (bytes > 0) {
				countLine(tr, pool, 'fetch', bytes, now);
				this.#meters.fetch.add(bytes, now);
				this.#cacheRing.push(rec);
			}
		}
	}

	/** DrvState fields 17 to 19, which only an assigned drv has. */
	#progress(rec: DrvRec, ds: DrvState) {
		const assigned = ds.phase === DrvState_Phase.ASSIGNED;
		rec.buildPhase = assigned ? ds.buildPhase : '';
		rec.buildStartedMs = assigned ? Number(ds.buildStartedMs) : 0;
		rec.buildPhaseStartedMs = assigned ? Number(ds.buildPhaseStartedMs) : 0;
		rec.view = null;
	}

	#drvGone(g: DrvGone, t: number, live: boolean, now: number) {
		let rec = this.#drvs.get(g.drvPath);
		let idents = EMPTY_STRINGS;
		if (rec) {
			this.#indexRemove(rec);
			this.#drvs.delete(rec.path);
			idents = this.#identities(rec.clientIds);
			for (const id of rec.clientIds) this.#unfollow(id, rec.path, now);
			rec.identities = idents;
		} else {
			rec = newDrv(g.drvPath);
			rec.identities = EMPTY_STRINGS;
		}
		const built = g.outcome === DrvGone_Outcome.BUILT;
		const failed = g.outcome === DrvGone_Outcome.FAILED;
		rec.phase = outcomePhase(g.outcome);
		rec.finishedMs = t;
		if (g.workerAddr) rec.worker = g.workerAddr;
		rec.outputs = built
			? g.outputs.map((o) => ({ path: o.path, narSize: Number(o.narSize) }))
			: EMPTY_OUTPUTS;
		rec.status = built || failed ? (STATUS[g.status] ?? null) : null;
		rec.errorSent = failed && g.error !== '';
		if (rec.errorSent) {
			this.#errors.set(rec, cleanError(g.error));
			if (this.#errors.size > ERRORS_KEPT) this.#errors.delete(this.#errors.keys().next().value!);
		}
		rec.view = null;
		// Every group still waiting counts the build once: #identities drops
		// repeats, so two streams of one identity count it once.
		if (live && (built || failed)) {
			for (const id of idents) {
				const gr = this.#groups.get(id);
				if (!gr) continue;
				(built ? gr.hist.built : gr.hist.failed).add(1, now);
				gr.win.dirty = true;
			}
		}
		const again = this.#recentByPath.has(rec.path);
		this.#pushRecent(rec);
		if (!rec.worker) return;
		this.#addBuild(rec, g);
		const tr = this.#trafficOf(rec.worker);
		// Keep the newest outcome only: a drv retried on the same builder ends
		// twice. drvsForWorker also skips repeats, for ones this check misses.
		if (again) {
			const recent = tr.recent;
			for (let i = recent.length - 1; i >= 0; i--) {
				if (recent[i].path !== rec.path) continue;
				recent.splice(i, 1);
				break;
			}
		}
		tr.recent.push(rec);
		if (tr.recent.length > this.#o.workerRecentLimit) tr.recent.shift();
		if (!live || !(built || failed)) return;
		const pool = this.#poolLineOf(rec.worker);
		if (built) {
			countLine(tr, pool, 'built', 1, now);
			const bytes = outputBytes(rec.outputs);
			if (bytes > 0) {
				countLine(tr, pool, 'publish', bytes, now);
				this.#meters.publish.add(bytes, now);
				this.#cacheRing.push(rec);
			}
		} else {
			countLine(tr, pool, 'failed', 1, now);
		}
		tr.win.dirty = true;
		if (pool) pool.win.dirty = true;
	}

	#cached(c: DrvCached, t: number, live: boolean, now: number) {
		const id = Number(c.clientId);
		const rec = newDrv(c.drvPath);
		rec.phase = 'cached';
		rec.cacheChecked = true;
		rec.system = rec.sysKey = c.system;
		rec.clientIds = [id];
		rec.identities = this.#identities(rec.clientIds);
		rec.queuedMs = rec.finishedMs = t;
		this.#pushRecent(rec);
		this.#cacheRing.push(rec);
		this.#hits.push(rec);
		if (live) this.#want(id, rec, now);
	}

	#stats(s: Stats, t: number, live: boolean, now: number) {
		const cur: CounterSample = {
			t,
			c: countersFromProto(s.totals),
			subs: substitutersFromProto(s.totals?.substituters)
		};
		this.#current = cur;
		// Cache hits and misses per second come from the counters, because the
		// events do not show every miss: a second Want for a queued drv is a
		// FOLLOWERS update. The first Stats after a Reset only sets the base.
		const prev = this.#lastTotals;
		this.#lastTotals = cur.c;
		if (live && prev) {
			const hits = cur.c.cacheHits - prev.cacheHits;
			const misses = cur.c.cacheMisses - prev.cacheMisses;
			if (hits > 0) {
				this.#meters.hits.add(hits, now);
				this.#hist.hits.add(hits, now);
			}
			if (misses > 0) this.#meters.misses.add(misses, now);
		}
		const prevSubs = this.#lastSubs;
		this.#lastSubs = cur.subs;
		if (live && prevSubs) {
			for (const [url, c] of cur.subs) {
				const d = c.nar - (prevSubs.get(url)?.nar ?? 0);
				if (d <= 0) continue;
				let m = this.#subMeters.get(url);
				if (!m) this.#subMeters.set(url, (m = new RateMeter({ windowMs: this.#o.rateWindowMs })));
				m.add(d, now);
			}
		}
		const last = this.#samples.at(-1);
		if (!last || t - last.t >= 60_000) {
			this.#samples.push(cur);
			if (this.#samples.length > HISTORY_KEEP) this.#samples.shift();
		}
		this.#systems = this.#queueRows(s.systems);
	}

	/**
	 * The scheduler panel's queue table. Stats keys queued drvs by what they
	 * need and slots by exactly what builders offer, so its row for
	 * big-parallel alone shows no slots when every builder offers more. A row
	 * here is a need, a system and features: its queue comes from Stats, and
	 * its slots from every builder that can take it, by the rule of "queued
	 * it can take". Each system also gets a row without features, which every
	 * builder of it can take. It makes the rows when Stats arrives, from the
	 * builders as the stream has them then, so both halves of a row describe
	 * the same moment. Rows with unplaceable derivations come first, then the
	 * busiest.
	 */
	#queueRows(stats: readonly SystemStats[]): SystemQueueView[] {
		const needs = new Map<string, { system: string; features: string; q: number; u: number }>();
		for (const x of stats) {
			if (!(x.queued || x.unplaceable || x.running || x.slots)) continue;
			const bare = `${x.system}|`;
			if (!needs.has(bare)) needs.set(bare, { system: x.system, features: '', q: 0, u: 0 });
			if (!x.queued && !x.unplaceable) continue;
			const k = `${x.system}|${x.features}`;
			const n = needs.get(k) ?? { system: x.system, features: x.features, q: 0, u: 0 };
			n.q += x.queued;
			n.u += x.unplaceable;
			needs.set(k, n);
		}
		// Builders mostly share a few offers, so each distinct one is summed once.
		const offered = new Map<
			string,
			{ w: WorkerRec; running: number; slots: number; free: number }
		>();
		for (const w of this.#workers.values()) {
			if (!w.up) continue;
			let o = offered.get(w.offer);
			if (!o) offered.set(w.offer, (o = { w, running: 0, slots: 0, free: 0 }));
			const running = this.#byWorker.get(w.addr)?.size ?? 0;
			o.running += running;
			if (w.draining || w.maxJobs <= 0) continue;
			o.slots += w.maxJobs;
			o.free += Math.max(0, w.maxJobs - running);
		}
		const rows: SystemQueueView[] = [];
		for (const n of needs.values()) {
			const need = n.features ? n.features.split(',') : EMPTY_STRINGS;
			let running = 0;
			let slots = 0;
			let free = 0;
			for (const o of offered.values()) {
				if (!offers(o.w.systems, o.w.features, n.system, need)) continue;
				running += o.running;
				slots += o.slots;
				free += o.free;
			}
			if (!(n.q || n.u || running || slots)) continue;
			rows.push({
				system: n.system,
				features: n.features,
				queued: n.q,
				unplaceable: n.u,
				running,
				slots,
				free
			});
		}
		// Rows with unplaceable work first, since it never clears by itself. The
		// scheduler card folds them into one row (#lib/flow/queue.ts).
		return rows.sort(
			(a, b) =>
				Number(b.unplaceable > 0) - Number(a.unplaceable > 0) ||
				b.queued - a.queued ||
				b.running - a.running ||
				b.slots - a.slots ||
				compareNatural(a.system, b.system) ||
				compareNatural(a.features, b.features)
		);
	}

	// --------------------------------------------------------------- helpers

	#resetMeters() {
		const w = this.#o.rateWindowMs;
		this.#meters = {
			assign: new RateMeter({ windowMs: w }),
			hits: new RateMeter({ windowMs: w }),
			misses: new RateMeter({ windowMs: w }),
			publish: new RateMeter({ windowMs: w }),
			fetch: new RateMeter({ windowMs: w })
		};
		this.#hist = { hits: new RateMeter(LINE_HISTORY) };
		this.#live = new RateMeter(LINE_HISTORY);
		this.#liveFrom = 0;
	}

	#churnOf(w: Pick<WorkerRec, 'systems'>): Churn {
		const pool = poolOf(w.systems[0] ?? '');
		let c = this.#churn.get(pool);
		if (!c) {
			const o = { windowMs: CHURN_MS, buckets: 30 };
			c = { joined: new RateMeter(o), left: new RateMeter(o) };
			this.#churn.set(pool, c);
		}
		return c;
	}

	#trafficOf(addr: string): WorkerTraffic {
		let t = this.#traffic.get(addr);
		if (!t) {
			const w = this.#o.rateWindowMs;
			t = {
				assign: new RateMeter({ windowMs: w }),
				publish: new RateMeter({ windowMs: w }),
				fetch: new RateMeter({ windowMs: w }),
				subst: new RateMeter({ windowMs: w }),
				byUrl: new Map(),
				built: new RateMeter({ windowMs: 60_000, buckets: 30 }),
				failed: new RateMeter({ windowMs: 60_000, buckets: 30 }),
				recent: [],
				hist: lineHist(),
				win: winCounts()
			};
			this.#traffic.set(addr, t);
		}
		return t;
	}

	/**
	 * The history of the pool a builder is in now. A WorkerState comes before
	 * any drv assigned to it, and the reducer never deletes a worker with
	 * drvs, so the record is there; without one nothing is counted.
	 */
	#poolLineOf(addr: string): PoolLine | undefined {
		const w = this.#workers.get(addr);
		if (!w) return undefined;
		const pool = poolOf(w.systems[0] ?? '');
		let p = this.#poolHist.get(pool);
		if (!p) this.#poolHist.set(pool, (p = { hist: lineHist(), win: winCounts() }));
		return p;
	}

	/**
	 * Built and failed within the window of `minutes`, recomputed only when
	 * an outcome arrived, a bucket boundary passed or the window changed.
	 */
	#winCounts(
		h: { built: RateMeter; failed: RateMeter },
		win: WinCounts,
		now: number,
		minutes: number
	): WinCounts {
		const bucket = h.built.bucketIndex(now);
		if (win.dirty || win.bucket !== bucket || win.minutes !== minutes) {
			const k = windowBuckets(minutes);
			win.failed = h.failed.recent(k, now);
			win.finished = h.built.recent(k, now) + win.failed;
			win.bucket = bucket;
			win.minutes = minutes;
			win.dirty = false;
		}
		return win;
	}

	/**
	 * Set while the oldest bucket a window of `minutes` reads had no live
	 * stream. Lines count only live data, so their counts start later than
	 * the window: captions say "Since 23:41".
	 */
	#linesSince(now: number, minutes: number): Coverage | null {
		const k = windowBuckets(minutes);
		if (this.#live.recent(k, now) !== this.#live.recent(k - 1, now)) return null;
		return { fromMs: this.#liveFrom || now, cause: this.#startCause() };
	}

	/** What the page's counts started with: this page going live, or a new scheduler. */
	#startCause(): Coverage['cause'] {
		return this.#restarted ? 'restart' : 'page';
	}

	/** Window counts of a client group's wants line; "other clients" adds up its groups. */
	#groupCounts(id: string, now: number, minutes: number): Counts | undefined {
		if (id !== OTHER_CLIENTS) {
			const g = this.#groups.get(id);
			return g && this.#winCounts(g.hist, g.win, now, minutes);
		}
		let finished = 0;
		let failed = 0;
		for (const oid of this.#otherIds) {
			const g = this.#groups.get(oid);
			if (!g) continue;
			const w = this.#winCounts(g.hist, g.win, now, minutes);
			finished += w.finished;
			failed += w.failed;
		}
		return { finished, failed };
	}

	#identities(ids: readonly number[]): readonly string[] {
		if (ids.length === 0) return EMPTY_STRINGS;
		const out: string[] = [];
		for (const id of ids) {
			const s = this.#identityOf.get(id);
			if (s !== undefined && !out.includes(s)) out.push(s);
		}
		return out;
	}

	#pushRecent(rec: DrvRec) {
		if (this.#recent.cap === 0) return;
		const old = this.#recent.push(rec);
		if (old && this.#recentByPath.get(old.path) === old) this.#recentByPath.delete(old.path);
		this.#recentByPath.set(rec.path, rec);
	}

	#sampleOffset(off: number, now: number) {
		const s = this.#offsetSamples;
		s.push({ at: now, off });
		while (s.length > 1 && (s[0].at < now - OFFSET_WINDOW_MS || s.length > 64)) s.shift();
		// The least delayed event gives the best estimate.
		let min = Infinity;
		for (const x of s) if (x.off < min) min = x.off;
		this.#offset = Math.round(min);
	}

	#toBrowser(serverMs: number): number | null {
		return serverMs > 0 ? serverMs + this.#offset : null;
	}

	// ------------------------------------------------------------- topology

	#updateTopology(now: number): TopologyShape {
		if (this.#workersDirty || now - this.#lastPrune >= 5_000) {
			this.#lastPrune = now;
			for (const w of this.#workers.values()) {
				if (w.up || !w.goneAt || now - w.goneAt < this.#o.workerLingerMs) continue;
				if (this.#byWorker.has(w.addr)) continue;
				this.#workers.delete(w.addr);
				this.#traffic.delete(w.addr);
				this.#workersDirty = true;
				this.#subsDirty = true;
			}
			if (this.#workersDirty) {
				this.#workersDirty = false;
				const sorted = [...this.#workers.values()].sort(
					(a, b) =>
						compareNatural(a.systems[0] ?? '', b.systems[0] ?? '') || compareNatural(a.addr, b.addr)
				);
				this.#workerOrder = sorted.map((w) => w.addr);
				this.#workerSystems = sorted.map((w) => w.systems[0] ?? '');
				this.#retired = sorted.filter((w) => w.retired).map((w) => w.addr);
				const up = sorted.filter((w) => w.upstream.length > 0);
				this.#upstreamWorkers = up.map((w) => w.addr);
				const urls = new Set<string>();
				let farmRow = false;
				const farm = this.#meta.cacheSubstituterUrl;
				for (const w of up) {
					for (const u of w.upstream) urls.add(u);
					if (farm !== '' && w.listed.includes(farm)) farmRow = true;
				}
				this.#upstreamRows = Math.min(UPSTREAM_CARD_ROWS, urls.size) + (farmRow ? 1 : 0);
			}
		}

		if (now - this.#lastRank >= this.#o.rerankMs) {
			this.#rank(now);
		} else if (this.#newGroups.length > 0) {
			const fresh = [...new Set(this.#newGroups)].filter(
				(id) => this.#groups.has(id) && !this.#shown.includes(id)
			);
			if (this.#hasOther) {
				// Full: newcomers wait in "other clients" until the next ranking.
				for (const id of fresh) if (!this.#otherIds.includes(id)) this.#otherIds.push(id);
			} else if (this.#shown.length + fresh.length <= this.#o.maxCards) {
				this.#shown.push(...fresh);
			} else {
				// The column just overflowed, so rank now, and "other clients" takes the last card.
				this.#rank(now);
			}
		}
		this.#newGroups.length = 0;

		const hasCache = this.#hasMeta && this.#meta.cacheUrl !== '';
		const groups = this.#hasOther ? [...this.#shown, OTHER_CLIENTS] : this.#shown;
		const t = this.#topology;
		const sameGroups = sameStrings(t.clientGroups, groups);
		const sameWorkers = sameStrings(t.workers, this.#workerOrder);
		const sameSystems = sameStrings(t.workerSystems, this.#workerSystems);
		const sameRetired = sameStrings(t.retired, this.#retired);
		const sameUpstream = sameStrings(t.upstreamWorkers, this.#upstreamWorkers);
		if (
			t.hasCache !== hasCache ||
			!sameGroups ||
			!sameWorkers ||
			!sameSystems ||
			!sameRetired ||
			!sameUpstream ||
			t.upstreamRows !== this.#upstreamRows
		) {
			this.#topology = {
				clientGroups: sameGroups ? t.clientGroups : groups.slice(),
				workers: sameWorkers ? t.workers : this.#workerOrder.slice(),
				workerSystems: sameSystems ? t.workerSystems : this.#workerSystems.slice(),
				retired: sameRetired ? t.retired : this.#retired.slice(),
				hasCache,
				upstreamWorkers: sameUpstream ? t.upstreamWorkers : this.#upstreamWorkers.slice(),
				upstreamRows: this.#upstreamRows
			};
		}
		return this.#topology;
	}

	// Busiest first, with hysteresis so the map does not reshuffle on
	// noise. Scores are log2 of activity. A hidden group takes the place of
	// the quietest shown one only when it is at least twice as busy, and two
	// shown groups swap places only when the lower one is four times busier.
	// Every group has a card while they fit; past that, "other clients" takes
	// the last card, so it never holds just one group.
	#rank(now: number) {
		this.#lastRank = now;
		const score = new Map<string, number>();
		for (const g of this.#groups.values()) {
			const active = g.clients > 0 || g.waits.size > 0;
			if (!active && g.idleSince && now - g.idleSince >= this.#o.groupLingerMs) {
				if (g.wants.idle(now)) this.#groups.delete(g.id);
				continue;
			}
			score.set(g.id, Math.log2(1 + g.waits.size + g.clients + 5 * g.wants.rate(now)));
		}
		const sc = (id: string) => score.get(id) ?? 0;
		const byScore = (a: string, b: string) => sc(b) - sc(a) || compareCode(a, b);
		const max = score.size <= this.#o.maxCards ? this.#o.maxCards : this.#o.maxCards - 1;
		const shown = this.#shown.filter((id, i, all) => score.has(id) && all.indexOf(id) === i);
		const rest = [...score.keys()].filter((id) => !shown.includes(id));
		// With fewer places than shown groups, the quietest make room.
		while (shown.length > max) {
			let worst = 0;
			for (let i = 1; i < shown.length; i++) if (sc(shown[i]) < sc(shown[worst])) worst = i;
			rest.push(...shown.splice(worst, 1));
		}
		rest.sort(byScore);
		while (shown.length < max && rest.length > 0) shown.push(rest.shift()!);
		for (let swaps = 0; swaps < 2 && rest.length > 0; swaps++) {
			let worst = 0;
			for (let i = 1; i < shown.length; i++) if (sc(shown[i]) < sc(shown[worst])) worst = i;
			if (sc(rest[0]) < sc(shown[worst]) + 1) break;
			const out = shown[worst];
			shown[worst] = rest.shift()!;
			rest.push(out);
		}
		for (let pass = 0; pass < shown.length; pass++) {
			let moved = false;
			for (let i = 0; i + 1 < shown.length; i++) {
				if (sc(shown[i + 1]) >= sc(shown[i]) + 2) {
					[shown[i], shown[i + 1]] = [shown[i + 1], shown[i]];
					moved = true;
				}
			}
			if (!moved) break;
		}
		this.#shown = shown;
		this.#otherIds = rest;
		this.#hasOther = rest.length > 0;
	}

	// ----------------------------------------------------------------- views

	views(now: number, windowMinutes: number): FarmViews {
		const topology = this.#updateTopology(now);
		const m = this.#meta;
		const meta: FarmMeta | null = this.#hasMeta
			? {
					instance: m.instance,
					version: m.version,
					defaultSystem: m.defaultSystem,
					cacheUrl: m.cacheUrl,
					cacheSubstituterUrl: m.cacheSubstituterUrl,
					servingSinceMs: m.servingSinceServer ? m.servingSinceServer + this.#offset : 0
				}
			: null;

		const edges = new Map<string, EdgeView>();
		const edge = (
			kind: FlowKind,
			endpoint: string,
			rate: number,
			unit: RateUnit,
			counts?: Counts
		) => {
			edges.set(edgeId(kind, endpoint), {
				rate: round3(rate),
				unit,
				finished: counts?.finished ?? 0,
				failed: counts?.failed ?? 0
			});
		};

		const workers = new Map<string, WorkerView>();
		let slots = 0;
		let free = 0;
		let workersUp = 0;
		// Queued work the scheduler could place on a builder: a system it
		// offers and every feature the drv needs. Builders mostly share a few
		// offers, so each distinct one is counted once.
		const canTakeByOffer = new Map<string, number>();
		const canTake = (w: WorkerRec) => {
			let n = canTakeByOffer.get(w.offer);
			if (n === undefined) {
				n = 0;
				for (const sc of this.#sys.values()) {
					if (sc.queued > sc.unplaceable && offers(w.systems, w.features, sc.system, sc.features))
						n += sc.queued - sc.unplaceable;
				}
				canTakeByOffer.set(w.offer, n);
			}
			return n;
		};
		const acc = new Map<string, PoolAcc>();
		let downloading = 0;
		for (const addr of topology.workers) {
			const w = this.#workers.get(addr)!;
			const tr = this.#traffic.get(addr);
			const running = this.#byWorker.get(addr)?.size ?? 0;
			if (w.up) {
				workersUp++;
				if (!w.draining && w.maxJobs > 0) {
					slots += w.maxJobs;
					free += Math.max(0, w.maxJobs - running);
				}
			}
			const assign = tr ? tr.assign.rate(now) : 0;
			const publish = tr ? tr.publish.rate(now) : 0;
			const fetch = tr ? tr.fetch.rate(now) : 0;
			const subst = tr ? tr.subst.rate(now) : 0;
			const upstream = w.upstream.length > 0;
			workers.set(addr, {
				addr,
				systems: w.systems,
				features: w.features,
				maxJobs: w.maxJobs,
				running,
				up: w.up,
				draining: w.draining,
				retired: w.retired,
				goneAt: !w.up && w.seenGoneAt ? w.seenGoneAt : null,
				drainReason: w.up ? w.drainReason : null,
				diskFree: w.diskFree,
				diskTotal: w.diskTotal,
				minFree: w.minFree,
				version: w.version,
				substituters: w.upstream,
				builtPerMin: tr ? Math.round(tr.built.total(now) * 10) / 10 : 0,
				failedPerMin: tr ? Math.round(tr.failed.total(now) * 10) / 10 : 0,
				queuedCanTake: canTake(w)
			});
			edge(
				'assign',
				addr,
				assign,
				'builds',
				tr && this.#winCounts(tr.hist, tr.win, now, windowMinutes)
			);
			if (topology.hasCache) {
				edge('publish', addr, publish, 'bytes');
				edge('fetch', addr, fetch, 'bytes');
			}
			if (upstream) {
				edge('substitute', addr, subst, 'bytes');
				if (w.up && subst > 0) downloading++;
			}

			// A retired builder left on purpose: it counts under `left` only.
			if (w.retired) continue;
			const pool = poolOf(w.systems[0] ?? '');
			let p = acc.get(pool);
			if (!p) {
				p = {
					builders: 0,
					up: 0,
					draining: 0,
					drainingLowDisk: 0,
					drainingStopping: 0,
					drainingLocalDaemon: 0,
					offline: 0,
					running: 0,
					slots: 0,
					offers: new Map(),
					assign: 0,
					publish: 0,
					fetch: 0,
					subst: 0,
					upstream: false
				};
				acc.set(pool, p);
			}
			p.builders++;
			if (!w.up) p.offline++;
			else if (w.draining) {
				p.draining++;
				if (w.drainReason === 'low-disk') p.drainingLowDisk++;
				else if (w.drainReason === 'stopping') p.drainingStopping++;
				else if (w.drainReason === 'local-daemon') p.drainingLocalDaemon++;
			} else p.up++;
			if (w.up) p.slots += w.maxJobs;
			p.running += running;
			const o = p.offers.get(w.offer);
			if (o) o.n++;
			else p.offers.set(w.offer, { w, n: 1 });
			p.assign += assign;
			p.publish += publish;
			p.fetch += fetch;
			p.subst += subst;
			if (upstream) p.upstream = true;
		}

		const pools = new Map<string, PoolView>();
		const churnSince: Coverage | null =
			!this.#watchingSince || now - this.#watchingSince < CHURN_MS
				? { fromMs: this.#watchingSince || now, cause: this.#startCause() }
				: null;
		for (const [system, p] of acc) {
			// Each queue key once, however many builders of the pool could take it.
			let queuedCanTake = 0;
			for (const sc of this.#sys.values()) {
				if (sc.queued <= sc.unplaceable) continue;
				for (const { w } of p.offers.values()) {
					if (offers(w.systems, w.features, sc.system, sc.features)) {
						queuedCanTake += sc.queued - sc.unplaceable;
						break;
					}
				}
			}
			const features = new Map<string, number>();
			for (const { w, n } of p.offers.values())
				for (const f of w.features) features.set(f, (features.get(f) ?? 0) + n);
			const churn = this.#churn.get(system);
			pools.set(system, {
				system,
				builders: p.builders,
				up: p.up,
				draining: p.draining,
				drainingLowDisk: p.drainingLowDisk,
				drainingStopping: p.drainingStopping,
				drainingLocalDaemon: p.drainingLocalDaemon,
				offline: p.offline,
				running: p.running,
				slots: p.slots,
				queuedCanTake,
				features: [...features]
					.sort((a, b) => b[1] - a[1] || compareNatural(a[0], b[0]))
					.map(([name, builders]) => ({ name, builders })),
				joined: churn ? Math.round(churn.joined.total(now)) : 0,
				left: churn ? Math.round(churn.left.total(now)) : 0,
				churnSince
			});
			const id = poolNodeId(system);
			const line = this.#poolHist.get(system);
			edge(
				'assign',
				id,
				p.assign,
				'builds',
				line && this.#winCounts(line.hist, line.win, now, windowMinutes)
			);
			if (topology.hasCache) {
				edge('publish', id, p.publish, 'bytes');
				edge('fetch', id, p.fetch, 'bytes');
			}
			if (p.upstream) edge('substitute', id, p.subst, 'bytes');
		}

		const clientGroups = new Map<string, ClientGroupView>();
		for (const id of topology.clientGroups) {
			const view = this.#groupView(id, now);
			clientGroups.set(id, view);
			edge('want', id, view.wantsPerSec, 'builds', this.#groupCounts(id, now, windowMinutes));
		}

		const base = this.#windowBase(now, windowMinutes);
		const totals = this.#totals(base, windowMinutes);
		const upstream = topology.upstreamWorkers.length
			? this.#upstreamView(now, base, downloading)
			: null;
		let cache: CacheView | null = null;
		if (topology.hasCache) {
			const mt = this.#meters;
			const hits = totals.view.cached;
			const lookups = hits + totals.cacheMisses;
			cache = {
				url: m.cacheUrl,
				hitsPerSec: round3(mt.hits.rate(now)),
				missesPerSec: round3(mt.misses.rate(now)),
				hitRatio: lookups > 0 ? hits / lookups : null,
				publishedBytesPerSec: round3(mt.publish.rate(now)),
				fetchedBytesPerSec: round3(mt.fetch.rate(now))
			};
			edge('cached', SCHEDULER_ID, mt.hits.rate(now), 'builds');
		}

		const scheduler: SchedulerView = {
			queued: this.#nQueued,
			unplaceable: this.#nUnplaceable,
			assigned: this.#nAssigned,
			workersUp,
			clients: this.#clients.size,
			slots,
			free,
			assignedPerSec: round3(this.#meters.assign.rate(now)),
			queuedPerMin: this.#queueTrend(now),
			systems: this.#systems
		};

		return {
			meta,
			topology,
			workers,
			pools,
			clientGroups,
			scheduler,
			cache,
			upstream,
			edges,
			totals: totals.view,
			linesSince: this.#linesSince(now, windowMinutes)
		};
	}

	/**
	 * Samples the queue size at most once a second, and gives its change per
	 * minute over the samples, or null until there are QUEUE_TREND_SAMPLES.
	 */
	#queueTrend(now: number): number | null {
		const s = this.#queueSamples;
		const last = s.at(-1);
		// A clock that went back, in tests or on a new stream, starts over.
		if (last && now < last.t) s.length = 0;
		if (this.#complete && (!s.length || now - s[s.length - 1].t >= 1000)) {
			s.push({ t: now, n: this.#nQueued });
			if (s.length > QUEUE_TREND_SAMPLES) s.shift();
		}
		if (s.length < QUEUE_TREND_SAMPLES) return null;
		const first = s[0];
		const end = s[s.length - 1];
		return end.t > first.t ? round3(((end.n - first.n) * 60_000) / (end.t - first.t)) : null;
	}

	#groupView(id: string, now: number): ClientGroupView {
		if (id === OTHER_CLIENTS) {
			let clients = 0;
			let wants = 0;
			for (const oid of this.#otherIds) {
				const g = this.#groups.get(oid);
				if (!g) continue;
				clients += g.clients;
				wants += g.wants.rate(now);
			}
			return {
				id,
				label: 'other clients',
				clients,
				waiting: this.#otherWaits().size,
				wantsPerSec: round3(wants)
			};
		}
		const g = this.#groups.get(id);
		return {
			id,
			label: id || 'unknown client',
			clients: g ? Math.max(0, g.clients) : 0,
			waiting: g ? g.waits.size : 0,
			wantsPerSec: g ? round3(g.wants.rate(now)) : 0
		};
	}

	#otherWaits(): Set<string> {
		const out = new Set<string>();
		for (const oid of this.#otherIds) {
			const g = this.#groups.get(oid);
			if (g) for (const p of g.waits.keys()) out.add(p);
		}
		return out;
	}

	/**
	 * Where the window of `minutes` starts in the counter history: the
	 * current sample, a reader for any counter's value at the window's start,
	 * and where the counts start while the history does not reach back that
	 * far. The header windows of 5, 15, 30 and 60 minutes all fit the samples
	 * the scheduler keeps.
	 */
	#windowBase(now: number, minutes: number): WindowBase {
		const nowServer = now - this.#offset;
		const start = nowServer - minutes * 60_000;
		const cur: CounterSample = this.#current ?? { t: nowServer, c: ZERO_COUNTERS, subs: NO_SUBS };
		let at: WindowBase['at'] = () => 0;
		const s = this.#samples;
		const serving = this.#meta.servingSinceServer;
		// Counters start at zero when the scheduler starts serving.
		let since: Coverage | null = {
			fromMs: (serving > 0 ? serving : (s[0]?.t ?? nowServer)) + this.#offset,
			cause: 'restart'
		};
		if (this.#hasMeta) {
			let i = -1;
			for (let k = s.length - 1; k >= 0; k--) {
				if (s[k].t <= start) {
					i = k;
					break;
				}
			}
			if (i >= 0) {
				const a = s[i];
				const b = s[i + 1] ?? cur;
				const span = b.t - a.t;
				const f = span > 0 ? Math.min(1, Math.max(0, (start - a.t) / span)) : 1;
				at = (get) => {
					const x = get(a);
					return x + (get(b) - x) * f;
				};
				since = null;
			} else if (serving > 0 && start >= serving) {
				const oldest = s[0] ?? cur;
				at = (get) => get(oldest);
				// History has minute resolution: a window that starts less than
				// 90 s before the oldest sample is as good as complete. Before
				// that, count from the oldest sample and say so.
				since =
					oldest.t - start <= 90_000 ? null : { fromMs: oldest.t + this.#offset, cause: 'history' };
			}
		}
		return { cur, at, since };
	}

	#totals(w: WindowBase, windowMinutes: number) {
		const d = (k: keyof CounterValues) => Math.max(0, Math.round(w.cur.c[k] - w.at((x) => x.c[k])));
		const view: Totals = {
			windowMinutes,
			queued: this.#nQueued,
			running: this.#nAssigned,
			built: d('built'),
			failed: d('failed'),
			cached: d('cacheHits'),
			since: w.since
		};
		return { view, cacheMisses: d('cacheMisses') };
	}

	/** One substituter's counts within the window. */
	#upstreamTotals(w: WindowBase, url: string): SubstituterCounts {
		const now = w.cur.subs.get(url);
		if (!now) return ZERO_SUBSTITUTER;
		const d = (k: keyof SubstituterCounts) =>
			Math.max(0, Math.round(now[k] - w.at((x) => x.subs.get(url)?.[k] ?? 0)));
		return { nar: d('nar'), download: d('download'), paths: d('paths'), failures: d('failures') };
	}

	/** How many connected builders list each URL, recounted only after a WorkerState changed one. */
	#countSubstituters() {
		if (!this.#subsDirty) return this.#subCounts;
		this.#subsDirty = false;
		const byUrl = new Map<string, number>();
		let builders = 0;
		let unreported = 0;
		for (const w of this.#workers.values()) {
			if (!w.up) continue;
			if (w.version === '') unreported++;
			if (w.upstream.length > 0) builders++;
			for (const u of w.listed) byUrl.set(u, (byUrl.get(u) ?? 0) + 1);
		}
		this.#subCounts = { byUrl, builders, unreported };
		return this.#subCounts;
	}

	#upstreamView(now: number, base: WindowBase, downloading: number): UpstreamView {
		const counts = this.#countSubstituters();
		const farm = this.#meta.cacheSubstituterUrl;
		const row = (url: string): SubstituterView => {
			const t = this.#upstreamTotals(base, url);
			return {
				url,
				builders: counts.byUrl.get(url) ?? 0,
				narBytesPerSec: round3(this.#subMeters.get(url)?.rate(now) ?? 0),
				narBytes: t.nar,
				downloadBytes: t.download,
				paths: t.paths,
				failures: t.failures
			};
		};
		// Every URL a builder on the map lists; the card's rows.
		const urls = new Set<string>();
		let farmListed = false;
		for (const addr of this.#topology.upstreamWorkers) {
			const w = this.#workers.get(addr);
			if (!w) continue;
			for (const u of w.upstream) urls.add(u);
			if (farm !== '' && w.listed.includes(farm)) farmListed = true;
		}
		const substituters = [...urls]
			.map(row)
			.sort(
				(a, b) => b.narBytes - a.narBytes || b.builders - a.builders || compareCode(a.url, b.url)
			);
		// Totals over every upstream URL with traffic, "other" included.
		let rate = 0;
		let narBytes = 0;
		for (const [url, m] of this.#subMeters) if (url !== farm) rate += m.rate(now);
		for (const url of base.cur.subs.keys())
			if (url !== farm) narBytes += this.#upstreamTotals(base, url).nar;
		return {
			substituters,
			narBytesPerSec: round3(rate),
			narBytes,
			builders: counts.builders,
			downloading,
			unreported: counts.unreported,
			since: base.since,
			farmCache: farmListed ? row(farm) : null
		};
	}

	// ----------------------------------------------------------- build list

	/** A derivation that finished on a builder joins the build list's rings. */
	#addBuild(rec: DrvRec, g: DrvGone) {
		const b: BuildRec = {
			key: buildKey(rec.path, rec.assignId),
			path: rec.path,
			system: rec.system,
			worker: rec.worker,
			assignId: rec.assignId,
			state: rec.phase as BuildRec['state'],
			status: rec.status,
			errorLine: rec.errorSent ? firstErrorLine(g.error) : null,
			assignedMs: rec.assignedMs,
			startedMs: rec.buildStartedMs,
			finishedMs: rec.finishedMs,
			requestedBy: rec.identities ?? EMPTY_STRINGS,
			from: 'live',
			rings: 0,
			row: null,
			rowOffset: 0
		};
		// A live row wins over the same build from history.
		const old = this.#buildKeys.get(b.key);
		if (old) this.#dropBuild(old);
		this.#buildKeys.set(b.key, b);
		this.#ringPush(b, IN_BUILDS);
		if (b.state === 'failed') this.#ringPush(b, IN_FAILURES);
		this.#trim(IN_BUILDS);
		this.#trim(IN_FAILURES);
	}

	#ringPush(b: BuildRec, ring: number) {
		if (b.rings & ring) return;
		b.rings |= ring;
		(ring === IN_BUILDS ? this.#builds : this.#failures).push(b);
	}

	#dropBuild(b: BuildRec) {
		this.#buildKeys.delete(b.key);
		for (const ring of [this.#builds, this.#failures]) {
			const i = ring.lastIndexOf(b);
			if (i >= 0) ring.splice(i, 1);
		}
		b.rings = 0;
	}

	/**
	 * Drops the oldest beyond the ring's cap, in steps of `slack`, so a ring
	 * at its cap does not shift on every build. Returns what it dropped.
	 */
	#trim(which: number, slack?: number): BuildRec[] {
		const ring = which === IN_BUILDS ? this.#builds : this.#failures;
		const cap = which === IN_BUILDS ? BUILDS_KEPT : FAILURES_KEPT;
		if (ring.length <= cap + (slack ?? Math.ceil(cap / 20))) return [];
		const gone = ring.splice(0, ring.length - cap);
		for (const b of gone) {
			b.rings &= ~which;
			if (b.rings === 0) this.#buildKeys.delete(b.key);
		}
		return gone;
	}

	/** The scheduler instance of the last Reset, '' before any. */
	get instance(): string {
		return this.#meta.instance;
	}

	/** What the scheduler has served of RecentBuilds for this instance. */
	get history(): Readonly<HistoryState> {
		return this.#history;
	}

	/** The first history load of this instance starts. False when it already ran. */
	startHistory(): boolean {
		if (this.#history.requested) return false;
		this.#history.requested = true;
		return true;
	}

	/**
	 * Rows from Events.RecentBuilds, newest first. Keyed by derivation and
	 * assignment: a live row wins over a history row. Failure text becomes
	 * the row's error line and is dropped; it never enters #errors.
	 */
	mergeHistory(batch: RecentBuildsBatch, failedOnly: boolean) {
		const h = this.#history;
		h.served = true;
		const added = new Set<BuildRec>();
		let touched = false;
		for (const f of batch.builds) {
			// Rows the page has, as most of a reconnect's top-up is, need no record of their own.
			const old = this.#buildKeys.get(buildKey(f.drvPath, Number(f.assignId)));
			if (old) {
				if (old.from === 'history' && old.errorLine === null && f.error) {
					const line = outcomePhase(f.outcome) === 'failed' ? firstErrorLine(f.error) : null;
					if (line !== null) {
						old.errorLine = line;
						old.row = null;
					}
				}
				if (old.state === 'failed' && !(old.rings & IN_FAILURES)) {
					this.#ringPush(old, IN_FAILURES);
					touched = true;
				}
				continue;
			}
			const b = this.#historyRec(f);
			this.#buildKeys.set(b.key, b);
			added.add(b);
			if (!failedOnly) this.#ringPush(b, IN_BUILDS);
			if (b.state === 'failed') this.#ringPush(b, IN_FAILURES);
			touched = true;
		}
		if (touched) {
			const byFinish = (a: BuildRec, b: BuildRec) => a.finishedMs - b.finishedMs;
			this.#builds.sort(byFinish);
			this.#failures.sort(byFinish);
			const gone = [...this.#trim(IN_BUILDS, 0), ...this.#trim(IN_FAILURES, 0)];
			if (gone.some((b) => added.has(b))) h.full = true;
		}
		// Only a call's last batch says complete.
		if (batch.complete) {
			if (failedOnly) h.failuresComplete = true;
			else h.complete = true;
		}
		this.#version++;
	}

	#historyRec(f: FinishedBuild): BuildRec {
		const state = outcomePhase(f.outcome) as BuildRec['state'];
		const failed = state === 'failed';
		return {
			key: buildKey(f.drvPath, Number(f.assignId)),
			path: f.drvPath,
			system: f.system,
			worker: f.workerAddr,
			assignId: Number(f.assignId),
			state,
			status: state === 'built' || failed ? (STATUS[f.status] ?? null) : null,
			errorLine: failed && f.error ? firstErrorLine(f.error) : null,
			assignedMs: Number(f.assignedMs),
			startedMs: Number(f.buildStartedMs),
			finishedMs: Number(f.finishedMs),
			requestedBy: f.requestedBy.length ? [...f.requestedBy] : EMPTY_STRINGS,
			from: 'history',
			rings: 0,
			row: null,
			rowOffset: 0
		};
	}

	/** The oldest finish time in a ring, server clock, for the next page of history. 0 when empty. */
	oldestBuildMs(failedOnly: boolean): number {
		return (failedOnly ? this.#failures : this.#builds)[0]?.finishedMs ?? 0;
	}

	/**
	 * The newest finish time in a ring, server clock. 0 when empty. Live rows
	 * join at the end as they arrive, some without a finish time, so the
	 * last row need not be the newest.
	 */
	#newestBuildMs(failedOnly: boolean): number {
		let newest = 0;
		for (const b of failedOnly ? this.#failures : this.#builds)
			if (b.finishedMs > newest) newest = b.finishedMs;
		return newest;
	}

	/** A top-up of a ring ended, because it read back to the cut or read a whole page. */
	closeCut(failedOnly: boolean): void {
		if (failedOnly) this.#history.cutMs.failures = null;
		else this.#history.cutMs.builds = null;
	}

	#buildRow(b: BuildRec): BuildRow {
		if (b.row && b.rowOffset === this.#offset) return b.row;
		const row: BuildRow = {
			drvPath: b.path,
			name: drvName(b.path),
			system: b.system,
			worker: b.worker,
			assignId: b.assignId,
			state: b.state,
			status: b.status,
			errorLine: b.errorLine,
			assignedMs: this.#toBrowser(b.assignedMs),
			startedMs: this.#toBrowser(b.startedMs),
			reportsStarts: false,
			finishedMs: this.#toBrowser(b.finishedMs),
			finishedServerMs: b.finishedMs > 0 ? b.finishedMs : null,
			phase: null,
			phaseStartedMs: null,
			requestedBy: b.requestedBy,
			from: b.from
		};
		b.row = row;
		b.rowOffset = this.#offset;
		return row;
	}

	#assignedRow(rec: DrvRec): BuildRow {
		const v = this.#view(rec);
		return {
			drvPath: rec.path,
			name: v.name,
			system: rec.system,
			worker: rec.worker,
			assignId: rec.assignId,
			state: 'assigned',
			status: null,
			errorLine: null,
			assignedMs: v.assignedMs,
			startedMs: v.buildStartedMs,
			reportsStarts: v.reportsStarts,
			finishedMs: null,
			finishedServerMs: null,
			phase: v.buildPhase,
			phaseStartedMs: v.buildPhaseStartedMs,
			requestedBy: v.identities,
			from: 'live'
		};
	}

	/** Every row of the build list, unfiltered: builds in progress, then the rings, newest first. */
	#buildRows(): BuildRow[] {
		const rows: BuildRow[] = [];
		for (const set of this.#byWorker.values())
			for (const rec of set) rows.push(this.#assignedRow(rec));
		const seen = new Set<BuildRec>();
		// A ring may hold a few more than its cap until the next trim.
		for (const [ring, cap] of [
			[this.#builds, BUILDS_KEPT],
			[this.#failures, FAILURES_KEPT]
		] as const)
			for (let i = ring.length - 1; i >= Math.max(0, ring.length - cap); i--) {
				const b = ring[i];
				if (seen.has(b)) continue;
				seen.add(b);
				rows.push(this.#buildRow(b));
			}
		return rows;
	}

	/** The build list for a query. `loading` comes from the store. */
	builds(
		query: BuildQuery,
		now: number
	): Omit<BuildsView, 'coverage'> & {
		coverage: Omit<BuildsView['coverage'], 'loading'>;
	} {
		const workers = this.#workers;
		const result = queryBuilds(this.#buildRows(), query, {
			now,
			poolOf: (addr) => {
				const w = workers.get(addr);
				return w ? poolOf(w.systems[0] ?? '') : null;
			},
			shownClients: new Set(this.#shown)
		});
		const h = this.#history;
		const oldest = Math.min(
			this.#builds[0]?.finishedMs || Infinity,
			this.#failures[0]?.finishedMs || Infinity
		);
		const oldestMs = Number.isFinite(oldest) ? this.#toBrowser(oldest) : null;
		const connected = this.#watchingSince || null;
		const servedOlder =
			h.served && oldestMs !== null && (connected === null || oldestMs < connected);
		return {
			...result,
			coverage: {
				source: servedOlder ? 'scheduler' : 'page',
				sinceMs: servedOlder
					? oldestMs
					: connected === null
						? oldestMs
						: Math.min(connected, oldestMs ?? connected),
				complete: h.complete,
				full: h.full,
				restartMs:
					this.#restarted && this.#meta.servingSinceServer
						? this.#meta.servingSinceServer + this.#offset
						: null
			}
		};
	}

	/** One build: in progress, or the newest kept one of `assignId` (0: any). */
	build(drvPath: string, assignId: number): BuildRow | undefined {
		const rec = this.#drvs.get(drvPath);
		if (rec?.phase === 'assigned' && (!assignId || rec.assignId === assignId))
			return this.#assignedRow(rec);
		if (assignId) {
			const b = this.#buildKeys.get(buildKey(drvPath, assignId));
			return b ? this.#buildRow(b) : undefined;
		}
		for (const ring of [this.#builds, this.#failures])
			for (let i = ring.length - 1; i >= 0; i--)
				if (ring[i].path === drvPath) return this.#buildRow(ring[i]);
		return undefined;
	}

	/** A history answer for one derivation, as the viewer shows it. */
	finishedBuildOf(f: FinishedBuild): FinishedBuildView {
		const row = this.#buildRow(this.#historyRec(f));
		return { ...row, errorText: f.error ? cleanError(f.error) : null };
	}

	/** The error text the page keeps for a finished build of `drvPath`, from live DrvGone only. */
	errorTextOf(drvPath: string): string | null {
		const rec = this.#recentByPath.get(drvPath);
		return rec ? (this.#errors.get(rec) ?? null) : null;
	}

	// ------------------------------------------------------------ drill-down

	#view(rec: DrvRec): DrvView {
		// A cached view with error text is stale once #errors dropped the text.
		if (
			rec.view &&
			rec.viewOffset === this.#offset &&
			(rec.view.errorText === null || this.#errors.has(rec))
		)
			return rec.view;
		const identities = rec.identities ?? this.#identities(rec.clientIds);
		const worker = rec.worker || null;
		const view: DrvView = {
			drvPath: rec.path,
			name: (rec.name ??= drvName(rec.path)),
			phase: rec.phase,
			system: rec.system,
			features: rec.features,
			workerAddr: worker,
			clientIds: rec.clientIds,
			identities,
			queuedMs: this.#toBrowser(rec.queuedMs),
			assignedMs: this.#toBrowser(rec.assignedMs),
			finishedMs: this.#toBrowser(rec.finishedMs),
			finishedServerMs: rec.finishedMs > 0 ? rec.finishedMs : null,
			cpHintMs: rec.cpHintMs,
			inputs: rec.inputs,
			inputSources: rec.inputSources.map((s): InputSourceView => ({
				...s,
				local: s.workerAddr === worker
			})),
			inputsUnknown: rec.inputsUnknown,
			fetchedBytes: fetchedBytes(rec.inputSources, worker),
			cacheChecked: rec.cacheChecked,
			outputs: rec.outputs,
			outputBytes: outputBytes(rec.outputs),
			reason: rec.reason || null,
			status: rec.status,
			errorSent: rec.errorSent,
			errorText: rec.errorSent ? (this.#errors.get(rec) ?? null) : null,
			assignId: rec.assignId,
			buildPhase: rec.phase === 'assigned' ? rec.buildPhase || null : null,
			buildPhaseStartedMs:
				rec.phase === 'assigned' && rec.buildPhase
					? this.#toBrowser(rec.buildPhaseStartedMs)
					: null,
			buildStartedMs: this.#toBrowser(rec.buildStartedMs),
			reportsStarts: rec.worker !== '' && this.#reportsStarts.has(rec.worker)
		};
		// An identity may still be unknown before its ClientState arrives, so rebuild next time.
		if (rec.identities || rec.clientIds.every((id) => this.#identityOf.has(id))) {
			rec.view = view;
			rec.viewOffset = this.#offset;
		}
		return view;
	}

	/**
	 * A drv in flight or recently finished. `via` names the line a list row
	 * came from, as EdgeItemView.via does, so a drv that left the recent ring
	 * still opens from the builder, group or cache hits ring behind that line.
	 */
	drv(drvPath: string, via?: string): DrvView | undefined {
		const rec =
			this.#drvs.get(drvPath) ??
			this.#recentByPath.get(drvPath) ??
			(via === undefined ? undefined : this.#viaRec(drvPath, via));
		return rec ? this.#view(rec) : undefined;
	}

	#viaRec(path: string, via: string): DrvRec | undefined {
		const p = parseEdgeId(via);
		if (!p) return undefined;
		if (p.flow === 'cached') {
			for (const rec of this.#hits.newest()) if (rec.path === path) return rec;
			return undefined;
		}
		if (p.flow === 'want') {
			const recent = this.#groups.get(p.endpoint)?.recent ?? [];
			for (let i = recent.length - 1; i >= 0; i--)
				if (recent[i].rec.path === path) return recent[i].rec;
			return undefined;
		}
		const recent = this.#traffic.get(p.endpoint)?.recent ?? [];
		for (let i = recent.length - 1; i >= 0; i--) if (recent[i].path === path) return recent[i];
		return undefined;
	}

	/**
	 * One line by its edge id, or a bundle of several ids of one kind, over
	 * the window of `windowMinutes`. It skips ids of another kind than the
	 * first known one and ids it does not know; undefined when none is known.
	 *
	 * Costs the in-flight drvs of the lines' builders plus 32 per builder for
	 * the items, and one window read per line.
	 */
	edgeDetail(
		edgeIds: readonly string[],
		now: number,
		windowMinutes: number,
		itemsLimit = 50
	): EdgeDetailView | undefined {
		const k = windowBuckets(windowMinutes);
		const asked = new Set<string>();
		const kinds: FlowKind[] = [];
		const lines: DetailLine[] = [];
		let flow: FlowKind | null = null;
		for (const id of edgeIds) {
			if (asked.has(id)) continue;
			asked.add(id);
			const p = parseEdgeId(id);
			if (p) kinds.push(p.flow);
			if (!p || (flow !== null && p.flow !== flow)) continue;
			const line = this.#detailLine(id, p.flow, p.endpoint, now, windowMinutes, k);
			if (!line) continue;
			flow = p.flow;
			lines.push(line);
		}
		if (flow === null) return undefined;

		const n = k - 1;
		const withFailed = flow === 'assign' || flow === 'want';
		const values = new Float64Array(n);
		const failedSum = withFailed ? new Float64Array(n) : null;
		let rate = 0;
		let total = 0;
		let finished = 0;
		let failed = 0;
		let count = 0;
		for (const l of lines) {
			rate += l.rate;
			total += l.total;
			finished += l.counts.finished;
			failed += l.counts.failed;
			count += l.members.length;
			for (const h of l.hist) h.addInto(values, now);
			if (failedSum) for (const h of l.failed) h.addInto(failedSum, now);
		}
		const live = new Float64Array(n);
		this.#live.addInto(live, now);
		const perSec = LINE_BUCKET_MS / 1000;
		const series: EdgeSeries = {
			startMs: (this.#live.bucketIndex(now) - n) * LINE_BUCKET_MS,
			bucketMs: LINE_BUCKET_MS,
			values: Array.from(values, (v, i) => (live[i] > 0 ? v / perSec : null)),
			failed: failedSum && Array.from(failedSum, (v, i) => (live[i] > 0 ? v / perSec : null))
		};

		// A bundle has a row per line. A pool line or "other clients" alone has
		// a row per member, on its member's own line.
		let sameKind = 0;
		for (const f of kinds) if (f === flow) sameKind++;
		let rows: EdgeRowView[] = [];
		if (sameKind > 1) rows = lines.map(rowOf);
		else if (lines[0].group) {
			const f = flow;
			rows = lines[0].members.map((m) => {
				const id = edgeId(f, m);
				return rowOf(
					f === 'want'
						? this.#groupLine(id, this.#groups.get(m)!, now, windowMinutes, k)
						: this.#builderLine(id, f as BuildFlow, m, now, windowMinutes, k)
				);
			});
		}
		// Stable: equal rates keep the order given.
		rows.sort((a, b) => b.rate - a.rate);

		// Repeated paths are rare: one pass almost always has enough.
		let newest: ItemCand[] = [];
		for (let cap = itemsLimit; itemsLimit > 0; cap *= 2) {
			const top = new Newest(cap);
			for (const l of lines) this.#offerItems(flow, l, top);
			newest = top.unique(itemsLimit);
			if (newest.length >= itemsLimit || !top.evicted) break;
		}
		const browserClock = flow === 'want';
		const items = newest.map((c): EdgeItemView => ({
			drv: this.#view(c.rec),
			via: c.via,
			atMs: browserClock ? c.at : this.#toBrowser(c.at),
			bytes: c.bytes
		}));

		return {
			edgeIds: lines.map((l) => l.id),
			flow,
			unit: flow === 'publish' || flow === 'fetch' || flow === 'substitute' ? 'bytes' : 'builds',
			count,
			rate: round3(rate),
			windowMinutes,
			total,
			finished,
			failed,
			series,
			since: this.#linesSince(now, windowMinutes),
			rows,
			items,
			estimate: flow === 'fetch'
		};
	}

	#detailLine(
		id: string,
		flow: FlowKind,
		endpoint: string,
		now: number,
		minutes: number,
		k: number
	): DetailLine | undefined {
		switch (flow) {
			case 'assign':
			case 'publish':
			case 'fetch':
			case 'substitute': {
				// A builder first: its host may be called "pool".
				if (this.#workers.has(endpoint))
					return this.#builderLine(id, flow, endpoint, now, minutes, k);
				const ref = parseNodeId(endpoint);
				if (ref?.kind !== 'pool') return undefined;
				const members = this.#poolMembers(ref.system, flow === 'substitute');
				if (members.length === 0) return undefined;
				let rate = 0;
				const meter = flow === 'substitute' ? 'subst' : flow;
				for (const a of members) rate += this.#traffic.get(a)?.[meter].rate(now) ?? 0;
				// The pool's own history: builders that left still count in it.
				const pl = this.#poolHist.get(ref.system);
				return this.#histLine(id, rate, pl, flow, members, true, now, minutes, k);
			}
			case 'want': {
				if (endpoint !== OTHER_CLIENTS) {
					const g = this.#groups.get(endpoint);
					return g && this.#groupLine(id, g, now, minutes, k);
				}
				if (!this.#hasOther) return undefined;
				const members: string[] = [];
				const hist: RateMeter[] = [];
				const failedHist: RateMeter[] = [];
				let rate = 0;
				for (const oid of this.#otherIds) {
					const g = this.#groups.get(oid);
					if (!g) continue;
					members.push(oid);
					rate += g.wants.rate(now);
					hist.push(g.hist.wants);
					failedHist.push(g.hist.failed);
				}
				return {
					id,
					rate,
					total: sumRecent(hist, k, now),
					counts: this.#groupCounts(OTHER_CLIENTS, now, minutes)!,
					hist,
					failed: failedHist,
					members,
					group: true
				};
			}
			case 'cached': {
				if (endpoint !== SCHEDULER_ID || !this.#hasMeta || !this.#meta.cacheUrl) return undefined;
				const hist = [this.#hist.hits];
				return {
					id,
					rate: this.#meters.hits.rate(now),
					total: sumRecent(hist, k, now),
					counts: NO_COUNTS,
					hist,
					failed: [],
					members: [],
					group: false
				};
			}
		}
	}

	#builderLine(
		id: string,
		flow: BuildFlow,
		addr: string,
		now: number,
		minutes: number,
		k: number
	): DetailLine {
		const tr = this.#traffic.get(addr);
		const rate = tr ? tr[flow === 'substitute' ? 'subst' : flow].rate(now) : 0;
		return this.#histLine(id, rate, tr, flow, [addr], false, now, minutes, k);
	}

	/** A builder's or a pool's line of one kind, from its history and window counts. */
	#histLine(
		id: string,
		rate: number,
		src: { hist: LineHist; win: WinCounts } | undefined,
		flow: BuildFlow,
		members: string[],
		group: boolean,
		now: number,
		minutes: number,
		k: number
	): DetailLine {
		const meter = flow === 'substitute' ? 'subst' : flow;
		const hist = src ? [src.hist[meter]] : [];
		const assign = src && flow === 'assign';
		return {
			id,
			rate,
			total: sumRecent(hist, k, now),
			counts: assign ? this.#winCounts(src.hist, src.win, now, minutes) : NO_COUNTS,
			hist,
			failed: assign ? [src.hist.failed] : [],
			members,
			group
		};
	}

	#groupLine(id: string, g: GroupRec, now: number, minutes: number, k: number): DetailLine {
		const hist = [g.hist.wants];
		return {
			id,
			rate: g.wants.rate(now),
			total: sumRecent(hist, k, now),
			counts: this.#winCounts(g.hist, g.win, now, minutes),
			hist,
			failed: [g.hist.failed],
			members: [g.id],
			group: false
		};
	}

	/**
	 * Builders of a pool on the map now, in map order. It leaves out retired
	 * ones, as PoolView does. `upstream`: only those with a substitute line.
	 */
	#poolMembers(system: string, upstream = false): string[] {
		const t = this.#topology;
		const out: string[] = [];
		for (let i = 0; i < t.workers.length; i++) {
			if (poolOf(t.workerSystems[i]) !== system) continue;
			const w = this.#workers.get(t.workers[i]);
			if (w && !w.retired && (!upstream || w.upstream.length > 0)) out.push(w.addr);
		}
		return out;
	}

	/** Offers the latest list candidates of one line. */
	#offerItems(flow: FlowKind, l: DetailLine, top: Newest) {
		if (flow === 'cached') {
			const via = edgeId('cached', SCHEDULER_ID);
			for (const rec of this.#hits.newest()) top.offer(rec, via, rec.finishedMs, 0);
			return;
		}
		if (flow === 'want') {
			for (const m of l.members) {
				const recent = this.#groups.get(m)?.recent;
				if (!recent) continue;
				const via = edgeId('want', m);
				for (let i = recent.length - 1; i >= 0; i--) top.offer(recent[i].rec, via, recent[i].at, 0);
			}
			return;
		}
		// Builders report substituter bytes without the build they were for.
		if (flow === 'substitute') return;
		for (const addr of l.members) {
			const via = edgeId(flow, addr);
			if (flow !== 'publish') {
				const assigned = this.#byWorker.get(addr);
				if (assigned) for (const rec of assigned) offerBuild(flow, rec, via, top);
			}
			const recent = this.#traffic.get(addr)?.recent;
			if (recent)
				for (let i = recent.length - 1; i >= 0; i--) offerBuild(flow, recent[i], via, top);
		}
	}

	drvsForWorker(addr: string, limit = 100): DrvView[] {
		const out: DrvView[] = [];
		const assigned = this.#byWorker.get(addr);
		const seen = new Set<string>();
		if (assigned) {
			const recs = [...assigned];
			for (const r of recs) seen.add(r.path);
			recs.sort(byActivity);
			for (const r of recs) {
				if (out.length >= limit) return out;
				out.push(this.#view(r));
			}
		}
		const recent = this.#traffic.get(addr)?.recent;
		if (recent) {
			for (let i = recent.length - 1; i >= 0 && out.length < limit; i--) {
				const r = recent[i];
				if (seen.has(r.path)) continue;
				seen.add(r.path);
				out.push(this.#view(r));
			}
		}
		return out;
	}

	drvsForClientGroup(group: string, limit = 100): DrvView[] {
		const paths: Iterable<string> =
			group === OTHER_CLIENTS ? this.#otherWaits() : (this.#groups.get(group)?.waits.keys() ?? []);
		const recs: DrvRec[] = [];
		for (const p of paths) {
			const r = this.#drvs.get(p);
			if (r) recs.push(r);
		}
		return topK(recs, limit, byActivity).map((r) => this.#view(r));
	}

	/** A known client group's view, drawn or folded into "other clients". */
	clientGroup(group: string, now: number): ClientGroupView | undefined {
		const known = group === OTHER_CLIENTS ? this.#hasOther : this.#groups.has(group);
		return known ? this.#groupView(group, now) : undefined;
	}

	drvsQueued(limit = 100): DrvView[] {
		const recs: DrvRec[] = [];
		for (const p of this.#queued) recs.push(this.#drvs.get(p)!);
		return topK(recs, limit, byPriority).map((r) => this.#view(r));
	}

	/**
	 * A builder's upstream substituters in its order, then other URLs it
	 * used. The farm cache is left out. Counts are since the scheduler's term
	 * began, and rates are the builder's own.
	 */
	substitutersOf(addr: string, now: number): BuilderSubstituterView[] {
		const w = this.#workers.get(addr);
		if (!w) return [];
		const farm = this.#meta.cacheSubstituterUrl;
		const tr = this.#traffic.get(addr);
		const urls = [...w.upstream];
		for (const u of w.subs.keys()) if (u !== farm && !urls.includes(u)) urls.push(u);
		return urls.map((url) => {
			const c = w.subs.get(url) ?? ZERO_SUBSTITUTER;
			return {
				url,
				narBytesPerSec: round3(tr?.byUrl.get(url)?.rate(now) ?? 0),
				narBytes: c.nar,
				paths: c.paths,
				failures: c.failures
			};
		});
	}

	drvsForCache(limit = 100): DrvView[] {
		const out: DrvView[] = [];
		const seen = new Set<string>();
		for (const rec of this.#cacheRing.newest()) {
			if (out.length >= limit) break;
			if (seen.has(rec.path)) continue;
			seen.add(rec.path);
			out.push(this.#view(rec));
		}
		return out;
	}
}

/** Line kinds that run between the scheduler, the cache or the upstream card and a builder. */
type BuildFlow = 'assign' | 'publish' | 'fetch' | 'substitute';

/** The start of a window in the counter history. */
type WindowBase = {
	cur: CounterSample;
	/** A counter's value where the window starts. */
	at: (get: (s: CounterSample) => number) => number;
	since: Coverage | null;
};

/** One resolved line of a detail query. */
type DetailLine = {
	id: string;
	/** 10 s rate, in the line's unit. */
	rate: number;
	/** Within the window, current bucket included. */
	total: number;
	counts: Counts;
	/** The kind's history meters, added up: one, or one per group of other clients. */
	hist: readonly RateMeter[];
	/** Failed builds, on assign and want lines. */
	failed: readonly RateMeter[];
	/** Builder addrs or group identities the line reaches. */
	members: readonly string[];
	/** A pool line or "other clients": alone, its rows are its members. */
	group: boolean;
};

function sumRecent(hist: readonly RateMeter[], k: number, now: number): number {
	let s = 0;
	for (const h of hist) s += h.recent(k, now);
	return s;
}

function rowOf(l: DetailLine): EdgeRowView {
	return {
		edgeId: l.id,
		rate: round3(l.rate),
		total: l.total,
		finished: l.counts.finished,
		failed: l.counts.failed
	};
}

/** A candidate for a line's latest list. `at` orders it, newest first; 0 is unknown. */
type ItemCand = { rec: DrvRec; via: string; at: number; bytes: number; n: number };

/**
 * The `cap` newest candidates, in a min-heap on `at`, so a candidate older
 * than the oldest kept one costs one comparison and any other O(log cap),
 * whatever order they come in. Of equal times the first offered wins.
 * It drops repeated paths at the end, so a caller that gets fewer than it
 * needs while `evicted` is set asks again with a larger cap.
 */
class Newest {
	readonly #cap: number;
	readonly #h: ItemCand[] = [];
	#n = 0;
	/** A candidate was dropped for lack of room. */
	evicted = false;

	constructor(cap: number) {
		this.#cap = Math.max(1, Math.floor(cap));
	}

	offer(rec: DrvRec, via: string, at: number, bytes: number) {
		const h = this.#h;
		const n = this.#n++;
		if (h.length < this.#cap) {
			h.push({ rec, via, at, bytes, n });
			let i = h.length - 1;
			while (i > 0) {
				const p = (i - 1) >> 1;
				const x = h[i];
				if (!older(x, h[p])) break;
				h[i] = h[p];
				h[p] = x;
				i = p;
			}
			return;
		}
		this.evicted = true;
		// Ties go to the one offered first, which is already here.
		if (at <= h[0].at) return;
		// Reuse the evicted root's object, then sift it down.
		const c = h[0];
		c.rec = rec;
		c.via = via;
		c.at = at;
		c.bytes = bytes;
		c.n = n;
		let i = 0;
		for (;;) {
			const l = 2 * i + 1;
			if (l >= h.length) break;
			const m = l + 1 < h.length && older(h[l + 1], h[l]) ? l + 1 : l;
			const x = h[m];
			if (!older(x, c)) break;
			h[m] = c;
			h[i] = x;
			i = m;
		}
	}

	/** At most `limit`, newest first, each path once. */
	unique(limit: number): ItemCand[] {
		const sorted = this.#h.slice().sort((a, b) => b.at - a.at || a.n - b.n);
		const seen = new Set<string>();
		const out: ItemCand[] = [];
		for (const c of sorted) {
			if (out.length >= limit) break;
			if (seen.has(c.rec.path)) continue;
			seen.add(c.rec.path);
			out.push(c);
		}
		return out;
	}
}

/** Heap order: older first, and of equal times the one offered later. */
function older(a: ItemCand, b: ItemCand): boolean {
	return a.at < b.at || (a.at === b.at && a.n > b.n);
}

/** Offers a drv for the latest list of an assign, publish or fetch line. */
function offerBuild(flow: FlowKind, rec: DrvRec, via: string, top: Newest) {
	if (flow === 'assign') {
		top.offer(rec, via, rec.assignedMs, 0);
	} else if (flow === 'fetch') {
		const bytes = fetchedBytes(rec.inputSources, rec.worker);
		if (bytes > 0) top.offer(rec, via, rec.assignedMs, bytes);
	} else if (rec.phase === 'built') {
		const bytes = outputBytes(rec.outputs);
		if (bytes > 0) top.offer(rec, via, rec.finishedMs, bytes);
	}
}

function offerKey(systems: readonly string[], features: readonly string[]): string {
	return `${systems.join(' ')}|${features.join(' ')}`;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// Sorting all of them is fine at the sizes we see, a few thousand. This
// keeps the common small-limit case cheaper.
function topK<T>(items: T[], k: number, cmp: (a: T, b: T) => number): T[] {
	if (items.length <= k * 4) return items.sort(cmp).slice(0, k);
	const out: T[] = [];
	for (const it of items) {
		if (out.length < k) {
			out.push(it);
			if (out.length === k) out.sort(cmp);
			continue;
		}
		if (cmp(it, out[k - 1]) >= 0) continue;
		let lo = 0;
		let hi = k - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cmp(it, out[mid]) < 0) hi = mid;
			else lo = mid + 1;
		}
		out.splice(lo, 0, it);
		out.pop();
	}
	return out;
}
