// The dots on a line, as particles. Each active line emits a dot at its start
// every so often, set by its traffic level, and each dot travels at a steady
// speed until it leaves at the end. A level change only changes how often new
// dots start, so the dots already on the line keep going and the density
// changes as they run out; nothing jumps or starts over. A line that turns
// idle stops emitting, and its dots run out.
//
// A dot's place follows from when it started, so frames that come late or not
// at all never move a dot off its course. Time here is the line's own time in
// ms, which stands still while focus, a pan or a hidden tab holds the line.

import { SLOTS, firstFailSlot, isFailSlot } from './marks.ts';

/** Dot speed along a line, flow px per second. The same on every line. */
export const SPEED = 56;
/** Dot spacing per traffic level 1 to 4, flow px. More traffic, denser dots. */
export const SPACING = [120, 76, 46, 28] as const;

/** Spacing in flow px for a traffic level, or 0 when idle. */
export function spacing(level: number): number {
	return level > 0 ? SPACING[Math.min(SPACING.length, level) - 1] : 0;
}

/** How far a dot goes in `ms`, flow px. */
const travel = (ms: number) => (SPEED * ms) / 1000;

export class Stream {
	/**
	 * Where in its spacing this line's dots start, 0 to 1. Lines drawn over
	 * each other on a bus would otherwise put their dots on the same spots.
	 */
	readonly seed: number;
	#length: number;
	/** Start times of the dots on the line, oldest first, in a ring. */
	#times = new Float64Array(16);
	#red = new Uint8Array(16);
	#head = 0;
	#count = 0;
	/** ms between new dots, 0 while idle. */
	#interval = 0;
	#next = Infinity;
	#last = -Infinity;
	/** Dots started so far, which picks each one's slot in the cycle of 10. */
	#slot = 0;
	/** Red slots out of 10 for new dots. */
	#fails = 0;

	constructor(seed: number, length: number) {
		this.seed = seed;
		this.#length = Math.max(0, length);
	}

	/** Track length, flow px. A layout change may change it; dots past the new end leave. */
	get length(): number {
		return this.#length;
	}

	set length(len: number) {
		this.#length = Math.max(0, len);
	}

	/** Dots on the line. */
	get size(): number {
		return this.#count;
	}

	/** Whether dots are on the line or new ones will start. */
	get busy(): boolean {
		return this.#count > 0 || this.#interval > 0;
	}

	/** Whether the line starts new dots. */
	get emitting(): boolean {
		return this.#interval > 0;
	}

	/**
	 * Start new dots at `level` from line time `t` on, 0 to stop. `prefill`
	 * fills an empty line as if it had carried this traffic for as long as a
	 * dot takes to cross it, so a fresh page does not start empty.
	 */
	setLevel(level: number, t: number, prefill = false): void {
		this.advance(t);
		const gap = spacing(level);
		const interval = gap > 0 ? (gap / SPEED) * 1000 : 0;
		if (interval === this.#interval) return;
		if (interval === 0) {
			this.#interval = 0;
			this.#next = Infinity;
			return;
		}
		if (prefill && this.#count === 0 && this.#interval === 0) {
			this.#prefill(gap, interval, t);
		} else if (this.#interval > 0) {
			// Only the spacing of new dots changes, counted from the last one.
			this.#next = Math.max(t, this.#last + interval);
		} else {
			// Waking up: start at the line's own place in the spacing, and never
			// closer to the last dot than the new spacing.
			this.#next = Math.max(this.#last + interval, t + this.seed * interval);
		}
		this.#interval = interval;
	}

	/**
	 * Red slots out of 10 for the dots that start from now on. Dots already
	 * on the line keep their color. When a line first fails, the next dot is
	 * red, so a failure shows without waiting for a cycle of 10.
	 */
	setFails(m: number): void {
		if (m === this.#fails) return;
		if (this.#fails === 0 && m > 0) {
			const first = firstFailSlot(m);
			this.#slot += (first - (this.#slot % SLOTS) + SLOTS) % SLOTS;
		}
		this.#fails = m;
	}

	/** Start the dots due by line time `t` and drop the ones that left. */
	advance(t: number): void {
		if (this.#interval > 0 && this.#next <= t) {
			// After a long hold, skip dots that would have left already.
			const life = (this.#length / SPEED) * 1000;
			const behind = t - life - this.#interval - this.#next;
			if (behind > 0) {
				const skip = Math.ceil(behind / this.#interval);
				this.#next += skip * this.#interval;
				this.#slot += skip;
			}
			while (this.#next <= t) {
				this.#push(this.#next, isFailSlot(this.#slot % SLOTS, this.#fails));
				this.#slot++;
				this.#last = this.#next;
				this.#next += this.#interval;
			}
		}
		while (this.#count > 0 && travel(t - this.#times[this.#head]) > this.#length) {
			this.#head = (this.#head + 1) % this.#times.length;
			this.#count--;
		}
	}

	/**
	 * Each dot on the line at line time `t`, newest first, so the distance
	 * from the start grows: `s` in flow px, `red` for a failure mark.
	 */
	forEach(t: number, fn: (s: number, red: boolean) => void): void {
		const cap = this.#times.length;
		for (let k = this.#count - 1; k >= 0; k--) {
			const i = (this.#head + k) % cap;
			const s = travel(t - this.#times[i]);
			if (s < 0 || s > this.#length) continue;
			fn(s, this.#red[i] === 1);
		}
	}

	#prefill(gap: number, interval: number, t: number) {
		// Dots at seed * gap, then every gap further out, oldest first.
		const n = Math.max(0, Math.floor((this.#length - this.seed * gap) / gap) + 1);
		for (let j = n - 1; j >= 0; j--) {
			const s = this.seed * gap + j * gap;
			this.#push(t - (s / SPEED) * 1000, isFailSlot(this.#slot % SLOTS, this.#fails));
			this.#slot++;
		}
		this.#last = t - ((this.seed * gap) / SPEED) * 1000;
		this.#next = this.#last + interval;
	}

	#push(time: number, red: boolean) {
		if (this.#count === this.#times.length) this.#grow();
		const i = (this.#head + this.#count) % this.#times.length;
		this.#times[i] = time;
		this.#red[i] = red ? 1 : 0;
		this.#count++;
	}

	#grow() {
		const cap = this.#times.length;
		const times = new Float64Array(cap * 2);
		const red = new Uint8Array(cap * 2);
		for (let k = 0; k < this.#count; k++) {
			times[k] = this.#times[(this.#head + k) % cap];
			red[k] = this.#red[(this.#head + k) % cap];
		}
		this.#times = times;
		this.#red = red;
		this.#head = 0;
	}
}

/** A fixed fraction from 0 to 1 per key (FNV-1a), for a line's place in its spacing. */
export function seed(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
	return (h >>> 0) / 2 ** 32;
}
