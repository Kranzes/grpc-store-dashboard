import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { EdgeDetailView, EdgeSeries } from '#lib/model/types.ts';
import { failPercent, rateText } from '#lib/flow/labels.ts';
import { formatClock } from '../format.ts';
import {
	CHART,
	barPath,
	chartLayout,
	chartReading,
	chartSlotAt,
	chartTitle,
	failCaption,
	failFact,
	lineCaption,
	slotCenter,
	spokenRate,
	totalLabel,
	totalText,
	type Bar,
	type ChartLayout
} from './line.ts';
import LineChart from './LineChart.svelte';

const series = (
	values: (number | null)[],
	failed: (number | null)[] | null = null
): EdgeSeries => ({
	startMs: 0,
	bucketMs: 30_000,
	values,
	failed
});

describe('line words', () => {
	it('rates carry the unit of their kind', () => {
		expect(rateText('request', 12)).toBe('720 requests/min');
		expect(rateText('assign', 0.4)).toBe('24 assigned/min');
		expect(rateText('hit', 4)).toBe('240 hits/min');
		expect(rateText('publish', 38 * 1024 * 1024)).toBe('38 MiB/s');
		expect(rateText('fetch', 4.2 * 1024 * 1024)).toBe('≈ 4.2 MiB/s');
		// An estimate of nothing is just 0.
		expect(rateText('fetch', 0)).toBe('0 B/s');
		expect(spokenRate('assign', 0.4)).toBe('24 assigned per minute');
		expect(spokenRate('request', 2)).toBe('120 requests per minute');
		expect(spokenRate('fetch', 4.2 * 1024 * 1024)).toBe('about 4.2 MiB per second');
	});

	it('failure shares round, and any failure shows', () => {
		expect(failPercent(null)).toBeNull();
		expect(failPercent(0)).toBeNull();
		expect(failPercent(0.004)).toBe('<1%');
		expect(failPercent(0.079)).toBe('8%');
		expect(failPercent(1)).toBe('100%');
		// Not all failed, so never 100%.
		expect(failPercent(0.996)).toBe('99%');
		expect(failFact(38, 3)).toBe('3 of 38, 8%');
		expect(failFact(38, 0)).toBe('0 of 38');
		expect(failFact(0, 0)).toBe('0 of 0');
	});

	it('totals and captions follow the kind', () => {
		expect(totalText('assign', 'builds', 41)).toBe('41');
		expect(totalText('publish', 'bytes', 12 * 1024 * 1024)).toBe('12 MiB');
		expect(totalText('fetch', 'bytes', 12 * 1024 * 1024)).toBe('≈ 12 MiB');
		expect(totalText('fetch', 'bytes', 0)).toBe('0 B');
		expect(lineCaption('assign', 'one')).toBe('Derivations the scheduler assigns to this builder.');
		expect(lineCaption('assign', 'pool')).toBe(
			'Derivations the scheduler assigns to the builders of this pool.'
		);
		expect(lineCaption('request', 'bundle')).toMatch(/^These lines run together on the map/);
		expect(chartTitle('assign', 'builds')).toBe('Assignments per minute');
		expect(chartTitle('publish', 'bytes')).toBe('Bytes published per second');
		expect(chartTitle('request', 'builds')).toBe('Requests per minute');
		expect(totalLabel('request')).toBe('Requested');
		// Substitute lines are measured: plain bytes, no "≈".
		expect(totalText('substitute', 'bytes', 12 * 1024 * 1024)).toBe('12 MiB');
		expect(totalLabel('substitute')).toBe('Substituted');
		expect(chartTitle('substitute', 'bytes')).toBe('Bytes substituted per second');
		expect(lineCaption('substitute', 'one')).toBe(
			'Input bytes this builder reports taking from substituters.'
		);
		expect(lineCaption('substitute', 'pool')).toBe(
			'Input bytes the builders of this pool report taking from substituters.'
		);
	});

	it('says what the failure share counts in one line, and the rest in at most four bullets', () => {
		const bars = 'Red bars among the dots show the failed share in tenths.';
		const skipped = "Builds skipped because a dependency failed don't count as failures.";
		expect(failCaption('request', 'one')).toEqual({
			line: "Share of this client group's finished builds that failed. Cache hits are left out.",
			bullets: [
				bars,
				"A failed build counts on every client group waiting on it, so request lines don't add up to assignment lines.",
				'A build whose clients all left first counts only on its assignment line.',
				skipped
			]
		});
		expect(failCaption('request', 'bundle').line).toBe(
			"Share of these client groups' finished builds that failed. Cache hits are left out."
		);
		expect(failCaption('request', 'one', true).bullets[2]).toBe(
			'Other clients adds up its identities, so a build two of them waited on counts twice.'
		);
		expect(failCaption('assign', 'one')).toEqual({
			line: 'Share of finished builds that failed.',
			bullets: [bars, "This builder's counts leave with it, 10m after it disconnects.", skipped]
		});
		expect(failCaption('assign', 'bundle').bullets[1]).toBe(
			"A builder's counts leave with it, 10m after it disconnects. Pool lines keep them."
		);
		expect(failCaption('assign', 'pool').bullets[1]).toBe(
			'The pool keeps the counts of builders that left.'
		);
		for (const flow of ['request', 'assign'] as const)
			for (const shape of ['one', 'pool', 'bundle'] as const)
				for (const other of [false, true]) {
					const c = failCaption(flow, shape, other);
					expect(c.bullets.length).toBeLessThanOrEqual(4);
					expect(c.line.split('. ').length).toBeLessThanOrEqual(2);
				}
	});
});

/**
 * Each bar sits in the middle of its own slot and is no wider than a bar,
 * and neighbours keep a gap between them.
 */
function inSlots(l: ChartLayout, bars: readonly Bar[]) {
	for (const b of bars) {
		expect(b.x + b.w / 2, `bar ${b.i}`).toBeCloseTo(slotCenter(l, b.i));
		expect(b.w, `bar ${b.i}`).toBeLessThanOrEqual(CHART.bar);
	}
	for (let k = 1; k < bars.length; k++)
		expect(bars[k - 1].x + bars[k - 1].w, `bar ${bars[k].i}`).toBeLessThan(bars[k].x);
}

describe('chartLayout', () => {
	it('draws one bar per bucket above 0, scaled to the busiest, per minute for builds', () => {
		const l = chartLayout(series([0.1, 0.2, null, 0]), 'builds', CHART.gutter + 400);
		// 0.2 a second is 12 a minute.
		expect(l.peak).toBeCloseTo(12);
		expect(l.bars.map((b) => b.i)).toEqual([0, 1]);
		const [a, b] = l.bars;
		expect(b.h).toBe(CHART.height);
		expect(a.h).toBeCloseTo(CHART.height / 2);
		for (const bar of l.bars) expect(bar.y + bar.h).toBe(CHART.height);
		// One slot per bucket across the plot, oldest at the left.
		expect(l.slots).toBe(4);
		expect(slotCenter(l, l.slots - 1) + l.slot / 2).toBeCloseTo(CHART.gutter + 400);
		inSlots(l, l.bars);
		// A slot wider than a bar gets the widest bar.
		expect(a.w).toBe(CHART.bar);
		expect(l.fails).toBeNull();
	});

	it('narrows bars to fit slots narrower than a bar, and keeps the gaps narrower than the bars', () => {
		const l = chartLayout(
			series(Array.from({ length: 40 }, () => 1)),
			'builds',
			CHART.gutter + 400
		);
		expect(l.slot).toBeLessThan(CHART.bar);
		expect(l.bars).toHaveLength(40);
		inSlots(l, l.bars);
		for (let k = 1; k < l.bars.length; k++) {
			const gap = l.bars[k].x - (l.bars[k - 1].x + l.bars[k - 1].w);
			expect(gap).toBeLessThan(l.bars[k].w);
		}
	});

	it('bytes chart per second, and a tiny bucket still shows', () => {
		const l = chartLayout(series([1000, 1, 0]), 'bytes', CHART.gutter + 300);
		expect(l.peak).toBe(1000);
		const [big, tiny] = l.bars;
		expect(big.h).toBe(CHART.height);
		// Its share is a fraction of a pixel, and it gets at least one.
		expect(tiny.h).toBeGreaterThanOrEqual(1);
		expect(tiny.h).toBeLessThan(big.h);
	});

	it('the failed strip has its own scale and shows any failure', () => {
		const per = (n: number) => n / 30;
		const l = chartLayout(
			series([1, 1, 1, null], [per(10), per(0.1), 0, null]),
			'builds',
			CHART.gutter + 400
		);
		expect(l.fails).not.toBeNull();
		const fails = l.fails!;
		expect(fails.map((f) => f.i)).toEqual([0, 1]);
		expect(fails[0].h).toBe(CHART.strip);
		// 0.1 failed builds is a sliver of the strip, so it draws taller than its share.
		expect(fails[1].h).toBeGreaterThan((0.1 / 10) * CHART.strip);
		expect(fails[1].h).toBeGreaterThanOrEqual(1);
		// On the strip's base, under their bucket's bar.
		for (const f of fails) {
			expect(f.y + f.h).toBe(CHART.height + CHART.gap + CHART.strip);
			const bar = l.bars.find((b) => b.i === f.i)!;
			expect([f.x, f.w]).toEqual([bar.x, bar.w]);
		}
		expect(l.failPeak).toBeCloseTo(10);
		expect(l.failed).toBe(10);
		expect(l.height).toBe(CHART.height + CHART.gap + CHART.strip + CHART.axis);
	});

	it('draws the bucket still filling from the rate now, in a slot of its own', () => {
		// Three whole buckets and the filling one.
		const l = chartLayout(series([0.1, 0.2, null]), 'builds', CHART.gutter + 400, 0.4);
		expect(l.slots).toBe(4);
		expect(l.live).not.toBeNull();
		expect(l.live!.i).toBe(l.slots - 1);
		inSlots(l, [...l.bars, l.live!]);
		// 0.4/s is 24/min, the busiest, so it sets the scale.
		expect(l.peak).toBeCloseTo(24);
		expect(l.live!.h).toBe(CHART.height);
		expect(l.bars[1].h).toBeCloseTo(CHART.height / 2);
		// The first 30 s: no whole bucket yet, and still a bar.
		const first = chartLayout(series([null, null, null]), 'bytes', CHART.gutter + 400, 25e6);
		expect(first.bars).toEqual([]);
		expect(first.live!.h).toBe(CHART.height);
		expect(first.peak).toBe(25e6);
		// Idle now: the slot stays, empty, and the bars stay where they were.
		const idle = chartLayout(series([0.1, 0.2, null]), 'builds', CHART.gutter + 400, 0);
		expect(idle.live).toBeNull();
		expect(idle.slots).toBe(l.slots);
		expect(idle.bars.map((b) => b.x)).toEqual(l.bars.map((b) => b.x));
	});

	it('an empty or all-null series draws no bars', () => {
		expect(chartLayout(series([]), 'builds', 400).bars).toEqual([]);
		const l = chartLayout(series([null, null], [null, null]), 'builds', 400);
		expect(l.bars).toEqual([]);
		expect(l.fails).toEqual([]);
		expect(l.peak).toBe(0);
	});
});

describe('barPath', () => {
	/** The radius of a path's arcs, or 0 when it has none. */
	const radius = (d: string) => Number(/A([\d.]+) /.exec(d)?.[1] ?? 0);

	it.each([
		['up to the corner radius', { i: 0, x: 10, y: 20, w: 24, h: 44 }, () => CHART.radius],
		['no taller than the bar', { i: 0, x: 0, y: 63, w: 24, h: 1 }, (b: Bar) => b.h],
		['no wider than half the bar', { i: 0, x: 0, y: 0, w: 6, h: 10 }, (b: Bar) => b.w / 2],
		['none on a bar with no width', { i: 0, x: 0, y: 0, w: 0, h: 10 }, () => 0]
	] as const)("rounds a bar's top corners %s, and keeps its base square", (_, bar, limit) => {
		const d = barPath(bar);
		const r = limit(bar);
		expect(radius(d)).toBe(r);
		// Two arcs, one per top corner, and none at the base.
		expect(d.match(/A/g) ?? []).toHaveLength(r > 0 ? 2 : 0);
		// From the base's left corner, and back to the base in a straight line.
		expect(d.startsWith(`M${bar.x} ${bar.y + bar.h}V`)).toBe(true);
		expect(d.endsWith(`V${bar.y + bar.h}Z`)).toBe(true);
	});
});

describe('chart readout', () => {
	const MIN = 60_000;
	const s = {
		startMs: 10 * MIN,
		bucketMs: 30_000,
		values: [null, 0.2, null, 0.4],
		failed: [null, 0, null, 0.1]
	};

	it('snaps the pointer to a slot, clamped to the plot', () => {
		const l = chartLayout(s, 'builds', CHART.gutter + 500, 0.3);
		expect(l.slots).toBe(5);
		expect(chartSlotAt(l, CHART.gutter + 1)).toBe(0);
		expect(chartSlotAt(l, CHART.gutter + 150)).toBe(1);
		expect(chartSlotAt(l, CHART.gutter + 499)).toBe(4);
		expect(chartSlotAt(l, 0)).toBe(0);
		expect(chartSlotAt(l, CHART.gutter + 900)).toBe(4);
		expect(slotCenter(l, 1)).toBe(CHART.gutter + 150);
		expect(chartSlotAt(chartLayout(series([]), 'builds', 400), 100)).toBe(-1);
	});

	it("reads a bucket's time, its rate in the chart's unit and its failed builds", () => {
		const at = (ms: number) => formatClock(ms);
		const r = chartReading('assign', 'builds', s, 0.3, 3, 'Before this page opened');
		expect(r.time).toBe(`${at(11.5 * MIN)} to ${at(12 * MIN)}`);
		expect(r.value).toBe('24/min');
		expect(r.failed).toBe(3);
		expect(r.spoken).toBe(`${r.time}, 24 per minute, 3 failed`);
		expect(chartReading('assign', 'builds', s, 0.3, 1, '').failed).toBe(0);
	});

	it('reads the bucket still filling from the rate now, without failures', () => {
		const r = chartReading('assign', 'builds', s, 0.3, 4, '');
		expect(r).toEqual({
			time: 'Now',
			value: '18/min',
			unseen: null,
			failed: null,
			spoken: 'Now, 18 per minute'
		});
	});

	it('says why a bucket has no value', () => {
		const lead = chartReading('assign', 'builds', s, 0, 0, 'Before this page opened');
		expect(lead.value).toBeNull();
		expect(lead.unseen).toBe('Before this page opened');
		expect(lead.spoken).toBe(`${lead.time}, before this page opened`);
		// A gap after the first live bucket is a reconnect, not the page opening.
		expect(chartReading('assign', 'builds', s, 0, 2, 'Before this page opened').unseen).toBe(
			'No data'
		);
	});

	it('reads bytes per second, and fetches as estimates', () => {
		const bytes = { ...s, values: [2048, 0], failed: null };
		const pub = chartReading('publish', 'bytes', bytes, 0, 0, '');
		expect(pub.value).toBe('2 KiB/s');
		expect(pub.failed).toBeNull();
		expect(pub.spoken).toMatch(/, 2 KiB per second$/);
		const fetch = chartReading('fetch', 'bytes', bytes, 0, 0, '');
		expect(fetch.value).toBe('≈ 2 KiB/s');
		expect(fetch.spoken).toMatch(/, about 2 KiB per second$/);
		// An estimate of nothing is just 0.
		expect(chartReading('fetch', 'bytes', bytes, 0, 1, '').value).toBe('0 B/s');
	});
});

const detail = (over: Partial<EdgeDetailView> = {}): EdgeDetailView => ({
	edgeIds: ['assign:10.0.0.13:50051'],
	flow: 'assign',
	unit: 'builds',
	count: 1,
	rate: 0.4,
	windowMinutes: 15,
	total: 41,
	finished: 38,
	failed: 3,
	series: series([0.2, 0.4, 0.1], [0, 0.05, 0]),
	since: null,
	rows: [],
	items: [],
	estimate: false,
	...over
});

describe('LineChart', () => {
	// The e2e tests read the hatch after a page opened. This one names a restart.
	it('hatches the start of the window the scheduler did not see, and names it', () => {
		const restart = detail({
			series: { ...series([0.2]), values: [null, 0.2], failed: [null, 0] },
			since: { fromMs: 0, cause: 'restart' }
		});
		expect(render(LineChart, { props: { detail: restart } }).body).toContain(
			'<title>Before the scheduler restarted</title>'
		);
	});

	it('names the peak, the rate and the failures, and draws the strip', () => {
		const { body } = render(LineChart, { props: { detail: detail() } });
		expect(body).toContain('role="img"');
		expect(body).toContain(
			'aria-label="Assignments per minute in the last 15 minutes. Peak 24 per minute, now 24 assigned per minute. 3 failed."'
		);
		// Three whole buckets, and the one still filling at the rate now.
		expect(body.match(/class="bar\b/g)).toHaveLength(3);
		expect(body.match(/class="live\b/g)).toHaveLength(1);
		expect(body.match(/class="fail\b/g)).toHaveLength(1);
		expect(body).toContain('Failed');
		expect(body).toContain('15m ago');
		// The data covers the window, so nothing is hatched.
		expect(body).not.toContain('Before this page opened');
	});

	it('names an hour window in hours', () => {
		const { body } = render(LineChart, { props: { detail: detail({ windowMinutes: 60 }) } });
		expect(body).toContain('aria-label="Assignments per minute in the last 1 hour.');
		expect(body).toContain('1h ago');
		expect(body).not.toContain('60m');
	});

	it('has no strip on lines without failures', () => {
		const { body } = render(LineChart, {
			props: {
				detail: detail({
					flow: 'publish',
					unit: 'bytes',
					rate: 512,
					series: series([1024, 2048]),
					since: { fromMs: Date.UTC(2026, 10, 8, 23, 41), cause: 'page' }
				})
			}
		});
		expect(body).toMatch(
			/Bytes published per second since [^.]+\. Peak 2 KiB per second, now 512 B per second\./
		);
		expect(body).not.toMatch(/class="fail\b/);
		expect(body).not.toContain('Failed');
	});
});
