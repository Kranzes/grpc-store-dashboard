import { describe, expect, it } from 'vitest';
import { FIT_PADDING, MAX_ZOOM, MIN_ZOOM } from './context.ts';
import { demo12, demo30, demo50Cards, farm } from './fixtures.ts';
import { layoutTopology } from './layout.ts';
import {
	PAN_ROOM,
	clampViewport,
	farmBounds,
	fitZoom,
	panExtent,
	zoomFloor,
	type Bounds,
	type Size,
	type Viewport
} from './limits.ts';

const PANE: Size = { width: 1440, height: 820 };

/** The flow point in the middle of the pane. */
const middle = (v: Viewport, pane: Size) => ({
	x: (pane.width / 2 - v.x) / v.zoom,
	y: (pane.height / 2 - v.y) / v.zoom
});

const inside = (p: { x: number; y: number }, b: Bounds) =>
	p.x >= b.x - 1e-6 &&
	p.x <= b.x + b.width + 1e-6 &&
	p.y >= b.y - 1e-6 &&
	p.y <= b.y + b.height + 1e-6;

describe('farmBounds', () => {
	it('boxes every node of a layout', () => {
		const l = demo12();
		const b = farmBounds(l.nodes)!;
		for (const n of l.nodes) {
			expect(n.x).toBeGreaterThanOrEqual(b.x);
			expect(n.y).toBeGreaterThanOrEqual(b.y);
			expect(n.x + n.w).toBeLessThanOrEqual(b.x + b.width);
			expect(n.y + n.h).toBeLessThanOrEqual(b.y + b.height);
		}
		// Each side touches a node.
		expect(l.nodes.some((n) => n.x === b.x)).toBe(true);
		expect(l.nodes.some((n) => n.x + n.w === b.x + b.width)).toBe(true);
		expect(l.nodes.some((n) => n.y + n.h === b.y + b.height)).toBe(true);
		expect(farmBounds([])).toBeNull();
	});
});

describe('zoom floor', () => {
	it('stops a little past the zoom that fits, lower for a bigger farm, and a huge one still fits', () => {
		const b12 = farmBounds(demo12().nodes)!;
		const floor12 = zoomFloor(b12, PANE);
		expect(floor12).toBeLessThan(fitZoom(b12, PANE));
		const floor50 = zoomFloor(farmBounds(demo50Cards().nodes)!, PANE);
		expect(floor50).toBeLessThan(floor12);
		// 600 builders as cards: far below the old fixed 0.15, still above the floor.
		const huge = farmBounds(
			layoutTopology(farm({ 'x86_64-linux': 600 }), undefined, new Map([['x86_64-linux', false]]))
				.nodes
		)!;
		const fit = fitZoom(huge, PANE);
		expect(fit).toBeLessThan(0.15);
		expect(fit).toBeGreaterThan(MIN_ZOOM);
		expect(zoomFloor(huge, PANE)).toBeLessThanOrEqual(fit);
		// Never below the floor of all farms.
		expect(zoomFloor({ x: 0, y: 0, width: 1e9, height: 1e9 }, PANE)).toBe(MIN_ZOOM);
	});

	it('follows the pane: a narrower map fits at a lower zoom', () => {
		const b = farmBounds(demo30().nodes)!;
		expect(zoomFloor(b, { width: 1000, height: 820 })).toBeLessThan(zoomFloor(b, PANE));
	});
});

describe('pan extent', () => {
	const b = farmBounds(demo12().nodes)!;

	it('keeps three quarters of a zoomed-in view over the farm, less the fit padding, at every edge', () => {
		const zoom = MAX_ZOOM;
		const [w, h] = [PANE.width / zoom, PANE.height / zoom];
		expect(b.width).toBeGreaterThan(w);
		expect(b.height).toBeGreaterThan(h);
		const [[x0, y0], [x1, y1]] = panExtent(b, PANE, zoom);
		const padX = Math.max(FIT_PADDING.left, FIT_PADDING.right);
		const padY = Math.max(FIT_PADDING.top, FIT_PADDING.bottom);
		/** Screen px of a view starting at `start` that lie over the farm's span. */
		const over = (start: number, size: number, lo: number, span: number) =>
			(Math.min(start + size, lo + span) - Math.max(start, lo)) * zoom;
		for (const left of [x0, x1 - w])
			expect(over(left, w, b.x, b.width) + 1e-6).toBeGreaterThanOrEqual(
				PANE.width * (1 - PAN_ROOM) - padX
			);
		for (const top of [y0, y1 - h])
			expect(over(top, h, b.y, b.height) + 1e-6).toBeGreaterThanOrEqual(
				PANE.height * (1 - PAN_ROOM) - padY
			);
	});

	it('keeps a farm smaller than the view in view, and is never narrower than the view', () => {
		for (const zoom of [zoomFloor(b, PANE), fitZoom(b, PANE), 1, MAX_ZOOM]) {
			const [[x0, y0], [x1, y1]] = panExtent(b, PANE, zoom);
			expect(x1 - x0).toBeGreaterThanOrEqual(PANE.width / zoom);
			expect(y1 - y0).toBeGreaterThanOrEqual(PANE.height / zoom);
		}
		// A tall, narrow farm stays wholly in view sideways, with the view at
		// either end of the extent.
		const narrow = { x: 0, y: 0, width: 200, height: 4000 };
		const zoom = fitZoom(narrow, PANE);
		const w = PANE.width / zoom;
		const [[x0], [x1]] = panExtent(narrow, PANE, zoom);
		const right = narrow.x + narrow.width;
		expect(x0).toBeLessThanOrEqual(narrow.x);
		expect(x0 + w).toBeGreaterThanOrEqual(right);
		expect(x1 - w).toBeLessThanOrEqual(narrow.x);
		expect(x1).toBeGreaterThanOrEqual(right);
	});

	it('makes room on the right for a panel that floats over the map', () => {
		const [, [x1]] = panExtent(b, PANE, 1, 440);
		const [, [plain]] = panExtent(b, PANE, 1);
		expect(x1 - plain).toBeCloseTo(440);
	});
});

describe('clampViewport', () => {
	const b = farmBounds(demo12().nodes)!;

	it('keeps a view inside the limits as it is', () => {
		const v = { x: 100, y: 50, zoom: 0.9 };
		expect(clampViewport(v, b, PANE)).toBe(v);
	});

	it('pans a view that left the farm back to the edge of the limits', () => {
		for (const v of [
			{ x: 50_000, y: 0, zoom: 1 },
			{ x: -50_000, y: -50_000, zoom: 1 },
			{ x: 0, y: 90_000, zoom: 2 }
		]) {
			const c = clampViewport(v, b, PANE);
			expect(c.zoom).toBe(v.zoom);
			// The middle stays over the farm's box, and the view inside the extent.
			expect(inside(middle(c, PANE), b)).toBe(true);
			const [[x0, y0], [x1, y1]] = panExtent(b, PANE, c.zoom);
			const left = -c.x / c.zoom;
			const top = -c.y / c.zoom;
			const right = left + PANE.width / c.zoom;
			const bottom = top + PANE.height / c.zoom;
			expect(left).toBeGreaterThanOrEqual(x0 - 1e-6);
			expect(top).toBeGreaterThanOrEqual(y0 - 1e-6);
			expect(right).toBeLessThanOrEqual(x1 + 1e-6);
			expect(bottom).toBeLessThanOrEqual(y1 + 1e-6);
			// On the edge, not pulled further in.
			const gaps = [left - x0, top - y0, x1 - right, y1 - bottom].map(Math.abs);
			expect(Math.min(...gaps)).toBeLessThan(1e-6);
		}
	});

	it('zooms a view in to the floor and out to the maximum', () => {
		const out = clampViewport({ x: 0, y: 0, zoom: 0.05 }, b, PANE);
		expect(out.zoom).toBeCloseTo(zoomFloor(b, PANE));
		expect(clampViewport({ x: 0, y: 0, zoom: 5 }, b, PANE).zoom).toBe(MAX_ZOOM);
	});

	it('leaves the fitted view alone', () => {
		const zoom = fitZoom(b, PANE);
		const fitted = {
			x: PANE.width / 2 - (b.x + b.width / 2) * zoom,
			y: PANE.height / 2 - (b.y + b.height / 2) * zoom,
			zoom
		};
		expect(clampViewport(fitted, b, PANE)).toBe(fitted);
	});
});
