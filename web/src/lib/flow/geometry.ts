// Where the lines of a layout run, in flow coordinates, and which lines a
// point on the map means. Computed once per layout, so a pointer move
// costs one pass over cached polylines.

import type { LineKind } from './kinds.ts';
import {
	BUILDER_PORT_OFFSET,
	POOL_PORT_Y,
	SUBSTITUTE_PORT_OFFSET,
	UPSTREAM_PORT_Y,
	type Layout,
	type LayoutNode
} from './layout.ts';
import { routePoints } from './route.ts';

export type Pt = readonly [number, number];

export type LineGeom = Readonly<{
	id: string;
	kind: LineKind;
	source: string;
	target: string;
	/** routePoints between the handle points below. */
	points: readonly Pt[];
}>;

/**
 * Where a handle sits in flow coordinates, as the node components place it.
 * Svelte Flow draws line ends about 1 px outside these, because its handles
 * are 2 px wide; hit tolerances absorb that.
 */
export function handlePoint(n: LayoutNode, handle: string): Pt {
	if (n.kind === 'cache' && (handle === 'publish' || handle === 'fetch'))
		return [n.x, n.y + (n.ports?.[handle] ?? 0)];
	if (handle === 'top') return [n.x + n.w / 2, n.y];
	if (n.kind === 'upstream') return [n.x, n.y + UPSTREAM_PORT_Y];
	// A pool's handles sit near its top, so they stay put while its grid grows.
	const cy = n.kind === 'pool' ? n.y + POOL_PORT_Y : n.y + n.h / 2;
	switch (handle) {
		case 'in':
			return [n.x, cy];
		case 'publish':
			return [n.x + n.w, cy - BUILDER_PORT_OFFSET];
		case 'fetch':
			return [n.x + n.w, cy + BUILDER_PORT_OFFSET];
		case 'substitute':
			return [n.x + n.w, cy + SUBSTITUTE_PORT_OFFSET];
		default:
			return [n.x + n.w, cy];
	}
}

/** Every line of a layout, in layout order. */
export function lineGeometry(layout: Layout): LineGeom[] {
	const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
	const lines: LineGeom[] = [];
	for (const e of layout.lines) {
		const src = nodes.get(e.source);
		const dst = nodes.get(e.target);
		if (!src || !dst) continue;
		const [sx, sy] = handlePoint(src, e.sourceHandle);
		const [tx, ty] = handlePoint(dst, e.targetHandle);
		lines.push({
			id: e.id,
			kind: e.kind,
			source: e.source,
			target: e.target,
			points: routePoints(sx, sy, tx, ty, e.route)
		});
	}
	return lines;
}

/** Distance from p to the segment a-b, and the nearest point on it. */
function nearest(p: Pt, a: Pt, b: Pt): { d: number; q: Pt } {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t =
		len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
	const q: Pt = [a[0] + t * dx, a[1] + t * dy];
	return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), q };
}

/** Distance from p to the nearest segment of a line, and the nearest point there. */
function toLine(line: LineGeom, p: Pt): { d: number; q: Pt } {
	const pts = line.points;
	if (pts.length === 1) return nearest(p, pts[0], pts[0]);
	let best = { d: Infinity, q: p };
	for (let i = 1; i < pts.length; i++) {
		const r = nearest(p, pts[i - 1], pts[i]);
		if (r.d < best.d) best = r;
	}
	return best;
}

/** Lines closer than this to each other draw on top of each other. */
const SAME = 0.5;

/**
 * Edge ids the user means by a point: one line, or every line of one kind
 * drawn over each other there, in the order of `lines`. Empty when no line
 * passes within `tol`.
 *
 * The nearest line wins. Between lines of two kinds at the same distance,
 * where they cross, the one painted on top wins: the higher `rank`, which
 * is the paint order, or without one the later in the list. Corners count
 * as sharp: a rounded corner passes 4.2 px inside its sharp one, which a
 * tolerance of 6 px covers.
 */
export function hitLines(
	lines: readonly LineGeom[],
	p: Pt,
	tol: number,
	rank?: ReadonlyMap<string, number>
): string[] {
	const near: { line: LineGeom; d: number; q: Pt; rank: number }[] = [];
	// Every line within reach, then the nearest one, then its kind's lines
	// that run through the same spot.
	let min = Infinity;
	for (const [i, line] of lines.entries()) {
		const r = toLine(line, p);
		if (r.d > tol) continue;
		near.push({ line, ...r, rank: rank?.get(line.id) ?? i });
		if (r.d < min) min = r.d;
	}
	if (near.length === 0) return [];
	let win = near[0];
	for (const c of near)
		if (c.d <= min + SAME && (win.d > min + SAME || c.rank >= win.rank)) win = c;
	const { kind } = win.line;
	const q = win.q;
	const ids: string[] = [];
	for (const line of lines) {
		if (line.kind !== kind) continue;
		if (line === win.line || toLine(line, q).d <= SAME) ids.push(line.id);
	}
	return ids;
}
