// The detail panel as a stack of views. The bottom view opened the panel and
// the top one shows. Back and Escape pop one view; closing empties the stack.
// Pure functions, so tests can check the navigation rules without a page.

import type { Focus } from '#lib/flow/focus.ts';
import { CACHE_ID, SCHEDULER_ID } from '#lib/model/types.ts';
import type { LineKind } from '#lib/flow/kinds.ts';

export type PanelView =
	| { kind: 'node'; nodeId: string }
	/** One id is a line, several of one kind a bundle. The ids need not be drawn. */
	| { kind: 'lines'; flow: LineKind; edgeIds: readonly string[] }
	/** `via`: the line the derivation was picked from, for FarmStore.drv. */
	| { kind: 'derivation'; drvPath: string; via?: string };

export type PanelStack = readonly PanelView[];

/**
 * What the map brightens: the topmost view that is not a derivation, or
 * null with no panel. It is the map's Focus (flow/focus.ts).
 */
export type ViewFocus = Focus;

/** The node ids at the two ends of a line, source first. */
export type EndsOf = (edgeId: string) => readonly [string, string];

/** Index of the topmost view that is not a derivation, or -1. */
export function focusIndex(stack: PanelStack): number {
	for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind !== 'derivation') return i;
	return -1;
}

export function focusOf(stack: PanelStack): ViewFocus {
	const v = stack[focusIndex(stack)];
	return v && v.kind !== 'derivation' ? v : null;
}

/** The node whose button reads as expanded and whose pool cell is ringed. */
export function selectedOf(focus: ViewFocus): string | null {
	return focus?.kind === 'node' ? focus.nodeId : null;
}

/** Same view: same node, the same set of lines, or the same derivation from the same line. */
export function sameView(a: PanelView, b: PanelView): boolean {
	if (a.kind === 'node' && b.kind === 'node') return a.nodeId === b.nodeId;
	if (a.kind === 'derivation' && b.kind === 'derivation')
		return a.drvPath === b.drvPath && a.via === b.via;
	if (a.kind === 'lines' && b.kind === 'lines') {
		if (a.flow !== b.flow || a.edgeIds.length !== b.edgeIds.length) return false;
		const ids = new Set(a.edgeIds);
		return b.edgeIds.every((id) => ids.has(id));
	}
	return false;
}

/** Clicking the view in focus again: close, or step back to it from a derivation over it. */
function again(stack: PanelStack, at: number): PanelStack {
	return at === stack.length - 1 ? [] : stack.slice(0, at + 1);
}

/**
 * A click on a node, or on a builder in a pool (`pool`: the pool's node id).
 * A builder picked from a pool opens over the pool, so Back returns to it.
 */
export function openNode(stack: PanelStack, nodeId: string, pool?: string): PanelStack {
	const at = focusIndex(stack);
	const f = stack[at];
	const view: PanelView = { kind: 'node', nodeId };
	if (f && sameView(f, view)) return again(stack, at);
	if (pool === undefined) return [view];
	if (f?.kind === 'node' && f.nodeId === pool) return [...stack.slice(0, at + 1), view];
	return [{ kind: 'node', nodeId: pool }, view];
}

/**
 * A click on a line or a bundle on the map. It opens over the node panel in
 * focus when that node is at an end of every clicked line, so Escape goes back
 * there, and otherwise starts a new stack.
 */
export function openLinesOnMap(
	stack: PanelStack,
	flow: LineKind,
	edgeIds: readonly string[],
	ends: EndsOf
): PanelStack {
	const at = focusIndex(stack);
	const f = stack[at];
	const view: PanelView = { kind: 'lines', flow, edgeIds };
	if (f && sameView(f, view)) return again(stack, at);
	if (
		f?.kind === 'node' &&
		edgeIds.length > 0 &&
		edgeIds.every((id) => ends(id).includes(f.nodeId))
	)
		return [...stack.slice(0, at + 1), view];
	return [view];
}

/** A Lines row, a breakdown row or a list row: the new view opens over the current one. */
export function push(stack: PanelStack, view: PanelView): PanelStack {
	const top = stack.at(-1);
	return top && sameView(top, view) ? stack : [...stack, view];
}

/** One view back. */
export function back(stack: PanelStack): PanelStack {
	return stack.slice(0, -1);
}

const SHARED: ReadonlySet<string> = new Set([SCHEDULER_ID, CACHE_ID]);

/**
 * The node that focus returns to when the panel closes: the first view's
 * node. For one line, the node at its builder, pool or client end; for a
 * bundle, the node its lines share; for the cache hits line, the scheduler.
 */
export function openerOf(stack: PanelStack, ends: EndsOf): string | null {
	const first = stack[0];
	if (!first || first.kind === 'derivation') return null;
	if (first.kind === 'node') return first.nodeId;
	const [id, ...rest] = first.edgeIds;
	if (id === undefined) return null;
	const [s, t] = ends(id);
	if (rest.length === 0) return [s, t].find((n) => !SHARED.has(n)) ?? s;
	return [s, t].find((n) => rest.every((r) => ends(r).includes(n))) ?? null;
}

/** A key that changes whenever the top view does. */
export function viewKey(v: PanelView): string {
	switch (v.kind) {
		case 'node':
			return `node\0${v.nodeId}`;
		case 'lines':
			return `lines\0${v.flow}\0${v.edgeIds.join('\0')}`;
		case 'derivation':
			return `drv\0${v.drvPath}\0${v.via ?? ''}`;
	}
}
