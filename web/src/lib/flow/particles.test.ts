import { describe, expect, it } from 'vitest';
import { SPEED, Stream, seed, spacing } from './particles.ts';

/** Dots on the line at time t, newest first. */
function dots(s: Stream, t: number) {
	const out: { s: number; red: boolean }[] = [];
	s.advance(t);
	s.forEach(t, (d, red) => out.push({ s: d, red }));
	return out;
}

const ms = (px: number) => (px / SPEED) * 1000;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe('Stream', () => {
	it("emits at the start at the level's spacing and moves dots at SPEED", () => {
		const s = new Stream(0, 1000);
		s.setLevel(3, 0);
		// The first dot starts at the line's own place in its spacing: seed 0 starts at once.
		expect(dots(s, 0).map((d) => d.s)).toEqual([0]);
		const t = ms(500);
		const at = dots(s, t).map((d) => d.s);
		// One dot every spacing(3) px, all moving at SPEED.
		const gap = spacing(3);
		expect(at.length).toBe(Math.floor(500 / gap) + 1);
		for (let i = 0; i < at.length; i++) expect(at[i]).toBeCloseTo((500 % gap) + i * gap, 6);
		expect(dots(s, t + 1000).at(-1)!.s).toBeCloseTo(at.at(-1)! + SPEED, 6);
	});

	it('a dot leaves at the end, so a full line holds length / spacing dots', () => {
		const s = new Stream(0.5, 300);
		s.setLevel(4, 0);
		const full = dots(s, ms(5000));
		expect(full.length).toBeGreaterThanOrEqual(Math.floor(300 / spacing(4)));
		expect(full.length).toBeLessThanOrEqual(Math.ceil(300 / spacing(4)));
		expect(Math.max(...full.map((d) => d.s))).toBeLessThanOrEqual(300);
	});

	it('a level change only changes the spacing of new dots: nothing jumps', () => {
		const s = new Stream(0.3, 2000);
		s.setLevel(1, 0);
		const t = ms(1200);
		const before = dots(s, t);
		s.setLevel(4, t);
		// The dots on the line stay where they are. The last one started longer
		// ago than the new spacing, so a new dot starts at once.
		expect(before[0].s).toBeGreaterThan(spacing(4));
		const after = dots(s, t);
		expect(after[0].s).toBe(0);
		expect(after.slice(1)).toEqual(before);
		// They keep going at the same speed.
		const later = dots(s, t + 500);
		for (const d of before) expect(later.some((l) => near(l.s, d.s + SPEED / 2))).toBe(true);
		// New dots come every spacing(4) px.
		const gap = spacing(4);
		const fresh = later.filter((l) => !before.some((d) => near(l.s, d.s + SPEED / 2)));
		expect(fresh.length).toBe(1 + Math.floor(SPEED / 2 / gap));
		for (let i = 1; i < fresh.length; i++) expect(fresh[i].s - fresh[i - 1].s).toBeCloseTo(gap, 6);
	});

	it('a slower level keeps the dots on the line and spaces new ones further', () => {
		const s = new Stream(0, 2000);
		s.setLevel(4, 0);
		const t = ms(1000);
		const before = dots(s, t);
		s.setLevel(1, t);
		expect(dots(s, t)).toEqual(before);
		// New dots come every spacing(1) px after the last one that started
		// before the change, and the dots already there move on.
		const gap = spacing(1);
		const moved = 300;
		const last = before[0].s + moved;
		const fresh: number[] = [];
		for (let x = last - gap; x >= 0; x -= gap) fresh.unshift(x);
		expect(fresh.length).toBeGreaterThan(0);
		const later = dots(s, t + ms(moved)).map((d) => d.s);
		const expected = [...fresh, ...before.map((d) => d.s + moved)];
		expect(later).toHaveLength(expected.length);
		expected.forEach((v, i) => expect(later[i]).toBeCloseTo(v, 6));
	});

	it('an idle line stops emitting and its dots run out', () => {
		const s = new Stream(0, 560);
		s.setLevel(2, 0);
		const t = ms(1000);
		const n = dots(s, t).length;
		expect(n).toBeGreaterThan(5);
		s.setLevel(0, t);
		expect(s.emitting).toBe(false);
		expect(dots(s, t).length).toBe(n);
		// Half a line later, the dots that were in the far half have left.
		expect(dots(s, t + ms(280)).length).toBeLessThan(n);
		expect(dots(s, t + ms(280)).every((d) => d.s >= 280)).toBe(true);
		expect(s.busy).toBe(true);
		// A line's length later, all are gone and nothing more moves.
		expect(dots(s, t + ms(561))).toEqual([]);
		expect(s.busy).toBe(false);
	});

	it('a line that turns active again starts at its start, keeping its spacing', () => {
		const s = new Stream(0, 400);
		s.setLevel(3, 0);
		s.setLevel(0, ms(100));
		s.setLevel(3, ms(110));
		// The next dot starts one spacing after the last one before the pause,
		// not when the line woke up, so every dot keeps the same spacing.
		const d = dots(s, ms(200)).map((x) => x.s);
		expect(d.filter((x) => x < 200 - 110).length).toBeGreaterThan(0);
		for (let i = 1; i < d.length; i++) expect(d[i] - d[i - 1]).toBeCloseTo(spacing(3), 6);
	});

	it('prefill fills an empty line at its spacing, so a fresh page does not start empty', () => {
		const s = new Stream(0.25, 500);
		s.setLevel(2, 1000, true);
		const gap = spacing(2);
		const d = dots(s, 1000).map((x) => x.s);
		expect(d[0]).toBeCloseTo(0.25 * gap, 6);
		for (let i = 1; i < d.length; i++) expect(d[i] - d[i - 1]).toBeCloseTo(gap, 6);
		expect(d.at(-1)!).toBeLessThanOrEqual(500);
		expect(500 - d.at(-1)!).toBeLessThan(gap);
		// The next dot keeps the spacing.
		const next = dots(s, 1000 + ms(gap)).map((x) => x.s);
		expect(next[0]).toBeCloseTo(0.25 * gap, 6);
		// Prefill only fills an empty, idle line.
		const busy = new Stream(0, 500);
		busy.setLevel(1, 0);
		busy.setLevel(4, ms(10), true);
		expect(dots(busy, ms(10)).length).toBe(1);
	});

	it('a line held still keeps its dots where they are, however long', () => {
		const s = new Stream(0, 300);
		s.setLevel(3, 0);
		const t = ms(400);
		const a = dots(s, t);
		// Its own time stands still while held, so the same time gives the same dots.
		expect(dots(s, t)).toEqual(a);
		// A long hold later the line is as full as ever, with no burst of dots.
		const later = dots(s, t + 600_000);
		expect(later.length).toBeLessThanOrEqual(Math.ceil(300 / spacing(3)));
		expect(later.length).toBeGreaterThanOrEqual(Math.floor(300 / spacing(3)));
	});

	it('a shorter track drops the dots past its new end', () => {
		const s = new Stream(0, 600);
		s.setLevel(4, 0);
		const t = ms(2000);
		expect(dots(s, t).some((d) => d.s > 300)).toBe(true);
		s.length = 300;
		expect(dots(s, t).every((d) => d.s <= 300)).toBe(true);
	});

	it('spacing and seeds', () => {
		// Idle lines emit nothing; busier levels space their dots closer, up to the busiest.
		expect(spacing(0)).toBe(0);
		const levels = [1, 2, 3, 4].map(spacing);
		for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThan(levels[i - 1]);
		expect(levels[3]).toBeGreaterThan(0);
		expect(spacing(5)).toBe(spacing(4));
		const a = seed('assign:10.0.0.10:50051');
		expect(a).toBeGreaterThanOrEqual(0);
		expect(a).toBeLessThan(1);
		expect(seed('assign:10.0.0.10:50051')).toBe(a);
		expect(seed('assign:10.0.0.11:50051')).not.toBe(a);
	});
});

describe('failure marks among the dots', () => {
	/** Colors of the next n dots the stream starts, oldest first. */
	function emitted(s: Stream, level: number, n: number, from = 0) {
		const gap = ms(spacing(level));
		const out: boolean[] = [];
		for (let i = 0; i < n; i++) {
			const d = dots(s, from + i * gap);
			out.push(d[0].red);
		}
		return out;
	}

	it('m red slots in every 10 dots, spread evenly', () => {
		for (let m = 0; m <= 10; m++) {
			const s = new Stream(0, 100_000);
			s.setFails(m);
			s.setLevel(4, 0);
			const red = emitted(s, 4, 30);
			for (let k = 0; k < 3; k++)
				expect(red.slice(k * 10, k * 10 + 10).filter(Boolean).length, `m=${m}`).toBe(m);
		}
		const s = new Stream(0, 100_000);
		s.setFails(3);
		s.setLevel(4, 0);
		// No two red dots in a row while fewer than half are red.
		const red = emitted(s, 4, 20);
		for (let i = 1; i < red.length; i++) expect(red[i] && red[i - 1]).toBe(false);
	});

	it('the first failure shows on the next dot, and dots on the line keep their color', () => {
		const s = new Stream(0, 100_000);
		s.setLevel(4, 0);
		const gap = ms(spacing(4));
		const before = dots(s, 5 * gap);
		expect(before.every((d) => !d.red)).toBe(true);
		s.setFails(1);
		const after = dots(s, 6 * gap);
		// The new dot is red; the five before it stay blue.
		expect(after[0].red).toBe(true);
		expect(after.slice(1).every((d) => !d.red)).toBe(true);
		// A share that falls to 0 leaves the red dot on its way.
		s.setFails(0);
		const later = dots(s, 9 * gap);
		expect(later.filter((d) => d.red).length).toBe(1);
		expect(later.slice(0, 3).every((d) => !d.red)).toBe(true);
	});

	it('prefilled dots carry the share too', () => {
		const s = new Stream(0, spacing(4) * 40 - 1);
		s.setFails(5);
		s.setLevel(4, 0, true);
		const d = dots(s, 0);
		expect(d.length).toBe(40);
		expect(d.filter((x) => x.red).length).toBe(20);
	});
});
