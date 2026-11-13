// Turn layout output into Svelte Flow nodes, keeping the old object when
// nothing Svelte Flow draws has changed. Svelte Flow reuses kept objects, and
// their measured size, by identity, so nothing flickers. Lines are not Svelte
// Flow edges. LineCanvas.svelte draws them from the layout.
//
// Live nodes carry their focus token from focus.ts as a class. A token
// depends only on the id, so it never makes an object change.

import type { LayoutNode } from './layout.ts';
import type { FlowNode } from './types.ts';

/** The focus class token of an id. */
export type Token = (id: string) => string;

export function reuseNode(old: FlowNode | undefined, n: LayoutNode, token?: Token): FlowNode {
	if (
		old &&
		old.type === n.kind &&
		old.position.x === n.x &&
		old.position.y === n.y &&
		old.width === n.w &&
		old.height === n.h &&
		old.data.ref === n.ref &&
		old.data.count === n.count &&
		old.data.rows === n.rows &&
		sameCells(old.data.cells, n.cells) &&
		old.data.ports?.publish === n.ports?.publish &&
		old.data.ports?.fetch === n.ports?.fetch
	) {
		return old;
	}
	const data = {
		ref: n.ref,
		count: n.count,
		cells: n.cells,
		rows: n.rows,
		ports: n.ports
	};
	const live = n.kind !== 'lane' && n.kind !== 'system' && !n.kind.startsWith('empty');
	return {
		...old,
		id: n.id,
		type: n.kind,
		position: { x: n.x, y: n.y },
		data,
		width: n.w,
		height: n.h,
		// Headings sit under the live nodes and never catch clicks; a group
		// heading's toggle opts back in. Only live nodes fade with focus.
		zIndex: live ? 1 : 0,
		class: live ? (token ? `farm-live ${token(n.id)}` : 'farm-live') : 'passive'
	};
}

function sameCells(a?: readonly (string | null)[], b?: readonly (string | null)[]): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Next node list, reusing what it can. `changed` is false when every node was
 * kept. `moved` is true when a node came, went, moved or changed size, so the
 * picture changed shape; a pool's cells changing alone does not count.
 */
export function reuseNodes(
	old: readonly FlowNode[],
	next: readonly LayoutNode[],
	token?: Token
): { nodes: FlowNode[]; changed: boolean; moved: boolean } {
	const byId = new Map(old.map((n) => [n.id, n]));
	const nodes = next.map((n) => reuseNode(byId.get(n.id), n, token));
	const changed = nodes.length !== old.length || nodes.some((n, i) => n !== old[i]);
	const moved =
		changed &&
		(nodes.length !== old.length ||
			nodes.some((n, i) => {
				const o = old[i];
				return (
					n.id !== o.id ||
					n.position.x !== o.position.x ||
					n.position.y !== o.position.y ||
					n.width !== o.width ||
					n.height !== o.height
				);
			}));
	return { nodes, changed, moved };
}

/** `next`, or `old` when it holds the same ids, so what keys on identity sees no change. */
export function reuseSet(
	old: ReadonlySet<string> | null,
	next: ReadonlySet<string> | null
): ReadonlySet<string> | null {
	if (!old || !next || old.size !== next.size) return next;
	for (const id of next) if (!old.has(id)) return next;
	return old;
}
