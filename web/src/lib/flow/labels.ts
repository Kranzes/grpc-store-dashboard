// Rate labels on lines: what they say, where each one may sit, and which
// ones fit. Pure, so placement can be tested on the demo layouts. Labels
// sit in fixed slots beside the card at their line's own end and keep a
// stable order, so a label does not appear and vanish as traffic shifts.

import { failShare, type EdgeView } from '#lib/model/types.ts';
import { countsFailures, type DrawnLine, type LineKind } from './kinds.ts';
import { formatByteRate, formatPercent, formatPerMinute } from '#lib/ui/format.ts';
import type { LineGeom, Pt } from './geometry.ts';
import type { LayoutNode } from './layout.ts';

/** Below this zoom, 10 px text reads at under 6 px, so labels hide. */
export const LABEL_MIN_ZOOM = 0.6;

/**
 * Pill metrics in flow px. RateLabels.svelte draws them with these. text-box
 * trims each line of text to its capitals and baseline, with the same
 * padding above and below, so the text sits in the middle. The g and q of
 * "assigned/min" and "requests/min" hang 2.2 px below the baseline into the bottom
 * padding, and the gap between lines is 5 px, so they keep 2 px from the next
 * line's capitals.
 */
export const PILL = {
	/** Padding left and right of the text. */
	padX: 5,
	/** Above the capitals. */
	padTop: 4,
	/** Below the baseline, the same, so the text is centred; descenders keep about 1 px. */
	padBottom: 4,
	border: 1,
	/** One line: the capital height of the 10 px text, rounded. */
	cap: 7,
	/** From the rate line's baseline to the failure line's capitals: the descenders and at least 2 px. */
	rowGap: 5,
	/** The failure line's red bar, short and level like the bars on the lines, and the space after it. */
	bar: 7,
	barHeight: 3,
	barGap: 4,
	/** From the card's border to the label. */
	gap: 4,
	/**
	 * From a builder's input height to a publish or fetch label's near edge.
	 * Past 14.5, half a two-line label, so these labels clear the two-line
	 * assignment label of a card across a group gap, on its input height.
	 */
	band: 15,
	/** How much further out a publish or fetch label tries when its slot is taken. */
	fallback: 10
} as const;

export type LabelText = Readonly<{ rate: string | null; fail: string | null }>;

// Counts per minute, so a slow farm reads "24 requests/min" and not "0.4 requests/s".
const PER_MIN: Partial<Record<LineKind, string>> = {
	request: 'requests/min',
	assign: 'assigned/min',
	hit: 'hits/min'
};

/**
 * A rate, per second, with its unit: "24 requests/min", "38 MiB/s", "≈ 4.2 MiB/s".
 * An estimate of nothing is 0.
 */
export function rateText(kind: LineKind, rate: number): string {
	const unit = PER_MIN[kind];
	if (unit) return `${formatPerMinute(rate * 60)} ${unit}`;
	const bytes = formatByteRate(rate);
	return isEstimate(kind, rate) ? `≈ ${bytes}` : bytes;
}

/** Fetch amounts are estimates, written "≈ 4.2 MiB/s" and spoken "about". An estimate of nothing is just 0. */
export function isEstimate(kind: LineKind, amount: number): boolean {
	return kind === 'fetch' && amount > 0;
}

/** A failure share above 0: "8%", "<1%", or null when nothing failed. The panels use it too. */
export function failPercent(share: number | null): string | null {
	if (share === null || !(share > 0)) return null;
	if (share < 0.01) return '<1%';
	// Not all failed, so never round up to 100%.
	if (share < 1 && share >= 0.995) return '99%';
	return formatPercent(share);
}

/** "8% failed", "<1% failed", or null when nothing failed. */
export function failText(share: number | null): string | null {
	const pct = failPercent(share);
	return pct && `${pct} failed`;
}

/** The text of a line's label, or null when the line has nothing to say. */
export function labelText(kind: LineKind, ev: EdgeView | undefined): LabelText | null {
	if (!ev) return null;
	const fail = countsFailures(kind) ? failText(failShare(ev)) : null;
	// The client card beside a request line shows its rate already.
	const rate = ev.rate > 0 && kind !== 'request' ? rateText(kind, ev.rate) : null;
	// "0 assigned/min" on every idle line would bury the busy ones.
	return rate || fail ? { rate, fail } : null;
}

/** A line or bundle, added up: what the hover readout says about it. */
export type LineSum = Readonly<{ rate: number; finished: number; failed: number }>;

export function sumLines(ids: readonly string[], edges: ReadonlyMap<string, EdgeView>): LineSum {
	let rate = 0;
	let finished = 0;
	let failed = 0;
	for (const id of ids) {
		const e = edges.get(id);
		if (!e) continue;
		rate += e.rate;
		finished += e.finished;
		failed += e.failed;
	}
	return { rate, finished, failed };
}

/** The hover readout's numbers: the rate, then the failure share when there is one. */
export type ReadoutText = Readonly<{ rate: string; fail: string | null }>;

/**
 * "24 assigned/min" and "8% failed (last 15m)", or the rate alone when
 * nothing failed. `window` names what the share covers: "last 15m",
 * "since 23:41".
 */
export function readoutText(kind: LineKind, sum: LineSum, window: string): ReadoutText {
	const rate = rateText(kind, sum.rate);
	const fail = countsFailures(kind) ? failText(failShare(sum)) : null;
	return { rate, fail: fail && `${fail} (${window})` };
}

export type LabelSlot = Readonly<{
	id: string;
	kind: LineKind;
	/** The anchor: which edge of the box sits here depends on align and band. */
	x: number;
	y: number;
	align: 'start' | 'end' | 'center';
	/** mid: centered on y. above: bottom at y. below: top at y. */
	band: 'mid' | 'above' | 'below';
}>;

export type Box = Readonly<{ x: number; y: number; w: number; h: number }>;
export type Size = Readonly<{ w: number; h: number }>;

/** The horizontal segment with the smallest y: the cache hits line's top run. */
function topRun(points: readonly Pt[]): [Pt, Pt] | null {
	let best: [Pt, Pt] | null = null;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (a[1] !== b[1] || a[0] === b[0]) continue;
		if (!best || a[1] < best[0][1]) best = [a, b];
	}
	return best;
}

/** One slot per drawn line, beside the card at the line's own end. */
export function labelSlots(lines: readonly LineGeom[]): LabelSlot[] {
	const slots: LabelSlot[] = [];
	for (const l of lines) {
		const first = l.points[0];
		const last = l.points[l.points.length - 1];
		if (!first || !last) continue;
		const { id, kind } = l;
		switch (kind) {
			case 'request':
				// Right of the client card, on its stub.
				slots.push({ id, kind, x: first[0] + PILL.gap, y: first[1], align: 'start', band: 'mid' });
				break;
			case 'assign':
				// Left of the builder or pool, on its stub.
				slots.push({ id, kind, x: last[0] - PILL.gap, y: last[1], align: 'end', band: 'mid' });
				break;
			case 'publish':
				// Above the publish stub, which leaves 7 px above the input.
				slots.push({
					id,
					kind,
					x: first[0] + PILL.gap,
					y: first[1] + 7 - PILL.band,
					align: 'start',
					band: 'above'
				});
				break;
			case 'fetch':
				slots.push({
					id,
					kind,
					x: last[0] + PILL.gap,
					y: last[1] - 7 + PILL.band,
					align: 'start',
					band: 'below'
				});
				break;
			case 'substitute':
				// Right of the builder or pool, on its own stub below the fetch label.
				slots.push({ id, kind, x: last[0] + PILL.gap, y: last[1], align: 'start', band: 'mid' });
				break;
			case 'hit': {
				const run = topRun(l.points);
				if (!run) break;
				slots.push({
					id,
					kind,
					x: (run[0][0] + run[1][0]) / 2,
					y: run[0][1],
					align: 'center',
					band: 'mid'
				});
				break;
			}
		}
	}
	return slots;
}

/** The box of a label of `size` in `slot`, moved `out` px further from its line. */
export function slotBox(slot: LabelSlot, size: Size, out = 0): Box {
	const x =
		slot.align === 'start' ? slot.x : slot.align === 'end' ? slot.x - size.w : slot.x - size.w / 2;
	const y =
		slot.band === 'mid'
			? slot.y - size.h / 2
			: slot.band === 'above'
				? slot.y - out - size.h
				: slot.y + out;
	return { x, y, w: size.w, h: size.h };
}

/**
 * The point of a label that stays put when markScale in marks.ts scales it,
 * as fractions of its box: the side that touches its line.
 */
export function labelOrigin(slot: Pick<LabelSlot, 'align' | 'band'>): readonly [number, number] {
	const x = slot.align === 'start' ? 0 : slot.align === 'end' ? 1 : 0.5;
	const y = slot.band === 'mid' ? 0.5 : slot.band === 'above' ? 1 : 0;
	return [x, y];
}

/** A placed label's box once it is scaled by `k` about its origin. */
export function scaleBox(box: Box, slot: Pick<LabelSlot, 'align' | 'band'>, k: number): Box {
	if (k === 1) return box;
	const [ox, oy] = labelOrigin(slot);
	return {
		x: box.x + ox * (1 - k) * box.w,
		y: box.y + oy * (1 - k) * box.h,
		w: box.w * k,
		h: box.h * k
	};
}

/** Half the widest line, so a label never lies on a bus. */
const BUS_PAD = 4;

/**
 * What labels must not cover: every node box, the buses into and out of the
 * cache, and the runs of substitute lines between the upstream card and a
 * builder's own stub.
 */
export type Obstacles = Readonly<{ nodes: readonly Box[]; buses: readonly Box[] }>;

export function labelObstacles(
	nodes: readonly LayoutNode[],
	lines: readonly LineGeom[]
): Obstacles {
	const buses: Box[] = [];
	const bus = (a: Pt, b: Pt): Box => ({
		x: Math.min(a[0], b[0]),
		y: a[1] - BUS_PAD,
		w: Math.abs(b[0] - a[0]),
		h: 2 * BUS_PAD
	});
	for (const l of lines) {
		if (l.kind === 'substitute') {
			// Every horizontal run but the stub into the builder, which its label sits on.
			for (let i = 1; i < l.points.length - 1; i++) {
				const a = l.points[i - 1];
				const b = l.points[i];
				if (a[1] !== b[1]) continue;
				buses.push(bus(a, b));
			}
			continue;
		}
		if (l.kind !== 'publish' && l.kind !== 'fetch') continue;
		const n = l.points.length;
		if (n < 2) continue;
		// The segment at the cache end: last for publish, first for fetch.
		const [a, b] =
			l.kind === 'publish' ? [l.points[n - 2], l.points[n - 1]] : [l.points[0], l.points[1]];
		if (a[1] !== b[1]) continue;
		buses.push(bus(a, b));
	}
	return { nodes: nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), buses };
}

const KIND_ORDER: Record<LineKind, number> = {
	assign: 0,
	request: 1,
	publish: 2,
	fetch: 3,
	substitute: 4,
	hit: 5
};

/**
 * The order labels claim their slots in: bright lines first, then by kind,
 * then in layout order. It does not follow the rates, so labels hold
 * still while traffic shifts.
 */
export function labelOrder(
	lines: readonly DrawnLine[],
	bright?: ReadonlySet<string> | null
): string[] {
	return lines
		.map((l, i) => ({ id: l.id, i, k: KIND_ORDER[l.kind], b: bright?.has(l.id) ? 0 : 1 }))
		.sort((a, b) => a.b - b.b || a.k - b.k || a.i - b.i)
		.map((l) => l.id);
}

const CELL = 256;

/** Boxes in a uniform grid, so overlap checks stay linear in the number of labels. */
class Grid {
	#cells = new Map<number, Box[]>();

	#keys(b: Box): number[] {
		const keys: number[] = [];
		const x0 = Math.floor(b.x / CELL);
		const x1 = Math.floor((b.x + b.w) / CELL);
		const y0 = Math.floor(b.y / CELL);
		const y1 = Math.floor((b.y + b.h) / CELL);
		for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(x * 1e6 + y);
		return keys;
	}

	add(b: Box) {
		for (const k of this.#keys(b)) {
			const list = this.#cells.get(k);
			if (list) list.push(b);
			else this.#cells.set(k, [b]);
		}
	}

	covers(b: Box): boolean {
		for (const k of this.#keys(b)) {
			for (const o of this.#cells.get(k) ?? []) if (overlaps(b, o)) return true;
		}
		return false;
	}
}

/** Boxes that only touch do not overlap. */
export function overlaps(a: Box, b: Box): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Boxes of the labels to show, by id. Goes through the slots in `order` and
 * tries each slot, then its fallback 10 px further from the line, which only
 * publish and fetch labels have. A box fails when it covers a node, a label
 * placed before it, or, for publish and fetch labels, a bus. It drops a label
 * whose slot and fallback both fail, and one without a size.
 */
export function placeLabels(
	slots: readonly LabelSlot[],
	sizes: ReadonlyMap<string, Size>,
	obstacles: Obstacles,
	order: readonly string[]
): Map<string, Box> {
	const byId = new Map(slots.map((s) => [s.id, s]));
	const nodes = new Grid();
	for (const b of obstacles.nodes) nodes.add(b);
	const buses = new Grid();
	for (const b of obstacles.buses) buses.add(b);
	const labels = new Grid();
	const placed = new Map<string, Box>();
	for (const id of order) {
		const slot = byId.get(id);
		const size = sizes.get(id);
		if (!slot || !size || placed.has(id)) continue;
		const side = slot.kind === 'publish' || slot.kind === 'fetch';
		const tries = side ? [0, PILL.fallback] : [0];
		for (const out of tries) {
			const box = slotBox(slot, size, out);
			if (nodes.covers(box) || labels.covers(box) || (side && buses.covers(box))) continue;
			placed.set(id, box);
			labels.add(box);
			break;
		}
	}
	return placed;
}

/**
 * A label's box size for its text. `measure` gives a string's width in px
 * at the pill's font.
 */
export function labelSize(t: LabelText, measure: (s: string) => number): Size {
	const rate = t.rate ? measure(t.rate) : 0;
	const fail = t.fail ? PILL.bar + PILL.barGap + measure(t.fail) : 0;
	const lines = (t.rate ? 1 : 0) + (t.fail ? 1 : 0);
	return {
		w: Math.ceil(Math.max(rate, fail)) + 2 * (PILL.padX + PILL.border),
		h:
			lines * PILL.cap +
			Math.max(0, lines - 1) * PILL.rowGap +
			PILL.padTop +
			PILL.padBottom +
			2 * PILL.border
	};
}

/** Sizes of the labels that have text. Without a measure, as before mount, none. */
export function labelSizes(
	texts: ReadonlyMap<string, LabelText | null>,
	measure: ((s: string) => number) | null
): Map<string, Size> {
	const sizes = new Map<string, Size>();
	if (!measure) return sizes;
	for (const [id, t] of texts) if (t) sizes.set(id, labelSize(t, measure));
	return sizes;
}

/** The placed labels a viewer can see: none while hidden by zoom, none faded by focus. */
export function visibleLabels(
	placed: ReadonlyMap<string, Box>,
	hidden: boolean,
	bright: ReadonlySet<string> | null
): Map<string, Box> {
	const visible = new Map<string, Box>();
	if (hidden) return visible;
	for (const [id, box] of placed) if (!bright || bright.has(id)) visible.set(id, box);
	return visible;
}

let canvas: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
let widthsFont = '';

/**
 * Text widths at `font` from one offscreen canvas, cached per string. Every
 * digit measures as 0: labels use tabular numbers, which canvas text cannot,
 * and a label then keeps its width, and its place, while its rate moves.
 */
export function textMeasurer(font: string): (s: string) => number {
	if (canvas === undefined)
		canvas =
			typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
	if (widthsFont !== font) {
		widths.clear();
		widthsFont = font;
	}
	return (s) => {
		const key = s.replace(/[0-9]/g, '0');
		let w = widths.get(key);
		if (w === undefined) {
			if (canvas) canvas.font = font;
			// Without a canvas, a generous guess per character.
			w = canvas ? canvas.measureText(key).width : key.length * 6.5;
			if (widths.size > 4096) widths.clear();
			widths.set(key, w);
		}
		return w;
	};
}
