// Scheduler facts that the reducer and the mock farm share: the Counters
// fields, and the queue rules of sched::Config with its default weights.

import { create } from '@bufbuild/protobuf';
import {
	CountersSchema,
	PoolSampleSchema,
	SubstituterTrafficSchema,
	type Counters,
	type PoolSample,
	type SubstituterTraffic
} from '#lib/gen/events_pb.ts';
import { compareCode } from './types.ts';

/** The fields of Counters, in proto order. */
export const COUNTER_KEYS = [
	'wanted',
	'cacheHits',
	'cacheMisses',
	'assigned',
	'built',
	'failed',
	'cancelled',
	'dropped',
	'requeued',
	'publishedBytes',
	'fetchedBytesEstimate',
	'graphDrvs',
	'graphPrunedDrvs'
] as const;

export type CounterValues = Record<(typeof COUNTER_KEYS)[number], number>;

/** What builders took from one substituter: NAR bytes, bytes on the wire, paths and failures. */
export type SubstituterCounts = Readonly<{
	nar: number;
	download: number;
	paths: number;
	failures: number;
}>;

export const ZERO_SUBSTITUTER: SubstituterCounts = Object.freeze({
	nar: 0,
	download: 0,
	paths: 0,
	failures: 0
});

export const NO_SUBS: ReadonlyMap<string, SubstituterCounts> = new Map();

/**
 * The connected builders of one native system at a sample: as Stats counts
 * slots, and the summed load of those that report it, null while none does.
 * CPUs, not millicores.
 */
export type PoolCounts = HostLoad &
	Readonly<{
		up: number;
		running: number;
		slots: number;
		free: number;
	}>;

/** A pool's counts while builders are added to it. */
export type PoolTally = { -readonly [K in keyof PoolCounts]: PoolCounts[K] };

/** A pool with no builder counted yet. */
export function newPool(): PoolTally {
	return {
		up: 0,
		running: 0,
		slots: 0,
		free: 0,
		cpuBusy: null,
		cpuIowait: null,
		cpuCores: null,
		memUsed: null,
		memTotal: null
	};
}

/** Adds a builder's load to its pool's: each pair while the builder reports it. */
export function addLoad(p: PoolTally, l: HostLoad): void {
	if (l.cpuBusy !== null && l.cpuCores !== null) {
		p.cpuBusy = (p.cpuBusy ?? 0) + l.cpuBusy;
		// Only where the host measures it: macOS does not.
		if (l.cpuIowait !== null) p.cpuIowait = (p.cpuIowait ?? 0) + l.cpuIowait;
		p.cpuCores = (p.cpuCores ?? 0) + l.cpuCores;
	}
	if (l.memUsed !== null && l.memTotal !== null) {
		p.memUsed = (p.memUsed ?? 0) + l.memUsed;
		p.memTotal = (p.memTotal ?? 0) + l.memTotal;
	}
}

/** Counter values at one time, with the per-substituter counts. */
export type CounterSample = {
	t: number;
	c: CounterValues;
	subs: ReadonlyMap<string, SubstituterCounts>;
	/** Keyed by native system. Absent where the scheduler sent none: older ones, and its first sample. */
	pools?: ReadonlyMap<string, PoolCounts>;
	/** The page took it from Stats, not from Reset.history. */
	fromPage?: boolean;
};

/** A sample's pools, or undefined for an empty list. */
export function poolsFromProto(
	list: readonly PoolSample[]
): ReadonlyMap<string, PoolCounts> | undefined {
	if (list.length === 0) return undefined;
	const out = new Map<string, PoolCounts>();
	for (const p of list) {
		out.set(p.system, {
			up: p.buildersUp,
			running: p.running,
			slots: p.slots,
			free: p.free,
			...loadFromProto(p)
		});
	}
	return out;
}

/** A sample's pools as the proto has them, sorted by system. */
export function poolsToProto(pools: ReadonlyMap<string, PoolCounts> | undefined): PoolSample[] {
	if (!pools) return [];
	return [...pools]
		.sort((a, b) => compareCode(a[0], b[0]))
		.map(([system, p]) =>
			create(PoolSampleSchema, {
				system,
				buildersUp: p.up,
				running: p.running,
				slots: p.slots,
				free: p.free,
				...loadToProto(p)
			})
		);
}

/**
 * A substituter URL as scheme://host[:port]/path: without user, password,
 * query or fragment, which can hold credentials. A store reference without
 * "://", such as daemon, local, auto and "other", keeps its text up to the
 * first '?'. The builder's reduction in the patch series drops the same parts, and
 * also lower-cases scheme and host, trims trailing slashes and cuts the URL
 * at 256 bytes. This one does only the dropping, to keep credentials off the
 * page if a server sends them; a URL the server reduced comes back unchanged.
 */
export function reduceSubstituterUrl(url: string): string {
	const sep = url.indexOf('://');
	if (sep < 0) {
		const q = url.indexOf('?');
		return q < 0 ? url : url.slice(0, q);
	}
	const start = sep + 3;
	let end = url.length;
	for (const c of ['?', '#']) {
		const i = url.indexOf(c, start);
		if (i >= 0 && i < end) end = i;
	}
	const slash = url.indexOf('/', start);
	const hostEnd = slash >= 0 && slash < end ? slash : end;
	const at = url.lastIndexOf('@', hostEnd - 1);
	const hostStart = at >= start ? at + 1 : start;
	if (hostStart === start && end === url.length) return url;
	return url.slice(0, start) + url.slice(hostStart, end);
}

/**
 * Per-URL counts as plain numbers, an empty map when there are none.
 * reduceSubstituterUrl reduces the URLs, and two that reduce to one add up.
 */
export function substitutersFromProto(
	list: readonly SubstituterTraffic[] | undefined
): ReadonlyMap<string, SubstituterCounts> {
	if (!list?.length) return NO_SUBS;
	const out = new Map<string, SubstituterCounts>();
	for (const s of list) {
		const url = reduceSubstituterUrl(s.url);
		const was = out.get(url) ?? ZERO_SUBSTITUTER;
		out.set(url, {
			nar: was.nar + Number(s.narBytes),
			download: was.download + Number(s.downloadBytes),
			paths: was.paths + Number(s.paths),
			failures: was.failures + Number(s.failures)
		});
	}
	return out;
}

/** Per-URL counts as the proto has them, sorted by URL. */
export function substitutersToProto(
	subs: ReadonlyMap<string, SubstituterCounts>
): SubstituterTraffic[] {
	return [...subs]
		.sort((a, b) => compareCode(a[0], b[0]))
		.map(([url, c]) =>
			create(SubstituterTrafficSchema, {
				url,
				narBytes: BigInt(Math.round(c.nar)),
				downloadBytes: BigInt(Math.round(c.download)),
				paths: BigInt(Math.round(c.paths)),
				failures: BigInt(Math.round(c.failures))
			})
		);
}

export const ZERO_COUNTERS: Readonly<CounterValues> = Object.freeze(
	Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as CounterValues
);

/** Counters as plain numbers, zeros when absent. */
export function countersFromProto(c: Counters | undefined): CounterValues {
	const out = { ...ZERO_COUNTERS };
	if (c) for (const k of COUNTER_KEYS) out[k] = Number(c[k]);
	return out;
}

export function countersToProto(v: Readonly<CounterValues>): Counters {
	const c = create(CountersSchema);
	for (const k of COUNTER_KEYS) c[k] = BigInt(Math.round(v[k]));
	return c;
}

// sched::Config defaults, in cp_hint ms: per ms waited, and per extra follower.
const AGE_WEIGHT = 4;
const FANIN_WEIGHT = 30_000;

/**
 * The scheduler's queue priority, higher first: the cp_hint, plus 30 s per
 * extra follower, plus 4 ms per ms waited since `queuedMs`.
 */
export function priority(cpHintMs: number, followers: number, queuedMs: number): number {
	return cpHintMs + FANIN_WEIGHT * Math.max(0, followers - 1) - AGE_WEIGHT * queuedMs;
}

/** Whether a builder can take a drv: it offers the drv's system and every feature it needs. */
export function offers(
	systems: readonly string[],
	features: readonly string[],
	system: string,
	needs: readonly string[]
): boolean {
	return systems.includes(system) && needs.every((f) => features.includes(f));
}

/** A builder's or a pool's host: busy CPUs and CPUs, bytes in use and in all. null where not reported. */
export type HostLoad = Readonly<{
	/** CPUs busy, and CPUs idle with I/O of theirs outstanding: each the average over about a minute. */
	cpuBusy: number | null;
	cpuIowait: number | null;
	cpuCores: number | null;
	memUsed: number | null;
	memTotal: number | null;
}>;

/** The load fields of a WorkerState, as the proto names them. */
type LoadFields = {
	cpuBusyMillicores?: bigint;
	cpuIowaitMillicores?: bigint;
	cpuCores?: number;
	memUsedBytes?: bigint;
	memTotalBytes?: bigint;
};

/** The load of a WorkerState: each pair of fields, or null. CPUs, not millicores. */
export function loadFromProto(x: LoadFields): HostLoad {
	const cpu = x.cpuBusyMillicores !== undefined && x.cpuCores !== undefined;
	const mem = x.memUsedBytes !== undefined && x.memTotalBytes !== undefined;
	return {
		cpuBusy: cpu ? Number(x.cpuBusyMillicores) / 1000 : null,
		cpuIowait:
			cpu && x.cpuIowaitMillicores !== undefined ? Number(x.cpuIowaitMillicores) / 1000 : null,
		cpuCores: cpu ? x.cpuCores! : null,
		memUsed: mem ? Number(x.memUsedBytes) : null,
		memTotal: mem ? Number(x.memTotalBytes) : null
	};
}

/** The same fields for a load, as the demo farm sends them. */
export function loadToProto(l: HostLoad): LoadFields {
	return {
		...(l.cpuBusy !== null && l.cpuCores !== null
			? { cpuBusyMillicores: BigInt(Math.round(l.cpuBusy * 1000)), cpuCores: l.cpuCores }
			: {}),
		...(l.cpuBusy !== null && l.cpuIowait !== null
			? { cpuIowaitMillicores: BigInt(Math.round(l.cpuIowait * 1000)) }
			: {}),
		...(l.memUsed !== null && l.memTotal !== null
			? {
					memUsedBytes: BigInt(Math.round(l.memUsed)),
					memTotalBytes: BigInt(Math.round(l.memTotal))
				}
			: {})
	};
}
