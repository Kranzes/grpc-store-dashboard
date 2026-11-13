// Shared with node components rendered inside Svelte Flow.

import { getContext, setContext } from 'svelte';
import type { FitViewOptions } from '@xyflow/svelte';
import type { FarmStore } from '#lib/model/types.ts';
import type { PoolToggles } from './pools.svelte.ts';

export type FlowContext = {
	readonly store: FarmStore;
	/** Node id of the open detail panel. */
	readonly selected: string | null;
	readonly pools: PoolToggles;
	/** Open a node's panel. `from`: the pool node a builder was picked from. */
	select(nodeId: string, from?: string): void;
};

const KEY = Symbol('flow');

export function setFlowContext(ctx: FlowContext) {
	setContext(KEY, ctx);
}

export function getFlowContext(): FlowContext {
	return getContext<FlowContext>(KEY);
}

/** Element id of the detail panel that node buttons open. */
export const PANEL_ID = 'detail-panel';

/**
 * The second click of a double click, or a later one. A second click on the
 * open view closes it, so a double click would open and close the panel at
 * once. Keyboard activation has detail 0.
 */
export const repeatClick = (e: MouseEvent) => e.detail > 1;

/** Attributes of a node's button, which opens and closes the node's panel. */
export function nodeButton(ctx: FlowContext, nodeId: string) {
	return {
		'data-node-button': nodeId,
		'aria-expanded': ctx.selected === nodeId,
		'aria-controls': PANEL_ID,
		onclick: (e: MouseEvent) => {
			if (!repeatClick(e)) ctx.select(nodeId);
		}
	};
}

/** Selector for a node's button, to give focus back when a panel closes. */
export function nodeButtonSelector(nodeId: string) {
	return `[data-node-button="${CSS.escape(nodeId)}"]`;
}

/** Selector for the pool toggle on a group's heading. */
export function poolToggleSelector(system: string) {
	return `[data-pool-toggle="${CSS.escape(system)}"]`;
}

/**
 * Zoom limits of the map. MIN_ZOOM is the floor for any farm, so a huge one
 * still fits; the map's own limit follows the layout, in limits.ts.
 */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 2;

/**
 * Room around the farm when it is fitted, px. Extra room at the bottom keeps
 * the legend and the zoom buttons off the lowest row of builders.
 */
export const FIT_PADDING = { top: 24, right: 56, bottom: 84, left: 24 } as const;

/** How "fit the whole farm" frames the map. */
export const FIT_VIEW: FitViewOptions = {
	padding: {
		top: `${FIT_PADDING.top}px`,
		right: `${FIT_PADDING.right}px`,
		bottom: `${FIT_PADDING.bottom}px`,
		left: `${FIT_PADDING.left}px`
	},
	minZoom: MIN_ZOOM,
	maxZoom: 1
};
