// The path a line draws and its dots travel, in flow coordinates: the
// route's points with each corner rounded by a quadratic curve through
// it. The track flattens corners into short segments, so a dot finds its
// place by distance along the line.

import type { Pt } from './geometry.ts';

/** Corner rounding, px; smaller where segments are short. */
const RADIUS = 12;
/** Straight pieces per rounded corner. Under 0.1 px off the curve at 12 px. */
const CORNER_STEPS = 8;

/** One drawing command of a line's path. */
export type PathOp =
	| { op: 'M' | 'L'; x: number; y: number }
	| { op: 'Q'; cx: number; cy: number; x: number; y: number };

export type Track = Readonly<{
	/** The path as drawn, for a canvas. */
	ops: readonly PathOp[];
	/** The flattened path: vertices and the distance from the start at each. */
	xs: Float64Array;
	ys: Float64Array;
	at: Float64Array;
	length: number;
	/** Bounding box, flow px. */
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}>;

function dist(a: Pt, b: Pt) {
	return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** The point r px from p toward q. */
function toward(p: Pt, q: Pt, r: number): Pt {
	const d = dist(p, q) || 1;
	return [p[0] + ((q[0] - p[0]) / d) * r, p[1] + ((q[1] - p[1]) / d) * r];
}

export function trackOf(points: readonly Pt[]): Track {
	const ops: PathOp[] = [];
	const xs: number[] = [];
	const ys: number[] = [];
	const add = (x: number, y: number) => {
		const n = xs.length;
		if (n > 0 && xs[n - 1] === x && ys[n - 1] === y) return;
		xs.push(x);
		ys.push(y);
	};
	if (points.length > 0) {
		ops.push({ op: 'M', x: points[0][0], y: points[0][1] });
		add(points[0][0], points[0][1]);
	}
	for (let i = 1; i < points.length - 1; i++) {
		const a = points[i - 1];
		const p = points[i];
		const b = points[i + 1];
		const r = Math.min(RADIUS, dist(a, p) / 2, dist(p, b) / 2);
		const inPt = toward(p, a, r);
		const outPt = toward(p, b, r);
		ops.push({ op: 'L', x: inPt[0], y: inPt[1] });
		ops.push({ op: 'Q', cx: p[0], cy: p[1], x: outPt[0], y: outPt[1] });
		add(inPt[0], inPt[1]);
		for (let k = 1; k <= CORNER_STEPS; k++) {
			const u = k / CORNER_STEPS;
			const v = 1 - u;
			add(
				v * v * inPt[0] + 2 * v * u * p[0] + u * u * outPt[0],
				v * v * inPt[1] + 2 * v * u * p[1] + u * u * outPt[1]
			);
		}
	}
	if (points.length > 1) {
		const end = points[points.length - 1];
		ops.push({ op: 'L', x: end[0], y: end[1] });
		add(end[0], end[1]);
	}
	const at = new Float64Array(xs.length);
	for (let i = 1; i < xs.length; i++)
		at[i] = at[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
	return {
		ops,
		xs: Float64Array.from(xs),
		ys: Float64Array.from(ys),
		at,
		length: at.length > 0 ? at[at.length - 1] : 0,
		minX: Math.min(...xs),
		minY: Math.min(...ys),
		maxX: Math.max(...xs),
		maxY: Math.max(...ys)
	};
}

/** A point on a track and the direction of travel there. */
export type TrackPoint = { x: number; y: number; dx: number; dy: number };

/**
 * Finds points along one track, fastest when asked in order of distance.
 * Reuses one result object, so read it before the next call.
 */
export class TrackWalker {
	#t: Track;
	#i = 1;
	readonly p: TrackPoint = { x: 0, y: 0, dx: 1, dy: 0 };

	constructor(t: Track) {
		this.#t = t;
	}

	/** The point `s` flow px from the start, clamped to the track. */
	at(s: number): TrackPoint {
		const { xs, ys, at } = this.#t;
		const n = xs.length;
		const p = this.p;
		if (n < 2) {
			p.x = xs[0] ?? 0;
			p.y = ys[0] ?? 0;
			return p;
		}
		let i = Math.min(Math.max(this.#i, 1), n - 1);
		while (i < n - 1 && at[i] < s) i++;
		while (i > 1 && at[i - 1] > s) i--;
		this.#i = i;
		const len = at[i] - at[i - 1];
		const u = len > 0 ? Math.min(1, Math.max(0, (s - at[i - 1]) / len)) : 0;
		const dx = xs[i] - xs[i - 1];
		const dy = ys[i] - ys[i - 1];
		p.x = xs[i - 1] + dx * u;
		p.y = ys[i - 1] + dy * u;
		if (len > 0) {
			p.dx = dx / len;
			p.dy = dy / len;
		}
		return p;
	}
}
