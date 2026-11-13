// The cells of a pool node: one per builder slot, in slot order.

import {
	builderState,
	type BuilderState,
	type PoolView,
	type WorkerView
} from '#lib/model/types.ts';
import { drainCell } from '#lib/ui/drain.ts';
import { formatCount } from '#lib/ui/format.ts';

/** Load as a step: 0 idle, 1 up to half, 2 more than half, 3 full. */
export type CellLevel = 0 | 1 | 2 | 3;

export type Cell = Readonly<{
	addr: string;
	level: CellLevel;
	state: BuilderState;
	/** Address and load, shown on hover. */
	title: string;
	/** The view this cell was made from, so an unchanged builder keeps its cell. */
	view: WorkerView | undefined;
}>;

export function cellLevel(running: number, maxJobs: number): CellLevel {
	if (running <= 0 || maxJobs <= 0) return 0;
	const f = running / maxJobs;
	return f >= 1 ? 3 : f > 0.5 ? 2 : 1;
}

export function cellOf(addr: string, w: WorkerView | undefined): Cell {
	if (!w) return { addr, level: 0, state: 'offline', title: `${addr} · gone`, view: w };
	const state = builderState(w);
	const load = `${w.running}/${w.maxJobs} assigned`;
	return {
		addr,
		level: cellLevel(w.running, w.maxJobs),
		state,
		title:
			state === 'up'
				? `${addr} · ${load}`
				: `${addr} · ${load} · ${state === 'draining' ? drainCell(w) : state}`,
		view: w
	};
}

/**
 * Cells for `slots`, reusing a previous cell wherever its builder's view kept
 * its identity, so only the cells of changed builders update.
 */
export function cellsOf(
	slots: readonly (string | null)[],
	workers: ReadonlyMap<string, WorkerView>,
	previous: readonly (Cell | null)[] = []
): (Cell | null)[] {
	return slots.map((addr, i) => {
		if (addr === null) return null;
		const w = workers.get(addr);
		const prev = previous[i];
		return prev && prev.addr === addr && prev.view === w ? prev : cellOf(addr, w);
	});
}

/**
 * Features, the rarest first: they tell builders apart, so a cut line keeps
 * them. Ties go by name.
 */
export function rarestFirst<T extends Readonly<{ name: string; builders: number }>>(
	features: readonly T[]
): T[] {
	return [...features].sort((a, b) => a.builders - b.builders || a.name.localeCompare(b.name));
}

/** A builder's features, the rarest in its pool first. */
export function builderFeatures(
	features: readonly string[],
	pool: PoolView['features'] | undefined
): string[] {
	const count = new Map(pool?.map((f) => [f.name, f.builders]));
	return rarestFirst(features.map((name) => ({ name, builders: count.get(name) ?? Infinity }))).map(
		(f) => f.name
	);
}

/**
 * "kvm 8 · benchmark 11 · big-parallel · +2", the rarest first. A feature
 * that some of the pool's `builders` lack shows its count; one that all of
 * them offer shows its name alone, since its count would repeat the pool's
 * size. A single feature left over shows itself, since "+1" takes about as
 * much room.
 */
export function featureSummary(features: PoolView['features'], builders: number, max = 3): string {
	if (features.length === 0) return 'No extra features';
	const sorted = rarestFirst(features);
	const keep = sorted.length === max + 1 ? sorted.length : max;
	const shown = sorted
		.slice(0, keep)
		.map((f) => (f.builders < builders ? `${f.name} ${formatCount(f.builders)}` : f.name));
	if (sorted.length > keep) shown.push(`+${sorted.length - keep}`);
	return shown.join(' · ');
}
