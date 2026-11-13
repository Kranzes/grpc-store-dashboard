// Scheduler facts that the reducer and the mock farm share: the Counters
// fields, and the queue rules of sched::Config with its default weights.

import { create } from '@bufbuild/protobuf';
import {
	CountersSchema,
	SubstituterTrafficSchema,
	type Counters,
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
	'fetchedBytesEstimate'
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

/** Counter values at one time, with the per-substituter counts. */
export type CounterSample = {
	t: number;
	c: CounterValues;
	subs: ReadonlyMap<string, SubstituterCounts>;
};

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
