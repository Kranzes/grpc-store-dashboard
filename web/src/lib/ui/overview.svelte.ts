// What the Overview keeps while the Logs tab shows. The map unmounts there,
// and this brings it back as the user left it. One per session, in memory
// only.

import type { Viewport } from '@xyflow/svelte';
import { PoolToggles } from '#lib/flow/pools.svelte.ts';
import type { FarmSession } from '#lib/model/types.ts';
import type { PanelStack } from './stack.ts';

export class OverviewState {
	/** The panel's views, bottom first. Empty while the panel is closed. */
	stack = $state.raw<PanelStack>([]);
	/** Back in a pool from this builder, whose row gets focus. */
	returnTo = $state<string | null>(null);
	/** Which groups show as pools, for the map and the pool panel. */
	readonly pools = new PoolToggles();
	/** Rates on lines. */
	showRates = $state(false);
	/** The user moved the view, so it stopped refitting. */
	userMoved = $state(false);
	/** The view when the user last moved it. Restored only while userMoved. */
	viewport: Viewport | null = null;
}

const states = new WeakMap<FarmSession, OverviewState>();

/** The Overview state of a session, made on first use. */
export function overviewOf(session: FarmSession): OverviewState {
	let s = states.get(session);
	if (!s) states.set(session, (s = new OverviewState()));
	return s;
}
