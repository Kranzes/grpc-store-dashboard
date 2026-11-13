import { describe, expect, it } from 'vitest';
import {
	CACHE_ID,
	OTHER_CLIENTS,
	SCHEDULER_ID,
	UPSTREAM_ID,
	type Topology
} from '#lib/model/types.ts';
import {
	BUS_SPACING,
	CHANNEL_CLEARANCE,
	GAP,
	MAX_ROWS,
	POOL_GRID,
	POOL_W,
	SIZE,
	TRACK_SPACING,
	assignSlots,
	channelSplit,
	layoutTopology,
	poolHeight,
	poolRows,
	showsAsPool,
	type BuilderGroup,
	type Layout,
	type LayoutNode,
	type PoolChoices
} from './layout.ts';
import { lineGeometry } from './geometry.ts';
import { routePoints } from './route.ts';
import { trackOf } from './track.ts';
import { traffic } from './traffic.ts';

/** x86 builders are named x.., arm ones a.. */
const systemOf = (addr: string) => (addr.startsWith('a') ? 'aarch64-linux' : 'x86_64-linux');

const topo = (workers: string[], extra: Partial<Topology> = {}): Topology => ({
	version: 1,
	clientGroups: ['hydra', 'ci', OTHER_CLIENTS],
	workers,
	workerSystems: workers.map(systemOf),
	retired: [],
	hasCache: true,
	upstreamWorkers: [],
	upstreamRows: 0,
	...extra
});

const range = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

const slots = (workers: string[], previous?: BuilderGroup[], sys = systemOf) =>
	assignSlots(workers, workers.map(sys), previous);

const byId = (nodes: readonly LayoutNode[]) => new Map(nodes.map((n) => [n.id, n]));

/** Both systems as builder cards, whatever their size. */
const CARDS: PoolChoices = new Map([
	['x86_64-linux', false],
	['aarch64-linux', false]
]);

function expectNoOverlap(l: Layout) {
	const boxes = l.nodes;
	const overlaps: string[] = [];
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
				overlaps.push(`${a.id} overlaps ${b.id}`);
		}
	}
	expect(overlaps).toEqual([]);
}

/** Lines never run behind a builder, pool or group heading other than their own ends. */
function expectClearRoutes(l: Layout) {
	const solid = l.nodes.filter(
		(n) => n.kind === 'builder' || n.kind === 'pool' || n.kind === 'system'
	);
	const behind: string[] = [];
	for (const g of lineGeometry(l)) {
		for (let i = 1; i < g.points.length; i++) {
			const [x1, y1] = g.points[i - 1];
			const [x2, y2] = g.points[i];
			for (const b of solid) {
				if (b.id === g.source || b.id === g.target) continue;
				if (
					Math.min(x1, x2) < b.x + b.w &&
					Math.max(x1, x2) > b.x &&
					Math.min(y1, y2) < b.y + b.h &&
					Math.max(y1, y2) > b.y
				)
					behind.push(`${g.id} runs behind ${b.id}`);
			}
		}
	}
	expect(behind).toEqual([]);
}

/**
 * The scheduler's out handle (assign), publish and fetch at the cache's
 * handles, and the top and bottom assignment tracks.
 */
function buses(l: Layout) {
	const n = byId(l.nodes);
	const sched = n.get(SCHEDULER_ID)!;
	const cache = n.get(CACHE_ID)!;
	const ys = [...new Set(tracks(l).values())];
	return {
		publish: cache.y + cache.ports!.publish,
		assign: sched.y + sched.h / 2,
		fetch: cache.y + cache.ports!.fetch,
		top: Math.min(...ys),
		bottom: Math.max(...ys)
	};
}

/** The group heading over a builder or pool node. */
function groupOf(l: Layout, id: string): string {
	const target = byId(l.nodes).get(id)!;
	const heading = l.nodes.find(
		(h) => h.kind === 'system' && target.x >= h.x && target.x < h.x + h.w
	)!;
	return heading.ref;
}

/**
 * Each assignment line's track, by line id: the y of the run that ends at
 * its trunk, or of the whole line when it runs straight into its card.
 */
function tracks(l: Layout): Map<string, number> {
	const out = new Map<string, number>();
	for (const g of lineGeometry(l))
		if (g.kind === 'assign') out.set(g.id, (g.points.at(-3) ?? g.points[0])[1]);
	return out;
}

/** Each group's track y, by system. */
function groupTracks(l: Layout): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const [id, y] of tracks(l)) {
		const target = l.lines.find((e) => e.id === id)!.target;
		const system = groupOf(l, target);
		out.set(system, [...new Set([...(out.get(system) ?? []), y])]);
	}
	return out;
}

const PITCH = SIZE.builder.h + GAP.builderRow;
/** Half the widest line a bus can draw. */
const HALF = traffic(1, 1).width / 2;
/** What the widest bus keeps to the cards either side in a plain row gap. */
const CLEAR = (GAP.builderRow - 2 * HALF) / 2;

/**
 * One assignment track per group, each group's lines on their own, the
 * tracks TRACK_SPACING apart and centered on the scheduler's out handle,
 * with the publish and fetch buses BUS_SPACING outside them.
 */
function expectTracks(l: Layout) {
	const b = buses(l);
	const groups = groupTracks(l);
	const headings = l.nodes.filter((n) => n.kind === 'system');
	expect([...groups.keys()].sort()).toEqual(headings.map((h) => h.ref).sort());
	for (const [system, ys] of groups) expect(ys, system).toHaveLength(1);
	const ys = [...groups.values()].map(([y]) => y).sort((a, c) => a - c);
	expect(new Set(ys).size).toBe(ys.length);
	for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBe(TRACK_SPACING);
	expect((b.top + b.bottom) / 2).toBe(b.assign);
	expect(b.publish).toBe(b.top - BUS_SPACING);
	expect(b.fetch).toBe(b.bottom + BUS_SPACING);
}

/**
 * The buses run side by side in one channel at the fixed spacings, and the
 * widest line on any of them keeps a plain row gap's clearance from every
 * card: no bus crosses or touches a card. The scheduler and the client
 * groups sit centered on the assignment tracks.
 */
function expectChannel(l: Layout) {
	const b = buses(l);
	expectTracks(l);
	for (const card of l.nodes.filter((n) => n.kind === 'builder')) {
		const above = card.y + card.h + CLEAR <= b.publish - HALF;
		const below = card.y - CLEAR >= b.fetch + HALF;
		expect(above || below, `${card.id} at ${card.y} is clear of the channel`).toBe(true);
	}
	const clients = l.nodes.filter((n) => n.kind === 'clients');
	const top = Math.min(...clients.map((c) => c.y));
	const bottom = Math.max(...clients.map((c) => c.y + c.h));
	expect((top + bottom) / 2).toBe(b.assign);
}

/** Distinct card rows above and below the assign bus, and the cards' middle. */
function cardRows(l: Layout) {
	const cards = l.nodes.filter((n) => n.kind === 'builder');
	const { assign } = buses(l);
	const ys = [...new Set(cards.map((c) => c.y))].sort((a, b) => a - b);
	const top = Math.min(...cards.map((c) => c.y));
	const bottom = Math.max(...cards.map((c) => c.y + c.h));
	return {
		above: ys.filter((y) => y < assign).length,
		below: ys.filter((y) => y > assign).length,
		ys,
		middle: (top + bottom) / 2
	};
}

/** Whether a pool's group heading sits clear below the lowest bus. */
function headingClearOfBuses(l: Layout, system: string, lowest: number) {
	const heading = byId(l.nodes).get(`system:${system}`)!;
	return heading.y > lowest + HALF;
}

describe('assignSlots', () => {
	it('groups by native system in topology order', () => {
		const g = slots(['a1', 'a2', 'x1']);
		expect(g).toEqual([
			{ system: 'aarch64-linux', slots: ['a1', 'a2'] },
			{ system: 'x86_64-linux', slots: ['x1'] }
		]);
	});

	it('keeps slots when builders leave and fills holes with new ones', () => {
		const first = slots(['x1', 'x2', 'x3']);
		const gone = slots(['x1', 'x3'], first);
		expect(gone[0].slots).toEqual(['x1', null, 'x3']);
		const back = slots(['x1', 'x3', 'x4'], gone);
		expect(back[0].slots).toEqual(['x1', 'x4', 'x3']);
	});

	it('trims trailing holes and drops empty groups', () => {
		const first = slots(['a1', 'x1', 'x2']);
		const next = slots(['x1'], first);
		expect(next).toEqual([{ system: 'x86_64-linux', slots: ['x1'] }]);
	});

	it('appends new systems after existing groups', () => {
		const first = slots(['x1']);
		const next = slots(['a1', 'x1'], first);
		expect(next.map((g) => g.system)).toEqual(['x86_64-linux', 'aarch64-linux']);
	});

	it('moves a builder whose native system changed', () => {
		const first = slots(['x1', 'x2']);
		const next = slots(['x1', 'x2'], first, (a) => (a === 'x2' ? 'aarch64-linux' : systemOf(a)));
		expect(next).toEqual([
			{ system: 'x86_64-linux', slots: ['x1'] },
			{ system: 'aarch64-linux', slots: ['x2'] }
		]);
	});

	it('puts builders without a known system in their own group', () => {
		expect(assignSlots(['q'], [''])[0].system).toBe('unknown system');
	});
});

describe('layoutTopology', () => {
	it('places lanes left to right', () => {
		const l = layoutTopology(topo(range('x', 3)));
		const n = byId(l.nodes);
		const clients = n.get('clients:hydra')!;
		const sched = n.get(SCHEDULER_ID)!;
		const builder = n.get('worker:x00')!;
		const cache = n.get(CACHE_ID)!;
		expect(clients.x).toBeLessThan(sched.x);
		expect(sched.x + sched.w).toBeLessThan(builder.x);
		expect(builder.x + builder.w).toBeLessThan(cache.x);
		const headings = l.nodes.filter((x) => x.kind === 'lane');
		expect(headings.map((h) => h.ref)).toEqual(['Clients', 'Scheduler', 'Builders', 'Cache']);
		// Headings share one row above everything else.
		expect(new Set(headings.map((h) => h.y)).size).toBe(1);
		const lowest = Math.min(...l.nodes.filter((x) => x.kind !== 'lane').map((x) => x.y));
		expect(headings[0].y + headings[0].h).toBeLessThan(lowest);
	});

	it('uses columns of at most 10 builders per system', () => {
		const workers = [...range('a', 5), ...range('x', 30)];
		const l = layoutTopology(topo(workers), undefined, CARDS);
		const builders = l.nodes.filter((n) => n.kind === 'builder');
		expect(builders).toHaveLength(35);
		const columns = new Map<number, LayoutNode[]>();
		for (const b of builders) columns.set(b.x, [...(columns.get(b.x) ?? []), b]);
		// aarch64: 1 column of 5; x86: 10 + 10 + 10.
		expect([...columns.values()].map((c) => c.length)).toEqual([5, 10, 10, 10]);
		for (const col of columns.values()) {
			expect(new Set(col.map((b) => systemOf(b.ref))).size).toBe(1);
			expect(col.length).toBeLessThanOrEqual(MAX_ROWS);
		}
		const groups = l.nodes.filter((n) => n.kind === 'system');
		expect(groups.map((g) => [g.ref, g.count])).toEqual([
			['aarch64-linux', 5],
			['x86_64-linux', 30]
		]);
	});

	it('never overlaps nodes', () => {
		const workers = [...range('a', 14), ...range('x', 36)];
		expectNoOverlap(layoutTopology(topo(workers), undefined, CARDS));
	});

	it('keeps positions stable as builders come and go', () => {
		const first = layoutTopology(topo(range('x', 20)), undefined, CARDS);
		const pos = (l: typeof first, id: string) => {
			const n = byId(l.nodes).get(id)!;
			return [n.x, n.y];
		};
		const without = range('x', 20).filter((a) => a !== 'x05');
		const second = layoutTopology(topo(without, { version: 2 }), first, CARDS);
		for (const a of without) expect(pos(second, `worker:${a}`)).toEqual(pos(first, `worker:${a}`));
		const third = layoutTopology(topo([...without, 'x99'], { version: 3 }), second, CARDS);
		expect(pos(third, 'worker:x99')).toEqual(pos(first, 'worker:x05'));
	});

	it('creates the lines of each lane', () => {
		const l = layoutTopology(topo(range('x', 2)));
		const ids = l.lines.map((e) => e.id).sort();
		expect(ids).toEqual(
			[
				'want:hydra',
				'want:ci',
				`want:${OTHER_CLIENTS}`,
				'assign:x00',
				'assign:x01',
				'publish:x00',
				'publish:x01',
				'fetch:x00',
				'fetch:x01',
				'cached:scheduler'
			].sort()
		);
		const ends = (id: string) => {
			const e = l.lines.find((x) => x.id === id)!;
			return [e.kind, e.source, e.target];
		};
		expect(ends('want:hydra')).toEqual(['request', 'clients:hydra', SCHEDULER_ID]);
		expect(ends(`want:${OTHER_CLIENTS}`)).toEqual([
			'request',
			`clients:${OTHER_CLIENTS}`,
			SCHEDULER_ID
		]);
		expect(ends('assign:x00')).toEqual(['assign', SCHEDULER_ID, 'worker:x00']);
		expect(ends('publish:x00')).toEqual(['publish', 'worker:x00', CACHE_ID]);
		expect(ends('fetch:x00')).toEqual(['fetch', CACHE_ID, 'worker:x00']);
		expect(ends('cached:scheduler')).toEqual(['hit', SCHEDULER_ID, CACHE_ID]);
	});

	it('shows placeholders without builders, clients or cache', () => {
		const l = layoutTopology(topo([], { clientGroups: [], hasCache: false }));
		const kinds = l.nodes.map((n) => n.kind);
		expect(kinds).toContain('empty-builders');
		expect(kinds).toContain('empty-clients');
		expect(kinds).toContain('empty-cache');
		expect(kinds).not.toContain('cache');
		expect(l.lines).toEqual([]);
	});

	it('routes multi-column buses through one channel, clear of every builder', () => {
		const l = layoutTopology(topo(range('x', 30)), undefined, CARDS);
		const builders = l.nodes.filter((n) => n.kind === 'builder');
		expectChannel(l);
		expectClearRoutes(l);
		// Trunks sit in gaps, not inside a column.
		for (const e of l.lines) {
			if (e.route.kind !== 'trunk') continue;
			const x = e.route.x;
			for (const b of builders)
				expect(x > b.x && x < b.x + b.w, `${e.id} trunk in ${b.id}`).toBe(false);
		}
	});

	/** The cache hits line's top run. */
	const roof = (l: Layout) => {
		const cached = l.lines.find((e) => e.kind === 'hit')!;
		expect(cached.route.kind).toBe('over');
		return cached.route.kind === 'over' ? cached.route.y : 0;
	};
	const top = (nodes: readonly LayoutNode[]) => Math.min(...nodes.map((n) => n.y));

	it('routes the cache hits line above the builder lane', () => {
		const l = layoutTopology(topo(range('x', 4)));
		const y = roof(l);
		const others = l.nodes.filter((n) => n.kind !== 'lane');
		expect(top(others)).toBeGreaterThan(y);
	});

	it('keeps the cache hits line low beside pools, and the lane headings above all', () => {
		// Pools hang below the buses, and nine client cards stand far taller.
		const clients = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', OTHER_CLIENTS];
		const l = layoutTopology(
			topo([...range('x', 40), ...range('a', 20)], { clientGroups: clients })
		);
		expect(l.pools.size).toBe(2);
		const y = roof(l);
		const kind = (k: string) => l.nodes.filter((n) => n.kind === k);
		const lanes = kind('lane');
		const rest = l.nodes.filter((n) => n.kind !== 'lane');
		// Over the scheduler, the pools, their headings and the cache.
		for (const k of ['scheduler', 'pool', 'system', 'cache'])
			expect(top(kind(k)), k).toBeGreaterThan(y);
		// Lower than the client cards, which it does not pass.
		expect(top(kind('clients'))).toBeLessThan(y);
		// The headings still clear every node, the client cards included.
		for (const h of lanes) {
			expect(h.y + h.h, h.id).toBeLessThan(top(kind('clients')));
			expect(h.y + h.h, h.id).toBeLessThan(top(rest));
		}
	});

	it('puts the cache hits line first, so it draws under the other lines', () => {
		const l = layoutTopology(topo(range('x', 4)));
		expect(l.lines[0].id).toBe('cached:scheduler');
		expect(l.lines.filter((e) => e.kind === 'hit')).toHaveLength(1);
		const pooled = layoutTopology(topo(range('x', 20)));
		expect(pooled.lines[0].id).toBe('cached:scheduler');
		expect(layoutTopology(topo(range('x', 4), { hasCache: false })).lines[0].kind).toBe('request');
	});
});

describe('pools', () => {
	const kinds = (l: Layout) => l.nodes.map((n) => n.kind);
	const pool = (l: Layout, system = 'x86_64-linux') => byId(l.nodes).get(`pool:${system}`);

	it('draws a group of more than 10 builders as one pool', () => {
		expect(showsAsPool(10, undefined, false)).toBe(false);
		expect(showsAsPool(11, undefined, false)).toBe(true);
		const ten = layoutTopology(topo(range('x', 10)));
		expect(kinds(ten).filter((k) => k === 'builder')).toHaveLength(10);
		expect(kinds(ten)).not.toContain('pool');
		const eleven = layoutTopology(topo(range('x', 11)));
		expect(kinds(eleven)).not.toContain('builder');
		const p = pool(eleven)!;
		expect(p).toMatchObject({ kind: 'pool', ref: 'x86_64-linux', count: 11, rows: 1, w: POOL_W });
		expect(p.cells).toEqual(range('x', 11));
		expect(p.h).toBe(poolHeight(1));
		expect([...eleven.pools]).toEqual([['x86_64-linux', 1]]);
	});

	it("follows the user's choice over the default", () => {
		const cards = layoutTopology(topo(range('x', 40)), undefined, CARDS);
		expect(kinds(cards).filter((k) => k === 'builder')).toHaveLength(40);
		expect(cards.pools.size).toBe(0);
		const small = layoutTopology(topo(range('x', 3)), undefined, new Map([['x86_64-linux', true]]));
		expect(pool(small)?.count).toBe(3);
		expect(small.pools.has('x86_64-linux')).toBe(true);
	});

	it('counts only builders taking work toward the default', () => {
		// 20 builders, but only 10 take work: the rest are offline or draining.
		const active = new Map([['x86_64-linux', 10]]);
		const l = layoutTopology(topo(range('x', 20)), undefined, new Map(), active);
		expect(pool(l)).toBeUndefined();
		expect(kinds(l).filter((k) => k === 'builder')).toHaveLength(20);
		const more = layoutTopology(
			topo(range('x', 20)),
			l,
			new Map(),
			new Map([['x86_64-linux', 13]])
		);
		expect(pool(more)?.count).toBe(20);
	});

	it("gives a retired builder's cell up at once, and a newcomer takes it", () => {
		const first = layoutTopology(topo(range('x', 20)));
		const retired = layoutTopology(topo(range('x', 20), { version: 2, retired: ['x03'] }), first);
		const cells = pool(retired)!.cells!;
		expect(cells[3]).toBeNull();
		expect(pool(retired)!.count).toBe(19);
		expect(byId(retired.nodes).get('system:x86_64-linux')!.count).toBe(19);
		// Nobody else moves.
		const next = layoutTopology(
			topo([...range('x', 20), 'x99'], { version: 3, retired: ['x03'] }),
			retired
		);
		expect(pool(next)!.cells).toEqual([...range('x', 20)].map((a) => (a === 'x03' ? 'x99' : a)));
	});

	it('keeps a retired builder as a card, with its lines, until it lingers out', () => {
		const cards = layoutTopology(
			topo(range('x', 20), { version: 4, retired: ['x03'] }),
			undefined,
			CARDS
		);
		expect(byId(cards.nodes).has('worker:x03')).toBe(true);
		// Its idle lines are drawn, so a click on one finds it.
		const ids = cards.lines.map((e) => e.id);
		for (const kind of ['assign', 'publish', 'fetch']) expect(ids).toContain(`${kind}:x03`);
	});

	it('does not count retired builders toward the default', () => {
		const ten = layoutTopology(topo(range('x', 11), { retired: ['x00'] }));
		expect(pool(ten)).toBeUndefined();
	});

	it('keeps a pool whose builders all retired, with nothing to draw', () => {
		const first = layoutTopology(topo(range('x', 20)));
		const gone = layoutTopology(
			topo(range('x', 20), { version: 5, retired: range('x', 20) }),
			first
		);
		expect(pool(gone)).toBeUndefined();
		expect(kinds(gone)).not.toContain('builder');
		expect(gone.pools.has('x86_64-linux')).toBe(true);
		const later = layoutTopology(
			topo(range('x', 20), { version: 6, retired: range('x', 20) }),
			gone
		);
		expect(kinds(later)).not.toContain('builder');
	});

	it('stays a pool as it shrinks, until the user expands it', () => {
		const big = layoutTopology(topo(range('x', 20)));
		const smaller = layoutTopology(topo(range('x', 8), { version: 2 }), big);
		expect(pool(smaller)?.count).toBe(8);
		// Without the previous layout, 8 builders are cards.
		expect(pool(layoutTopology(topo(range('x', 8))))).toBeUndefined();
		const expanded = layoutTopology(
			topo(range('x', 8), { version: 3 }),
			smaller,
			new Map([['x86_64-linux', false]])
		);
		expect(pool(expanded)).toBeUndefined();
		// Gone from the topology, gone from the pools: it starts over when it comes back.
		const empty = layoutTopology(topo(range('a', 2), { version: 4 }), smaller);
		expect(empty.pools.has('x86_64-linux')).toBe(false);
	});

	it('keeps each builder in its cell, and fills free cells first', () => {
		const first = layoutTopology(topo(range('x', 30)));
		const without = range('x', 30).filter((a) => a !== 'x07' && a !== 'x29');
		const second = layoutTopology(topo(without, { version: 2 }), first);
		const cells = pool(second)!.cells!;
		expect(cells.indexOf('x08')).toBe(8);
		expect(cells[7]).toBeNull();
		// The grid drops trailing free cells and keeps its rows.
		expect(cells).toHaveLength(29);
		const third = layoutTopology(topo([...without, 'y1', 'y2'], { version: 3 }), second);
		const next = pool(third)!.cells!;
		expect(next[7]).toBe('y1');
		expect(next[29]).toBe('y2');
		// Joins and leaves change only the cells: the node stays put and keeps its size.
		for (const l of [second, third]) {
			const p = pool(l)!;
			expect([p.x, p.y, p.w, p.h]).toEqual([
				pool(first)!.x,
				pool(first)!.y,
				pool(first)!.w,
				pool(first)!.h
			]);
		}
	});

	it('grows the grid as soon as it is full and shrinks it only below half', () => {
		const c = POOL_GRID.columns;
		expect(poolRows(1)).toBe(1);
		expect(poolRows(c)).toBe(1);
		expect(poolRows(c + 1)).toBe(2);
		expect(poolRows(c + 1, 1)).toBe(2);
		// One builder either side of a row boundary keeps the size.
		expect(poolRows(c, 2)).toBe(2);
		expect(poolRows(2 * c, 4)).toBe(4);
		expect(poolRows(c, 4)).toBe(1);
		expect(poolRows(1000)).toBe(Math.ceil(1000 / c));
		// A thousand builders stay a sensible height.
		expect(poolHeight(poolRows(1000))).toBeLessThan(800);
	});

	it('gives a pool the lines of its builders, summed', () => {
		const l = layoutTopology(topo(range('x', 20)));
		const ids = l.lines.map((e) => e.id).filter((id) => !id.startsWith('want:'));
		expect(ids.sort()).toEqual(
			[
				'assign:pool:x86_64-linux',
				'publish:pool:x86_64-linux',
				'fetch:pool:x86_64-linux',
				'cached:scheduler'
			].sort()
		);
		const e = (id: string) => {
			const x = l.lines.find((y) => y.id === id)!;
			return [x.kind, x.source, x.target, x.sourceHandle, x.targetHandle];
		};
		const p = 'pool:x86_64-linux';
		expect(e(`assign:${p}`)).toEqual(['assign', SCHEDULER_ID, p, 'out', 'in']);
		expect(e(`publish:${p}`)).toEqual(['publish', p, CACHE_ID, 'publish', 'publish']);
		expect(e(`fetch:${p}`)).toEqual(['fetch', CACHE_ID, p, 'fetch', 'fetch']);
		expectClearRoutes(l);
	});

	it('lays pools side by side below the buses, clear of each other and their lines', () => {
		const workers = [...range('a', 300), ...range('x', 700)];
		const l = layoutTopology(topo(workers));
		const pools = l.nodes.filter((n) => n.kind === 'pool');
		expect(pools.map((p) => [p.ref, p.count])).toEqual([
			['aarch64-linux', 300],
			['x86_64-linux', 700]
		]);
		expect(pools[0].x + pools[0].w).toBeLessThan(pools[1].x);
		expect(new Set(pools.map((p) => p.y)).size).toBe(1);
		for (const p of pools) expect(headingClearOfBuses(l, p.ref, buses(l).fetch), p.id).toBe(true);
		expect(l.nodes.filter((n) => n.kind === 'builder')).toHaveLength(0);
		expectNoOverlap(l);
		expectClearRoutes(l);
	});

	it('moves nothing but the pool itself when a pool grows', () => {
		const workers = [...range('a', 30), ...range('x', 48)];
		const first = layoutTopology(topo(workers));
		const grown = layoutTopology(topo([...workers, 'x99'], { version: 2 }), first);
		expect(pool(grown)!.h).toBeGreaterThan(pool(first)!.h);
		const before = byId(first.nodes);
		for (const n of grown.nodes) {
			if (n.id === 'pool:x86_64-linux') continue;
			const b = before.get(n.id)!;
			expect([n.x, n.y, n.w, n.h], n.id).toEqual([b.x, b.y, b.w, b.h]);
		}
		expect(grown.lines).toEqual(first.lines);
	});

	it('routes a mixed farm cleanly, whichever group is the pool', () => {
		const workers = [...range('a', 13), ...range('x', 40)];
		for (const cards of ['aarch64-linux', 'x86_64-linux']) {
			const l = layoutTopology(topo(workers), undefined, new Map([[cards, false]]));
			const n = byId(l.nodes);
			const system = cards === 'x86_64-linux' ? 'aarch64-linux' : 'x86_64-linux';
			expect(l.nodes.filter((x) => x.kind === 'builder').length).toBe(
				cards === 'x86_64-linux' ? 40 : 13
			);
			// All three buses run above the pool's heading on their way past it.
			const cache = n.get(CACHE_ID)!;
			expect(cache.y + cache.ports!.fetch).toBeLessThan(n.get(`system:${system}`)!.y);
			expectNoOverlap(l);
			expectClearRoutes(l);
		}
	});

	it('keeps groups in system order, so a toggle moves no other group in the tab order', () => {
		const workers = [...range('a', 3), ...range('x', 20)];
		const order = (choices?: PoolChoices) =>
			layoutTopology(topo(workers), undefined, choices).nodes.map((x) => x.id);
		const first = order();
		const at = (id: string) => first.indexOf(id);
		expect(at('system:aarch64-linux')).toBeLessThan(at('worker:a00'));
		expect(at('worker:a02')).toBeLessThan(at('system:x86_64-linux'));
		expect(at('system:x86_64-linux')).toBeLessThan(at('pool:x86_64-linux'));
		const headings = (ids: string[]) =>
			ids.filter((id) => id.startsWith('system:') || id === 'cache');
		expect(headings(order(CARDS))).toEqual(headings(first));
		expect(headings(order(new Map([['aarch64-linux', true]])))).toEqual(headings(first));
	});
});

describe('the routing channel', () => {
	/** n x86 builders shown as cards, alone or beside m aarch64 cards. */
	const cards = (x86: number, arm = 0) =>
		layoutTopology(topo([...range('a', arm), ...range('x', x86)]), undefined, CARDS);

	it('keeps the channel clearance between the outer buses and the cards, with and without substituters', () => {
		for (const upstream of [false, true]) {
			const workers = [...range('a', 4), ...range('x', 4)];
			const l = layoutTopology(
				topo(workers, upstream ? { upstreamWorkers: workers, upstreamRows: 3 } : {}),
				undefined,
				CARDS
			);
			expectChannel(l);
			const b = buses(l);
			const top = b.publish;
			const bottom = upstream ? b.fetch + BUS_SPACING : b.fetch;
			const cards = l.nodes.filter((n) => n.kind === 'builder');
			const aboveEdge = Math.max(...cards.filter((c) => c.y < top).map((c) => c.y + c.h));
			const belowEdge = Math.min(...cards.filter((c) => c.y > bottom).map((c) => c.y));
			expect(top - aboveEdge, `upstream ${upstream}`).toBe(CHANNEL_CLEARANCE);
			expect(belowEdge - bottom, `upstream ${upstream}`).toBe(CHANNEL_CLEARANCE);
		}
	});

	it('splits the rows evenly, with the odd row below, and keeps even counts centered', () => {
		// Two columns of n rows each, from one row up to a full column.
		for (let n = 1; n <= MAX_ROWS; n++) {
			const l = cards(n, n);
			expectChannel(l);
			expectClearRoutes(l);
			expectNoOverlap(l);
			const r = cardRows(l);
			const { assign } = buses(l);
			if (n === 1) {
				// One row: the channel goes below it.
				expect([r.above, r.below]).toEqual([1, 0]);
				expect(r.ys[0] + SIZE.builder.h).toBeLessThan(assign);
				continue;
			}
			expect(r.above + r.below, `${n} rows`).toBe(n);
			expect(r.below - r.above, `${n} rows`).toBe(n % 2);
			// Rows above the channel keep their place in a lone column; rows
			// below all move down by the same amount, the channel's extra height.
			const plain = cardRows(cards(n)).ys;
			expect(r.ys.slice(0, r.above), `${n} rows`).toEqual(plain.slice(0, r.above));
			const shifts = r.ys.slice(r.above).map((y, i) => y - plain[r.above + i]);
			expect(new Set(shifts).size, `${n} rows`).toBe(1);
			expect(shifts[0], `${n} rows`).toBeGreaterThan(0);
			if (n % 2 === 0) {
				expect(r.middle, `${n} rows`).toBe(assign);
			} else {
				// The odd row hangs below: half a row off center.
				expect(r.middle - assign, `${n} rows`).toBe(PITCH / 2);
			}
		}
	});

	it('is shared by columns of different heights, across groups', () => {
		// aarch64: one column of 5; x86: 10, 10 and 3.
		const l = cards(23, 5);
		expectChannel(l);
		expectClearRoutes(l);
		expectNoOverlap(l);
		const n = byId(l.nodes);
		// The tallest column sets the split: 5 rows above, 5 below.
		expect(cardRows(l)).toMatchObject({ above: 5, below: 5 });
		const { assign } = buses(l);
		// The short columns sit wholly above the channel.
		for (const id of ['worker:a04', 'worker:x22'])
			expect(n.get(id)!.y + SIZE.builder.h).toBeLessThan(assign);
		// Columns of one row and of three rows still split around one channel.
		const short = cards(3, 1);
		expectChannel(short);
		expectClearRoutes(short);
		expect(cardRows(short)).toMatchObject({ above: 1, below: 2 });
	});

	it('runs through cards beside pools', () => {
		// One column of 10 cards beside a pool, and four columns beside one.
		for (const [arm, x86, pool] of [
			[10, 20, 'x86_64-linux'],
			[13, 40, 'aarch64-linux']
		] as const) {
			const l = layoutTopology(
				topo([...range('a', arm), ...range('x', x86)]),
				undefined,
				new Map([
					['aarch64-linux', pool === 'aarch64-linux'],
					['x86_64-linux', pool === 'x86_64-linux']
				])
			);
			expectChannel(l);
			expectClearRoutes(l);
			expectNoOverlap(l);
			expect(cardRows(l)).toMatchObject({ above: 5, below: 5 });
			expect(cardRows(l).middle).toBe(buses(l).assign);
			// The pool hangs below all three buses, as before.
			expect(headingClearOfBuses(l, pool, buses(l).fetch)).toBe(true);
		}
	});

	it('holds its split within a row of half', () => {
		expect(channelSplit(10)).toBe(5);
		expect(channelSplit(9)).toBe(4);
		expect(channelSplit(1)).toBe(1);
		// A row more or less keeps the split.
		expect(channelSplit(10, 4)).toBe(4);
		expect(channelSplit(9, 5)).toBe(5);
		expect(channelSplit(4, 1)).toBe(1);
		// Further off, or past the last row, it starts again at half.
		expect(channelSplit(10, 3)).toBe(5);
		expect(channelSplit(4, 4)).toBe(2);
		expect(channelSplit(1, 2)).toBe(1);
	});

	it('moves no card when the tallest column gains or loses a row', () => {
		// x86 between 9 and 10 cards beside 4 aarch64 cards, each layout
		// from the last, as the map does on every topology change.
		const pos = (l: Layout) =>
			new Map(l.nodes.filter((n) => n.kind === 'builder').map((n) => [n.id, [n.x, n.y]]));
		let last = cards(9, 4);
		const first = pos(last);
		for (const [version, x86] of [10, 9, 10, 9].entries()) {
			const l = layoutTopology(
				topo([...range('a', 4), ...range('x', x86)], { version: version + 2 }),
				last,
				CARDS
			);
			expectChannel(l);
			expectClearRoutes(l);
			for (const [id, p] of pos(l)) if (first.has(id)) expect(p, id).toEqual(first.get(id));
			last = l;
		}
		// A lone group back down to one column keeps the channel, so its
		// cards stay put.
		const eleven = cards(11);
		const ten = layoutTopology(topo(range('x', 10), { version: 2 }), eleven, CARDS);
		expectChannel(ten);
		const before = pos(eleven);
		for (const [id, p] of pos(ten)) expect(p, id).toEqual(before.get(id));
		// Without cards there is no channel to keep.
		const pools = layoutTopology(
			topo(range('x', 10), { version: 3 }),
			ten,
			new Map([['x86_64-linux', true]])
		);
		expect(pools.channel).toBeNull();
	});

	it('stays clear and near the middle as columns grow a row at a time', () => {
		let last: Layout | undefined;
		for (let n = 1; n <= MAX_ROWS; n++) {
			const l = layoutTopology(
				topo([...range('a', n), ...range('x', n)], { version: n }),
				last,
				CARDS
			);
			expectChannel(l);
			expectClearRoutes(l);
			expectNoOverlap(l);
			expect(
				Math.abs(l.channel! - Math.max(1, Math.floor(n / 2))),
				`${n} rows`
			).toBeLessThanOrEqual(1);
			last = l;
		}
	});

	it('leaves a single column and pools alone', () => {
		// One column: no channel, the buses fan out from its middle, rows at one pitch.
		for (let n = 1; n <= MAX_ROWS; n++) {
			const l = cards(n);
			const b = buses(l);
			const r = cardRows(l);
			expect(l.channel, `${n} rows`).toBeNull();
			expect(b.assign, `${n} rows`).toBe(r.middle);
			expectTracks(l);
			expect([b.top, b.bottom]).toEqual([b.assign, b.assign]);
			const steps = r.ys.slice(1).map((y, i) => y - r.ys[i]);
			expect(new Set(steps).size, `${n} rows`).toBeLessThanOrEqual(1);
			expectClearRoutes(l);
		}
		// Pools only: no channel, and the buses sit above the pools.
		const pools = layoutTopology(topo([...range('a', 30), ...range('x', 40)]));
		const b = buses(pools);
		expect(pools.channel).toBeNull();
		expectTracks(pools);
		for (const p of pools.nodes.filter((n) => n.kind === 'pool'))
			expect(headingClearOfBuses(pools, p.ref, b.fetch), p.id).toBe(true);
		expectClearRoutes(pools);
	});
});

describe('assignment tracks', () => {
	const SYSTEMS = [
		'aarch64-darwin',
		'aarch64-linux',
		'i686-linux',
		'riscv64-linux',
		'x86_64-linux'
	];
	/**
	 * counts[i] builders of SYSTEMS[i], in that order, as cards unless pools[i].
	 * Upstream substituters on every builder with `upstream`.
	 */
	const groups = (counts: number[], pools: boolean[] = [], upstream = false) => {
		const workers: string[] = [];
		const systems: string[] = [];
		counts.forEach((n, i) => {
			for (let k = 0; k < n; k++) {
				workers.push(`g${i}-${k}`);
				systems.push(SYSTEMS[i]);
			}
		});
		const extra = upstream ? { upstreamWorkers: workers, upstreamRows: 3 } : {};
		return layoutTopology(
			topo(workers, { workerSystems: systems, ...extra }),
			undefined,
			new Map(SYSTEMS.map((sys, i) => [sys, pools[i] ?? false]))
		);
	};

	/** Groups left to right, by their headings. */
	const order = (l: Layout) =>
		l.nodes
			.filter((n) => n.kind === 'system')
			.sort((a, b) => a.x - b.x)
			.map((n) => n.ref);

	/** "a>b" for each group a whose assignment trunk crosses group b's track. */
	function crossings(l: Layout): Set<string> {
		const lines = lineGeometry(l).filter((g) => g.kind === 'assign');
		const runs = (pts: readonly (readonly [number, number])[], vertical: boolean) =>
			pts.slice(1).flatMap((b, i) => {
				const a = pts[i];
				return (vertical ? a[0] === b[0] : a[1] === b[1]) ? [[a, b] as const] : [];
			});
		const inside = (v: number, p: number, q: number) =>
			v > Math.min(p, q) + 0.5 && v < Math.max(p, q) - 0.5;
		const out = new Set<string>();
		for (const a of lines) {
			for (const b of lines) {
				const ga = groupOf(l, a.target);
				const gb = groupOf(l, b.target);
				if (ga === gb) continue;
				for (const [p, q] of runs(a.points, true))
					for (const [r, t] of runs(b.points, false))
						if (inside(p[0], r[0], t[0]) && inside(r[1], p[1], q[1])) out.add(`${ga}>${gb}`);
			}
		}
		return out;
	}

	/** The crossings no order can avoid: a group with nodes on both sides of the tracks crosses every later group's. */
	function unavoidable(l: Layout): Set<string> {
		const { assign } = buses(l);
		const groups = order(l);
		const out = new Set<string>();
		groups.forEach((g, i) => {
			const nodes = l.nodes.filter(
				(n) => (n.kind === 'builder' || n.kind === 'pool') && groupOf(l, n.id) === g
			);
			const up = nodes.some((n) => n.y + n.h < assign);
			const down = nodes.some((n) => n.y > assign);
			if (up && down) for (const later of groups.slice(i + 1)) out.add(`${g}>${later}`);
		});
		return out;
	}

	it('with one group, every assignment runs on one bus, as before', () => {
		for (const l of [
			groups([0, 0, 0, 0, 4]),
			groups([0, 0, 0, 0, 25]),
			groups([0, 0, 0, 0, 40], [false, false, false, false, true]),
			groups([0, 0, 0, 0, 14], [], true)
		]) {
			expectTracks(l);
			const { assign } = buses(l);
			for (const g of lineGeometry(l).filter((x) => x.kind === 'assign')) {
				// Out of the scheduler at its handle's height, then straight to the trunk.
				expect(l.lines.find((e) => e.id === g.id)!.route.kind, g.id).toBe('trunk');
				expect(g.points[1][1], g.id).toBe(assign);
			}
		}
	});

	it.each<[string, number[], boolean[]]>([
		['two groups of cards', [4, 0, 0, 0, 8], []],
		['three groups of cards', [3, 3, 0, 0, 6], []],
		['five groups of cards', [2, 4, 6, 8, 10], []],
		['cards beside a pool', [7, 0, 0, 0, 15], [false, false, false, false, true]],
		['two pools', [20, 0, 0, 0, 40], [true, false, false, false, true]],
		['five pools', [12, 30, 15, 20, 60], [true, true, true, true, true]],
		['cards and pools in turn', [4, 30, 9, 20, 3], [false, true, false, true, false]]
	])(
		'with %s, gives each group a track of its own, clear of cards and buses',
		(_, counts, pools) => {
			for (const upstream of [false, true]) {
				const l = groups(counts, pools, upstream);
				expect(order(l)).toHaveLength(counts.filter((n) => n > 0).length);
				if (l.channel === null) expectTracks(l);
				else expectChannel(l);
				expectNoOverlap(l);
				expectClearRoutes(l);
				// The substitute bus runs below the fetch bus, outside the tracks.
				if (upstream) {
					for (const e of l.lines)
						if (e.route.kind === 'jog' && e.kind === 'substitute')
							expect(e.route.y, e.id).toBe(buses(l).fetch + BUS_SPACING);
				}
			}
		}
	);

	it('leaves the scheduler on one stub and spreads onto the tracks before any trunk', () => {
		for (const l of [
			groups([4, 0, 0, 0, 8]),
			groups([3, 3, 0, 0, 6]),
			groups([2, 4, 6, 8, 10]),
			groups([20, 0, 0, 0, 40], [true, false, false, false, true])
		]) {
			const sched = byId(l.nodes).get(SCHEDULER_ID)!;
			const { assign } = buses(l);
			const lines = lineGeometry(l).filter((g) => g.kind === 'assign');
			const turns = new Set<number>();
			for (const g of lines) {
				const [a, b, c] = g.points;
				// Every line leaves the out handle level.
				expect([a[1], b[1]], g.id).toEqual([assign, assign]);
				// A line off the middle turns straight onto its track.
				if (c[0] === b[0] && c[1] !== tracks(l).get(g.id)) continue;
				if (b[1] !== tracks(l).get(g.id) || c[0] === b[0]) turns.add(b[0]);
			}
			// One spread for every track, right of the scheduler and left of every
			// trunk and every builder, so the stub before it is every line's.
			expect(turns.size).toBe(1);
			const [fan] = turns;
			expect(fan).toBeGreaterThan(sched.x + sched.w);
			for (const g of lines) {
				const trunk = g.points.at(-3)![0];
				expect(trunk, g.id).toBeGreaterThan(fan);
			}
			const left = Math.min(
				...l.nodes.filter((n) => n.kind === 'builder' || n.kind === 'pool').map((n) => n.x)
			);
			expect(fan).toBeLessThan(left);
		}
	});

	it.each<[string, number[], boolean[]]>([
		['cards above the channel, then cards on both sides', [4, 0, 0, 0, 8], []],
		['three groups of cards', [3, 3, 0, 0, 6], []],
		['five groups of cards', [2, 4, 6, 8, 10], []],
		['cards on both sides beside a pool', [7, 0, 0, 0, 15], [false, false, false, false, true]],
		['two pools', [20, 0, 0, 0, 40], [true, false, false, false, true]],
		['five pools', [12, 30, 15, 20, 60], [true, true, true, true, true]],
		['cards and pools in turn', [4, 30, 9, 20, 3], [false, true, false, true, false]],
		['pools and cards in turn', [30, 4, 20, 9, 30], [true, false, true, false, true]]
	])(
		'with %s, a track crosses only the trunk of a group with cards on both sides',
		(_, counts, pools) => {
			const l = groups(counts, pools);
			expect([...crossings(l)].sort()).toEqual([...unavoidable(l)].sort());
		}
	);

	it('keeps every group on its track as a column grows a row at a time', () => {
		const rank = (l: Layout) => {
			const t = groupTracks(l);
			return order(l).map((g) => t.get(g)![0] - buses(l).top);
		};
		let last: Layout | undefined;
		let first: number[] | undefined;
		for (let n = 1; n <= MAX_ROWS; n++) {
			const counts = [3, 3, 0, 0, n];
			const workers: string[] = [];
			const systems: string[] = [];
			counts.forEach((c, i) => {
				for (let k = 0; k < c; k++) {
					workers.push(`g${i}-${k}`);
					systems.push(SYSTEMS[i]);
				}
			});
			const l = layoutTopology(topo(workers, { workerSystems: systems, version: n }), last, CARDS);
			first ??= rank(l);
			expect(rank(l), `${n} rows`).toEqual(first);
			last = l;
		}
	});

	it('grows the channel by a track spacing for each further group, and moves only the rows below', () => {
		// k groups of eight cards each, so the channel splits them alike.
		const of = (k: number, upstream: boolean) =>
			groups(
				SYSTEMS.map((_, i) => (i >= SYSTEMS.length - k ? 8 : 0)),
				[],
				upstream
			);
		const ys = (l: Layout) => cardRows(l).ys;
		for (const upstream of [false, true]) {
			const two = of(2, upstream);
			for (let k = 2; k <= SYSTEMS.length; k++) {
				const l = of(k, upstream);
				expectChannel(l);
				const b = buses(l);
				expect(b.bottom - b.top, `${k} groups`).toBe((k - 1) * TRACK_SPACING);
				// The outer buses keep the clearance to the cards either side.
				const cards = l.nodes.filter((n) => n.kind === 'builder');
				const lowest = upstream ? b.fetch + BUS_SPACING : b.fetch;
				const aboveEdge = Math.max(...cards.filter((c) => c.y < b.top).map((c) => c.y + c.h));
				const belowEdge = Math.min(...cards.filter((c) => c.y > b.bottom).map((c) => c.y));
				expect(b.publish - aboveEdge, `${k} groups`).toBe(CHANNEL_CLEARANCE);
				expect(belowEdge - lowest, `${k} groups`).toBe(CHANNEL_CLEARANCE);
				// Rows above keep their place, rows below move down by the extra tracks.
				const above = cardRows(l).above;
				expect(ys(l).slice(0, above), `${k} groups`).toEqual(ys(two).slice(0, above));
				for (const [i, y] of ys(l).slice(above).entries())
					expect(y - ys(two)[above + i], `${k} groups`).toBe((k - 2) * TRACK_SPACING);
			}
		}
	});
});

describe('routePoints', () => {
	it('rounds the corners of a trunk route', () => {
		const pts = routePoints(0, 0, 100, 80, { kind: 'trunk', x: 50 });
		expect(pts).toEqual([
			[0, 0],
			[50, 0],
			[50, 80],
			[100, 80]
		]);
		// The track starts and ends on the route, and curves through each inner corner.
		const ops = trackOf(pts).ops;
		expect(ops[0]).toEqual({ op: 'M', x: 0, y: 0 });
		expect(ops.at(-1)).toMatchObject({ x: 100, y: 80 });
		expect(ops.filter((o) => o.op === 'Q').map((o) => (o.op === 'Q' ? [o.cx, o.cy] : []))).toEqual([
			[50, 0],
			[50, 80]
		]);
	});

	it('jogs: across, up, across and down into the target', () => {
		expect(routePoints(500, 200, 100, 80, { kind: 'jog', via: 450, y: 20, x: 140 })).toEqual([
			[500, 200],
			[450, 200],
			[450, 20],
			[140, 20],
			[140, 80],
			[100, 80]
		]);
		// A jog whose via is the target's own trunk is a plain trunk.
		expect(routePoints(500, 200, 100, 80, { kind: 'jog', via: 140, y: 20, x: 140 })).toEqual([
			[500, 200],
			[140, 200],
			[140, 80],
			[100, 80]
		]);
	});

	it('goes over the top', () => {
		expect(routePoints(0, 100, 300, 120, { kind: 'over', y: -20 })).toEqual([
			[0, 100],
			[0, -20],
			[300, -20],
			[300, 120]
		]);
	});
});

describe('upstream', () => {
	/** Every builder lists upstream substituters; the card has `rows` rows. */
	const up = (workers: string[], rows = 4, extra: Partial<Topology> = {}) =>
		topo(workers, { upstreamWorkers: workers, upstreamRows: rows, ...extra });
	const DEMO = [...range('a', 4), ...range('x', 8)];

	it('puts its card under the cache, growing with its rows, after the cache in tab order', () => {
		const l = layoutTopology(up(DEMO));
		const n = byId(l.nodes);
		const cache = n.get(CACHE_ID)!;
		const card = n.get(UPSTREAM_ID)!;
		expect(card).toMatchObject({ kind: 'upstream', x: cache.x });
		expect(card.y).toBeGreaterThan(cache.y + cache.h);
		const height = (rows: number) => byId(layoutTopology(up(DEMO, rows)).nodes).get(UPSTREAM_ID)!.h;
		expect(height(1)).toBeLessThan(height(4));
		expect(height(4)).toBeLessThan(height(9));
		const order = l.nodes.map((x) => x.id);
		expect(order.indexOf(UPSTREAM_ID)).toBe(order.indexOf(CACHE_ID) + 1);
		// The lane heading names both cards and spans them.
		const lane = n.get('lane:cache')!;
		expect(lane.ref).toBe('Caches');
		expect(lane.w).toBeGreaterThanOrEqual(Math.max(cache.w, card.w));
	});

	it.each<[string, string[]]>([
		['several columns of cards', DEMO],
		['one column', range('x', 3)],
		['cards beside a pool', [...range('a', 10), ...range('x', 20)]],
		['pools only', [...range('a', 100), ...range('x', 200)]]
	])('with %s, substitute lines climb in the lane gap and jog along a fourth bus', (_, workers) => {
		const l = layoutTopology(up(workers));
		const n = byId(l.nodes);
		const lane = n.get('lane:builders')!;
		const laneRight = lane.x + lane.w;
		const cache = n.get(CACHE_ID)!;
		const card = n.get(UPSTREAM_ID)!;
		const b = buses(l);
		const targets = l.nodes.filter((x) => x.kind === 'builder' || x.kind === 'pool');
		const lines = lineGeometry(l).filter((g) => g.kind === 'substitute');
		expect(lines.length).toBeGreaterThan(0);
		const climbs = new Set<number>();
		for (const g of lines) {
			const route = l.lines.find((e) => e.id === g.id)!.route;
			const target = n.get(g.target)!;
			const right = target.x + target.w;
			// It leaves the card's left side and enters its target's right side.
			const start = g.points[0];
			const end = g.points.at(-1)!;
			expect(start[0], g.id).toBe(card.x);
			expect(end[0], g.id).toBe(right);
			expect(end[1], g.id).toBeGreaterThan(target.y);
			expect(end[1], g.id).toBeLessThan(target.y + target.h);
			// Every line climbs at one x, in the gap left of the cache lane.
			const climb = g.points[1][0];
			climbs.add(climb);
			expect(climb, g.id).toBeGreaterThan(laneRight);
			expect(climb, g.id).toBeLessThan(cache.x);
			// The last block's lines go straight in. The others run along the
			// fourth bus, then down a trunk in the gap right of their own column.
			if (right === laneRight) {
				expect(route.kind, g.id).toBe('trunk');
				continue;
			}
			expect(route.kind, g.id).toBe('jog');
			if (route.kind !== 'jog') continue;
			expect(route.y, g.id).toBe(b.fetch + BUS_SPACING);
			const next = Math.min(...targets.filter((t) => t.x > right).map((t) => t.x));
			expect(route.x, g.id).toBeGreaterThan(right);
			expect(route.x, g.id).toBeLessThan(next);
		}
		expect(climbs.size).toBe(1);
		// The channel is taller for the fourth bus, and keeps the clearance.
		if (l.channel !== null)
			for (const c of l.nodes.filter((x) => x.kind === 'builder' && x.y > b.assign))
				expect(c.y - CLEAR, c.id).toBeGreaterThanOrEqual(b.fetch + BUS_SPACING + HALF);
		expectClearRoutes(l);
	});

	it('a two-column group gets a wider gap, so the substitute trunk fits between the others', () => {
		const t = range('x', 14);
		const plain = layoutTopology(topo(t), undefined, CARDS);
		const l = layoutTopology(up(t), undefined, CARDS);
		const node = (lay: Layout, id: string) => byId(lay.nodes).get(id)!;
		const gap = (lay: Layout) =>
			node(lay, 'worker:x10').x - (node(lay, 'worker:x00').x + node(lay, 'worker:x00').w);
		expect(gap(l)).toBeGreaterThan(gap(plain));
		// Publish, fetch and substitute trunks of the first column, then the
		// second column's assign trunk: in that order, inside the gap, and
		// each at least the widest line from the next and from the cards.
		const trunk = (id: string) => {
			const r = l.lines.find((e) => e.id === id)!.route;
			return r.kind === 'over' ? NaN : r.x;
		};
		const xs = ['publish:x00', 'fetch:x00', 'substitute:x00', 'assign:x10'].map(trunk);
		const left = node(l, 'worker:x00').x + node(l, 'worker:x00').w;
		const right = node(l, 'worker:x10').x;
		expect(xs[0] - left).toBeGreaterThanOrEqual(HALF);
		expect(right - xs.at(-1)!).toBeGreaterThanOrEqual(HALF);
		for (let i = 1; i < xs.length; i++)
			expect(xs[i] - xs[i - 1], `trunk ${i}`).toBeGreaterThanOrEqual(2 * HALF);
	});

	it('moves pools down 12 px, beside cards and alone', () => {
		for (const w of [
			[...range('a', 10), ...range('x', 20)],
			[...range('a', 100), ...range('x', 200)]
		]) {
			const before = byId(layoutTopology(topo(w)).nodes);
			const after = byId(layoutTopology(up(w)).nodes);
			for (const [id, n] of before)
				if (n.kind === 'pool') expect(after.get(id)!.y - n.y, id).toBe(BUS_SPACING);
		}
	});

	it('draws substitute lines only for upstream builders and their pools, each after its fetch line', () => {
		const w = [...range('a', 4), ...range('x', 8)];
		const l = layoutTopology(up(w, 2, { upstreamWorkers: ['a01', 'x03'] }));
		expect(l.lines.filter((e) => e.kind === 'substitute').map((e) => e.id)).toEqual([
			'substitute:a01',
			'substitute:x03'
		]);
		const ids = l.lines.map((e) => e.id);
		for (const a of ['a01', 'x03'])
			expect(ids.indexOf(`substitute:${a}`)).toBe(ids.indexOf(`fetch:${a}`) + 1);
		// A pool with one upstream builder has its line.
		const p = layoutTopology(
			up([...range('a', 100), ...range('x', 200)], 2, { upstreamWorkers: ['x05'] })
		);
		expect(p.lines.filter((e) => e.kind === 'substitute').map((e) => e.id)).toEqual([
			'substitute:pool:x86_64-linux'
		]);
	});

	it('overlaps no node, runs behind no card, and clears the cache and its placeholder', () => {
		for (const w of [
			[...range('a', 4), ...range('x', 8)],
			[...range('a', 10), ...range('x', 20)],
			[...range('a', 17), ...range('x', 33)],
			[...range('a', 100), ...range('x', 200)],
			range('x', 3)
		]) {
			for (const choices of [undefined, CARDS]) {
				const l = layoutTopology(up(w), undefined, choices);
				expectNoOverlap(l);
				expectClearRoutes(l);
			}
		}
		// Without a cache the card sits below the placeholder.
		const l = layoutTopology(up(range('x', 3), 2, { hasCache: false }));
		const n = byId(l.nodes);
		const ph = n.get('empty:cache')!;
		expect(n.get(UPSTREAM_ID)!.y).toBeGreaterThan(ph.y + ph.h);
		expectNoOverlap(l);
	});

	it("without upstream builders the layout is today's", () => {
		for (const w of [
			[...range('a', 4), ...range('x', 8)],
			[...range('a', 10), ...range('x', 20)],
			range('x', 14)
		]) {
			const plain = layoutTopology(topo(w), undefined, CARDS);
			// Rows alone, as for a farm cache row without upstream builders, change nothing.
			expect(layoutTopology(topo(w, { upstreamRows: 1 }), undefined, CARDS)).toEqual(plain);
			expect(plain.nodes.some((n) => n.id === UPSTREAM_ID)).toBe(false);
			expect(byId(plain.nodes).get('lane:cache')!.ref).toBe('Cache');
		}
	});
});
