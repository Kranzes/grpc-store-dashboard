import { describe, expect, it } from 'vitest';
import type { EdgeView } from '#lib/model/types.ts';
import { ACTIVE_FLOOR, lineLooks, maxRate, paintOrder, traffic } from './traffic.ts';

describe('traffic', () => {
	it('is idle without traffic or below the floor', () => {
		expect(traffic(0, 10)).toEqual({ active: false, width: 0, level: 0 });
		expect(traffic(1, 0).active).toBe(false);
		expect(traffic(10 * ACTIVE_FLOOR * 0.9, 10).active).toBe(false);
	});

	it("still shows a card's traffic next to a pool down to the floor's share of it", () => {
		const pool = 1 / ACTIVE_FLOOR;
		expect(traffic(1, pool)).toEqual({ active: true, width: 1.5, level: 1 });
		expect(traffic(1, pool * 1.001).active).toBe(false);
	});

	it('grows with the square root of the rate, in steps', () => {
		expect(traffic(10, 10)).toEqual({ active: true, width: 7.5, level: 4 });
		expect(traffic(2.5, 10)).toEqual({ active: true, width: 4.5, level: 2 });
		// Above the busiest line drawn counts as the busiest.
		expect(traffic(20, 10)).toEqual(traffic(10, 10));
	});
});

describe('maxRate', () => {
	const rates = new Map<string, EdgeView>([
		['assign:a', { rate: 2, unit: 'builds', finished: 0, failed: 0 }],
		['publish:a', { rate: 500, unit: 'bytes', finished: 0, failed: 0 }],
		['assign:pool:x', { rate: 40, unit: 'builds', finished: 0, failed: 0 }],
		['publish:pool:x', { rate: 9000, unit: 'bytes', finished: 0, failed: 0 }]
	]);

	it('takes the busiest line drawn, per unit', () => {
		const cards = [
			{ id: 'assign:a', kind: 'assign' as const },
			{ id: 'publish:a', kind: 'publish' as const }
		];
		expect(maxRate(cards, rates, 'builds')).toBe(2);
		expect(maxRate(cards, rates, 'bytes')).toBe(500);
		// The pool's lines set the scale only while the pool is drawn.
		const pool = [
			...cards,
			{ id: 'assign:pool:x', kind: 'assign' as const },
			{ id: 'publish:pool:x', kind: 'publish' as const }
		];
		expect(maxRate(pool, rates, 'builds')).toBe(40);
		expect(maxRate(pool, rates, 'bytes')).toBe(9000);
		expect(maxRate([{ id: 'want:gone', kind: 'request' }], rates, 'builds')).toBe(0);
	});

	it('maxRate skips the cache hits line', () => {
		const hits = new Map<string, EdgeView>([
			['want:ci', { rate: 3, unit: 'builds', finished: 0, failed: 0 }],
			['cached:scheduler', { rate: 300, unit: 'builds', finished: 0, failed: 0 }]
		]);
		const drawn = [
			{ id: 'want:ci', kind: 'request' as const },
			{ id: 'cached:scheduler', kind: 'hit' as const }
		];
		expect(maxRate(drawn, hits, 'builds')).toBe(3);
	});
});

describe('lineLooks', () => {
	const ev = (rate: number, finished = 0, failed = 0): EdgeView => ({
		rate,
		unit: 'builds',
		finished,
		failed
	});
	const drawn = [
		{ id: 'cached:scheduler', kind: 'hit' as const },
		{ id: 'want:ci', kind: 'request' as const },
		{ id: 'assign:a', kind: 'assign' as const },
		{ id: 'assign:b', kind: 'assign' as const },
		{ id: 'assign:c', kind: 'assign' as const }
	];

	it('takes level, width and failure slots from the numbers', () => {
		const looks = lineLooks(
			drawn,
			new Map([
				['cached:scheduler', ev(40)],
				['want:ci', ev(10, 100, 3)],
				['assign:a', ev(2.5, 20, 0)],
				['assign:b', ev(0, 10, 10)]
			])
		);
		// The lookup is never active and keeps out of the scale, but shows its hits.
		expect(looks.get('cached:scheduler')).toMatchObject({
			active: false,
			lookup: true,
			hits: true
		});
		// 3% failed still shows as 1 slot in 10.
		expect(looks.get('want:ci')).toMatchObject({ active: true, level: 4, fails: 1 });
		expect(looks.get('assign:a')).toMatchObject({ active: true, level: 2, width: 4.5, fails: 0 });
		// An idle line keeps its failures, for the legend's "Failed builds" highlight.
		expect(looks.get('assign:b')).toMatchObject({ active: false, level: 0, fails: 10 });
		expect(looks.get('assign:c')).toMatchObject({ active: false, fails: 0, lookup: false });
	});

	it('paints idle lines first, then active ones, each in the order drawn', () => {
		const looks = lineLooks(
			drawn,
			new Map([
				['assign:a', ev(0)],
				['assign:b', ev(3)],
				['want:ci', ev(5)]
			])
		);
		expect(paintOrder(drawn, looks)).toEqual([
			'cached:scheduler',
			'assign:a',
			'assign:c',
			'want:ci',
			'assign:b'
		]);
	});
});
