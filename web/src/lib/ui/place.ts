// Where a readout box sits beside the pointer.

/**
 * The start of a box `size` long, `after` px past `at`, or `before` px short
 * of it where it would run past `limit`, and never before 0. Along x: right
 * of the pointer, or left of it at the edge.
 */
export function beside(at: number, size: number, limit: number, after: number, before = after) {
	return at + after + size > limit ? Math.max(0, at - before - size) : at + after;
}
