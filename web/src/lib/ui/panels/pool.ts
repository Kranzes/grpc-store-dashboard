// The builder list of the pool panel: search, filter and sort.

import {
	builderState,
	compareNatural,
	loadOf,
	poolOf,
	type BuilderState,
	type Topology,
	type WorkerView
} from '#lib/model/types.ts';

export type PoolSort = 'busiest' | 'idle' | 'address';
export type PoolFilter = 'all' | 'draining' | 'offline';

/**
 * Addresses of the builders in a pool, in topology order. Retired builders
 * left on purpose, so the pool leaves them out.
 */
export function poolMembers(topology: Topology, system: string): string[] {
	const retired = new Set(topology.retired);
	return topology.workers.filter(
		(addr, i) => poolOf(topology.workerSystems[i]) === system && !retired.has(addr)
	);
}

/**
 * Whether a builder matches every word of `query`: each word is part of its
 * address, or of one of its systems or features. Case is ignored.
 */
export function matches(w: WorkerView, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const fields = [w.addr, ...w.systems, ...w.features].map((f) => f.toLowerCase());
	return words.every((word) => fields.some((f) => f.includes(word)));
}

/** Builders taking work first, then draining ones, then offline ones. */
const RANK: Record<BuilderState, number> = { up: 0, draining: 1, offline: 2 };

export function poolList(
	workers: readonly WorkerView[],
	o: Readonly<{ query: string; sort: PoolSort; filter: PoolFilter }>
): WorkerView[] {
	const out = workers.filter(
		(w) => (o.filter === 'all' || builderState(w) === o.filter) && matches(w, o.query)
	);
	const byAddr = (a: WorkerView, b: WorkerView) => compareNatural(a.addr, b.addr);
	if (o.sort === 'address') return out.sort(byAddr);
	// By state first, so "idle first" means spare capacity, not builders that left.
	const dir = o.sort === 'busiest' ? -1 : 1;
	return out.sort(
		(a, b) =>
			RANK[builderState(a)] - RANK[builderState(b)] ||
			dir * (loadOf(a) - loadOf(b)) ||
			dir * (a.running - b.running) ||
			byAddr(a, b)
	);
}
