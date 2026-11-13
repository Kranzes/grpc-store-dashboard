import { describe, expect, it } from 'vitest';
import { RateMeter } from './rates.ts';

describe('RateMeter', () => {
	// One event, or a million bytes, every 200 ms for 30 s.
	it.each([1, 1_000_000])('reports a steady rate per second, for amounts of %d', (amount) => {
		const m = new RateMeter({ windowMs: 10_000, buckets: 20 });
		for (let t = 0; t < 30_000; t += 200) m.add(amount, t);
		expect(m.rate(30_000) / amount).toBeCloseTo(5, 1);
	});

	it('decays to exactly 0 one window after traffic stops', () => {
		const m = new RateMeter({ windowMs: 10_000, buckets: 20 });
		for (let t = 0; t <= 10_000; t += 100) m.add(1, t);
		const r0 = m.rate(10_000);
		expect(r0).toBeGreaterThan(9);
		const r5 = m.rate(15_000);
		expect(r5).toBeLessThan(r0);
		expect(r5).toBeGreaterThan(0);
		expect(m.rate(20_600)).toBe(0);
		expect(m.idle(20_600)).toBe(true);
		expect(m.rate(1_000_000)).toBe(0);
	});

	it('changes smoothly instead of in bucket steps', () => {
		const m = new RateMeter({ windowMs: 10_000, buckets: 10 });
		for (let t = 0; t < 10_000; t += 50) m.add(1, t);
		// While the oldest bucket slides out, consecutive readings differ a little.
		let prev = m.rate(10_000);
		for (let t = 10_050; t < 20_000; t += 50) {
			const r = m.rate(t);
			expect(r).toBeLessThanOrEqual(prev + 1e-9);
			expect(prev - r).toBeLessThan(0.15);
			prev = r;
		}
	});

	it('ignores zero and negative amounts', () => {
		const m = new RateMeter({ windowMs: 1000 });
		m.add(0, 100);
		m.add(-5, 100);
		expect(m.total(100)).toBe(0);
		// total() never goes below 0, so a positive amount shows whether -5 counted.
		m.add(2, 100);
		expect(m.total(100)).toBe(2);
	});
});

describe('RateMeter histories', () => {
	// The line histories: an hour in 120 buckets of 30 s.
	const HOUR = { windowMs: 3_600_000, buckets: 120, compact: true };
	const B = 30_000;

	it('recent sums whole buckets without weighting and holds still inside a bucket', () => {
		const m = new RateMeter(HOUR);
		expect(m.bucketMs).toBe(B);
		expect(m.recent(11, 0)).toBe(0);
		// One event in each of the first 12 buckets, two in the 13th.
		for (let i = 0; i < 12; i++) m.add(1, i * B + 1000);
		m.add(2, 12 * B + 5000);
		const now = 12 * B + 5000;
		expect(m.bucketIndex(now)).toBe(12);
		// The current bucket and the 10 before it: buckets 2 to 12.
		expect(m.recent(11, now)).toBe(12);
		expect(m.recent(1, now)).toBe(2);
		// The whole history.
		expect(m.recent(121, now)).toBe(14);
		expect(m.recent(500, now)).toBe(14);
		// Nothing moves until the next boundary, however far into the bucket.
		expect(m.recent(11, 13 * B - 1)).toBe(12);
		// At the boundary bucket 2 leaves and an empty bucket 13 arrives.
		expect(m.bucketIndex(13 * B)).toBe(13);
		expect(m.recent(11, 13 * B)).toBe(11);
		// total() still weights the oldest bucket of its hour.
		expect(m.total(13 * B)).toBe(14);
	});

	it('addInto writes buckets oldest first and adds to what is there', () => {
		const a = new RateMeter(HOUR);
		const b = new RateMeter(HOUR);
		a.add(1, 0);
		a.add(3, 2 * B);
		a.add(7, 3 * B + 10);
		b.add(10, 2 * B + 10);
		// The bucket holding `now` is not whole yet, so 7 is left out.
		const out = new Float64Array(4);
		a.addInto(out, 3 * B + 20);
		expect([...out]).toEqual([0, 1, 0, 3]);
		b.addInto(out, 3 * B + 20);
		expect([...out]).toEqual([0, 1, 0, 13]);
		// A meter that never counted adds nothing.
		new RateMeter(HOUR).addInto(out, 3 * B + 20);
		expect([...out]).toEqual([0, 1, 0, 13]);
		// Longer than the history: the oldest entries get nothing.
		const long = new Float64Array(130);
		a.addInto(long, 3 * B + 20);
		expect(long.reduce((s, x) => s + x, 0)).toBe(4);
		expect([...long.slice(-3)]).toEqual([1, 0, 3]);
	});

	it('addInto leaves zeros after a gap longer than the window', () => {
		const m = new RateMeter(HOUR);
		for (let i = 0; i < 120; i++) m.add(1, i * B);
		const later = 300 * B;
		const out = new Float64Array(120);
		m.addInto(out, later);
		expect(out.every((x) => x === 0)).toBe(true);
		expect(m.recent(121, later)).toBe(0);
		// Counting starts over from there.
		m.add(5, later);
		m.addInto(out, later + B);
		expect(out[119]).toBe(5);
		expect(out.slice(0, 119).every((x) => x === 0)).toBe(true);
	});

	it('a clock that goes back keeps the current bucket', () => {
		const m = new RateMeter(HOUR);
		m.add(1, 2 * B + 5000);
		// The browser clock steps back by 40 s.
		const back = 2 * B + 5000 - 40_000;
		expect(m.bucketIndex(back)).toBe(2);
		m.add(1, back);
		expect(m.recent(1, back)).toBe(2);
		expect(m.recent(1, 2 * B + 6000)).toBe(2);
		const out = new Float64Array(2);
		m.addInto(out, back);
		expect([...out]).toEqual([0, 0]);
		// Once the clock passes the bucket again, it is whole.
		m.addInto(out, 3 * B);
		expect([...out]).toEqual([0, 2]);
	});

	it('compact meters count exactly below 2^24', () => {
		const m = new RateMeter(HOUR);
		for (let i = 0; i < 100_000; i++) m.add(1, 1000);
		expect(m.recent(1, 1000)).toBe(100_000);
		m.add(2 ** 24 - 100_001, 1000);
		expect(m.recent(1, 1000)).toBe(2 ** 24 - 1);
		m.add(1, B + 1);
		m.add(2 ** 24 - 2, B + 1);
		expect(m.recent(1, B + 1)).toBe(2 ** 24 - 1);
		// Sums over several buckets are float64, so they stay exact. A float32
		// sum would round this odd number above 2^24 to an even one.
		m.add(1, 2 * B);
		expect(m.recent(3, 2 * B)).toBe(2 ** 25 - 1);
	});
});
