// How far the map pans and zooms. A dashboard shows one map, and empty space
// around it only gets the user lost. So most of the view stays over the farm,
// and zooming out stops a little past the zoom that fits it all. Pure, so the
// limits can be tested on the demo layouts.

import { FIT_PADDING, FIT_VIEW, MAX_ZOOM, MIN_ZOOM } from './context.ts';
import type { LayoutNode } from './layout.ts';

export type Bounds = Readonly<{
	x: number;
	y: number;
	width: number;
	height: number;
}>;
export type Size = Readonly<{ width: number; height: number }>;
export type Viewport = Readonly<{ x: number; y: number; zoom: number }>;
/** Svelte Flow's translateExtent: top left and bottom right, in flow px. */
export type Extent = [[number, number], [number, number]];

/** Zooming out stops at this share of the zoom that fits the whole farm. */
export const ZOOM_OUT_ROOM = 0.75;

/**
 * How far past the farm's box the view may pan, as a share of the visible
 * map. With half, a zoomed-in view could sit over an empty corner of the box
 * and show nothing; with a quarter, three quarters of the view stay over it.
 */
export const PAN_ROOM = 0.25;

/** The box around every node of a layout, or null without nodes. */
export function farmBounds(
	nodes: readonly Pick<LayoutNode, 'x' | 'y' | 'w' | 'h'>[]
): Bounds | null {
	if (nodes.length === 0) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const n of nodes) {
		x0 = Math.min(x0, n.x);
		y0 = Math.min(y0, n.y);
		x1 = Math.max(x1, n.x + n.w);
		y1 = Math.max(y1, n.y + n.h);
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The zoom the Fit button picks for `bounds` in a pane, as Svelte Flow computes it. */
export function fitZoom(bounds: Bounds, pane: Size): number {
	const w = pane.width - FIT_PADDING.left - FIT_PADDING.right;
	const h = pane.height - FIT_PADDING.top - FIT_PADDING.bottom;
	const zoom = Math.min(w / Math.max(1, bounds.width), h / Math.max(1, bounds.height));
	return clamp(zoom, MIN_ZOOM, FIT_VIEW.maxZoom ?? 1);
}

/** How far out the user may zoom: a little past the fit, never below the floor. */
export function zoomFloor(bounds: Bounds, pane: Size): number {
	return Math.max(MIN_ZOOM, fitZoom(bounds, pane) * ZOOM_OUT_ROOM);
}

/**
 * Where the view may go at `zoom`: the farm plus PAN_ROOM of the visible map
 * on each side, or while the farm is smaller than the view, as far as keeps
 * it all in view. Plus the fit's padding, so the Fit button's view is always
 * inside. `cover`: screen px at the pane's right that a floating panel
 * hides, so a node can still be brought out from under it.
 */
export function panExtent(bounds: Bounds, pane: Size, zoom: number, cover = 0): Extent {
	const room = (view: number, farm: number, pad: number) =>
		(Math.max(view * PAN_ROOM, (view - farm * zoom) / 2) + pad) / zoom;
	const mx = room(pane.width, bounds.width, Math.max(FIT_PADDING.left, FIT_PADDING.right));
	const my = room(pane.height, bounds.height, Math.max(FIT_PADDING.top, FIT_PADDING.bottom));
	return [
		[bounds.x - mx, bounds.y - my],
		[bounds.x + bounds.width + mx + cover / zoom, bounds.y + bounds.height + my]
	];
}

/**
 * The nearest view inside the limits: the zoom between the floor and the
 * maximum, kept about the pane's middle, then panned into the extent. The
 * same view when it is inside already.
 */
export function clampViewport(v: Viewport, bounds: Bounds, pane: Size, cover = 0): Viewport {
	const zoom = clamp(v.zoom, zoomFloor(bounds, pane), MAX_ZOOM);
	// The flow point in the pane's middle stays there through the zoom.
	const cx = (pane.width / 2 - v.x) / v.zoom;
	const cy = (pane.height / 2 - v.y) / v.zoom;
	const [[x0, y0], [x1, y1]] = panExtent(bounds, pane, zoom, cover);
	const mx = within(cx, x0, x1, pane.width / 2 / zoom);
	const my = within(cy, y0, y1, pane.height / 2 / zoom);
	const x = pane.width / 2 - mx * zoom;
	const y = pane.height / 2 - my * zoom;
	if (zoom === v.zoom && near(x, v.x) && near(y, v.y)) return v;
	return { x, y, zoom };
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

/** A view's middle that keeps [mid - half, mid + half] in [lo, hi]; centred when it is wider, as d3 does. */
function within(mid: number, lo: number, hi: number, half: number): number {
	return hi - lo < 2 * half ? (lo + hi) / 2 : clamp(mid, lo + half, hi - half);
}

function near(a: number, b: number): boolean {
	return Math.abs(a - b) < 0.5;
}
