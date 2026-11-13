// What the shell, which is the header and the session, hands to the tab it
// shows. The layout sets it; the Overview and Logs pages read it.

import { getContext, setContext } from 'svelte';
import type { Farm, FarmSession, FarmStore } from '#lib/model/types.ts';
import type { OverviewState } from './overview.svelte.ts';
import type { Pause } from './pause.svelte.ts';

export type Shell = {
	readonly farmName: string;
	/** The farm that serves this page. null in the demo. */
	readonly farm: Farm | null;
	readonly session: FarmSession;
	readonly store: FarmStore;
	/** The store, held still while the user paused. */
	readonly shown: FarmStore;
	readonly pause: Pause;
	readonly overview: OverviewState;
	/** Load the page again, through the farm's sign-in when it asks for one. */
	onreload(): void;
	onreconnect(): void;
	ondemo(): void;
};

const KEY = Symbol('shell');

export function setShell(shell: Shell): void {
	setContext(KEY, shell);
}

export function getShell(): Shell {
	const s = getContext<Shell | undefined>(KEY);
	if (!s) throw new Error('getShell outside the shell');
	return s;
}
