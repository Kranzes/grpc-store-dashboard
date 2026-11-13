// Failure marks on assignment and request lines. A share of a line's
// particles are red bars instead of dots, quantised into slots out of ten.
// Pure, so the rules can be tested without a canvas.

/** Particles come in cycles of this many slots. */
export const SLOTS = 10;

/**
 * Slots out of 10 that carry a failure bar. Any failure shows as at least 1
 * in 10, so a 3% share is still visible; labels and panels give the exact share.
 */
export function failSlots(share: number | null): number {
	if (share === null || !(share > 0)) return 0;
	return Math.min(SLOTS, Math.max(1, Math.round(share * SLOTS)));
}

/** Whether slot i (0 to 9) is red with m red slots, which spreads them evenly. */
export function isFailSlot(i: number, m: number): boolean {
	return Math.floor(((i + 1) * m) / SLOTS) > Math.floor((i * m) / SLOTS);
}

/** The first red slot with m red slots, or -1 with none. */
export function firstFailSlot(m: number): number {
	for (let i = 0; i < SLOTS; i++) if (isFailSlot(i, m)) return i;
	return -1;
}

/**
 * Above this zoom, the marks on the lines stop growing with the map: dots,
 * failure bars and rate labels. Zooming in should enlarge the cards, not the
 * overlay. Line widths keep scaling.
 */
export const MARK_MAX_ZOOM = 1.25;

/** What marks are scaled by at `zoom`, so on screen they grow no larger than at MARK_MAX_ZOOM. */
export function markScale(zoom: number): number {
	return zoom > MARK_MAX_ZOOM ? MARK_MAX_ZOOM / zoom : 1;
}

/** Dot diameter for a line width, flow px, as the dots have always been drawn. */
export function dotSize(width: number): number {
	return Math.max(4, Math.min(8, width + 2.5));
}

/** A failure bar's size for a dot size: twice as long, 2 px wider, so it stands past the line. */
export function barSize(dot: number): { length: number; width: number } {
	return { length: 2 * dot, width: dot + 2 };
}
