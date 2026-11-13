// Words and chart geometry for the line panel and the Lines rows in node panels.

import {
	WORKER_LINGER_MS,
	failShare,
	type EdgeSeries,
	type EdgeView,
	type RateUnit
} from '#lib/model/types.ts';
import { countsFailures, type LineKind } from '#lib/flow/kinds.ts';
import { failPercent, isEstimate, rateText } from '#lib/flow/labels.ts';
import {
	formatByteRate,
	formatBytes,
	formatClock,
	formatCount,
	formatPerMinute,
	formatSpan
} from '../format.ts';

/** The rate as a screen reader says it: "24 assigned per minute", "about 4.2 MiB per second". */
export function spokenRate(flow: LineKind, rate: number): string {
	return rateText(flow, rate)
		.replace(/^≈ /, 'about ')
		.replace(/\/s$/, ' per second')
		.replace(/\/min$/, ' per minute');
}

/** The Failed fact: "3 of 38, 8%", or "0 of 38". */
export function failFact(finished: number, failed: number): string {
	const pct = failPercent(failShare({ finished, failed }));
	const of = `${formatCount(failed)} of ${formatCount(finished)}`;
	return pct ? `${of}, ${pct}` : of;
}

/** The numbers of a Lines row: rate and failure share, added up over a bundle. */
export function lineRow(
	flow: LineKind,
	edgeIds: readonly string[],
	view: (edgeId: string) => EdgeView | undefined
): { rate: string; spoken: string; fail: string | null } {
	let rate = 0;
	let finished = 0;
	let failed = 0;
	for (const id of edgeIds) {
		const e = view(id);
		if (!e) continue;
		rate += e.rate;
		finished += e.finished;
		failed += e.failed;
	}
	return {
		rate: rateText(flow, rate),
		spoken: spokenRate(flow, rate),
		fail: countsFailures(flow) ? failPercent(failShare({ finished, failed })) : null
	};
}

const TOTAL_LABEL: Record<LineKind, string> = {
	request: 'Requested',
	assign: 'Assigned',
	hit: 'Hits',
	publish: 'Published',
	fetch: 'Fetched (estimated)',
	substitute: 'Substituted'
};

/** The name of a line's window total. */
export function totalLabel(flow: LineKind): string {
	return TOTAL_LABEL[flow];
}

/** A window total in the line's unit: "41", "1.2 GiB", "≈ 30 MiB". An estimate of nothing is 0. */
export function totalText(flow: LineKind, unit: RateUnit, total: number): string {
	if (unit === 'builds') return formatCount(total);
	return isEstimate(flow, total) ? `≈ ${formatBytes(total)}` : formatBytes(total);
}

/** What the line panel shows: one builder's or group's line, a pool's line, or a bundle. */
export type LineShape = 'one' | 'pool' | 'bundle';

/** One sentence on what the line carries. */
export function lineCaption(flow: LineKind, shape: LineShape): string {
	if (shape === 'bundle') return 'These lines run together on the map. Pick a row to see one line.';
	const pool = shape === 'pool';
	switch (flow) {
		case 'request':
			return 'Build requests from this client group: derivations its clients ask the scheduler for, cache hits included.';
		case 'assign':
			return pool
				? 'Derivations the scheduler assigns to the builders of this pool.'
				: 'Derivations the scheduler assigns to this builder.';
		case 'hit':
			return 'Requests the scheduler found in the cache. No bytes travel on this line.';
		case 'publish':
			return pool
				? 'Output bytes the builders of this pool publish to the cache.'
				: 'Output bytes this builder publishes to the cache.';
		case 'fetch':
			return pool
				? 'Input bytes the builders of this pool fetch from the cache.'
				: 'Input bytes this builder fetches from the cache.';
		case 'substitute':
			return pool
				? 'Input bytes the builders of this pool report taking from substituters.'
				: 'Input bytes this builder reports taking from substituters.';
	}
}

/** Why a substitute line's panel lists no builds. */
export const SUBSTITUTE_NO_BUILDS =
	'Builders report how much they take from each substituter, not which build it was for, so this line lists no builds.';

/** What the fetch estimate misses. */
export const FETCH_CAVEAT =
	'Fetches are an estimate from which builder last built each input. They count an input again when a builder already has it, and they miss sources, client uploads and older cache content.';

/** The failure caption: one line under the chart, and the rest behind "How failures count". */
export type FailCaption = Readonly<{ line: string; bullets: readonly string[] }>;

const BARS = 'Red bars among the dots show the failed share in tenths.';
const SKIPPED = "Builds skipped because a dependency failed don't count as failures.";

/**
 * What the failure share counts, for assignment and request lines. `other`:
 * the other clients line, which adds up its identities.
 */
export function failCaption(flow: LineKind, shape: LineShape, other = false): FailCaption {
	if (flow === 'request')
		return {
			line:
				shape === 'bundle'
					? "Share of these client groups' finished builds that failed. Cache hits are left out."
					: "Share of this client group's finished builds that failed. Cache hits are left out.",
			bullets: [
				BARS,
				"A failed build counts on every client group waiting on it, so request lines don't add up to assignment lines.",
				other
					? 'Other clients adds up its identities, so a build two of them waited on counts twice.'
					: 'A build whose clients all left first counts only on its assignment line.',
				SKIPPED
			]
		};
	const linger = formatSpan(WORKER_LINGER_MS);
	return {
		line: 'Share of finished builds that failed.',
		bullets: [
			BARS,
			shape === 'pool'
				? 'The pool keeps the counts of builders that left.'
				: shape === 'bundle'
					? `A builder's counts leave with it, ${linger} after it disconnects. Pool lines keep them.`
					: `This builder's counts leave with it, ${linger} after it disconnects.`,
			SKIPPED
		]
	};
}

const CHART_NOUN: Record<LineKind, string> = {
	request: 'Requests',
	assign: 'Assignments',
	hit: 'Cache hits',
	publish: 'Bytes published',
	fetch: 'Estimated bytes fetched',
	substitute: 'Bytes substituted'
};

/** Builds chart per minute, bytes per second. */
export function chartPer(unit: RateUnit): 'minute' | 'second' {
	return unit === 'builds' ? 'minute' : 'second';
}

/** From the series' per second to the chart's unit. */
const chartScale = (unit: RateUnit) => (unit === 'builds' ? 60 : 1);

/** The first bucket the page has data for, or -1. */
const firstSeen = (series: EdgeSeries) => series.values.findIndex((v) => v !== null);

/** Failed builds in bucket `i`: per second times the bucket's seconds. null without data. */
function failedIn(series: EdgeSeries, i: number): number | null {
	const f = series.failed?.[i];
	return f === null || f === undefined ? null : (f * series.bucketMs) / 1000;
}

/** "Assignments per minute", "Bytes published per second". */
export function chartTitle(flow: LineKind, unit: RateUnit): string {
	return `${CHART_NOUN[flow]} per ${chartPer(unit)}`;
}

/** A chart value with its unit, for the scale and the label: "24/min", "38 MiB/s". */
export function chartValue(unit: RateUnit, v: number): string {
	return unit === 'builds' ? `${formatPerMinute(v)}/min` : formatByteRate(v);
}

/** Chart sizes in px. */
export const CHART = {
	/** The bars. */
	height: 64,
	/** The failed strip under them, on assignment and request lines. */
	strip: 12,
	/** Between the bars and the strip. */
	gap: 6,
	/** Left of the bars, for the scale and the strip's label. */
	gutter: 56,
	/** The time axis under everything. */
	axis: 16,
	/** The widest bar. A wider slot leaves the rest empty. */
	bar: 24,
	/** Corner radius at a bar's top. */
	radius: 4,
	/** The full-color top edge of the bucket still filling. */
	edge: 2
} as const;

/** A bar of slot `i`, where slot n, after the last whole bucket, is the bucket still filling. */
export type Bar = Readonly<{ i: number; x: number; y: number; w: number; h: number }>;

export type ChartLayout = Readonly<{
	/** One per bucket that has a value above 0. */
	bars: readonly Bar[];
	/** The bucket still filling, at the right end, from the rate now. null without a rate above 0. */
	live: Bar | null;
	/** Failed builds per bucket, on their own scale. null on kinds without failures. */
	fails: readonly Bar[] | null;
	/** Largest bucket, per minute for builds and per second for bytes. 0 when all are 0. */
	peak: number;
	/** Most failed builds in one bucket. */
	failPeak: number;
	/** Failed builds over the chart. */
	failed: number;
	/** Slots: one per whole bucket, and one more for the bucket still filling when there is a rate. */
	slots: number;
	/** Width of a slot in px. */
	slot: number;
	/** Height of the whole drawing. */
	height: number;
	/** The start of the window before the first live data, hatched. null when the data covers it. */
	uncovered: Readonly<{ x: number; w: number }> | null;
}>;

/**
 * Bars for a series: one per whole bucket, oldest at the left, scaled to the
 * busiest. Buckets without live data, which are null, draw nothing, and the
 * run of them at the start is the part of the window the page did not see. A
 * bucket above 0 is at least 1 px tall, and a failed bucket at least 2 px, so none vanishes.
 * A bar is at most 24 px wide, in the middle of its slot.
 *
 * With `live`, the rate now in the series' unit per second, one more slot at
 * the right end shows the bucket still filling, so a line that is busy now
 * never shows an empty chart. It counts toward the scale.
 */
export function chartLayout(
	series: EdgeSeries,
	unit: RateUnit,
	width: number,
	live?: number
): ChartLayout {
	const n = series.values.length;
	const slots = n + (live === undefined ? 0 : 1);
	const plot = Math.max(0, width - CHART.gutter);
	const slot = slots > 0 ? plot / slots : 0;
	const gap = Math.min(2, slot * 0.25);
	const w = Math.min(CHART.bar, slot - gap);
	const scale = chartScale(unit);
	const per = series.values.map((v) => (v === null ? null : v * scale));
	const now = live !== undefined && live > 0 ? live * scale : 0;
	const peak = Math.max(0, now, ...per.map((v) => v ?? 0));
	const at = (i: number) => CHART.gutter + i * slot + (slot - w) / 2;
	const bars: Bar[] = [];
	per.forEach((v, i) => {
		if (v === null || !(v > 0) || peak <= 0) return;
		const h = Math.max(1, (v / peak) * CHART.height);
		bars.push({ i, x: at(i), y: CHART.height - h, w, h });
	});
	const fails: Bar[] | null = series.failed ? [] : null;
	const counts = (series.failed ?? []).map((_, i) => failedIn(series, i));
	const failPeak = Math.max(0, ...counts.map((c) => c ?? 0));
	const failed = counts.reduce<number>((s, c) => s + (c ?? 0), 0);
	const top = CHART.height + CHART.gap;
	counts.forEach((c, i) => {
		if (c === null || !(c > 0) || !fails) return;
		const h = Math.max(2, (c / failPeak) * CHART.strip);
		fails.push({ i, x: at(i), y: top + CHART.strip - h, w, h });
	});
	let liveBar: Bar | null = null;
	if (now > 0) {
		const h = Math.max(1, (now / peak) * CHART.height);
		liveBar = { i: n, x: at(n), y: CHART.height - h, w, h };
	}
	const height = (fails ? top + CHART.strip : CHART.height) + CHART.axis;
	const lead = firstSeen(series);
	const empty = lead < 0 ? n : lead;
	const uncovered = empty > 0 ? { x: CHART.gutter, w: empty * slot } : null;
	return {
		bars,
		live: liveBar,
		fails,
		peak,
		failPeak,
		failed: Math.round(failed),
		slots,
		slot,
		height,
		uncovered
	};
}

const px = (n: number) => Math.round(n * 100) / 100;

/** A bar's outline: its top corners rounded, as far as its size allows, and square at the base. */
export function barPath({ x, y, w, h }: Bar): string {
	const r = px(Math.min(CHART.radius, w / 2, h));
	const [l, t, right, base] = [px(x), px(y), px(x + w), px(y + h)];
	if (r <= 0) return `M${l} ${base}V${t}H${right}V${base}Z`;
	return (
		`M${l} ${base}V${px(t + r)}A${r} ${r} 0 0 1 ${px(l + r)} ${t}` +
		`H${px(right - r)}A${r} ${r} 0 0 1 ${right} ${px(t + r)}V${base}Z`
	);
}

/** The slot under `x`, in px from the chart's left, clamped to the plot. -1 without slots. */
export function chartSlotAt(layout: ChartLayout, x: number): number {
	if (layout.slots <= 0 || !(layout.slot > 0)) return -1;
	const i = Math.floor((x - CHART.gutter) / layout.slot);
	return Math.min(layout.slots - 1, Math.max(0, i));
}

/** The middle of slot `i`, in px from the chart's left. */
export function slotCenter(layout: ChartLayout, i: number): number {
	return CHART.gutter + (i + 0.5) * layout.slot;
}

/** What the chart's readout says about one slot. */
export type ChartReading = Readonly<{
	/** "10:41:30 PM to 10:42:00 PM", or "Now" for the bucket still filling. */
	time: string;
	/** "24/min", "≈ 38 MiB/s". null for a bucket the page has no data for. */
	value: string | null;
	/** Why a bucket has no value, instead of the value. */
	unseen: string | null;
	/** Failed builds in the bucket. null on lines without failures, without data, and now. */
	failed: number | null;
	/** All of it in words, for screen readers. */
	spoken: string;
}>;

/**
 * The readout of slot `i`: its time, its value in the chart's unit, and its
 * failed builds. Slot n, after the last whole bucket, reads the rate now.
 * `before` names the run of buckets at the start that the page did not see.
 */
export function chartReading(
	flow: LineKind,
	unit: RateUnit,
	series: EdgeSeries,
	rate: number,
	i: number,
	before: string
): ChartReading {
	const n = series.values.length;
	const now = i >= n;
	const start = series.startMs + i * series.bucketMs;
	const time = now ? 'Now' : `${formatClock(start)} to ${formatClock(start + series.bucketMs)}`;
	const raw = now ? Math.max(0, rate) : series.values[i];
	if (raw === null || raw === undefined) {
		const lead = firstSeen(series);
		const unseen = lead < 0 || i < lead ? before : 'No data';
		return {
			time,
			value: null,
			unseen,
			failed: null,
			spoken: `${time}, ${unseen.charAt(0).toLowerCase()}${unseen.slice(1)}`
		};
	}
	const v = raw * chartScale(unit);
	const estimate = isEstimate(flow, v);
	const value = `${estimate ? '≈ ' : ''}${chartValue(unit, v)}`;
	const amount = unit === 'builds' ? formatPerMinute(v) : formatBytes(v);
	const parts = [time, `${estimate ? 'about ' : ''}${amount} per ${chartPer(unit)}`];
	const f = now ? null : failedIn(series, i);
	const failed = f === null ? null : Math.round(f);
	if (failed !== null) parts.push(`${formatCount(failed)} failed`);
	return { time, value, unseen: null, failed, spoken: parts.join(', ') };
}
