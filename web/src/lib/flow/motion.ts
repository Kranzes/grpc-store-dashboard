// When the line canvas draws. Two kinds of frames:
//
// - A draw on the next display frame, when the picture itself changed: the
//   layout, the canvas size or the colors. The view's own moves draw at once
//   instead, through LineLayer.setView, in the frame that moves the cards.
// - Animation ticks, while dots travel or a line eases, at most MAX_FPS times
//   a second whatever the screen's refresh rate, on a steady grid. On a 240 Hz
//   screen the clock waits on a timer between ticks instead of on every frame.
//
// Ticks stop when nothing moves. The canvas draws in one go, so a tick costs
// one repaint of the canvas and nothing else on the page.

/** Animation ticks per second at most. At 56 px/s a dot moves under 1 px per tick. */
export const MAX_FPS = 60;
/** How long a line takes to reach a new width, ms. Matches --dur-slow. */
export const EASE_MS = 320;
/** How long a line's band takes to fade in or out when it turns active or idle, ms. */
export const HALO_MS = 500;
/** How long a line takes to fade with focus, ms. Matches --dur-fast. */
export const FADE_MS = 120;

const STEP = 1000 / MAX_FPS;
/** A frame this close before the next tick takes it, so a 60 Hz screen ticks every frame. */
const SLACK = 2;
/** Until this long before the next tick, wait on a timer instead of on every frame. */
const EARLY = 8;

/** What the clock needs from the browser. Tests pass a fake. */
export type FrameEnv = {
	now(): number;
	requestAnimationFrame(cb: (t: number) => void): number;
	cancelAnimationFrame(id: number): void;
	setTimeout(cb: () => void, ms: number): number;
	clearTimeout(id: number): void;
};

export class Frames {
	#env: FrameEnv;
	/** Draws at the given clock time and says whether it wants another tick. */
	#draw: (now: number) => boolean;
	#raf = 0;
	#timer = 0;
	/** A draw is asked for on the next frame, tick or not. */
	#soon = false;
	#due = -Infinity;
	#stopped = false;

	constructor(env: FrameEnv, draw: (now: number) => boolean) {
		this.#env = env;
		this.#draw = draw;
	}

	/** Draw on the next display frame. */
	soon() {
		if (this.#stopped) return;
		this.#soon = true;
		if (this.#raf) return;
		this.#clearTimer();
		this.#raf = this.#env.requestAnimationFrame(this.#frame);
	}

	/** Make sure a tick comes, on the 60 Hz grid. */
	wake() {
		if (this.#stopped || this.#raf || this.#timer) return;
		this.#raf = this.#env.requestAnimationFrame(this.#frame);
	}

	/**
	 * A draw happened outside the frames, at clock time `now`. A pending
	 * `soon` is done, and it counts as a tick, so a frame that follows in the
	 * same display frame does not draw again.
	 */
	drawn(now: number) {
		this.#soon = false;
		if (now >= this.#due - SLACK) this.#due = now + STEP;
	}

	/** No frames until `start`, as in a hidden tab. */
	stop() {
		this.#stopped = true;
		this.#cancel();
	}

	start() {
		this.#stopped = false;
	}

	destroy() {
		this.stop();
	}

	#cancel() {
		if (this.#raf) this.#env.cancelAnimationFrame(this.#raf);
		this.#raf = 0;
		this.#clearTimer();
	}

	#clearTimer() {
		if (this.#timer) this.#env.clearTimeout(this.#timer);
		this.#timer = 0;
	}

	#frame = (t: number) => {
		this.#raf = 0;
		if (this.#stopped) return;
		const tick = t >= this.#due - SLACK;
		if (!tick && !this.#soon) return this.#later(t);
		// Keep to the 60 Hz grid while on time; start a new one after a gap.
		if (tick) this.#due = t - this.#due < STEP ? this.#due + STEP : t + STEP;
		this.#soon = false;
		if (this.#draw(this.#env.now())) this.#later(t);
	};

	#later(t: number) {
		const env = this.#env;
		const wait = this.#due - EARLY - t;
		if (wait < 1) {
			this.#raf = env.requestAnimationFrame(this.#frame);
			return;
		}
		this.#timer = env.setTimeout(() => {
			this.#timer = 0;
			this.#raf = env.requestAnimationFrame(this.#frame);
		}, wait);
	}
}

/** A number that eases to a new value over a fixed time, close to --ease-out. */
export class Ease {
	#from: number;
	#to: number;
	#start = -Infinity;
	readonly ms: number;

	constructor(value: number, ms: number) {
		this.#from = value;
		this.#to = value;
		this.ms = ms;
	}

	get target(): number {
		return this.#to;
	}

	/** Head for `to` from where it is at `now`, or jump there at once. */
	set(to: number, now: number, instant = false) {
		if (to === this.#to && (!instant || !this.moving(now))) return;
		this.#from = instant ? to : this.value(now);
		this.#to = to;
		this.#start = instant ? -Infinity : now;
	}

	value(now: number): number {
		const u = (now - this.#start) / this.ms;
		if (!(u < 1)) return this.#to;
		// Close to cubic-bezier(0.2, 0.7, 0.2, 1).
		return this.#from + (this.#to - this.#from) * (1 - (1 - Math.max(0, u)) ** 4);
	}

	/** Still on its way at `now`. One tick past the end, so the last frame lands on the target. */
	moving(now: number): boolean {
		return now < this.#start + this.ms + STEP;
	}
}

export function browserFrames(): FrameEnv | null {
	if (typeof window === 'undefined') return null;
	return {
		now: () => performance.now(),
		requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
		cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
		setTimeout: (cb, ms) => window.setTimeout(cb, ms),
		clearTimeout: (id) => window.clearTimeout(id)
	};
}
