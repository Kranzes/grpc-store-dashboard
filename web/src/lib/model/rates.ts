// Smoothed rate meters for lines and per-minute counts, and the bucket
// histories behind line charts.
//
// A sliding window split into buckets. The meter weights the oldest bucket
// by how much of it still lies inside the window, so the rate changes
// smoothly instead of in steps, and it reaches exactly 0 one window after
// the last event. Cost: O(1) per add, O(buckets) once per bucket period.
//
// Buckets sit at absolute times, `floor(now / bucketMs)`, so meters with the
// same bucket length share their boundaries and their bucket indexes.

export type RateMeterOptions = {
	/** Window length in ms. Default 10 s. */
	windowMs?: number;
	/** Buckets per window. Default 20. */
	buckets?: number;
	/** Float32 buckets, for long histories. Counts stay exact below 2^24 per bucket. */
	compact?: boolean;
};

export class RateMeter {
	readonly windowMs: number;
	readonly bucketMs: number;
	// One more bucket than the window holds: the partly expired oldest one.
	readonly #b: Float64Array | Float32Array;
	#head = -1;
	// Always a float64, also over Float32 buckets.
	#sum = 0;

	constructor(options: RateMeterOptions = {}) {
		this.windowMs = options.windowMs ?? 10_000;
		const buckets = Math.max(1, Math.round(options.buckets ?? 20));
		this.bucketMs = this.windowMs / buckets;
		this.#b = options.compact ? new Float32Array(buckets + 1) : new Float64Array(buckets + 1);
	}

	/** Record `amount`, events or bytes, at time `now`. */
	add(amount: number, now: number): void {
		if (!(amount > 0)) return;
		const h = this.#advance(now);
		this.#b[h % this.#b.length] += amount;
		this.#sum += amount;
	}

	/** Amount within the window ending at `now`. */
	total(now: number): number {
		if (this.#head < 0) return 0;
		const h = this.#advance(now);
		if (this.#sum === 0) return 0;
		const frac = (now - h * this.bucketMs) / this.bucketMs;
		const oldest = this.#b[(h + 1) % this.#b.length];
		const t = this.#sum - Math.min(1, Math.max(0, frac)) * oldest;
		return t > 0 ? t : 0;
	}

	/** Per second, averaged over the window. */
	rate(now: number): number {
		return (this.total(now) * 1000) / this.windowMs;
	}

	/** True when nothing was recorded within the window. */
	idle(now: number): boolean {
		return this.total(now) === 0;
	}

	/** Absolute index of the bucket that holds `now`. */
	bucketIndex(now: number): number {
		const h = Math.floor(now / this.bucketMs);
		return h < this.#head ? this.#head : h;
	}

	/**
	 * Sum of the bucket holding `now` and the n - 1 before it, without
	 * weighting, so it changes only when an amount arrives or a bucket
	 * boundary passes. At most one window plus the current bucket.
	 */
	recent(n: number, now: number): number {
		if (this.#head < 0) return 0;
		const h = this.#advance(now);
		const len = this.#b.length;
		const k = Math.min(len, Math.max(0, Math.floor(n)));
		let s = 0;
		for (let i = 0; i < k; i++) s += this.#b[mod(h - i, len)];
		return s;
	}

	/**
	 * Adds the whole buckets before the current one into `out`, oldest first,
	 * so out[out.length - 1] is the last whole bucket. Several meters can add
	 * into one array. Entries older than the window get nothing.
	 */
	addInto(out: Float64Array, now: number): void {
		if (this.#head < 0) return;
		const h = this.#advance(now);
		const len = this.#b.length;
		const k = Math.min(out.length, len - 1);
		for (let j = 1; j <= k; j++) out[out.length - j] += this.#b[mod(h - j, len)];
	}

	// Moves the window so that its newest bucket holds `now`. Returns that
	// bucket's absolute index. A clock that goes back keeps the current bucket.
	#advance(now: number): number {
		const h = Math.floor(now / this.bucketMs);
		if (this.#head < 0) {
			this.#head = h;
			return h;
		}
		if (h <= this.#head) return this.#head;
		const n = this.#b.length;
		const clear = Math.min(h - this.#head, n);
		for (let i = 1; i <= clear; i++) this.#b[(this.#head + i) % n] = 0;
		this.#head = h;
		// Recompute instead of subtracting, so float error never keeps a
		// silent meter above zero.
		let s = 0;
		for (let i = 0; i < n; i++) s += this.#b[i];
		this.#sum = s;
		return h;
	}
}

/** Index into a ring, also for negative positions. */
function mod(i: number, n: number): number {
	const r = i % n;
	return r < 0 ? r + n : r;
}
