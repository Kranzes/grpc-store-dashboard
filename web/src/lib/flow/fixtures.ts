// Layouts for tests of lines, labels and focus: the default demo's shape
// and ?demo&builders=30, with the mock's systems and an address scheme
// that puts 10.0.0.13:50051 in column 1, row 3. Also a fake clock and 2D
// context for the line canvas.

import { OTHER_CLIENTS, type Topology } from '#lib/model/types.ts';
import { layoutTopology, type Layout, type PoolChoices } from './layout.ts';
import type { Ctx } from './lineLayer.ts';
import type { FrameEnv } from './motion.ts';

/** Shown client groups: 8 identities plus "other clients", as the demo has. */
export const GROUPS = [...Array.from({ length: 8 }, (_, i) => `ci-runner-${i}`), OTHER_CLIENTS];

/** n builders of a system, 10.0.<s>.<10 + i>:50051, with s = 0 for x86_64-linux. */
export function builders(system: string, n: number): string[] {
	const s = system === 'x86_64-linux' ? 0 : system === 'aarch64-linux' ? 1 : 2;
	return Array.from({ length: n }, (_, i) => `10.0.${s}.${10 + i}:50051`);
}

/** A topology with builders per system, in system order as the reducer sorts them. */
export function farm(
	perSystem: Readonly<Record<string, number>>,
	extra: Partial<Topology> = {}
): Topology {
	const systems = Object.keys(perSystem).sort();
	const workers = systems.flatMap((s) => builders(s, perSystem[s]));
	return {
		version: 1,
		clientGroups: GROUPS,
		workers,
		workerSystems: systems.flatMap((s) => builders(s, perSystem[s]).map(() => s)),
		retired: [],
		hasCache: true,
		upstreamWorkers: [],
		upstreamRows: 0,
		...extra
	};
}

/** A topology whose builders all list upstream substituters, with the card's rows. */
export function upstreamFarm(
	perSystem: Readonly<Record<string, number>>,
	rows = 4,
	extra: Partial<Topology> = {}
): Topology {
	const t = farm(perSystem, extra);
	return { ...t, upstreamWorkers: t.workers, upstreamRows: rows, ...extra };
}

/** The default demo: 4 aarch64-linux and 8 x86_64-linux builders, all as cards. */
export function demo12(): Layout {
	return layoutTopology(farm({ 'aarch64-linux': 4, 'x86_64-linux': 8 }));
}

/** ?demo&builders=30: 10 aarch64-linux cards and a pool of 20 x86_64-linux builders. */
export function demo30(choices?: PoolChoices): Layout {
	return layoutTopology(farm({ 'aarch64-linux': 10, 'x86_64-linux': 20 }), undefined, choices);
}

/** ?demo&builders=50 with both groups shown as cards. */
export function demo50Cards(): Layout {
	return layoutTopology(
		farm({ 'aarch64-linux': 17, 'x86_64-linux': 33 }),
		undefined,
		new Map([
			['aarch64-linux', false],
			['x86_64-linux', false]
		])
	);
}

/**
 * A fake browser clock for the line canvas: frames come only when the test
 * runs them, timers run by time.
 */
export function fakeFrames() {
	let time = 0;
	let nextId = 1;
	const frames = new Map<number, (t: number) => void>();
	const timers = new Map<number, { at: number; cb: () => void }>();
	let frameCount = 0;
	const env: FrameEnv = {
		now: () => time,
		requestAnimationFrame: (cb) => {
			const id = nextId++;
			frames.set(id, cb);
			return id;
		},
		cancelAnimationFrame: (id) => void frames.delete(id),
		setTimeout: (cb, ms) => {
			const id = nextId++;
			timers.set(id, { at: time + ms, cb });
			return id;
		},
		clearTimeout: (id) => void timers.delete(id)
	};
	/** Run display frames at `hz` up to `until` ms, firing due timers between them. */
	function run(until: number, hz = 240) {
		const dt = 1000 / hz;
		while (time + dt <= until + 1e-9) {
			time += dt;
			for (const [id, t] of [...timers]) {
				if (t.at <= time) {
					timers.delete(id);
					t.cb();
				}
			}
			const due = [...frames.values()];
			frames.clear();
			if (due.length) frameCount++;
			for (const cb of due) cb(time);
		}
	}
	return {
		env,
		run,
		/** Move the clock without running frames, as a hidden tab or a long task does. */
		skip(ms: number) {
			time += ms;
		},
		get time() {
			return time;
		},
		/** Display frames that had a callback waiting. */
		get frames() {
			return frameCount;
		},
		idle: () => frames.size === 0 && timers.size === 0
	};
}

/**
 * A 2D context that only counts what it is asked to do: strokes with their
 * colors, fills, arcs, and the most arcs any one fill took in its path.
 */
export function fakeContext() {
	const calls = {
		clear: 0,
		stroke: 0,
		fill: 0,
		arc: 0,
		strokes: [] as string[],
		/** Every stroke and fill in order, a fill with its color: "stroke", "fill:danger". */
		ops: [] as string[],
		/** The radius of every arc, so tests can tell the dots' size. */
		radii: [] as number[],
		arcsPerFill: 0,
		reset() {
			this.clear = this.stroke = this.fill = this.arc = this.arcsPerFill = 0;
			this.strokes.length = 0;
			this.ops.length = 0;
			this.radii.length = 0;
		}
	};
	let arcs = 0;
	const ctx: Ctx = {
		globalAlpha: 1,
		strokeStyle: '',
		fillStyle: '',
		lineWidth: 1,
		lineCap: 'butt',
		lineJoin: 'miter',
		lineDashOffset: 0,
		setTransform: () => {},
		clearRect: () => void calls.clear++,
		beginPath: () => void (arcs = 0),
		moveTo: () => {},
		lineTo: () => {},
		quadraticCurveTo: () => {},
		arc: (_x, _y, r) => {
			calls.arc++;
			arcs++;
			calls.radii.push(r);
		},
		closePath: () => {},
		fill() {
			calls.fill++;
			calls.ops.push(`fill:${String(this.fillStyle)}`);
			calls.arcsPerFill = Math.max(calls.arcsPerFill, arcs);
		},
		fillRect() {
			calls.fill++;
			calls.ops.push(`fill:${String(this.fillStyle)}`);
		},
		stroke() {
			calls.stroke++;
			calls.strokes.push(String(this.strokeStyle));
			calls.ops.push('stroke');
		},
		setLineDash: () => {}
	};
	return { ctx, calls };
}
