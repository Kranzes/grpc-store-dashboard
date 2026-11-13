// Fixed-lane layout of the farm's map, a pure function of Topology, the
// previous layout and the user's pool choices.
//
// Lanes, left to right: incoming builds from client groups, the scheduler,
// builders grouped by native system, the cache. A group shows as builder
// cards in columns of at most 10, or as one pool node with a cell per
// builder. Groups keep their order whichever way they show, so a toggle
// moves no other group's nodes in the tab order.
//
// The layout routes lines orthogonally: out of the source, along a
// horizontal "bus", down a vertical trunk in the gap next to the target
// column, into the target. The publish, assign and fetch buses run side by
// side. The assign bus has one track per group, so the map shows which
// group gets work. With several columns, or cards beside pools, the buses
// share one routing channel: the row gap after the middle row, widened to
// fit them, so lines never pass behind a builder and the cards stay in two
// solid blocks. Like a pool, the channel holds its place as builders come
// and go.
// Pools hang below all three buses with their handles near their top, so a
// pool that grows a row moves nothing else, not even a line.
//
// While builders list upstream substituters, a card for them sits under the
// cache, and a fourth bus, for their lines, runs below the fetch bus. A line
// from the card climbs to it in the gap left of the cache lane, the last
// block's trunk, so every substitute line bundles there.

import {
	CACHE_ID,
	SCHEDULER_ID,
	UPSTREAM_ID,
	clientGroupNodeId,
	hasUpstream,
	poolNodeId,
	poolOf,
	workerNodeId,
	type Topology
} from '#lib/model/types.ts';
import { lineId, type LineKind } from './kinds.ts';

export const MAX_ROWS = 10;

export const SIZE = {
	client: { w: 232, h: 76 },
	scheduler: { w: 280, h: 284 },
	builder: { w: 220, h: 88 },
	cache: { w: 260, h: 264 },
	/** Its height grows with its rows: upstreamHeight. */
	upstream: { w: 260 },
	empty: { w: 240, h: 112 },
	heading: { h: 24 }
} as const;

export const GAP = {
	clientRow: 12,
	builderRow: 20,
	column: 56,
	/** Inside a group while substitute lines show: room for their trunk. */
	columnUpstream: 68,
	/** Room for a builder's assignment label, "720 assigned/min", between two groups. */
	group: 120,
	lane: 140
} as const;

/**
 * A pool's cell grid. The column count is fixed, so a builder's cell never
 * moves as the pool grows or shrinks; the node grows a row at a time.
 */
export const POOL_GRID = {
	columns: 24,
	cell: 10,
	gap: 2,
	/** Node padding around the grid, per side. */
	pad: 12,
	/** Node border. */
	border: 1,
	/** From the node's top to the grid: the summary lines. Joins and leaves are in the panel. */
	head: 88,
	/** From the grid to the node's bottom: its padding and border. The map's legend explains the cells. */
	foot: 11
} as const;

/** From one cell's top left to the next one's, px. */
export const POOL_PITCH = POOL_GRID.cell + POOL_GRID.gap;
export const POOL_W =
	POOL_GRID.columns * POOL_PITCH - POOL_GRID.gap + 2 * (POOL_GRID.pad + POOL_GRID.border);

/** Cell i's top left within the pool grid, px. */
export function poolCellAt(i: number): { x: number; y: number } {
	return {
		x: (i % POOL_GRID.columns) * POOL_PITCH,
		y: Math.floor(i / POOL_GRID.columns) * POOL_PITCH
	};
}

/** Height of a pool node whose grid has `rows` rows. */
export function poolHeight(rows: number): number {
	return POOL_GRID.head + rows * POOL_PITCH - POOL_GRID.gap + POOL_GRID.foot;
}

/** Vertical offset of the publish and fetch handles from a builder's or pool's input. */
export const BUILDER_PORT_OFFSET = 7;
/** A pool's handles: input at this distance from its top, publish and fetch either side. */
export const POOL_PORT_Y = 34;

/** The upstream card's height for `rows` rows: 30 px a row. */
export function upstreamHeight(rows: number): number {
	return 118 + 30 * rows;
}

/** The upstream card's line handle, from its top. */
export const UPSTREAM_PORT_Y = 34;
/** From the upstream card's top to the cache's bottom above it. */
const UPSTREAM_GAP = 50;
/**
 * The substitute handle, below a builder's middle or a pool's input. The
 * line enters under the fetch label, which ends 32 px below the middle
 * (PILL.band + 17), so its own 17 px label, centered on it, starts 0.5 px
 * lower. On a builder card that label reaches 5.5 px past the card's bottom,
 * into the row gap.
 */
export const SUBSTITUTE_PORT_OFFSET = 41;

/**
 * From the assign bus, or its outer tracks, to the publish bus above it and
 * the fetch bus below it.
 */
export const BUS_SPACING = 12;
/** From one assignment track to the next, room for the widest line and its dots. */
export const TRACK_SPACING = 20;
/** From the scheduler's edge to where the assignment lines spread onto their tracks. */
const FAN = 32;
/**
 * From a card's edge to the outer bus beside it in the routing channel. The
 * widest line (7.5 px) then ends 12 px from the card. A plain row gap's 10 px
 * (6.25 px to that line's edge) read as glued to the cards with four busy
 * buses side by side.
 */
export const CHANNEL_CLEARANCE = 16;
/**
 * Height of the routing channel, the row gap the buses share, with one
 * assignment track: the clearance outside the publish and fetch buses and
 * the two bus spacings between them, 56 px. Each further track adds a track
 * spacing, and a fourth bus, for substitutions, one more bus spacing below.
 */
export const CHANNEL = 2 * CHANNEL_CLEARANCE + 2 * BUS_SPACING;

const PITCH = SIZE.builder.h + GAP.builderRow;
const GROUP_HEADING_Y = -36;
/** Space between the lowest bus and the pools' headings. */
const POOL_CLEARANCE = 20;

export type LayoutNodeKind =
	| 'clients'
	| 'scheduler'
	| 'builder'
	| 'pool'
	| 'cache'
	| 'upstream'
	| 'lane'
	/** Heading of one native system's builders. Not 'group': Svelte Flow styles that type. */
	| 'system'
	| 'empty-clients'
	| 'empty-builders'
	| 'empty-cache';

export type LayoutNode = Readonly<{
	id: string;
	kind: LayoutNodeKind;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Worker addr, client group id or system for live nodes, heading text for lanes. */
	ref: string;
	/** Group headings and pools: number of builders in the group. */
	count?: number;
	/** Pools: builder address per cell, null for a free cell. */
	cells?: readonly (string | null)[];
	/** Pools: rows of the cell grid. */
	rows?: number;
	/** Cache only: y offsets of its left handles from its top. */
	ports?: Readonly<{ publish: number; fetch: number }>;
}>;

/**
 * How a line is drawn between its two handles.
 * trunk: horizontal from the source to x, vertical to the target's y, horizontal in.
 * over: up from the source to y, across, down into the target.
 * jog: horizontal from the source to via, vertical to y, horizontal to x,
 *   vertical to the target's y, horizontal in.
 */
export type LineRoute = Readonly<
	| { kind: 'trunk'; x: number }
	| { kind: 'over'; y: number }
	| { kind: 'jog'; via: number; y: number; x: number }
>;

export type LayoutLine = Readonly<{
	id: string;
	kind: LineKind;
	source: string;
	target: string;
	sourceHandle: string;
	targetHandle: string;
	route: LineRoute;
}>;

/** Builder slots per native system. Pass back in for stable positions. */
export type BuilderGroup = Readonly<{ system: string; slots: readonly (string | null)[] }>;

/** The user's choice per system: true shows a pool, false the builder cards. */
export type PoolChoices = ReadonlyMap<string, boolean>;

export type Layout = Readonly<{
	nodes: readonly LayoutNode[];
	lines: readonly LayoutLine[];
	groups: readonly BuilderGroup[];
	/** Systems drawn as pools, with the rows of their grids. */
	pools: ReadonlyMap<string, number>;
	/** Card rows above the routing channel, or null without one. */
	channel: number | null;
}>;

/**
 * What the next layout needs from the last one: slots, which groups were
 * pools, and where the channel was.
 */
export type LayoutState = Pick<Layout, 'groups' | 'pools'> & Partial<Pick<Layout, 'channel'>>;

/**
 * Assign builders to slots, given each one's native system ('' when unknown).
 * A builder keeps its slot while it stays in the topology; a new builder
 * takes the first free slot of its system's group, or goes at the end. New
 * systems go after the existing groups.
 */
export function assignSlots(
	workers: readonly string[],
	systems: readonly string[],
	previous: readonly BuilderGroup[] = []
): BuilderGroup[] {
	const systemOf = new Map(workers.map((addr, i) => [addr, poolOf(systems[i])]));
	const placed = new Set<string>();
	const groups = previous.map((g) => ({
		system: g.system,
		slots: g.slots.map((addr) => {
			if (addr === null || placed.has(addr) || systemOf.get(addr) !== g.system) return null;
			placed.add(addr);
			return addr;
		})
	}));
	for (const [addr, system] of systemOf) {
		if (placed.has(addr)) continue;
		placed.add(addr);
		let group = groups.find((g) => g.system === system);
		if (!group) {
			group = { system, slots: [] };
			groups.push(group);
		}
		const hole = group.slots.indexOf(null);
		if (hole >= 0) group.slots[hole] = addr;
		else group.slots.push(addr);
	}
	for (const g of groups) {
		while (g.slots.length > 0 && g.slots[g.slots.length - 1] === null) g.slots.pop();
	}
	return groups.filter((g) => g.slots.length > 0);
}

/**
 * Whether a group shows as a pool. The user's choice wins. Without one, a
 * group with more than 10 builders taking work becomes a pool and then stays
 * one while it exists, so builders coming and going change only the pool's
 * cells.
 */
export function showsAsPool(active: number, choice: boolean | undefined, wasPool: boolean) {
	return choice ?? (wasPool || active > MAX_ROWS);
}

/**
 * Rows of a pool's grid for `cells` cells. A grid grows as soon as it is
 * full, and shrinks only once less than half of it would do, so a pool near
 * a row boundary does not change size with every builder.
 */
export function poolRows(cells: number, previous?: number): number {
	const need = Math.max(1, Math.ceil(cells / POOL_GRID.columns));
	if (previous === undefined || need > previous || need * 2 < previous) return need;
	return previous;
}

/**
 * Card rows above the routing channel when the tallest column has `rows`
 * rows: half of them, with an odd row below. The split then holds while it
 * is within a row of half, so a builder coming and going does not move a
 * row of cards across the channel.
 */
export function channelSplit(rows: number, previous?: number | null): number {
	const half = Math.max(1, Math.floor(rows / 2));
	if (previous == null || previous > rows || Math.abs(previous - half) > 1) return half;
	return previous;
}

/** A group heading's node id. */
export const systemHeadingId = (system: string) => `system:${system}`;

/**
 * @param active Builders taking work per system, for the more-than-10 rule.
 *   Without it, every builder that is not retired counts.
 */
export function layoutTopology(
	topology: Topology,
	previous?: LayoutState,
	choices: PoolChoices = new Map(),
	active?: ReadonlyMap<string, number>
): Layout {
	const wasPool = previous?.pools ?? new Map<string, number>();
	const retired = new Set(topology.retired);
	const upstream = hasUpstream(topology);
	const upstreamSet = new Set(topology.upstreamWorkers);
	// A fourth trunk needs room between the columns of a group.
	const columnGap = upstream ? GAP.columnUpstream : GAP.column;
	const counts = new Map<string, number>();
	topology.workers.forEach((addr, i) => {
		if (retired.has(addr)) return;
		const system = poolOf(topology.workerSystems[i]);
		counts.set(system, (counts.get(system) ?? 0) + 1);
	});
	const isPool = (system: string) =>
		showsAsPool(
			active?.get(system) ?? counts.get(system) ?? 0,
			choices.get(system),
			wasPool.has(system)
		);
	// A retired builder left on purpose, so it gives up its cell in a pool at
	// once. As a card it shows as offline until it lingers out.
	const workers: string[] = [];
	const systems: string[] = [];
	topology.workers.forEach((addr, i) => {
		if (retired.has(addr) && isPool(poolOf(topology.workerSystems[i]))) return;
		workers.push(addr);
		systems.push(topology.workerSystems[i]);
	});
	const groups = assignSlots(workers, systems, previous?.groups);
	const pools = new Map<string, number>();
	const nodes: LayoutNode[] = [];
	const lines: LayoutLine[] = [];

	type Column = { x: number; slots: (string | null)[] };
	/** One system's builders: a pool when `rows` is set, else card columns. */
	type Block = {
		system: string;
		slots: readonly (string | null)[];
		count: number;
		rows?: number;
		x: number;
		w: number;
		columns: Column[];
	};
	const blocks: Block[] = [];
	for (const g of groups) {
		const count = g.slots.filter((s) => s !== null).length;
		const b: Block = { system: g.system, slots: g.slots, count, x: 0, w: 0, columns: [] };
		if (isPool(g.system)) {
			b.rows = poolRows(g.slots.length, wasPool.get(g.system));
			pools.set(g.system, b.rows);
		}
		blocks.push(b);
	}
	// A pool whose builders all retired has nothing to draw, but it is still
	// a pool, so its retired builders do not come back as offline cards.
	topology.workers.forEach((addr, i) => {
		const system = poolOf(topology.workerSystems[i]);
		if (retired.has(addr) && !pools.has(system) && isPool(system))
			pools.set(system, wasPool.get(system) ?? 1);
	});

	const xClients = 0;
	const xScheduler = xClients + SIZE.client.w + GAP.lane;
	const xBuilders = xScheduler + SIZE.scheduler.w + GAP.lane;
	let x = xBuilders;
	// Card columns hold 10 rows each and fill column by column, so a builder
	// keeps its column when others join or leave its group. A pool is one
	// column of its own.
	const columns: Column[] = [];
	for (const b of blocks) {
		if (x > xBuilders) x += GAP.group;
		b.x = x;
		if (b.rows !== undefined) {
			x += POOL_W;
		} else {
			for (let c = 0; c * MAX_ROWS < b.slots.length; c++) {
				if (c > 0) x += columnGap;
				const col = { x, slots: b.slots.slice(c * MAX_ROWS, (c + 1) * MAX_ROWS) };
				b.columns.push(col);
				columns.push(col);
				x += SIZE.builder.w;
			}
		}
		b.w = x - b.x;
	}
	const hasPools = pools.size > 0;
	const hasBuilders = groups.length > 0;
	/** From the top assignment track to the bottom one. */
	const spread = Math.max(0, blocks.length - 1) * TRACK_SPACING;
	// A fourth bus needs room in the channel too, below the fetch bus.
	const channelH = CHANNEL + spread + (upstream ? BUS_SPACING : 0);
	const buildersRight = hasBuilders ? x : xBuilders + SIZE.empty.w;
	const xCache = buildersRight + GAP.lane;

	// Bus heights. One column of cards: the buses fan out from its middle.
	// Several columns, or cards and pools: the buses run through a channel
	// after the middle row of the tallest column, which every column shares,
	// so they go straight across. An odd row goes below, and a single row
	// has the channel under it. The channel stays while there are cards, and
	// channelSplit holds its split within a row of half, so a builder coming
	// and going moves no other card. Without cards the buses sit just above
	// the pools, and without builders they line up with the placeholder.
	const rows = Math.max(1, ...columns.map((c) => c.slots.length));
	const channel =
		columns.length > 0 && (columns.length > 1 || hasPools || (previous?.channel ?? null) !== null);
	/** Card rows above the channel; the rows after it move down to make room. */
	const above = channel ? channelSplit(rows, previous?.channel) : rows;
	const rowY = (row: number) => row * PITCH + (row >= above ? channelH - GAP.builderRow : 0);
	// busAssign is the scheduler's out handle, in the middle of the tracks.
	let busAssign = 0;
	if (channel) busAssign = above * PITCH - GAP.builderRow + CHANNEL / 2 + spread / 2;
	else if (columns.length > 0) busAssign = (rows * PITCH - GAP.builderRow) / 2;
	else if (!hasBuilders) busAssign = SIZE.empty.h / 2;
	const busPublish = busAssign - spread / 2 - BUS_SPACING;
	const busFetch = busAssign + spread / 2 + BUS_SPACING;
	const busSubst = busFetch + BUS_SPACING;
	// A group's trunk crosses every later group's track on the side it
	// leaves: up to cards above the channel, down to cards below it or to a
	// pool. So, from the last group back, a group whose trunk only leaves
	// down goes under the later tracks and any other over them. Only a group
	// with cards on both sides of the channel then crosses a track.
	const order: Block[] = [];
	for (const b of [...blocks].reverse()) {
		const up = b.columns.some((c) => c.slots.some((a, row) => a !== null && row < above));
		if (up) order.unshift(b);
		else order.push(b);
	}
	const track = new Map(order.map((b, i) => [b, busAssign - spread / 2 + i * TRACK_SPACING]));
	const poolTop = (upstream ? busSubst : busFetch) + POOL_CLEARANCE - GROUP_HEADING_Y;

	// Client groups, centered on the scheduler's input.
	const groupsShown = topology.clientGroups;
	if (groupsShown.length > 0) {
		const total = groupsShown.length * SIZE.client.h + (groupsShown.length - 1) * GAP.clientRow;
		let y = busAssign - total / 2;
		for (const g of groupsShown) {
			const id = clientGroupNodeId(g);
			nodes.push({ id, kind: 'clients', x: xClients, y, ...wh(SIZE.client), ref: g });
			lines.push({
				id: lineId('request', g),
				kind: 'request',
				source: id,
				target: SCHEDULER_ID,
				sourceHandle: 'out',
				targetHandle: 'in',
				route: { kind: 'trunk', x: xClients + SIZE.client.w + GAP.lane / 2 }
			});
			y += SIZE.client.h + GAP.clientRow;
		}
	} else {
		nodes.push({
			id: 'empty:clients',
			kind: 'empty-clients',
			x: xClients,
			y: busAssign - SIZE.empty.h / 2,
			w: SIZE.client.w,
			h: SIZE.empty.h,
			ref: ''
		});
	}

	const schedulerY = busAssign - SIZE.scheduler.h / 2;
	nodes.push({
		id: SCHEDULER_ID,
		kind: 'scheduler',
		x: xScheduler,
		y: schedulerY,
		...wh(SIZE.scheduler),
		ref: ''
	});

	const laneGapRight = buildersRight + GAP.lane / 2;
	const firstTrunk = xScheduler + SIZE.scheduler.w + GAP.lane / 2;
	const fan = xScheduler + SIZE.scheduler.w + FAN;
	/** Where the substitute lines run up out of the card, and the last block's trunk. */
	const substTrunk = laneGapRight + 24;
	/** Edges of a builder or pool node of block b whose column starts at colX. */
	const builderLines = (b: Block, id: string, endpoint: string, colX: number, w: number) => {
		const first = colX === xBuilders;
		const last = colX + w === buildersRight;
		// With several tracks, the first group's trunk sits by its cards too,
		// so its track runs alongside the others out of the scheduler.
		const trunk = first && blocks.length === 1 ? firstTrunk : colX - 18;
		lines.push({
			id: lineId('assign', endpoint),
			kind: 'assign',
			source: SCHEDULER_ID,
			target: id,
			sourceHandle: 'out',
			targetHandle: 'in',
			route:
				blocks.length > 1
					? { kind: 'jog', via: fan, y: track.get(b)!, x: trunk }
					: { kind: 'trunk', x: trunk }
		});
		if (!topology.hasCache) return;
		lines.push({
			id: lineId('publish', endpoint),
			kind: 'publish',
			source: id,
			target: CACHE_ID,
			sourceHandle: 'publish',
			targetHandle: 'publish',
			route: { kind: 'trunk', x: last ? laneGapRight - 8 : colX + w + 14 }
		});
		lines.push({
			id: lineId('fetch', endpoint),
			kind: 'fetch',
			source: CACHE_ID,
			target: id,
			sourceHandle: 'fetch',
			targetHandle: 'fetch',
			route: { kind: 'trunk', x: last ? laneGapRight + 8 : colX + w + 26 }
		});
	};
	/**
	 * A substitute line, for a builder that lists an upstream substituter or a
	 * pool with one. After fetch, so it wins ties in the hit test.
	 */
	const substituteLine = (id: string, endpoint: string, colX: number, w: number) => {
		const last = colX + w === buildersRight;
		lines.push({
			id: lineId('substitute', endpoint),
			kind: 'substitute',
			source: UPSTREAM_ID,
			target: id,
			sourceHandle: 'out',
			targetHandle: 'substitute',
			// The last block's trunk is where every line climbs from the card.
			route: last
				? { kind: 'trunk', x: substTrunk }
				: { kind: 'jog', via: substTrunk, y: busSubst, x: colX + w + 38 }
		});
	};

	// Each group's heading comes before its nodes, so the toggle is the
	// first tab stop of its group.
	for (const b of blocks) {
		const pool = b.rows !== undefined;
		nodes.push({
			id: systemHeadingId(b.system),
			kind: 'system',
			x: b.x,
			y: (pool ? poolTop : 0) + GROUP_HEADING_Y,
			w: b.w,
			h: SIZE.heading.h,
			ref: b.system,
			count: b.count
		});
		if (pool) {
			const id = poolNodeId(b.system);
			nodes.push({
				id,
				kind: 'pool',
				x: b.x,
				y: poolTop,
				w: POOL_W,
				h: poolHeight(b.rows!),
				ref: b.system,
				count: b.count,
				cells: b.slots,
				rows: b.rows
			});
			builderLines(b, id, id, b.x, POOL_W);
			if (b.slots.some((a) => a !== null && upstreamSet.has(a)))
				substituteLine(id, id, b.x, POOL_W);
			continue;
		}
		for (const col of b.columns) {
			for (const [row, addr] of col.slots.entries()) {
				if (addr === null) continue;
				const id = workerNodeId(addr);
				nodes.push({
					id,
					kind: 'builder',
					x: col.x,
					y: rowY(row),
					...wh(SIZE.builder),
					ref: addr
				});
				builderLines(b, id, addr, col.x, SIZE.builder.w);
				if (upstreamSet.has(addr)) substituteLine(id, addr, col.x, SIZE.builder.w);
			}
		}
	}
	if (!hasBuilders) {
		nodes.push({
			id: 'empty:builders',
			kind: 'empty-builders',
			x: xBuilders,
			y: busAssign - SIZE.empty.h / 2,
			...wh(SIZE.empty),
			ref: ''
		});
	}

	const cacheY = (busPublish + busFetch) / 2 - SIZE.cache.h / 2;
	if (topology.hasCache) {
		nodes.push({
			id: CACHE_ID,
			kind: 'cache',
			x: xCache,
			y: cacheY,
			...wh(SIZE.cache),
			ref: '',
			ports: { publish: busPublish - cacheY, fetch: busFetch - cacheY }
		});
	} else {
		nodes.push({
			id: 'empty:cache',
			kind: 'empty-cache',
			x: xCache,
			y: busAssign - SIZE.empty.h / 2,
			...wh(SIZE.empty),
			ref: ''
		});
	}
	// Under the cache, or under its placeholder, which it clears. Right after
	// it, so its tab stop follows the cache's.
	if (upstream) {
		nodes.push({
			id: UPSTREAM_ID,
			kind: 'upstream',
			x: xCache,
			y: cacheY + SIZE.cache.h + UPSTREAM_GAP,
			w: SIZE.upstream.w,
			h: upstreamHeight(topology.upstreamRows),
			ref: ''
		});
	}

	// The cache hits line goes over the builder lane: no builder takes part.
	// It clears the scheduler, the builder lane and the cache, not the client
	// cards, which can stand far taller next to pools. It comes first, so it
	// draws under every other line and loses ties when a click picks the line
	// on top.
	const isClient = (n: LayoutNode) => n.kind === 'clients' || n.kind === 'empty-clients';
	const overY = Math.min(...nodes.filter((n) => !isClient(n)).map((n) => n.y)) - 28;
	if (topology.hasCache) {
		lines.unshift({
			id: lineId('hit', SCHEDULER_ID),
			kind: 'hit',
			source: SCHEDULER_ID,
			target: CACHE_ID,
			sourceHandle: 'top',
			targetHandle: 'top',
			route: { kind: 'over', y: overY }
		});
	}

	// Lane headings clear everything, the client cards included.
	const clientTop = Math.min(...nodes.filter(isClient).map((n) => n.y));
	const headingY = Math.min(overY, clientTop - 28) - 20 - SIZE.heading.h;
	const lanes: [string, string, number, number][] = [
		['lane:clients', 'Clients', xClients, SIZE.client.w],
		['lane:scheduler', 'Scheduler', xScheduler, SIZE.scheduler.w],
		['lane:builders', 'Builders', xBuilders, buildersRight - xBuilders],
		[
			'lane:cache',
			upstream ? 'Caches' : 'Cache',
			xCache,
			Math.max(topology.hasCache ? SIZE.cache.w : SIZE.empty.w, upstream ? SIZE.upstream.w : 0)
		]
	];
	for (const [id, label, lx, lw] of lanes) {
		nodes.push({ id, kind: 'lane', x: lx, y: headingY, w: lw, h: SIZE.heading.h, ref: label });
	}

	return { nodes, lines, groups, pools, channel: channel ? above : null };
}

function wh(s: { w: number; h: number }) {
	return { w: s.w, h: s.h };
}
