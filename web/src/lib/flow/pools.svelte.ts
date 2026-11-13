// The user's pool settings for this session, shared by the map's headings
// and the pool panel: which groups show as pools, and each pool list's
// search, sort, filter and scroll position. In memory only, since the
// dashboard keeps nothing across visits.

import { emptyMap } from '#lib/model/reconcile.ts';
import type { PoolFilter, PoolSort } from '#lib/ui/panels/pool.ts';
import type { PoolChoices } from './layout.ts';

/** A pool list as the user left it, so a way back from a builder finds it again. */
export type PoolListState = Readonly<{
	query: string;
	sort: PoolSort;
	filter: PoolFilter;
	scrollTop: number;
}>;

const FRESH_LIST: PoolListState = { query: '', sort: 'busiest', filter: 'all', scrollTop: 0 };

export class PoolToggles {
	#choices = $state.raw<PoolChoices>(emptyMap());
	#shown = $state.raw<ReadonlyMap<string, number>>(emptyMap());
	// Read once when a pool panel opens, so plain, not reactive.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	readonly #lists = new Map<string, PoolListState>();

	/** The user's choices, for layoutTopology. */
	get choices(): PoolChoices {
		return this.#choices;
	}

	/** Whether the system's builders show as a pool in the current layout. */
	collapsed(system: string): boolean {
		return this.#shown.has(system);
	}

	/** The map reports the pools of each new layout here. */
	shown(pools: ReadonlyMap<string, number>): void {
		this.#shown = pools;
	}

	/** Show the system's builders as a pool when true, or as cards when false, from now on. */
	set(system: string, collapsed: boolean): void {
		// Replaced, never mutated once published, so a plain map is right.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Map(this.#choices);
		next.set(system, collapsed);
		this.#choices = next;
	}

	/** Systems the user chose to show as cards. */
	expanded(): string[] {
		return [...this.#choices].filter(([, c]) => !c).map(([s]) => s);
	}

	list(system: string): PoolListState {
		return this.#lists.get(system) ?? FRESH_LIST;
	}

	saveList(system: string, state: PoolListState): void {
		this.#lists.set(system, state);
	}
}
