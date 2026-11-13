import { describe, expect, it } from 'vitest';
import {
	MARK_MAX_ZOOM,
	barSize,
	dotSize,
	markScale,
	failSlots,
	firstFailSlot,
	isFailSlot
} from './marks.ts';

describe('mark scale', () => {
	it('stops marks growing past MARK_MAX_ZOOM', () => {
		expect(markScale(MARK_MAX_ZOOM / 2)).toBe(1);
		expect(markScale(MARK_MAX_ZOOM)).toBe(1);
		// On screen a mark is as large at any higher zoom as at MARK_MAX_ZOOM.
		for (const zoom of [1.5 * MARK_MAX_ZOOM, 2 * MARK_MAX_ZOOM])
			expect(dotSize(4) * markScale(zoom) * zoom).toBeCloseTo(dotSize(4) * MARK_MAX_ZOOM, 9);
	});
});

describe('failure marks', () => {
	it('failSlots shows any failure as at least 1 in 10', () => {
		const shares = [null, 0, 0.001, 0.04, 0.15, 0.25, 0.5, 1];
		expect(shares.map(failSlots)).toEqual([0, 0, 1, 1, 2, 3, 5, 10]);
	});

	it('red slots spread evenly', () => {
		const slots = (m: number) =>
			Array.from({ length: 10 }, (_, i) => i).filter((i) => isFailSlot(i, m));
		expect(slots(0)).toEqual([]);
		expect(slots(1)).toEqual([9]);
		expect(slots(3)).toEqual([3, 6, 9]);
		expect(slots(5)).toEqual([1, 3, 5, 7, 9]);
		expect(slots(10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		for (let m = 0; m <= 10; m++) expect(slots(m).length).toBe(m);
		expect(firstFailSlot(0)).toBe(-1);
		expect(firstFailSlot(3)).toBe(3);
	});

	it('a dot is wider than its line and a bar longer and wider than a dot, so the shapes differ at any zoom', () => {
		let last = 0;
		for (const width of [0, 1.5, 4.5, 7.5]) {
			const dot = dotSize(width);
			expect(dot, `width ${width}`).toBeGreaterThan(width);
			expect(dot, `width ${width}`).toBeGreaterThanOrEqual(last);
			last = dot;
			const bar = barSize(dot);
			expect(bar.length, `width ${width}`).toBeGreaterThan(dot);
			expect(bar.width, `width ${width}`).toBeGreaterThan(dot);
		}
	});
});
