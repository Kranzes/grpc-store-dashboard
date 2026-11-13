// Every line of the map on one canvas: the base, the band whose width shows
// traffic, the dots and failure bars travelling along it, and the cache hits
// lookup. The canvas is the size of the visible map and draws from the
// layout's geometry through the viewport transform, so its cost follows the
// lines in view, not how many pixels they cover at the zoom.
//
// Lines paint in traffic.ts's paint order, each one whole before the next, as
// separate SVG groups did. Dots travel as the particles of particles.ts. A
// line's band fades in and out when it turns active or idle, its width eases,
// and focus dims it, all on the clock of motion.ts. Dimmed lines keep moving.

import type { LineKind } from './kinds.ts';
import type { LineGeom } from './geometry.ts';
import { SLOTS, barSize, dotSize, isFailSlot, markScale } from './marks.ts';
import { EASE_MS, Ease, FADE_MS, Frames, HALO_MS, type FrameEnv } from './motion.ts';
import { SPEED, Stream, seed, spacing } from './particles.ts';
import { TrackWalker, trackOf, type Track } from './track.ts';
import type { LineLook } from './traffic.ts';

/** Resolved colors: one per flow kind, the idle grey and the failure red. */
export type Colors = Readonly<Record<LineKind, string> & { idle: string; danger: string }>;

/** What the layer draws with. A CanvasRenderingContext2D; tests pass a fake. */
export type Ctx = {
	globalAlpha: number;
	strokeStyle: unknown;
	fillStyle: unknown;
	lineWidth: number;
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	clearRect(x: number, y: number, w: number, h: number): void;
	beginPath(): void;
	lineDashOffset: number;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
	arc(x: number, y: number, r: number, a0: number, a1: number): void;
	closePath(): void;
	fill(): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	stroke(): void;
	setLineDash(segments: number[]): void;
};

/** A faded line's opacity while something else is in focus. */
export const FADED = 0.2;
/**
 * A faded line's opacity while the pointer rests on another line or on a
 * legend item: lighter than focus, since a hover only points.
 */
export const HOVER_FADED = 0.45;
/** How long the pointer rests on the same lines or legend item before a hover lights them. */
export const HOVER_REST_MS = 200;
/** Lines that turn active this soon after the first numbers arrive start full of dots. */
export const WARM_MS = 5000;
/**
 * How fast the cache hits line's dashes creep while hits come in, flow px a
 * second: an eighth of the dots' speed, so it reads as a lookup ticking
 * over, not as data on the move.
 */
export const LOOKUP_SPEED = SPEED / 8;

/** An active line's 1 px core, under its band, while dots run along it. */
export const BASE_ALPHA = 0.35;
/**
 * The core under reduced motion, where no dots draw. At 0.35 a line with no
 * other on its track read as a pale band, 1.3:1 to 1.5:1 against the map in
 * Latte. In full color the core is 2.5:1 to 4.5:1, like the dots.
 */
export const STILL_BASE_ALPHA = 1;
const BAND_ALPHA = 0.28;
const LOOKUP_WIDTH = 1.5;
const LOOKUP_DASH = [5, 4];
/** Length of one dash and gap of the lookup, flow px. */
const LOOKUP_PERIOD = LOOKUP_DASH[0] + LOOKUP_DASH[1];
/** Room around the view for marks that stick out of their line, flow px. */
const MARGIN = 12;

const IDLE: LineLook = {
	active: false,
	width: 0,
	level: 0,
	fails: 0,
	lookup: false,
	hits: false
};

type LineState = {
	readonly id: string;
	readonly kind: LineKind;
	track: Track;
	walker: TrackWalker;
	readonly stream: Stream;
	look: LineLook;
	readonly width: Ease;
	readonly halo: Ease;
	readonly fade: Ease;
	/** The dots' own opacity: a line that fills with dots at once fades them in with its band. */
	readonly dotsIn: Ease;
	/** No look has reached the line since it joined the canvas. */
	fresh: boolean;
	everActive: boolean;
	/** Travel ms the lookup's dashes have crept, up to `driftFrom`. */
	drift: number;
	/** Travel time hits started coming in on the lookup, or null while none do. */
	driftFrom: number | null;
	/** Counts up for each new line, so tests can tell a line that started over. */
	readonly serial: number;
};

/** One line as the test hook reports it. */
export type LineReport = Readonly<{
	id: string;
	kind: LineKind;
	serial: number;
	active: boolean;
	level: number;
	width: number;
	targetWidth: number;
	halo: number;
	fade: number;
	/** The dots' own opacity, under the fade: below 1 while a line that filled at once fades them in. */
	dotsIn: number;
	fails: number;
	lookup: boolean;
	hits: boolean;
	/** Width of the band, or of the lookup's dashes, as drawn now. */
	stroke: number;
	/** The lookup's dash pattern, empty for other lines. */
	dash: readonly number[];
	/** How far the lookup's dashes have crept along it, flow px. */
	dashOffset: number;
	length: number;
	/** Line time of the dots below. */
	time: number;
	dots: readonly Readonly<{ s: number; x: number; y: number; red: boolean }>[];
	/** Under reduced motion: the static failure bars, by distance from the start. */
	still: readonly number[];
}>;

let serials = 0;

export class LineLayer {
	#env: FrameEnv;
	#frames: Frames;
	#ctx: Ctx | null = null;
	#lines = new Map<string, LineState>();
	#order: LineState[] = [];
	/** The lines in view this frame, in paint order. Kept to spare an array per frame. */
	readonly #inView: LineState[] = [];
	#view = { x: 0, y: 0, zoom: 1 };
	#size = { w: 0, h: 0, dpr: 1 };
	#colors: Colors | null = null;
	#bright: ReadonlySet<string> | null = null;
	/** What the lines outside #bright fade to. */
	#faded = FADED;
	#reduced = false;
	#hidden = false;
	#pauses = 0;
	#pausedAt = 0;
	/** Clock ms lost to pauses, so dots resume where they stopped. */
	#lost = 0;
	/** Clock ms the first active line arrived. */
	#firstData = Infinity;
	/** Draws so far, for the test hook. */
	draws = 0;
	/** Time spent drawing, ms, for the test hook. */
	drawMs = 0;

	constructor(env: FrameEnv) {
		this.#env = env;
		this.#frames = new Frames(env, (now) => this.#draw(now));
	}

	attach(ctx: Ctx | null) {
		this.#ctx = ctx;
		this.#frames.soon();
	}

	destroy() {
		this.#frames.destroy();
		this.#ctx = null;
	}

	/** The lines of a new layout, in layout order. Lines that stay keep their dots. */
	setLines(lines: readonly LineGeom[]) {
		const now = this.#env.now();
		const next = new Map<string, LineState>();
		for (const g of lines) {
			const old = this.#lines.get(g.id);
			const track = trackOf(g.points);
			if (old) {
				old.track = track;
				old.walker = new TrackWalker(track);
				old.stream.length = track.length;
				next.set(g.id, old);
				continue;
			}
			const line: LineState = {
				id: g.id,
				kind: g.kind,
				track,
				walker: new TrackWalker(track),
				stream: new Stream(seed(g.id), track.length),
				look: IDLE,
				width: new Ease(0, EASE_MS),
				halo: new Ease(0, HALO_MS),
				fade: new Ease(1, FADE_MS),
				dotsIn: new Ease(1, HALO_MS),
				fresh: true,
				everActive: false,
				drift: 0,
				driftFrom: null,
				serial: ++serials
			};
			if (this.#bright && !this.#bright.has(g.id)) line.fade.set(this.#faded, now, true);
			next.set(g.id, line);
		}
		this.#lines = next;
		this.#order = [...next.values()];
		this.#frames.soon();
	}

	/**
	 * Each line's look from the store, and the order lines paint in. A new
	 * level changes only how often new dots start; width and band ease.
	 *
	 * A line that turns active starts empty and fills from its start, unless
	 * it has carried traffic all along: on a fresh page, where every rate
	 * starts at 0 and the first ones arrive within a few seconds, or when it
	 * is drawn already busy, as the cards of a pool the user opens are.
	 * Those start full of dots at their spacing, as if they had been drawn
	 * for a while, and fade in with the band instead of showing in one frame.
	 * A line that turns active again later fills from its start.
	 */
	setLooks(looks: ReadonlyMap<string, LineLook>, order: readonly string[]) {
		const now = this.#env.now();
		const travel = this.#travel(now);
		const instant = this.#reduced;
		let changed = false;
		for (const line of this.#lines.values()) {
			const look = looks.get(line.id) ?? IDLE;
			if (look.active && this.#firstData === Infinity) this.#firstData = now;
			const fresh = line.fresh;
			line.fresh = false;
			const old = line.look;
			if (sameLook(look, old)) continue;
			changed = true;
			line.look = look;
			if (look.active) {
				// From fully idle the band takes its width at once and fades in.
				line.width.set(look.width, now, instant || line.halo.value(now) === 0);
			}
			if (look.active !== old.active) line.halo.set(look.active ? 1 : 0, now, instant);
			line.stream.setFails(look.fails);
			if (look.level !== old.level) {
				const warm = fresh || now - this.#firstData <= WARM_MS;
				const empty = line.stream.size === 0 && !line.stream.emitting;
				line.stream.setLevel(look.level, travel, warm && !line.everActive);
				if (empty && line.stream.size > 0) {
					line.dotsIn.set(0, now, true);
					line.dotsIn.set(1, now, instant);
				}
			}
			if (look.active) line.everActive = true;
			if (look.hits && line.driftFrom === null) line.driftFrom = travel;
			else if (!look.hits && line.driftFrom !== null) {
				line.drift += travel - line.driftFrom;
				line.driftFrom = null;
			}
		}
		const ordered: LineState[] = [];
		for (const id of order) {
			const line = this.#lines.get(id);
			if (line) ordered.push(line);
		}
		if (ordered.length === this.#lines.size && ordered.some((l, i) => l !== this.#order[i])) {
			this.#order = ordered;
			changed = true;
		}
		// The store publishes up to 30 times a second; only a new look draws.
		if (changed) this.#frames.wake();
	}

	/**
	 * While something is in focus, lines outside `bright` dim to `faded`:
	 * FADED for a panel's focus, HOVER_FADED for a hover. Their dots keep
	 * moving, so nothing jumps or starts over when focus ends. `null` ends focus.
	 */
	setFocus(bright: ReadonlySet<string> | null, faded = FADED) {
		this.#bright = bright;
		this.#faded = faded;
		const now = this.#env.now();
		let changed = false;
		for (const line of this.#lines.values()) {
			const to = bright !== null && !bright.has(line.id) ? faded : 1;
			if (line.fade.target === to) continue;
			line.fade.set(to, now, this.#reduced);
			changed = true;
		}
		if (changed) this.#frames.wake();
	}

	/** The viewport transform. Draws at once, in the frame that moves the cards. */
	setView(x: number, y: number, zoom: number) {
		const v = this.#view;
		if (v.x === x && v.y === y && v.zoom === zoom) return;
		this.#view = { x, y, zoom };
		this.#drawNow();
	}

	/** Canvas size in CSS px and the device pixel ratio. The caller sizes the canvas itself. */
	setSize(w: number, h: number, dpr: number) {
		this.#size = { w, h, dpr };
		this.#drawNow();
	}

	setColors(colors: Colors) {
		this.#colors = colors;
		this.#frames.soon();
	}

	/** Reduced motion: no dots, static failure bars, no easing. */
	setReduced(reduced: boolean) {
		if (reduced === this.#reduced) return;
		this.#reduced = reduced;
		const now = this.#env.now();
		if (reduced) {
			for (const line of this.#lines.values()) {
				line.width.set(line.width.target, now, true);
				line.halo.set(line.halo.target, now, true);
				line.fade.set(line.fade.target, now, true);
				line.dotsIn.set(line.dotsIn.target, now, true);
			}
		}
		this.#frames.soon();
	}

	/** A hidden tab draws nothing, and the dots stand still until it shows again. */
	setHidden(hidden: boolean) {
		if (hidden === this.#hidden) return;
		this.#hidden = hidden;
		if (hidden) {
			this.pause();
			this.#frames.stop();
		} else {
			this.#frames.start();
			this.resume();
			this.#frames.soon();
		}
	}

	/**
	 * Stop every dot where it is. Calls nest; the last `resume` moves them on
	 * from there. For pan and zoom, and a hidden tab.
	 */
	pause() {
		if (this.#pauses++ > 0) return;
		this.#pausedAt = this.#env.now();
	}

	resume() {
		if (this.#pauses === 0 || --this.#pauses > 0) return;
		this.#lost += this.#env.now() - this.#pausedAt;
		this.#frames.wake();
	}

	/** The colors the lines draw with, resolved from the theme. */
	get colors(): Colors | null {
		return this.#colors;
	}

	/** Paint order now, bottom first. */
	get order(): string[] {
		return this.#order.map((l) => l.id);
	}

	/** Travel time: the clock without pauses, ms. */
	travel(): number {
		return this.#travel(this.#env.now());
	}

	/** What each line shows now, for the test hook. */
	report(): LineReport[] {
		const now = this.#env.now();
		const travel = this.#travel(now);
		return this.#order.map((line) => {
			const t = travel;
			if (!this.#reduced) line.stream.advance(t);
			const walker = new TrackWalker(line.track);
			const dots: { s: number; x: number; y: number; red: boolean }[] = [];
			if (!this.#reduced)
				line.stream.forEach(t, (s, red) => {
					const p = walker.at(s);
					dots.push({ s, x: p.x, y: p.y, red });
				});
			const look = line.look;
			return {
				id: line.id,
				kind: line.kind,
				serial: line.serial,
				active: look.active,
				level: look.level,
				width: line.width.value(now),
				targetWidth: line.width.target,
				halo: line.halo.value(now),
				fade: line.fade.value(now),
				dotsIn: line.dotsIn.value(now),
				fails: look.fails,
				lookup: look.lookup,
				hits: look.hits,
				stroke: look.lookup ? LOOKUP_WIDTH : line.width.value(now),
				dash: look.lookup ? LOOKUP_DASH : [],
				dashOffset: look.lookup ? this.#crept(line, t) : 0,
				length: line.track.length,
				time: t,
				dots,
				still: this.#reduced ? stillBars(line) : []
			};
		});
	}

	/** A point `s` flow px along a line, in flow px, or null for an unknown line. */
	point(id: string, s: number): { x: number; y: number } | null {
		const line = this.#lines.get(id);
		if (!line) return null;
		const p = new TrackWalker(line.track).at(s < 0 ? line.track.length + s : s);
		return { x: p.x, y: p.y };
	}

	#travel(now: number): number {
		return (this.#pauses > 0 ? this.#pausedAt : now) - this.#lost;
	}

	/** How far the lookup's dashes have crept by travel time `t`, flow px. */
	#crept(line: LineState, t: number): number {
		if (this.#reduced) return 0;
		const ms = line.drift + (line.driftFrom === null ? 0 : t - line.driftFrom);
		return (LOOKUP_SPEED * ms) / 1000;
	}

	#drawNow() {
		if (this.#hidden) return;
		const now = this.#env.now();
		const busy = this.#draw(now);
		this.#frames.drawn(now);
		if (busy) this.#frames.wake();
	}

	/** Draws everything at clock time `now`. Returns whether something still moves. */
	#draw(now: number): boolean {
		const ctx = this.#ctx;
		const colors = this.#colors;
		const { w, h, dpr } = this.#size;
		if (!ctx || !colors || !(w > 0 && h > 0) || this.#hidden) return false;
		const started = this.#env.now();
		const { x, y, zoom } = this.#view;
		const k = dpr * zoom;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, Math.round(w * dpr), Math.round(h * dpr));
		ctx.setTransform(k, 0, 0, k, dpr * x, dpr * y);
		// What the view shows, in flow px.
		const view = {
			x0: -x / zoom - MARGIN,
			y0: -y / zoom - MARGIN,
			x1: (w - x) / zoom + MARGIN,
			y1: (h - y) / zoom + MARGIN
		};
		const travel = this.#travel(now);
		const moving = this.#pauses === 0 && !this.#reduced;
		let busy = false;
		const inView = this.#inView;
		inView.length = 0;
		for (const line of this.#order) {
			const t = travel;
			if (!this.#reduced) line.stream.advance(t);
			if (
				line.width.moving(now) ||
				line.halo.moving(now) ||
				line.fade.moving(now) ||
				line.dotsIn.moving(now)
			)
				busy = true;
			if (moving && (line.stream.busy || line.driftFrom !== null)) busy = true;
			const tr = line.track;
			if (tr.maxX < view.x0 || tr.minX > view.x1 || tr.maxY < view.y0 || tr.minY > view.y1)
				continue;
			inView.push(line);
		}
		// Every stroke first, then every line's dots, then every line's failure
		// bars, so a line painted later never covers another line's marks where
		// their tracks overlap.
		for (const line of inView) this.#stroke(ctx, colors, line, now, travel);
		for (const line of inView) this.#marks(ctx, colors, line, now, travel, view, false);
		for (const line of inView) this.#marks(ctx, colors, line, now, travel, view, true);
		ctx.globalAlpha = 1;
		this.draws++;
		this.drawMs += this.#env.now() - started;
		return busy;
	}

	#stroke(ctx: Ctx, colors: Colors, line: LineState, now: number, t: number) {
		const look = line.look;
		const fade = line.fade.value(now);
		const color = colors[line.kind];
		ctx.beginPath();
		trace(ctx, line.track);
		if (look.lookup) {
			// A lookup, not data on the move: thin dashes, colored while hits
			// come in, which creep toward the cache meanwhile.
			ctx.setLineDash(LOOKUP_DASH);
			ctx.lineDashOffset = -(this.#crept(line, t) % LOOKUP_PERIOD);
			ctx.lineCap = 'butt';
			ctx.lineWidth = LOOKUP_WIDTH;
			ctx.globalAlpha = fade;
			ctx.strokeStyle = look.hits ? color : colors.idle;
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.lineDashOffset = 0;
			return;
		}
		const halo = line.halo.value(now);
		const width = line.width.value(now);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = 1;
		// The 1 px base: grey while idle, the line's color while active, in
		// full color under reduced motion, where no dots draw.
		if (halo < 1) {
			ctx.globalAlpha = (1 - halo) * fade;
			ctx.strokeStyle = colors.idle;
			ctx.stroke();
		}
		if (halo > 0) {
			ctx.globalAlpha = (this.#reduced ? STILL_BASE_ALPHA : BASE_ALPHA) * halo * fade;
			ctx.strokeStyle = color;
			ctx.stroke();
			if (width > 0) {
				ctx.globalAlpha = BAND_ALPHA * halo * fade;
				ctx.lineWidth = width;
				ctx.stroke();
			}
		}
	}

	/** A line's dots, or with `bars` its failure bars. */
	#marks(
		ctx: Ctx,
		colors: Colors,
		line: LineState,
		now: number,
		t: number,
		view: { x0: number; y0: number; x1: number; y1: number },
		bars: boolean
	) {
		if (line.look.lookup) return;
		const fade = line.fade.value(now);
		// Dots and bars grow with the map only up to MARK_MAX_ZOOM; the band keeps scaling.
		const dot = dotSize(line.width.value(now)) * markScale(this.#view.zoom);
		const bar = barSize(dot);
		if (this.#reduced) {
			// Reduced motion: the bars stand still in their slots, without dots.
			if (!bars || !line.look.active || line.look.fails === 0) return;
			const walker = new TrackWalker(line.track);
			ctx.globalAlpha = fade;
			ctx.fillStyle = colors.danger;
			for (const s of stillBars(line)) {
				const p = walker.at(s);
				barAt(ctx, p.x, p.y, p.dx, p.dy, bar.length, bar.width);
			}
			return;
		}
		if (line.stream.size === 0) return;
		const walker = line.walker;
		const r = dot / 2;
		if (bars) {
			ctx.globalAlpha = fade * line.dotsIn.value(now);
			ctx.fillStyle = colors.danger;
			line.stream.forEach(t, (s, red) => {
				if (!red) return;
				const p = walker.at(s);
				if (within(view, p)) barAt(ctx, p.x, p.y, p.dx, p.dy, bar.length, bar.width);
			});
			return;
		}
		// One fill per dot, not one path of every dot. A circle that only
		// moves is the same path every frame, and Firefox on the GPU drew
		// that several times faster than a path of every dot, which is new
		// each frame: 0.3 to 0.6 ms a draw at 12 cards, against 5 to 7 ms.
		ctx.globalAlpha = fade * line.dotsIn.value(now);
		ctx.fillStyle = colors[line.kind];
		line.stream.forEach(t, (s, red) => {
			if (red) return;
			const p = walker.at(s);
			if (!within(view, p)) return;
			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
			ctx.fill();
		});
	}
}

function within(
	view: { x0: number; y0: number; x1: number; y1: number },
	p: { x: number; y: number }
): boolean {
	return p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1;
}

function sameLook(a: LineLook, b: LineLook): boolean {
	return (
		a === b ||
		(a.active === b.active &&
			a.level === b.level &&
			a.width === b.width &&
			a.fails === b.fails &&
			a.lookup === b.lookup &&
			a.hits === b.hits)
	);
}

/** Trace a track's path, rounded corners included. */
function trace(ctx: Ctx, track: Track) {
	for (const o of track.ops) {
		if (o.op === 'Q') ctx.quadraticCurveTo(o.cx, o.cy, o.x, o.y);
		else if (o.op === 'M') ctx.moveTo(o.x, o.y);
		else ctx.lineTo(o.x, o.y);
	}
}

/**
 * Fill a failure bar centered on (x, y), along the direction (dx, dy). Along
 * a straight run it is a plain rectangle; in a corner it turns with the line.
 */
function barAt(ctx: Ctx, x: number, y: number, dx: number, dy: number, len: number, w: number) {
	if (dy === 0 || dx === 0) {
		const along = dy === 0;
		const bw = along ? len : w;
		const bh = along ? w : len;
		ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
		return;
	}
	const ax = (dx * len) / 2;
	const ay = (dy * len) / 2;
	const nx = (-dy * w) / 2;
	const ny = (dx * w) / 2;
	ctx.beginPath();
	ctx.moveTo(x - ax + nx, y - ay + ny);
	ctx.lineTo(x + ax + nx, y + ay + ny);
	ctx.lineTo(x + ax - nx, y + ay - ny);
	ctx.lineTo(x - ax - nx, y - ay - ny);
	ctx.closePath();
	ctx.fill();
}

/** Under reduced motion, the static bars of an active failing line, by distance from its start. */
function stillBars(line: LineState): number[] {
	const { look, stream } = line;
	if (!look.active || look.fails === 0) return [];
	const gap = spacing(look.level);
	const out: number[] = [];
	for (let i = 0, s = stream.seed * gap; s <= stream.length; i++, s += gap)
		if (isFailSlot(i % SLOTS, look.fails)) out.push(s);
	return out;
}
