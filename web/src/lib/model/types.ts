// Contract between the UI and the data layer: the sources, the reducer and
// the store. The UI reads only these types; the data layer may change freely
// behind them.

import type { Farm, FarmAuth } from '#lib/farm/farm.ts';
import type { LogBackend } from '#lib/source/types.ts';

/** Connection state of the current session, shown in the header. */
export type ConnectionStatus =
	| { kind: 'connecting'; attempt: number }
	/** Stream open, snapshot not complete yet. */
	| { kind: 'syncing' }
	| { kind: 'live'; sinceMs: number }
	/**
	 * Lost the stream or saw a seq gap, and retries with backoff. reason busy:
	 * the farm turned the stream away for its limits; refused: for its setup,
	 * which the error says how to fix.
	 */
	| {
			kind: 'retrying';
			attempt: number;
			retryAtMs: number;
			error: string;
			reason?: 'busy' | 'refused';
	  }
	/**
	 * The auth proxy in front of the farm no longer lets this browser through,
	 * most likely because its session ended. A reload signs in again. No retries.
	 */
	| { kind: 'signed-out' }
	/** Signed in, but the farm does not grant the watch role. No retries. */
	| { kind: 'denied'; error: string }
	| { kind: 'stopped' };

/** Kinds of traffic drawn as lines. */
export type FlowKind =
	/** client group to scheduler: Wants per second */
	| 'want'
	/** scheduler to cache: cache hits per second */
	| 'cached'
	/** scheduler to builder: assignments per second */
	| 'assign'
	/** builder to cache: output bytes published per second */
	| 'publish'
	/** cache to builder: estimated input bytes fetched per second */
	| 'fetch'
	/** upstream substituters to builder: input NAR bytes per second, as builders measure them */
	| 'substitute';

export type RateUnit = 'builds' | 'bytes';

/** Node ids on the map. */
export const SCHEDULER_ID = 'scheduler';
export const CACHE_ID = 'cache';
/** The upstream substituters card. */
export const UPSTREAM_ID = 'upstream';
const WORKER_PREFIX = 'worker:';
const CLIENTS_PREFIX = 'clients:';
const POOL_PREFIX = 'pool:';
export const workerNodeId = (addr: string) => `${WORKER_PREFIX}${addr}`;
export const clientGroupNodeId = (group: string) => `${CLIENTS_PREFIX}${group}`;
/** A collapsed group of builders: all builders of one native system. */
export const poolNodeId = (system: string) => `${POOL_PREFIX}${system}`;

/** Native system of builders that report none, as pools and headings name it. */
const UNKNOWN_SYSTEM = 'unknown system';

/** The pool a builder belongs to: its native system. */
export const poolOf = (nativeSystem: string) => nativeSystem || UNKNOWN_SYSTEM;

/** What a map node id names. */
export type NodeRef =
	| { kind: 'scheduler' }
	| { kind: 'cache' }
	| { kind: 'upstream' }
	| { kind: 'builder'; addr: string }
	| { kind: 'pool'; system: string }
	| { kind: 'clients'; group: string };

/** The node behind a map node id, or null for headings and placeholders. */
export function parseNodeId(id: string): NodeRef | null {
	if (id === SCHEDULER_ID) return { kind: 'scheduler' };
	if (id === CACHE_ID) return { kind: 'cache' };
	if (id === UPSTREAM_ID) return { kind: 'upstream' };
	if (id.startsWith(WORKER_PREFIX))
		return { kind: 'builder', addr: id.slice(WORKER_PREFIX.length) };
	if (id.startsWith(CLIENTS_PREFIX))
		return { kind: 'clients', group: id.slice(CLIENTS_PREFIX.length) };
	if (id.startsWith(POOL_PREFIX)) return { kind: 'pool', system: id.slice(POOL_PREFIX.length) };
	return null;
}

/**
 * Edge ids are `${kind}:${endpoint}`, where the endpoint is a client group
 * id, worker addr, pool node id or 'scheduler'.
 */
export const edgeId = (kind: FlowKind, endpoint: string) => `${kind}:${endpoint}`;

/** Client group id for identities beyond the shown ones. */
export const OTHER_CLIENTS = '__other';

/** How long a disconnected builder stays in the topology. */
export const WORKER_LINGER_MS = 10 * 60_000;

/** Natural order: numbers inside strings compare by value, so 10.0.0.9 sorts before 10.0.0.10. */
export const compareNatural = new Intl.Collator('en', { numeric: true }).compare;

/** Code-unit order, for ids and URLs. */
export const compareCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What exists on the map. Changes only when builders or client groups come
 * and go, so the UI can rebuild Svelte Flow nodes from it without churn.
 */
export type Topology = Readonly<{
	/** Bumped on every change, including a builder changing its native system. */
	version: number;
	/** Shown client groups, busiest first, OTHER_CLIENTS last if present. */
	clientGroups: readonly string[];
	/** Worker addrs, sorted by native system then addr. Includes recently gone ones. */
	workers: readonly string[];
	/** Native system of each worker in `workers`, '' when it reports none. */
	workerSystems: readonly string[];
	/**
	 * Workers in `workers` that disconnected while draining, other than for
	 * low disk, so they left on purpose. Pools leave them out; as cards they
	 * show as offline.
	 */
	retired: readonly string[];
	hasCache: boolean;
	/**
	 * Workers in `workers` that list at least one upstream substituter. They
	 * get substitute lines, and pools with one of them do too.
	 */
	upstreamWorkers: readonly string[];
	/** Rows the upstream card lists: upstream URLs (at most 8), plus the farm cache row. */
	upstreamRows: number;
}>;

/** The upstream card and its lines show. */
export function hasUpstream(t: Pick<Topology, 'upstreamWorkers'>): boolean {
	return t.upstreamWorkers.length > 0;
}

/** Upstream substituters the card lists before "+N more". */
export const UPSTREAM_CARD_ROWS = 8;

/** Why a builder drains. 'unknown': it does not say. */
export type DrainReason = 'stopping' | 'low-disk' | 'local-daemon' | 'unknown';

export type WorkerView = Readonly<{
	addr: string;
	/** Native system first. */
	systems: readonly string[];
	features: readonly string[];
	maxJobs: number;
	/** Assigned slots in use. The scheduler cannot tell assigned from building. */
	running: number;
	up: boolean;
	draining: boolean;
	/**
	 * Disconnected while draining, unless for low disk: taken out on purpose,
	 * as when an autoscaler scales in.
	 */
	retired: boolean;
	/**
	 * When this page saw it go offline, browser time. null while connected,
	 * and when nobody knows since when: it was offline in the first snapshot,
	 * or went down while the page was not watching. Fixed, so the view keeps
	 * its identity; the age is worked out where it shows.
	 */
	goneAt: number | null;
	/** null unless draining. */
	drainReason: DrainReason | null;
	/** Bytes of the store's file system, as last reported. null: never reported. */
	diskFree: number | null;
	diskTotal: number | null;
	/** --min-free in bytes, 0 for none. */
	minFree: number;
	/** nix-grpc-store version, '' when the builder does not report it. */
	version: string;
	/**
	 * Upstream substituters it has configured, in its order, reduced to
	 * scheme://host/path. The farm cache is left out when the scheduler names it.
	 */
	substituters: readonly string[];
	/** Recent outcomes, per minute. */
	builtPerMin: number;
	failedPerMin: number;
	/**
	 * Queued derivations this worker could take: their system is one of its
	 * systems and it has every feature they need. Unplaceable ones do not count.
	 */
	queuedCanTake: number;
}>;

export type BuilderState = 'up' | 'draining' | 'offline';

/** Whether a builder takes work, drains, or is gone. A missing view counts as offline. */
export function builderState(w: WorkerView | undefined): BuilderState {
	return !w || !w.up ? 'offline' : w.draining ? 'draining' : 'up';
}

/** Share of a builder's slots in use, 0 to 1. */
export function loadOf(w: WorkerView | undefined): number {
	return w && w.maxJobs > 0 ? Math.min(1, w.running / w.maxJobs) : 0;
}

/** Samples of the queue size, one a second, behind SchedulerView.queuedPerMin: a minute's worth. */
export const QUEUE_TREND_SAMPLES = 61;

/** How long pools count builders joining and leaving. */
export const POOL_CHURN_MINUTES = 5;

/**
 * The builders of one native system, summed. Drawn as one node when collapsed.
 * It leaves out retired builders, which disconnected while draining. They
 * count only under `left`.
 */
export type PoolView = Readonly<{
	/** Native system, or UNKNOWN_SYSTEM. */
	system: string;
	/** up + draining + offline. */
	builders: number;
	/** Connected and taking work. */
	up: number;
	/** Connected and draining. */
	draining: number;
	/** Of those, the ones low on disk, stopping, and with no nix-daemon. */
	drainingLowDisk: number;
	drainingStopping: number;
	drainingLocalDaemon: number;
	/** Disconnected without draining first, still shown for WORKER_LINGER_MS. */
	offline: number;
	/**
	 * Assigned slots in use, summed over the pool's builders, draining ones
	 * included: the sum of its cards. The scheduler's own slot count leaves
	 * draining builders out.
	 */
	running: number;
	/** Slots of connected builders, draining ones included. */
	slots: number;
	/**
	 * Queued derivations some builder of the pool could take: a system and
	 * every feature it needs. Unplaceable ones do not count.
	 */
	queuedCanTake: number;
	/** Features and how many builders offer each, most common first. */
	features: readonly Readonly<{ name: string; builders: number }>[];
	/** Builders that connected or came back, and that disconnected, within POOL_CHURN_MINUTES. */
	joined: number;
	left: number;
	/** Where churn counts start while the churn window reaches back before the page was watching. */
	churnSince: Coverage | null;
}>;

export type ClientGroupView = Readonly<{
	id: string;
	/** Identity, a cert CN or oidc:<provider>:<sub>, or "other clients". */
	label: string;
	/** Open Schedule streams. */
	clients: number;
	/** Derivations they are waiting on right now. */
	waiting: number;
	wantsPerSec: number;
}>;

export type SchedulerView = Readonly<{
	/** All queued derivations, unplaceable ones included, as Stats counts them. */
	queued: number;
	unplaceable: number;
	assigned: number;
	workersUp: number;
	clients: number;
	slots: number;
	free: number;
	assignedPerSec: number;
	/**
	 * How fast `queued` grew over the last minute, per minute, negative while
	 * it shrinks, from QUEUE_TREND_SAMPLES samples a second apart. Null until
	 * the reducer has them all.
	 */
	queuedPerMin: number | null;
	/** Queue per system and feature set, unplaceable rows first, then the busiest. */
	systems: readonly SystemQueueView[];
}>;

export type SystemQueueView = Readonly<{
	system: string;
	features: string;
	queued: number;
	unplaceable: number;
	running: number;
	slots: number;
	free: number;
}>;

export type CacheView = Readonly<{
	url: string;
	/** Scheduler cache lookups only: clients skip outputs they already found in the cache. */
	hitsPerSec: number;
	missesPerSec: number;
	/** hits / (hits + misses) over the totals window, or null without lookups. */
	hitRatio: number | null;
	publishedBytesPerSec: number;
	/** An estimate that can be too high or too low. See Counters.fetched_bytes_estimate in the proto. */
	fetchedBytesPerSec: number;
}>;

/** Live traffic of one edge. The layout knows its kind and ends from its id. */
export type EdgeView = Readonly<{
	/** Per second, in `unit`. Smoothed. */
	rate: number;
	unit: RateUnit;
	/**
	 * Assign and want lines, pool lines included: builds that ended on the
	 * line within the totals window, built or failed, and how many failed.
	 * 0 on other kinds.
	 */
	finished: number;
	failed: number;
}>;

/** failed / finished, or null when nothing finished. */
export function failShare(e: Pick<EdgeView, 'finished' | 'failed'>): number | null {
	return e.finished > 0 ? e.failed / e.finished : null;
}

const FLOW_KINDS: ReadonlySet<string> = new Set<FlowKind>([
	'want',
	'cached',
	'assign',
	'publish',
	'fetch',
	'substitute'
]);

/** Kind and endpoint of an edge id, split at the first ':'. null when the kind is unknown. */
export function parseEdgeId(id: string): { flow: FlowKind; endpoint: string } | null {
	const at = id.indexOf(':');
	if (at < 0) return null;
	const flow = id.slice(0, at);
	return FLOW_KINDS.has(flow) ? { flow: flow as FlowKind, endpoint: id.slice(at + 1) } : null;
}

/** History of one line or bundle, in whole buckets. */
export type EdgeSeries = Readonly<{
	/** Browser clock at the start of the first bucket. */
	startMs: number;
	bucketMs: number;
	/** Per second in each whole bucket, oldest first. null where this page had no live stream. */
	values: readonly (number | null)[];
	/** Assign and want lines: failed builds per second in each bucket. null on other kinds. */
	failed: readonly (number | null)[] | null;
}>;

export type EdgeItemView = Readonly<{
	drv: DrvView;
	/** The builder, group or cache hits line the item came from. Pass it to drv(path, via). */
	via: string;
	/** Browser clock: assigned for assign and fetch, finished for publish, wanted for want, answered for cached. */
	atMs: number | null;
	/** publish: output bytes. fetch: estimated input bytes. 0 otherwise. */
	bytes: number;
}>;

export type EdgeRowView = Readonly<{
	/** The line this row narrows to. A builder inside a collapsed pool has no drawn line, but its id works. */
	edgeId: string;
	rate: number;
	/** Within the window, in the line's unit. */
	total: number;
	finished: number;
	failed: number;
}>;

export type EdgeDetailView = Readonly<{
	edgeIds: readonly string[];
	flow: FlowKind;
	unit: RateUnit;
	/** Builders or client groups the lines reach. A pool line counts its builders. */
	count: number;
	rate: number;
	windowMinutes: number;
	/** Within the window, current bucket included: assignments, wants, hits or bytes. */
	total: number;
	finished: number;
	failed: number;
	series: EdgeSeries;
	/** Where the counts start, while the window reaches back before this page's first live data. */
	since: Coverage | null;
	/**
	 * Busiest first. A bundle has one row per line, a pool line or
	 * "other clients" one per member. Empty for a builder or group line.
	 */
	rows: readonly EdgeRowView[];
	/** Newest first, at most `itemsLimit`, each path once. */
	items: readonly EdgeItemView[];
	/** Fetch lines carry estimates, from Counters.fetched_bytes_estimate. */
	estimate: boolean;
}>;

/** Header totals over the selected window. */
export type Totals = Readonly<{
	windowMinutes: number;
	/** Current. */
	queued: number;
	running: number;
	/** Within the window. */
	built: number;
	failed: number;
	cached: number;
	/** Where the counts start, while the window reaches back further than the data we have. */
	since: Coverage | null;
}>;

/**
 * Where a window's counts start when they cover less of it: when this page
 * went live, when the scheduler started, or at the oldest sample of the
 * scheduler's history.
 */
export type Coverage = Readonly<{
	/** Browser clock. */
	fromMs: number;
	cause: 'page' | 'restart' | 'history';
}>;

export type DrvPhase =
	| 'queued'
	| 'unplaceable'
	| 'assigned'
	| 'built'
	| 'failed'
	| 'cancelled'
	| 'dropped'
	| 'cached';

export type InputSourceView = Readonly<{
	workerAddr: string;
	paths: number;
	narBytes: number;
	/** Built on the worker this drv is assigned to. */
	local: boolean;
}>;

/** The "<name>" of "<hash>-<name>.drv". */
export function drvName(path: string): string {
	let s = path.slice(path.lastIndexOf('/') + 1);
	if (s.endsWith('.drv')) s = s.slice(0, -4);
	return /^[0-9a-z]{32}-./.test(s) ? s.slice(33) : s;
}

/** Nix's result of a build, as the builder reports it. */
export type BuildStatus =
	| 'built'
	| 'substituted'
	| 'already-valid'
	| 'build-failed'
	| 'timed-out'
	| 'log-limit'
	| 'output-rejected'
	| 'input-rejected'
	| 'not-deterministic'
	| 'dependency-failed'
	| 'transient'
	| 'cached-failure'
	| 'no-substituters'
	| 'misc'
	| 'worker-error';

export type DrvView = Readonly<{
	drvPath: string;
	/** drvPath without the hash and ".drv". */
	name: string;
	phase: DrvPhase;
	system: string;
	features: readonly string[];
	workerAddr: string | null;
	clientIds: readonly number[];
	/** Identities of those clients, deduplicated. */
	identities: readonly string[];
	/** Unix ms in the browser's clock, with the server offset applied. null when unknown. */
	queuedMs: number | null;
	assignedMs: number | null;
	finishedMs: number | null;
	/**
	 * finishedMs on the scheduler's clock, for links. It does not move as the
	 * page's estimate of the clock offset settles, and means the same on any
	 * machine.
	 */
	finishedServerMs: number | null;
	cpHintMs: number;
	inputs: number;
	inputSources: readonly InputSourceView[];
	inputsUnknown: number;
	/** Input bytes from other builders, so fetched from the cache. An estimate. */
	fetchedBytes: number;
	/** The scheduler asked the cache. A cached drv was a hit; any other phase means it missed. */
	cacheChecked: boolean;
	outputs: readonly Readonly<{ path: string; narSize: number }>[];
	/** NAR bytes of all outputs. */
	outputBytes: number;
	/** Unplaceable or requeue reason. */
	reason: string | null;
	/** Built and failed drvs whose builder reported it, else null. */
	status: BuildStatus | null;
	/** Failed drvs: the builder sent error text. */
	errorSent: boolean;
	/** That text, while the dashboard keeps it, for the newest ERRORS_KEPT failures. */
	errorText: string | null;
	/** DrvState.assign_id of the current or last assignment, 0 when unknown. */
	assignId: number;
	/** Assigned only, as the builder reported it: its last stdenv phase. */
	buildPhase: string | null;
	/** When that phase began. null with no phase. */
	buildPhaseStartedMs: number | null;
	/** When the build started on the builder. null: not reported or not started. */
	buildStartedMs: number | null;
	/**
	 * The builder has reported a start for some build since the page
	 * connected, so a null buildStartedMs means "not started yet", not "unknown".
	 */
	reportsStarts: boolean;
}>;

/** Failed builds whose error text the dashboard keeps, newest first. */
export const ERRORS_KEPT = 256;

/** A build that ran on a builder: in progress, or finished. */
export type BuildState = 'assigned' | 'built' | 'failed' | 'cancelled' | 'dropped';

/** One row of the build list. Times are browser clock, ms. */
export type BuildRow = Readonly<{
	drvPath: string;
	name: string;
	system: string;
	/** The builder's address. */
	worker: string;
	/** DrvState.assign_id. 0 when unknown. */
	assignId: number;
	state: BuildState;
	/** Nix's status, when the builder said. */
	status: BuildStatus | null;
	/**
	 * Failed only: the line the row shows, at most 200 characters, found
	 * once from the error text when the row arrived. null: no text came.
	 */
	errorLine: string | null;
	/** null when unknown, as for a build adopted after a scheduler restart. */
	assignedMs: number | null;
	/** When the build started on the builder. null: not reported or not started. */
	startedMs: number | null;
	/**
	 * Assigned only: this builder has reported a start for some build since
	 * the page connected, so a null startedMs means "not started yet".
	 */
	reportsStarts: boolean;
	finishedMs: number | null;
	/**
	 * finishedMs on the scheduler's clock, for links. It does not move as the
	 * page's estimate of the clock offset settles, and means the same on any
	 * machine.
	 */
	finishedServerMs: number | null;
	/** Assigned only, as the builder reported them. */
	phase: string | null;
	phaseStartedMs: number | null;
	/** Identities of the clients that waited on it, at most 4 for history rows. */
	requestedBy: readonly string[];
	/** 'history' rows came from the scheduler's rings through Events.RecentBuilds. */
	from: 'live' | 'history';
}>;

/** The key of one build: a derivation can be built again. */
export const buildKey = (path: string, assignId: number) => `${path}#${assignId}`;

export type BuildStateFilter = 'failed' | 'assigned' | 'built' | 'other';

export type BuildQuery = Readonly<{
	/** Empty: all. 'other' is cancelled and dropped. */
	states: ReadonlySet<BuildStateFilter>;
	system: string | null;
	builder: string | null;
	/** A pool, by its native system. */
	pool: string | null;
	/** A client identity. OTHER_CLIENTS: identities outside the client groups shown. */
	client: string | null;
	/** A name, a hash prefix or a pasted /nix/store/…drv path. */
	q: string;
	/**
	 * Finished within this many ms of the query's time, so the window slides
	 * as a list stays open. Assigned builds always pass.
	 */
	withinMs: number | null;
	sort: 'failures' | 'newest' | 'longest';
}>;

export type BuildCounts = Readonly<{
	failed: number;
	assigned: number;
	built: number;
	other: number;
}>;

export type BuildsCoverage = Readonly<{
	/** The oldest finish time the page holds, or when the page connected; null before either. */
	sinceMs: number | null;
	/** scheduler: rows from its rings reach back further than the page. page: only since it connected. */
	source: 'scheduler' | 'page';
	/** The scheduler holds nothing older. */
	complete: boolean;
	/** The page's rings are full, so older rows would push out newer ones. */
	full: boolean;
	loading: boolean;
	/** A new scheduler took over at this time, browser ms, and keeps builds from then on. */
	restartMs: number | null;
}>;

export type BuildsView = Readonly<{
	rows: readonly BuildRow[];
	/** Rows by state under every filter but the states. */
	counts: BuildCounts;
	facets: Readonly<{
		systems: readonly string[];
		builders: readonly Readonly<{ addr: string; pool: string | null }>[];
		clients: readonly string[];
	}>;
	coverage: BuildsCoverage;
}>;

/** One finished build from the scheduler, error text included, for the log viewer. */
export type FinishedBuildView = BuildRow & Readonly<{ errorText: string | null }>;

/** Builds the page keeps that finished on a builder, and failures among them. */
export const BUILDS_KEPT = 10_000;
export const FAILURES_KEPT = 2_000;

export type FarmMeta = Readonly<{
	instance: string;
	version: string;
	defaultSystem: string;
	cacheUrl: string;
	/** Reset.cache_substituter_url: the farm cache as builders list it. '' when not named. */
	cacheSubstituterUrl: string;
	/** Browser clock. */
	servingSinceMs: number;
}>;

/** One upstream substituter, over the farm's builders. */
export type SubstituterView = Readonly<{
	/** Reduced URL, as builders report it. */
	url: string;
	/** Connected builders that list it. */
	builders: number;
	narBytesPerSec: number;
	/** Within the header window, from the Counters history. */
	narBytes: number;
	downloadBytes: number;
	paths: number;
	failures: number;
}>;

export type UpstreamView = Readonly<{
	/** Every upstream one, by narBytes, then builders, then URL. The card shows the first 8. */
	substituters: readonly SubstituterView[];
	narBytesPerSec: number;
	/** Within the header window. */
	narBytes: number;
	/** Connected builders that list at least one. */
	builders: number;
	/** Of those, the ones with traffic now. */
	downloading: number;
	/** Connected builders that do not report their substituters, with an empty version. */
	unreported: number;
	/** Where the window's totals start, while the window reaches back before the data. */
	since: Coverage | null;
	/** The farm cache's own row, when the scheduler names it. */
	farmCache: SubstituterView | null;
}>;

/** One substituter of one builder. */
export type BuilderSubstituterView = Readonly<{
	url: string;
	narBytesPerSec: number;
	/** Since the scheduler started serving. */
	narBytes: number;
	paths: number;
	failures: number;
}>;

/**
 * Live state of one farm, published at most once per animation frame. Every
 * field is replaced, never mutated, when it changes, and unchanged map entries
 * keep their identity, so `$derived` cuts off unchanged parts.
 */
export interface FarmStore {
	readonly status: ConnectionStatus;
	/** null until the first snapshot. */
	readonly meta: FarmMeta | null;
	readonly topology: Topology;
	/** Keyed by addr. */
	readonly workers: ReadonlyMap<string, WorkerView>;
	/** Keyed by group id. */
	readonly clientGroups: ReadonlyMap<string, ClientGroupView>;
	readonly scheduler: SchedulerView;
	readonly cache: CacheView | null;
	/** Keyed by native system, UNKNOWN_SYSTEM for none, one per system in the topology. */
	readonly pools: ReadonlyMap<string, PoolView>;
	/** null while no builder lists an upstream substituter. */
	readonly upstream: UpstreamView | null;
	/**
	 * Keyed by edge id. Has the edges of every builder and of every pool, so
	 * the line canvas can draw either; it scales widths by the lines it draws.
	 */
	readonly edges: ReadonlyMap<string, EdgeView>;
	readonly totals: Totals;
	/**
	 * Set while the totals window starts before this page's first live data.
	 * Line counts, EdgeView's finished and failed, start there, so they cover
	 * less than the window even when the header totals cover all of it.
	 */
	readonly linesSince: Coverage | null;
	/** Bumped on every publish. Drill-down panels re-query when it changes. */
	readonly frame: number;

	setWindowMinutes(minutes: number): void;

	// Drill-down queries. Computed on demand from the current state; cheap
	// enough to call a few times per second, not per frame for thousands of
	// items. While a new snapshot streams in, they repeat their last answer
	// from the last complete state.
	/** `via` names the line a list row came from, so a drv that left the recent ring still opens. */
	drv(drvPath: string, via?: string): DrvView | undefined;
	/** One line by its id, or a bundle of several ids of one kind. undefined when no id is known. */
	edgeDetail(edgeIds: readonly string[], itemsLimit?: number): EdgeDetailView | undefined;
	/** Assigned to this worker, newest first, then its recent finished ones. */
	drvsForWorker(addr: string, limit?: number): DrvView[];
	/** Waited on by clients of this group. */
	drvsForClientGroup(group: string, limit?: number): DrvView[];
	/**
	 * Any client group the scheduler still has, whether it is drawn or folded
	 * into "other clients". undefined once its clients left and it went idle.
	 */
	clientGroup(group: string): ClientGroupView | undefined;
	/** Queued and unplaceable, highest priority first. */
	drvsQueued(limit?: number): DrvView[];
	/** Recently cached, published or fetched, newest first. */
	drvsForCache(limit?: number): DrvView[];
	/** A builder's upstream substituters in its order, then others it used. */
	substitutersOf(addr: string): readonly BuilderSubstituterView[];
	/** The build list: builds in progress, then the finished ones the page keeps. */
	builds(query: BuildQuery): BuildsView;
	/**
	 * One build of the list: in progress or kept. `assignId` 0: the newest
	 * of the derivation. undefined when the page has none.
	 */
	build(drvPath: string, assignId: number): BuildRow | undefined;
	/** Load the scheduler's recent builds, once per scheduler instance. */
	ensureHistory(): void;
	/**
	 * Ask the scheduler for older rows. Does nothing while a load runs, after
	 * the scheduler said it has nothing older, or once the page's rings are full.
	 */
	loadOlderBuilds(failedOnly: boolean): void;
	/**
	 * One finished build from the scheduler, error text included, for a log
	 * opened from a link or a history row. null: the scheduler has none.
	 */
	finishedBuild(drvPath: string, signal: AbortSignal): Promise<FinishedBuildView | null>;
	/** A time on the scheduler's clock, such as a link's, on the browser's. */
	browserMs(serverMs: number): number;
}

/** A running connection to a farm, live or mock. */
export interface FarmSession {
	readonly store: FarmStore;
	readonly mode: 'live' | 'mock';
	/** Where build logs come from. */
	readonly logs: LogBackend;
	stop(): void;
	/** Live sessions: skip the current reconnect wait, for a "Retry now" button. */
	retryNow?(): void;
}

export type { Farm, FarmAuth };

export type AppError = Readonly<{
	/** Short headline. */
	title: string;
	/** What happened and what to try. */
	detail: string;
}>;

/** A problem worded for the user. The app shows its title and detail as they are. */
export class UserError extends Error implements AppError {
	constructor(
		readonly title: string,
		readonly detail: string,
		options?: { cause?: unknown }
	) {
		super(`${title}: ${detail}`, options);
	}
}

/** The message of any thrown value. */
export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** What the root page shows. */
export type AppPhase =
	/** Fetching dashboard.json. */
	| { kind: 'loading' }
	/** No farm serves this copy, as on the dev server or a static host. */
	| { kind: 'no-farm' }
	| { kind: 'error'; error: AppError }
	/** farm is null in the demo. */
	| { kind: 'session'; farm: Farm | null; farmName: string; session: FarmSession };
