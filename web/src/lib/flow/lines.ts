// What a line on the map connects and what to call it: the ends of a line
// id, the titles of lines and bundles, and the lines a node panel lists.
// Pure, so the map, the readout and the panels name lines the same way.

import {
	CACHE_ID,
	OTHER_CLIENTS,
	SCHEDULER_ID,
	UPSTREAM_ID,
	clientGroupNodeId,
	parseNodeId,
	poolNodeId,
	workerNodeId,
	type NodeRef
} from '#lib/model/types.ts';
import { lineId, parseLineId, type DrawnLine, type LineKind } from './kinds.ts';

export type { DrawnLine } from './kinds.ts';

/**
 * Whether an endpoint names a builder address. Endpoints of pool lines are
 * pool node ids (`pool:<system>`), so this settles a builder whose host is
 * named `pool`, as the reducer does: a known builder address wins.
 */
export type IsBuilder = (addr: string) => boolean;

/** What a line's endpoint is. */
export type LineEndpoint =
	| { kind: 'builder'; addr: string }
	| { kind: 'pool'; system: string }
	| { kind: 'clients'; group: string }
	| { kind: 'scheduler' };

export type LineEnds = Readonly<{
	flow: LineKind;
	endpoint: LineEndpoint;
	/** Node ids at both ends, in the direction the traffic goes. */
	source: string;
	target: string;
	/**
	 * The node at the line's own end: its builder, pool or client group.
	 * null for the cache hits line, whose two ends are both shared.
	 */
	own: string | null;
	/**
	 * The node the line shares with every other line of its kind: the
	 * scheduler, the cache or the upstream card.
	 */
	hub: string;
}>;

/** Which node an endpoint of an assign, publish, fetch or substitute line is. */
function builderEnd(endpoint: string, isBuilder: IsBuilder): LineEndpoint {
	if (!isBuilder(endpoint)) {
		const ref = parseNodeId(endpoint);
		if (ref?.kind === 'pool') return { kind: 'pool', system: ref.system };
	}
	return { kind: 'builder', addr: endpoint };
}

function endpointNode(e: LineEndpoint): string {
	switch (e.kind) {
		case 'builder':
			return workerNodeId(e.addr);
		case 'pool':
			return poolNodeId(e.system);
		case 'clients':
			return clientGroupNodeId(e.group);
		case 'scheduler':
			return SCHEDULER_ID;
	}
}

/** The nodes at the ends of a line, or null for an id of no known kind. */
export function lineEnds(id: string, isBuilder: IsBuilder): LineEnds | null {
	const parsed = parseLineId(id);
	if (!parsed) return null;
	const { kind: flow, endpoint } = parsed;
	if (flow === 'hit') {
		return {
			flow,
			endpoint: { kind: 'scheduler' },
			source: SCHEDULER_ID,
			target: CACHE_ID,
			own: null,
			hub: SCHEDULER_ID
		};
	}
	if (flow === 'request') {
		const e: LineEndpoint = { kind: 'clients', group: endpoint };
		const own = endpointNode(e);
		return { flow, endpoint: e, source: own, target: SCHEDULER_ID, own, hub: SCHEDULER_ID };
	}
	const e = builderEnd(endpoint, isBuilder);
	const own = endpointNode(e);
	if (flow === 'assign')
		return { flow, endpoint: e, source: SCHEDULER_ID, target: own, own, hub: SCHEDULER_ID };
	if (flow === 'publish')
		return { flow, endpoint: e, source: own, target: CACHE_ID, own, hub: CACHE_ID };
	if (flow === 'substitute')
		return { flow, endpoint: e, source: UPSTREAM_ID, target: own, own, hub: UPSTREAM_ID };
	return { flow, endpoint: e, source: CACHE_ID, target: own, own, hub: CACHE_ID };
}

/** A title in parts, so the address or identity part can use the mono face. */
export type TitlePart = Readonly<{ text: string; mono: boolean }>;
export type LineTitle = Readonly<{ text: string; parts: readonly TitlePart[] }>;

export type LineNames = Readonly<{
	isBuilder: IsBuilder;
	/** A client group's label, as its node shows it. Without one, the group id names it. */
	groupLabel?: (group: string) => string | undefined;
}>;

const KIND_NAME: Record<LineKind, string> = {
	request: 'Requests',
	assign: 'Assignments',
	hit: 'Cache hits',
	publish: 'Publishes',
	fetch: 'Fetches',
	substitute: 'Substitutions'
};

/** A line kind's name: "Assignments", "Fetches". The line panel's kicker. */
export function kindName(flow: LineKind): string {
	return KIND_NAME[flow];
}

/** A line kind as the legend and Lines rows label it: "Assignments", "Fetches (estimated)". */
export function kindLabel(flow: LineKind): string {
	return flow === 'fetch' ? `${kindName(flow)} (estimated)` : kindName(flow);
}

/** How a line of each kind relates to what it reaches. */
const BUNDLE_WORD: Record<LineKind, string> = {
	request: 'from',
	assign: 'to',
	hit: 'to',
	publish: 'from',
	fetch: 'to',
	substitute: 'to'
};

/** The cache hits line runs between two shared nodes, so it names both. */
const CACHE_HITS_ENDS = 'scheduler to cache';

function groupName(group: string, names: LineNames): TitlePart {
	if (group === OTHER_CLIENTS) return { text: 'other clients', mono: false };
	return { text: names.groupLabel?.(group) ?? (group || 'unknown client'), mono: true };
}

/** The varying end of a line. `the`: "the x86_64-linux pool" in a sentence. */
function endName(e: LineEndpoint, names: LineNames, the: boolean): TitlePart[] {
	switch (e.kind) {
		case 'builder':
			return [{ text: e.addr, mono: true }];
		case 'pool':
			return [
				{ text: the ? 'the ' : '', mono: false },
				{ text: e.system, mono: true },
				{ text: ' pool', mono: false }
			];
		case 'clients':
			return [groupName(e.group, names)];
		case 'scheduler':
			return [{ text: 'scheduler', mono: false }];
	}
}

function title(parts: TitlePart[]): LineTitle {
	// Merge neighbours of one face, so callers render as few spans as possible.
	const merged: TitlePart[] = [];
	for (const p of parts) {
		if (!p.text) continue;
		const last = merged[merged.length - 1];
		if (last && last.mono === p.mono)
			merged[merged.length - 1] = { ...last, text: last.text + p.text };
		else merged.push(p);
	}
	return { text: merged.map((p) => p.text).join(''), parts: merged };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const plain = (text: string): TitlePart => ({ text, mono: false });
const capital = (p: TitlePart): TitlePart =>
	p.mono ? p : { ...p, text: p.text.charAt(0).toUpperCase() + p.text.slice(1) };

/** The lines of `flow` among `ids`, and what a bundle of them reaches: "6 builders". */
function linesOf(flow: LineKind, ids: readonly string[], names: LineNames) {
	const ends: LineEnds[] = [];
	for (const id of ids) {
		const e = lineEnds(id, names.isBuilder);
		if (e && e.flow === flow) ends.push(e);
	}
	if (flow === 'hit' || ends.length <= 1) return { one: ends[0] ?? null, what: '' };
	if (flow === 'request')
		return {
			one: null,
			what: counted(ends.length, 'client group', 'client groups')
		};
	const pools = ends.filter((e) => e.endpoint.kind === 'pool').length;
	const builders = ends.length - pools;
	const what = [
		builders > 0 ? counted(builders, 'builder', 'builders') : '',
		pools > 0 ? counted(pools, 'pool', 'pools') : ''
	]
		.filter(Boolean)
		.join(' and ');
	return { one: null, what };
}

/**
 * A line or a bundle in one phrase, for screen readers, the hover readout
 * and Back buttons: "Assignments to 10.0.0.13:50051", "Fetches to the
 * x86_64-linux pool", "Requests from ci-runner-3", "Cache hits, scheduler
 * to cache", "Assignments to 14 builders and 1 pool". It leaves out ids of
 * another kind than `flow`. A bundle counts the lines it holds, so a pool
 * counts as one pool, not as its builders.
 */
export function lineTitle(flow: LineKind, ids: readonly string[], names: LineNames): LineTitle {
	const kind = KIND_NAME[flow];
	const { one, what } = linesOf(flow, ids, names);
	if (flow === 'hit' || (!one && !what)) return title([plain(`${kind}, ${CACHE_HITS_ENDS}`)]);
	if (one)
		return title([plain(`${kind} ${BUNDLE_WORD[flow]} `), ...endName(one.endpoint, names, true)]);
	return title([plain(`${kind} ${BUNDLE_WORD[flow]} ${what}`)]);
}

/**
 * The line panel's heading under its kicker (kindName): only the end that
 * varies. "10.0.0.13:50051", "x86_64-linux pool", "ci-runner-3", "6 builders",
 * and "Scheduler to cache" for the cache hits line.
 */
export function lineHeading(flow: LineKind, ids: readonly string[], names: LineNames): LineTitle {
	const { one, what } = linesOf(flow, ids, names);
	if (flow === 'hit' || (!one && !what)) return title([capital(plain(CACHE_HITS_ENDS))]);
	if (one) {
		const [first, ...rest] = endName(one.endpoint, names, false).filter((p) => p.text);
		return title([capital(first), ...rest]);
	}
	return title([plain(what)]);
}

/** One row of a node panel's Lines section: a line or a bundle of one kind. */
export type NodeLine = Readonly<{
	flow: LineKind;
	/** One id for a line, several for a bundle. */
	edgeIds: readonly string[];
	/** The row's text: the bare kind, "Assignments", "Fetches (estimated)". */
	label: string;
	/** The full phrase from the node's point of view, for screen readers: "Assignments from the scheduler". */
	name: string;
}>;

const ofKind = (drawn: readonly DrawnLine[], kind: LineKind) =>
	drawn.filter((l) => l.kind === kind).map((l) => l.id);

/**
 * The Lines rows of a node's panel. A builder or a client group lists its
 * own lines, drawn or not: a builder inside a collapsed pool and a group
 * folded into "other clients" keep their ids, and the panels say which line
 * carries them on the map. The scheduler, the cache and the upstream card
 * list bundles of every drawn line of a kind, and leave out a kind with no
 * drawn line. `hasLine` says whether the store has a line, which only
 * builders and pools with upstream substituters have of the substitute kind.
 */
export function nodeLines(
	ref: NodeRef,
	drawn: readonly DrawnLine[],
	hasCache: boolean,
	hasLine: (id: string) => boolean = () => false
): NodeLine[] {
	const rows: NodeLine[] = [];
	// Each node has at most one row per kind, so the row names only the kind.
	const row = (flow: LineKind, edgeIds: readonly string[], name: string): NodeLine => ({
		flow,
		edgeIds,
		label: kindLabel(flow),
		name
	});
	const bundle = (flow: LineKind, name: string) => {
		const ids = ofKind(drawn, flow);
		if (ids.length > 0) rows.push(row(flow, ids, name));
	};
	switch (ref.kind) {
		case 'builder':
		case 'pool': {
			const endpoint = ref.kind === 'builder' ? ref.addr : poolNodeId(ref.system);
			rows.push(row('assign', [lineId('assign', endpoint)], 'Assignments from the scheduler'));
			if (hasCache) {
				rows.push(
					row('publish', [lineId('publish', endpoint)], 'Publishes to the cache'),
					row('fetch', [lineId('fetch', endpoint)], 'Fetches from the cache (estimated)')
				);
			}
			const subst = lineId('substitute', endpoint);
			if (hasLine(subst)) rows.push(row('substitute', [subst], 'Substitutions from substituters'));
			break;
		}
		case 'clients':
			rows.push(row('request', [lineId('request', ref.group)], 'Requests to the scheduler'));
			break;
		case 'scheduler':
			bundle('request', 'Requests from clients');
			bundle('assign', 'Assignments to builders');
			bundle('hit', 'Cache hits');
			break;
		case 'cache':
			bundle('publish', 'Publishes from builders');
			bundle('fetch', 'Fetches to builders (estimated)');
			bundle('hit', 'Cache hits');
			break;
		case 'upstream':
			bundle('substitute', 'Substitutions to builders');
			break;
	}
	return rows;
}
