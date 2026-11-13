import { describe, expect, it } from 'vitest';
import { fakeFrames } from './fixtures.ts';
import { EASE_MS, Ease, Frames } from './motion.ts';

describe('Frames', () => {
	it('ticks at most 60 times a second on a 240 Hz screen, on a steady grid', () => {
		const f = fakeFrames();
		const at: number[] = [];
		const frames = new Frames(f.env, (now) => {
			at.push(now);
			return true;
		});
		frames.wake();
		f.run(2000);
		expect(at.length).toBeGreaterThanOrEqual(118);
		expect(at.length).toBeLessThanOrEqual(121);
		for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThan(12);
		// Between ticks the clock waits on a timer, not on every display frame.
		expect(f.frames).toBeLessThan(at.length * 2 + 2);
	});

	it('a 60 Hz screen ticks on every frame', () => {
		const f = fakeFrames();
		let n = 0;
		const frames = new Frames(f.env, () => {
			n++;
			return true;
		});
		frames.wake();
		f.run(1000, 60);
		expect(n).toBeGreaterThanOrEqual(59);
	});

	it('stops when nothing moves, and soon() draws once on the next frame', () => {
		const f = fakeFrames();
		let n = 0;
		let busy = 3;
		const frames = new Frames(f.env, () => {
			n++;
			return --busy > 0;
		});
		frames.wake();
		f.run(500);
		expect(n).toBe(3);
		expect(f.idle()).toBe(true);
		frames.soon();
		f.run(510);
		expect(n).toBe(4);
		expect(f.idle()).toBe(true);
	});

	it('a draw outside the frames counts as a tick, so the same display frame does not draw twice', () => {
		const f = fakeFrames();
		let n = 0;
		const frames = new Frames(f.env, () => {
			n++;
			return true;
		});
		frames.wake();
		f.run(100);
		// A tick is due by now; the view drew instead.
		f.skip(20);
		const before = n;
		frames.drawn(f.time);
		f.run(f.time + 1000 / 240);
		expect(n).toBe(before);
		// The next tick keeps to the grid from there.
		f.run(f.time + 20);
		expect(n).toBe(before + 1);
	});

	it('stop() holds every frame until start()', () => {
		const f = fakeFrames();
		let n = 0;
		const frames = new Frames(f.env, () => {
			n++;
			return true;
		});
		frames.wake();
		f.run(100);
		frames.stop();
		const held = n;
		frames.soon();
		frames.wake();
		f.run(1000);
		expect(n).toBe(held);
		expect(f.idle()).toBe(true);
		frames.start();
		frames.wake();
		f.run(1100);
		expect(n).toBeGreaterThan(held);
	});
});

describe('Ease', () => {
	it('eases to its target and lands on it', () => {
		const e = new Ease(2, EASE_MS);
		e.set(6, 0);
		const mid = e.value(EASE_MS / 2);
		expect(mid).toBeGreaterThan(4);
		expect(mid).toBeLessThan(6);
		expect(e.value(EASE_MS)).toBe(6);
		expect(e.moving(EASE_MS)).toBe(true);
		expect(e.moving(EASE_MS + 20)).toBe(false);
		// A new target starts from where it is, not from its old start.
		const at100 = e.value(100);
		e.set(2, 100);
		expect(e.value(100)).toBeCloseTo(at100, 9);
		expect(e.value(100)).toBeGreaterThan(5);
		e.set(0, 150, true);
		expect(e.value(150)).toBe(0);
		expect(e.moving(150)).toBe(false);
	});
});
