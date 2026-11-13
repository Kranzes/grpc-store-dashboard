import { describe, expect, it } from 'vitest';
import type { EdgeView } from '#lib/model/types.ts';
import {
	OUTLIER_MIN_FINISHED,
	failTail,
	failingBuilders,
	failingTitle,
	farmFailShare,
	isFailOutlier,
	outlierShare
} from './outliers.ts';

const edge = (finished: number, failed: number): EdgeView => ({
	rate: 1,
	unit: 'builds',
	finished,
	failed
});

/** A seeded mulberry32 generator, so the noise test is the same every run. */
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('failure outliers', () => {
	it('takes the farm share from the header totals', () => {
		expect(farmFailShare({ built: 75, failed: 25 })).toBe(0.25);
		expect(farmFailShare({ built: 0, failed: 0 })).toBeNull();
	});

	it('gives the binomial tail', () => {
		expect(failTail(0, 10, 0.3)).toBe(1);
		expect(failTail(11, 10, 0.3)).toBe(0);
		expect(failTail(1, 10, 0)).toBe(0);
		// 1 - 0.95^10 - 10 · 0.05 · 0.95^9
		expect(failTail(2, 10, 0.05)).toBeCloseTo(0.0861, 4);
		expect(failTail(10, 10, 0.5)).toBeCloseTo(1 / 1024, 10);
		// Many builds stay cheap and finite.
		const big = failTail(600, 5000, 0.1);
		expect(big).toBeGreaterThan(0);
		expect(big).toBeLessThan(1e-4);
		expect(failTail(500, 5000, 0.1)).toBeCloseTo(0.5, 1);
	});

	it('needs twice the farm share and 15 points over it', () => {
		expect(isFailOutlier(30, 100, 0.1)).toBe(true);
		expect(isFailOutlier(19, 100, 0.1)).toBe(false); // under twice
		expect(isFailOutlier(24, 100, 0.1)).toBe(false); // twice, but 14 points over
		// The demo with two broken builders: 80% against a farm of about 30%.
		expect(isFailOutlier(32, 40, 0.3)).toBe(true);
		expect(isFailOutlier(8, 40, 0.3)).toBe(false);
		// When the farm fails more than half, nothing can stand out.
		expect(isFailOutlier(40, 40, 0.6)).toBe(false);
	});

	it('needs enough finished builds, and a count chance cannot explain', () => {
		expect(isFailOutlier(9, 9, 0.05)).toBe(false);
		expect(isFailOutlier(10, 10, 0.05)).toBe(true);
		// 2 of 10 is four times a 5% farm, but 1 line in 12 gets there by chance.
		expect(isFailOutlier(2, 10, 0.05)).toBe(false);
		expect(isFailOutlier(3, 15, 0.05)).toBe(false);
		// A broken builder 10 builds in, against a farm of 30%, waits for more.
		expect(isFailOutlier(8, 10, 0.3)).toBe(false);
		expect(isFailOutlier(16, 20, 0.3)).toBe(true);
	});

	it('does not flag lines that fail at the farm rate', () => {
		const rand = random(1);
		let flagged = 0;
		for (const p of [0.02, 0.05, 0.1, 0.2, 0.36]) {
			for (let trial = 0; trial < 4000; trial++) {
				const n = OUTLIER_MIN_FINISHED + Math.floor(rand() * 200);
				let failed = 0;
				for (let i = 0; i < n; i++) if (rand() < p) failed++;
				if (isFailOutlier(failed, n, p)) flagged++;
			}
		}
		expect(flagged).toBe(0);
	});

	it('never flags a line without failures, or without a farm share', () => {
		expect(isFailOutlier(0, 50, 0)).toBe(false);
		expect(isFailOutlier(0, 0, 0.1)).toBe(false);
		expect(isFailOutlier(25, 50, null)).toBe(false);
		// A farm that failed nothing in the window: a line failing a fifth stands out.
		expect(isFailOutlier(10, 50, 0)).toBe(true);
		expect(isFailOutlier(5, 50, 0)).toBe(false);
	});

	it('gives the share of an outlier line, and counts outlier builders', () => {
		expect(outlierShare(edge(20, 16), 0.2)).toBe(0.8);
		expect(outlierShare(edge(20, 2), 0.2)).toBeNull();
		expect(outlierShare(undefined, 0.2)).toBeNull();
		const edges = new Map([
			['assign:a', edge(20, 16)],
			['assign:b', edge(20, 2)],
			['assign:c', edge(5, 5)],
			['assign:d', edge(30, 24)]
		]);
		expect(failingBuilders(['a', 'b', null, 'c', 'd', 'e'], edges, 0.2)).toBe(2);
		expect(failingBuilders(['a', 'd'], edges, null)).toBe(0);
	});
});

describe('failingTitle', () => {
	it('names all three conditions of the rule in one sentence', () => {
		const t = failingTitle(0.04);
		expect(t).toBe(
			"Builders failing at least twice the farm's 4% and 15 percentage points above it, too often to be chance, in the selected window."
		);
		expect(t.match(/\./g)).toHaveLength(1);
	});

	it('says 0% before anything has failed', () => {
		expect(failingTitle(null)).toContain("the farm's 0% and");
		expect(failingTitle(0)).toContain("the farm's 0% and");
	});
});
