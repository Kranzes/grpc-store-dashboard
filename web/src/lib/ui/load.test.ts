import { describe, expect, it } from 'vitest';
import type { PoolView } from '#lib/model/types.ts';
import { loadShares, loadText, loadTitle, poolLoadCoverage } from './load.ts';

const GiB = 1024 ** 3;
const NONE = { cpuBusy: null, cpuCores: null, memUsed: null, memTotal: null };

describe('load', () => {
	it('says busy CPUs and memory in use as shares, and nothing without a report', () => {
		const l = { cpuBusy: 4.5, cpuCores: 16, memUsed: 16 * GiB, memTotal: 64 * GiB };
		expect(loadShares(l)).toEqual({ cpu: 4.5 / 16, mem: 0.25 });
		expect(loadText(l)).toBe('CPU 28% · mem 25%');
		expect(loadTitle(l)).toBe(
			'4.5 of 16 CPUs busy, 16 GiB of 64 GiB memory in use. Every process on the builder counts, not only its builds.'
		);
		expect(loadTitle({ ...l, cpuBusy: 60.4, cpuCores: 1400 })).toMatch(/^60 of 1,400 CPUs busy/);
		expect(loadText(NONE)).toBeNull();
		expect(loadShares(NONE)).toEqual({ cpu: null, mem: null });
	});

	it('names how many builders of a pool report, only while some do not', () => {
		const pool = (loadBuilders: number) =>
			({
				up: 170,
				draining: 7,
				loadBuilders,
				cpuBusy: 60.5,
				cpuCores: 1400,
				memUsed: 2000 * GiB,
				memTotal: 5000 * GiB
			}) as PoolView;
		expect(poolLoadCoverage(pool(170))).toEqual({ reporting: 170, connected: 177 });
		expect(poolLoadCoverage(pool(177))).toBeNull();
		expect(poolLoadCoverage(pool(0))).toBeNull();
		expect(loadText(pool(170))).toBe('CPU 4% · mem 40%');
	});
});
