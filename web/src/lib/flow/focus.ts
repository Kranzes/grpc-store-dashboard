// Focus on the map: which nodes and lines stay bright while the user
// looks at one node, line or bundle, and how that reaches the DOM without
// re-rendering any node or line. Every drawn node and line carries a short
// class token; one adopted stylesheet lists the bright tokens, and focus.css
// fades the rest.

import {
	OTHER_CLIENTS,
	clientGroupNodeId,
	parseNodeId,
	poolNodeId,
	workerNodeId
} from '#lib/model/types.ts';
import { lineId, type LineKind } from './kinds.ts';
import type { Layout } from './layout.ts';
import { lineEnds } from './lines.ts';

export type Focus =
	| { kind: 'node'; nodeId: string }
	/** One id is a line, several of one kind a bundle. The ids need not be drawn. */
	| { kind: 'lines'; flow: LineKind; edgeIds: readonly string[] }
	| null;

/**
 * A short class token per id, `fx-<n>`. Ids cannot be classes themselves,
 * since client identities may contain spaces. The counter never goes back,
 * so an id that leaves and returns gets a new token, as its node or line
 * gets a new object anyway.
 */
export class Tokens {
	#ids = new Map<string, string>();
	#next = 0;

	/** The id's token, made on first use. */
	readonly token = (id: string): string => {
		let t = this.#ids.get(id);
		if (t === undefined) {
			t = `fx-${(this.#next++).toString(36)}`;
			this.#ids.set(id, t);
		}
		return t;
	};

	/**
	 * Forget every id not drawn now. Without this the map would keep every
	 * builder address an autoscaler ever used.
	 */
	retain(drawn: ReadonlySet<string>): void {
		for (const id of this.#ids.keys()) if (!drawn.has(id)) this.#ids.delete(id);
	}

	get size(): number {
		return this.#ids.size;
	}
}

/** What brightIds needs to know about a layout. Built once per layout. */
export type FocusIndex = Readonly<{
	/** Drawn lines and their ends. */
	lines: ReadonlyMap<string, Readonly<{ source: string; target: string }>>;
	/** Drawn lines at each node. */
	nodeLines: ReadonlyMap<string, readonly string[]>;
	/** Drawn node ids. */
	nodes: ReadonlySet<string>;
	/** Builders in the layout and their system, whether drawn as cards or in a pool. */
	systemOf: ReadonlyMap<string, string>;
	/** Builders per system. */
	members: ReadonlyMap<string, readonly string[]>;
}>;

export const EMPTY_INDEX: FocusIndex = {
	lines: new Map(),
	nodeLines: new Map(),
	nodes: new Set(),
	systemOf: new Map(),
	members: new Map()
};

export function focusIndex(layout: Layout): FocusIndex {
	const lines = new Map<string, { source: string; target: string }>();
	const nodeLines = new Map<string, string[]>();
	const at = (node: string, id: string) => {
		const list = nodeLines.get(node);
		if (list) list.push(id);
		else nodeLines.set(node, [id]);
	};
	for (const e of layout.lines) {
		lines.set(e.id, { source: e.source, target: e.target });
		at(e.source, e.id);
		at(e.target, e.id);
	}
	const systemOf = new Map<string, string>();
	const members = new Map<string, string[]>();
	for (const g of layout.groups) {
		const list: string[] = [];
		for (const addr of g.slots) {
			if (addr === null) continue;
			systemOf.set(addr, g.system);
			list.push(addr);
		}
		members.set(g.system, list);
	}
	return { lines, nodeLines, nodes: new Set(layout.nodes.map((n) => n.id)), systemOf, members };
}

/** Every id the layout draws, for Tokens.retain. */
export function drawnIds(index: FocusIndex): Set<string> {
	return new Set([...index.nodes, ...index.lines.keys()]);
}

/** The drawn nodes that stand for a node id: itself, its pool, or a pool's builders. */
function nodeCarriers(id: string, ix: FocusIndex): string[] {
	if (ix.nodes.has(id)) return [id];
	const ref = parseNodeId(id);
	switch (ref?.kind) {
		case 'builder': {
			const system = ix.systemOf.get(ref.addr);
			const pool = system === undefined ? null : poolNodeId(system);
			return pool && ix.nodes.has(pool) ? [pool] : [];
		}
		case 'pool':
			return (ix.members.get(ref.system) ?? []).map(workerNodeId).filter((n) => ix.nodes.has(n));
		case 'clients': {
			const other = clientGroupNodeId(OTHER_CLIENTS);
			return ref.group !== OTHER_CLIENTS && ix.nodes.has(other) ? [other] : [];
		}
		default:
			return [];
	}
}

/** The drawn lines that carry a line id: itself, its pool's line, or a pool's builders' lines. */
function lineCarriers(id: string, ix: FocusIndex): string[] {
	if (ix.lines.has(id)) return [id];
	const ends = lineEnds(id, (addr) => ix.systemOf.has(addr));
	if (!ends) return [];
	const { flow, endpoint } = ends;
	const drawn = (ids: string[]) => ids.filter((e) => ix.lines.has(e));
	switch (endpoint.kind) {
		case 'builder': {
			const system = ix.systemOf.get(endpoint.addr);
			return system === undefined ? [] : drawn([lineId(flow, poolNodeId(system))]);
		}
		case 'pool':
			return drawn((ix.members.get(endpoint.system) ?? []).map((a) => lineId(flow, a)));
		case 'clients':
			return endpoint.group === OTHER_CLIENTS ? [] : drawn([lineId('request', OTHER_CLIENTS)]);
		default:
			return [];
	}
}

/**
 * The drawn ids that stay bright. For a node: the node, its lines, and the
 * nodes at their other ends. For lines: the lines and the nodes at both
 * ends. Ids that are not drawn map to what carries them on the map; one
 * with no carrier, such as a builder that left, drops out. Empty when
 * nothing is focused or nothing remains, and then the map does not focus.
 */
export function brightIds(focus: Focus, ix: FocusIndex): Set<string> {
	const bright = new Set<string>();
	if (!focus) return bright;
	const line = (id: string) => {
		const e = ix.lines.get(id);
		if (!e) return;
		bright.add(id);
		bright.add(e.source);
		bright.add(e.target);
	};
	if (focus.kind === 'node') {
		for (const n of nodeCarriers(focus.nodeId, ix)) {
			bright.add(n);
			for (const id of ix.nodeLines.get(n) ?? []) line(id);
		}
	} else {
		for (const id of focus.edgeIds) for (const e of lineCarriers(id, ix)) line(e);
	}
	return bright;
}

/**
 * The bright rule: one selector per bright id, so the style match stays
 * linear however many there are. It has the specificity of the rules in
 * focus.css and wins by order, since adopted sheets follow document sheets.
 */
export function focusCss(bright: ReadonlySet<string>, token: (id: string) => string): string {
	if (bright.size === 0) return '';
	const selectors = [...bright].map((id) => `.farm-map.focusing .${token(id)}`).join(',\n');
	return `${selectors} {
	opacity: 1;
	visibility: visible;
	--fg: inherit;
	--warn-fg: inherit;
	--danger-fg: inherit;
	--accent-strong: inherit;
	--chrome: initial;
	--node-shadow: initial;
	--node-border: initial;
	--badge-bg: initial;
}
`;
}
