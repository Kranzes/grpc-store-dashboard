import { describe, expect, it } from 'vitest';
import type { PoolPoint } from '#lib/model/types.ts';
import { SPARK, nearestPoint, sparkPath, sparkReading, sparkX, sparkY } from './sparkline.ts';

const T = 1_800_000_000_000;
const MIN = 60_000;
const pt = (min: number, slots: number | null, cpu: number | null): PoolPoint => ({
	t: T + min * MIN,
	slots,
	cpu
});

describe('sparkline', () => {
	it('spans the last hour across the width, and 0 to 100% up the plot', () => {
		expect(sparkX(T, T, 600)).toBe(600);
		expect(sparkX(T - 30 * MIN, T, 600)).toBe(300);
		expect(sparkY(0)).toBe(SPARK.height);
		expect(sparkY(1)).toBe(SPARK.pad);
	});

	it('breaks a line at unknown minutes and at gaps the page did not see', () => {
		const points = [
			pt(-60, 0.5, 0.25),
			pt(-59, 0.5, null),
			pt(-58, 1, 0.25),
			// Five minutes nobody saw.
			pt(-53, 0, 0.5),
			pt(-52, null, 0.5),
			pt(0, 0, 0)
		];
		const y = (v: number) => sparkY(v);
		expect(sparkPath(points, 'slots', 600)).toBe(
			`M0 ${y(0.5)}L10 ${y(0.5)}L20 ${y(1)}M70 ${y(0)}M600 ${y(0)}`
		);
		expect(sparkPath(points, 'cpu', 600)).toBe(
			`M0 ${y(0.25)}M20 ${y(0.25)}M70 ${y(0.5)}L80 ${y(0.5)}M600 ${y(0)}`
		);
		expect(sparkPath([], 'slots', 600)).toBe('');
	});

	it('picks the minute nearest the pointer', () => {
		const points = [pt(-60, 0.5, null), pt(-30, 0.5, null), pt(0, 0.5, null)];
		expect(nearestPoint(points, 140, 600)).toBe(0);
		expect(nearestPoint(points, 160, 600)).toBe(1);
		expect(nearestPoint(points, 590, 600)).toBe(2);
		expect(nearestPoint([], 10, 600)).toBe(-1);
	});

	it('reads a minute out, and says when a value is unknown', () => {
		const r = sparkReading(pt(0, 0.82, null), true);
		expect([r.slots, r.cpu]).toEqual(['82%', '–']);
		expect(r.spoken).toBe(`${r.time}, slots 82%, CPU unknown`);
		expect(sparkReading(pt(0, 0.5, 0.25), false).spoken).toBe(`${r.time}, slots 50%`);
	});
});
