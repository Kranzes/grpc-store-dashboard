import { describe, expect, it } from 'vitest';
import type { EdgeView } from '#lib/model/types.ts';
import { demo12, fakeContext, fakeFrames } from './fixtures.ts';
import { lineGeometry } from './geometry.ts';
import {
	BASE_ALPHA,
	FADED,
	HOVER_FADED,
	LOOKUP_SPEED,
	LineLayer,
	WARM_MS,
	type Colors
} from './lineLayer.ts';
import { FADE_MS, HALO_MS } from './motion.ts';
import { SPEED } from './particles.ts';
import { trackOf } from './track.ts';
import { lineLooks, paintOrder } from './traffic.ts';

const COLORS: Colors = {
	request: 'request',
	assign: 'assign',
	hit: 'hit',
	publish: 'publish',
	fetch: 'fetch',
	substitute: 'substitute',
	idle: 'idle',
	danger: 'danger'
};

const ev = (rate: number, finished = 0, failed = 0): EdgeView => ({
	rate,
	unit: 'builds',
	finished,
	failed
});

/** The default demo's lines on a canvas, with every line at `rate` unless `rates` says otherwise. */
function setup(rates: (id: string) => EdgeView | undefined = () => ev(1)) {
	const f = fakeFrames();
	const { ctx, calls } = fakeContext();
	const lines = lineGeometry(demo12());
	const layer = new LineLayer(f.env);
	layer.attach(ctx);
	layer.setLines(lines);
	layer.setColors(COLORS);
	layer.setSize(1800, 1000, 1);
	layer.setView(100, 120, 0.9);
	const look = (r: (id: string) => EdgeView | undefined) => {
		const map = new Map<string, EdgeView>();
		for (const l of lines) {
			const v = r(l.id);
			if (v) map.set(l.id, v);
		}
		const looks = lineLooks(lines, map);
		layer.setLooks(looks, paintOrder(lines, looks));
	};
	look(rates);
	const line = (id: string) => layer.report().find((l) => l.id === id)!;
	return { f, ctx, layer, calls, lines, look, line };
}

const A = 'assign:10.0.0.13:50051';
const B = 'assign:10.0.0.10:50051';

describe('LineLayer', () => {
	it('stops drawing once every line is idle and its dots ran out', () => {
		const { f, layer, look } = setup();
		f.run(2000);
		look(() => ev(0));
		f.run(60_000);
		expect(layer.report().every((l) => l.dots.length === 0)).toBe(true);
		expect(f.idle()).toBe(true);
		const rest = layer.draws;
		f.run(65_000);
		expect(layer.draws).toBe(rest);
	});

	it('draws at once when the view moves, in the same call', () => {
		const { f, layer } = setup();
		f.run(100);
		const n = layer.draws;
		layer.setView(80, 120, 0.9);
		expect(layer.draws).toBe(n + 1);
		// The same view draws nothing.
		layer.setView(80, 120, 0.9);
		expect(layer.draws).toBe(n + 1);
	});

	it('the dots move at SPEED and stand still while the view moves', () => {
		const { f, layer, line } = setup();
		f.run(1000);
		const a = line(A).dots[0].s;
		f.run(1500);
		const b = line(A).dots.find((d) => Math.abs(d.s - (a + SPEED / 2)) < 0.01);
		expect(b).toBeDefined();
		layer.pause();
		const held = line(A).dots.map((d) => d.s);
		f.run(2500);
		expect(line(A).dots.map((d) => d.s)).toEqual(held);
		layer.resume();
		f.run(2600);
		// Picked up where they stopped: 0.1 s further, not 1.1 s.
		expect(line(A).dots.some((d) => Math.abs(d.s - (held[0] + SPEED / 10)) < 0.01)).toBe(true);
	});

	it('a hidden tab draws nothing and its dots stand still until it shows again', () => {
		const { f, layer, line } = setup();
		f.run(1000);
		layer.setHidden(true);
		const n = layer.draws;
		const held = line(A).dots.map((d) => d.s);
		layer.setView(0, 0, 1);
		f.run(5000);
		expect(layer.draws).toBe(n);
		expect(f.idle()).toBe(true);
		expect(line(A).dots.map((d) => d.s)).toEqual(held);
		layer.setHidden(false);
		f.run(5100);
		expect(layer.draws).toBeGreaterThan(n);
		expect(line(A).dots.some((d) => Math.abs(d.s - (held[0] + SPEED / 10)) < 0.01)).toBe(true);
	});

	it('reduced motion shows no dots and still failure bars, and does not tick', () => {
		const { f, layer, look, line } = setup((id) => (id === A ? ev(1, 10, 3) : ev(1)));
		layer.setReduced(true);
		f.run(100);
		const n = layer.draws;
		f.run(3000);
		expect(layer.draws - n).toBe(0);
		expect(layer.report().every((l) => l.dots.length === 0)).toBe(true);
		const a = line(A);
		expect(a.fails).toBe(3);
		expect(a.still.length).toBeGreaterThan(0);
		expect(line(B).still).toEqual([]);
		// An idle line shows no bars.
		look((id) => (id === A ? ev(0, 10, 3) : ev(1)));
		expect(line(A).still).toEqual([]);
	});

	it("under reduced motion an active line's 1 px core draws in full color", () => {
		const { f, ctx, layer } = setup();
		f.run(HALO_MS + 100);
		/** The opacity of every assignment line's core in one draw. */
		const cores = (draw: () => void) => {
			const seen: number[] = [];
			const stroke = ctx.stroke;
			ctx.stroke = function () {
				if (this.strokeStyle === 'assign' && this.lineWidth === 1) seen.push(this.globalAlpha);
				stroke.call(this);
			};
			draw();
			ctx.stroke = stroke;
			return seen;
		};
		const moving = cores(() => layer.setView(0, 0, 1));
		expect(moving.length).toBeGreaterThan(0);
		expect(new Set(moving)).toEqual(new Set([BASE_ALPHA]));
		// Without dots, a line alone on its track would read as a pale band.
		layer.setReduced(true);
		layer.setView(10, 0, 1);
		const still = cores(() => layer.setView(0, 0, 1));
		expect(still.length).toBe(moving.length);
		expect(new Set(still)).toEqual(new Set([1]));
	});

	it('focus dims the other lines, which keep moving; nothing restarts when it ends', () => {
		const { f, layer, line } = setup();
		f.run(1000);
		const serials = new Map(layer.report().map((l) => [l.id, l.serial]));
		layer.setFocus(new Set([A]));
		const a = line(B);
		f.run(1000 + FADE_MS + 100);
		expect(line(B).fade).toBe(FADED);
		expect(line(A).fade).toBe(1);
		// The dimmed line's dots go on at the same speed, every one on its course.
		const b = line(B);
		const moved = (SPEED * (b.time - a.time)) / 1000;
		expect(b.time - a.time).toBeGreaterThan(FADE_MS);
		for (const d of a.dots.filter((d) => d.s + moved < a.length))
			expect(b.dots.some((e) => Math.abs(e.s - (d.s + moved)) < 0.01)).toBe(true);
		// Ending focus brightens it where its dots are now: nothing jumps.
		f.run(3000);
		const c = line(B);
		layer.setFocus(null);
		expect(line(B).dots).toEqual(c.dots);
		f.run(3000 + FADE_MS + 20);
		expect(line(B).fade).toBe(1);
		for (const l of layer.report()) expect(l.serial).toBe(serials.get(l.id));
	});

	it('a hover fades the other lines less than focus, and focus takes over', () => {
		const { f, layer, line } = setup();
		f.run(1000);
		layer.setFocus(new Set([A]), HOVER_FADED);
		f.run(1000 + FADE_MS + 20);
		const hovered = line(B).fade;
		expect(hovered).toBe(HOVER_FADED);
		expect(line(A).fade).toBe(1);
		// A click focuses another line, and the hover's fade gives way to focus, which fades more.
		layer.setFocus(new Set([B]));
		f.run(1000 + 2 * FADE_MS + 40);
		expect(line(A).fade).toBe(FADED);
		expect(line(A).fade).toBeLessThan(hovered);
		expect(line(B).fade).toBe(1);
		layer.setFocus(null);
		f.run(1000 + 3 * FADE_MS + 60);
		expect(line(A).fade).toBe(1);
	});

	it('dots grow with the map only up to zoom 1.25', () => {
		const { f, layer, calls } = setup();
		f.run(3000);
		/** Dot radii, flow px, in the draw that a view at `zoom` makes at once. */
		const radii = (zoom: number) => {
			calls.reset();
			layer.setView(100, 120, zoom);
			return [...new Set(calls.radii.map((r) => +r.toFixed(3)))].sort();
		};
		const at1 = radii(1);
		expect(at1.length).toBeGreaterThan(0);
		expect(radii(1.25)).toEqual(at1);
		// Flow px shrink by 1.25 / 2, so on screen a dot is as large as at 1.25.
		expect(radii(2)).toEqual(at1.map((r) => +(r * 0.625).toFixed(3)).sort());
	});

	it('focus changes alone draw only while the fade runs', () => {
		const { f, layer, look } = setup();
		look(() => ev(0));
		f.run(60_000);
		expect(f.idle()).toBe(true);
		const n = layer.draws;
		layer.setFocus(new Set([A]));
		f.run(60_000 + FADE_MS + 200);
		expect(layer.draws - n).toBeGreaterThan(3);
		expect(layer.draws - n).toBeLessThanOrEqual(Math.ceil(((FADE_MS + 40) * 60) / 1000));
		expect(f.idle()).toBe(true);
		// The same focus again changes nothing.
		const m = layer.draws;
		layer.setFocus(new Set([A]));
		f.run(61_000);
		expect(layer.draws).toBe(m);
	});

	it('paints every idle line before every active one', () => {
		// Builders in column 0 are idle, the rest active.
		const idle = (id: string) => id.includes('10.0.1.');
		const { f, layer, calls } = setup((id) => (idle(id) ? ev(0) : ev(1)));
		f.run(HALO_MS + 100);
		calls.reset();
		layer.setView(0, 0, 1);
		const strokes = calls.strokes;
		const lastIdle = strokes.lastIndexOf('idle');
		const firstActive = strokes.findIndex((s) => s === 'assign' || s === 'request');
		expect(lastIdle).toBeGreaterThan(0);
		expect(firstActive).toBeGreaterThan(lastIdle);
	});

	it('draws the failure bars last, over every line and dot', () => {
		// Every line fails half its builds, so bars sit on trunks that later lines share.
		const { f, layer, calls } = setup(() => ev(1, 10, 5));
		f.run(HALO_MS + 4000);
		calls.reset();
		layer.setView(101, 120, 0.9);
		const firstBar = calls.ops.indexOf('fill:danger');
		expect(firstBar).toBeGreaterThan(0);
		expect(calls.ops.slice(firstBar).every((op) => op === 'fill:danger')).toBe(true);
	});

	it("a line's band fades in and out over about half a second, at its width", () => {
		const { f, look, line } = setup((id) => (id === A ? ev(0) : ev(1)));
		f.run(1000);
		expect(line(A).halo).toBe(0);
		look(() => ev(1));
		f.run(1000 + HALO_MS / 2);
		const mid = line(A).halo;
		expect(mid).toBeGreaterThan(0.3);
		expect(mid).toBeLessThan(1);
		f.run(1000 + HALO_MS + 50);
		expect(line(A).halo).toBe(1);
		const width = line(A).width;
		look((id) => (id === A ? ev(0) : ev(1)));
		f.run(1000 + HALO_MS + 50 + HALO_MS / 2);
		expect(line(A).halo).toBeGreaterThan(0);
		expect(line(A).halo).toBeLessThan(0.7);
		expect(line(A).width).toBe(width);
	});

	it('lines start full when the first numbers come, and empty at their start later', () => {
		const { f, look, line } = setup((id) => (id === A ? ev(0) : ev(1)));
		const b = line(B);
		// Full right away, at its spacing.
		expect(b.dots.length).toBeGreaterThan(b.length / 120 - 1);
		f.run(WARM_MS + 1000);
		look(() => ev(1));
		const a = line(A);
		expect(a.dots.length).toBeLessThanOrEqual(1);
		expect(a.dots.every((d) => d.s < 1)).toBe(true);
	});

	it('dots that fill a line at once fade in with its band', () => {
		const { f, look, line } = setup((id) => (id === A ? ev(0) : ev(1)));
		f.run(1000);
		expect(line(B).dotsIn).toBe(1);
		// A turns active soon after the first numbers, so it fills at once.
		look(() => ev(1));
		const a = line(A);
		expect(a.dots.length).toBeGreaterThan(a.length / 120 - 1);
		expect(a.dotsIn).toBe(0);
		f.run(1000 + HALO_MS / 2);
		const mid = line(A);
		expect(mid.dotsIn).toBeGreaterThan(0.3);
		expect(mid.dotsIn).toBeLessThan(1);
		expect(mid.dotsIn).toBeCloseTo(mid.halo, 6);
		f.run(1000 + HALO_MS + 50);
		expect(line(A).dotsIn).toBe(1);
	});

	it('draws only the lines and dots in view, each dot in a path of its own', () => {
		const { f, layer, calls, lines } = setup();
		f.run(1000);
		const tracks = lines.map((g) => trackOf(g.points));
		const count = (v: { x0: number; y0: number; x1: number; y1: number }, pad: number) => {
			const near = (x: number, y: number) =>
				x >= v.x0 - pad && x <= v.x1 + pad && y >= v.y0 - pad && y <= v.y1 + pad;
			const shown = tracks.filter(
				(t) =>
					t.maxX >= v.x0 - pad &&
					t.minX <= v.x1 + pad &&
					t.maxY >= v.y0 - pad &&
					t.minY <= v.y1 + pad
			).length;
			const dots = layer.report().flatMap((l) => l.dots.filter((d) => near(d.x, d.y))).length;
			return { shown, dots };
		};
		// The whole map at zoom 0.5: every line and every dot.
		layer.setSize(1000, 600, 1);
		calls.reset();
		layer.setView(0, 100, 0.5);
		const all = count({ x0: 0, y0: -200, x1: 2000, y1: 1000 }, 0);
		expect(all.shown).toBe(lines.length);
		expect(calls.stroke).toBeGreaterThanOrEqual(lines.length);
		expect(calls.arc).toBe(all.dots);
		expect(calls.arcsPerFill).toBe(1);
		// A corner at zoom 2, 500 by 300 flow px: the clients' lines and the
		// lookup, not the builders'. Lines and dots out of view cost nothing.
		calls.reset();
		layer.setView(-200, 0, 2);
		const corner = { x0: 100, y0: 0, x1: 600, y1: 300 };
		const inside = count(corner, 0);
		const around = count(corner, 20);
		expect(around.shown).toBeLessThan(lines.length / 4);
		expect(inside.dots).toBeGreaterThan(0);
		expect(calls.stroke).toBeGreaterThan(0);
		expect(calls.stroke).toBeLessThanOrEqual(3 * around.shown);
		expect(calls.arc).toBeGreaterThanOrEqual(inside.dots);
		expect(calls.arc).toBeLessThanOrEqual(around.dots);
		expect(calls.arcsPerFill).toBe(1);
	});

	it('a new layout keeps the dots of the lines that stay', () => {
		const { f, layer, lines, line } = setup();
		f.run(1000);
		const before = line(A);
		layer.setLines(lines.map((l) => ({ ...l })));
		const after = line(A);
		expect(after.serial).toBe(before.serial);
		expect(after.dots).toEqual(before.dots);
	});

	it('a line drawn already busy starts full; one that turns active later fills from its start', () => {
		const { f, layer, lines, line } = setup();
		f.run(WARM_MS + 1000);
		// A new layout adds two builders' lines, as a pool the user opens does.
		const busy = {
			...lines.find((l) => l.id === A)!,
			id: 'assign:10.9.0.1:50051'
		};
		const later = {
			...lines.find((l) => l.id === A)!,
			id: 'assign:10.9.0.2:50051'
		};
		layer.setLines([...lines, busy, later]);
		const rates = new Map<string, EdgeView>(lines.map((l) => [l.id, ev(1)]));
		rates.set(busy.id, ev(1));
		const looks = lineLooks([...lines, busy, later], rates);
		layer.setLooks(looks, paintOrder([...lines, busy, later], looks));
		// It carried traffic before it was drawn, so it is full at once.
		expect(line(busy.id).dots.length).toBeGreaterThan(line(busy.id).length / 120 - 1);
		expect(line(later.id).dots).toEqual([]);
		// The other turns active a moment later, as a builder that just joined does.
		f.run(WARM_MS + 2000);
		rates.set(later.id, ev(1));
		const next = lineLooks([...lines, busy, later], rates);
		layer.setLooks(next, paintOrder([...lines, busy, later], next));
		expect(line(later.id).dots.length).toBeLessThanOrEqual(1);
		f.run(WARM_MS + 3000);
		expect(Math.max(...line(later.id).dots.map((d) => d.s))).toBeLessThanOrEqual(SPEED + 0.01);
	});

	it('the cache hits line creeps while hits come in and stands still when none do', () => {
		const C = 'cached:scheduler';
		let hits = true;
		const { f, layer, look, line } = setup((id) => (id === C ? ev(hits ? 4 : 0) : ev(0)));
		f.run(1000);
		const a = line(C);
		expect(a.hits).toBe(true);
		expect(a.dots).toEqual([]);
		f.run(3000);
		const b = line(C);
		expect(b.dashOffset - a.dashOffset).toBeCloseTo((LOOKUP_SPEED * (b.time - a.time)) / 1000, 6);
		// It keeps the clock ticking, though every other line is idle.
		const n = layer.draws;
		f.run(4000);
		expect(layer.draws - n).toBeGreaterThan(50);
		// No hits: it stands still, and nothing draws once the other dots ran out.
		hits = false;
		look((id) => (id === C ? ev(0) : ev(0)));
		const still = line(C).dashOffset;
		f.run(60_000);
		expect(line(C).dashOffset).toBe(still);
		expect(f.idle()).toBe(true);
		// It stands still while the view moves, too, and goes on from there.
		hits = true;
		look((id) => (id === C ? ev(4) : ev(0)));
		layer.pause();
		f.run(62_000);
		expect(line(C).dashOffset).toBeCloseTo(still, 6);
		layer.resume();
		f.run(63_000);
		expect(line(C).dashOffset).toBeCloseTo(still + LOOKUP_SPEED, 6);
		// Under reduced motion its dashes sit still at their place at rest.
		layer.setReduced(true);
		expect(line(C).dashOffset).toBe(0);
	});
});
