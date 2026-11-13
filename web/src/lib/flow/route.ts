// The points of the orthogonal line routes computed by layout.ts.

import type { Pt } from './geometry.ts';
import type { LineRoute } from './layout.ts';

export function routePoints(
	sx: number,
	sy: number,
	tx: number,
	ty: number,
	route: LineRoute
): Pt[] {
	const raw: Pt[] =
		route.kind === 'trunk'
			? [
					[sx, sy],
					[route.x, sy],
					[route.x, ty],
					[tx, ty]
				]
			: route.kind === 'jog'
				? [
						[sx, sy],
						[route.via, sy],
						[route.via, route.y],
						[route.x, route.y],
						[route.x, ty],
						[tx, ty]
					]
				: [
						[sx, sy],
						[sx, route.y],
						[tx, route.y],
						[tx, ty]
					];
	// Drop repeated and collinear points so straight lines stay one segment.
	const pts: Pt[] = [];
	for (const p of raw) {
		const last = pts[pts.length - 1];
		if (last && near(last[0], p[0]) && near(last[1], p[1])) continue;
		const prev = pts[pts.length - 2];
		if (prev && last && collinear(prev, last, p)) pts[pts.length - 1] = p;
		else pts.push(p);
	}
	return pts;
}

function near(a: number, b: number) {
	return Math.abs(a - b) < 0.5;
}

function collinear(a: Pt, b: Pt, c: Pt) {
	return (near(a[0], b[0]) && near(b[0], c[0])) || (near(a[1], b[1]) && near(b[1], c[1]));
}
