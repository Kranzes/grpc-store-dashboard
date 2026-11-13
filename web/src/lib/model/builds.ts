// The build list: filter, sort and facets over builds in progress and the
// finished builds the page keeps. Pure, so it is tested on plain rows.

import { OTHER_CLIENTS, compareNatural } from './types.ts';
import type { BuildCounts, BuildQuery, BuildRow, BuildStateFilter } from './types.ts';

export const ANY_QUERY: BuildQuery = Object.freeze({
	states: new Set<BuildStateFilter>(),
	system: null,
	builder: null,
	pool: null,
	client: null,
	q: '',
	withinMs: null,
	sort: 'failures'
});

export function stateFilterOf(row: Pick<BuildRow, 'state'>): BuildStateFilter {
	return row.state === 'cancelled' || row.state === 'dropped' ? 'other' : row.state;
}

/** What a search box text matches: a name, a hash prefix or a pasted /nix/store/…drv path. */
function searchMatcher(q: string): ((row: Pick<BuildRow, 'drvPath' | 'name'>) => boolean) | null {
	const t = q.trim().toLowerCase();
	if (!t) return null;
	// A pasted path: /nix/store/<hash>-<name>.drv, or the base name itself.
	const base = t.slice(t.lastIndexOf('/') + 1);
	if (/^[0-9a-z]{32}-.+\.drv$/.test(base)) return (r) => r.drvPath === base;
	// A hash prefix: only hash characters, at least 4 of them.
	const hash = /^[0-9a-df-np-sv-z]{4,32}$/.test(t);
	return (r) => r.name.toLowerCase().includes(t) || (hash && r.drvPath.startsWith(t));
}

/**
 * What a build in progress is doing, as its builder reported it: its
 * phase, "Running" when it started without one, as a NixOS test or any
 * buildCommand does, "Waiting to start" when the builder reports starts and
 * this one has not, and "Assigned" when the builder never says.
 */
export function assignedText(row: Pick<BuildRow, 'startedMs' | 'phase' | 'reportsStarts'>): string {
	if (row.startedMs !== null) return row.phase ?? 'Running';
	return row.reportsStarts ? 'Waiting to start' : 'Assigned';
}

/** How long a build ran or has run: from its start, or its assignment when no start was reported. */
export function durationMs(row: BuildRow, now: number): number | null {
	const from = row.startedMs ?? row.assignedMs;
	if (from === null) return null;
	const to = row.state === 'assigned' ? now : row.finishedMs;
	return to === null ? null : Math.max(0, to - from);
}

export type QueryContext = Readonly<{
	now: number;
	/** The pool of a builder, by its native system. null when the page does not know the builder. */
	poolOf: (addr: string) => string | null;
	/** Identities of the client groups shown, for OTHER_CLIENTS. */
	shownClients: ReadonlySet<string>;
}>;

export type QueryResult = Readonly<{
	rows: readonly BuildRow[];
	counts: BuildCounts;
	facets: Readonly<{
		systems: readonly string[];
		builders: readonly Readonly<{ addr: string; pool: string | null }>[];
		clients: readonly string[];
	}>;
}>;

const finishedDesc = (a: BuildRow, b: BuildRow) => (b.finishedMs ?? 0) - (a.finishedMs ?? 0);
const startOf = (r: BuildRow) => r.startedMs ?? r.assignedMs ?? 0;
const startedDesc = (a: BuildRow, b: BuildRow) => startOf(b) - startOf(a);
const RANK: Record<BuildStateFilter, number> = { failed: 0, assigned: 1, built: 2, other: 2 };

/**
 * Filter, sort and list facets. "failures" puts failed builds first, newest
 * first, then builds in progress by start, then the other finished builds
 * by finish. "longest" sorts by how long each ran, builds in progress by
 * the time elapsed.
 */
export function queryBuilds(
	all: readonly BuildRow[],
	query: BuildQuery,
	ctx: QueryContext
): QueryResult {
	const match = searchMatcher(query.q);
	const sinceMs = query.withinMs === null ? null : ctx.now - query.withinMs;
	const counts = { failed: 0, assigned: 0, built: 0, other: 0 };
	const rows: BuildRow[] = [];
	const systems = new Set<string>();
	const builders = new Map<string, string | null>();
	const clients = new Set<string>();
	for (const r of all) {
		if (r.system) systems.add(r.system);
		if (r.worker && !builders.has(r.worker)) builders.set(r.worker, ctx.poolOf(r.worker));
		for (const c of r.requestedBy) clients.add(c);
		if (query.system !== null && r.system !== query.system) continue;
		if (query.builder !== null && r.worker !== query.builder) continue;
		if (query.pool !== null && ctx.poolOf(r.worker) !== query.pool) continue;
		if (query.client !== null) {
			const other = query.client === OTHER_CLIENTS;
			if (!r.requestedBy.some((c) => (other ? !ctx.shownClients.has(c) : c === query.client)))
				continue;
		}
		if (match && !match(r)) continue;
		if (sinceMs !== null && r.state !== 'assigned' && (r.finishedMs ?? 0) < sinceMs) continue;
		const f = stateFilterOf(r);
		counts[f]++;
		if (query.states.size > 0 && !query.states.has(f)) continue;
		rows.push(r);
	}
	if (query.sort === 'failures') {
		rows.sort((a, b) => {
			const ra = RANK[stateFilterOf(a)];
			const rb = RANK[stateFilterOf(b)];
			if (ra !== rb) return ra - rb;
			return ra === 1 ? startedDesc(a, b) : finishedDesc(a, b);
		});
	} else if (query.sort === 'newest') {
		const at = (r: BuildRow) => r.finishedMs ?? startOf(r);
		rows.sort((a, b) => at(b) - at(a));
	} else {
		const d = (r: BuildRow) => durationMs(r, ctx.now) ?? -1;
		rows.sort((a, b) => d(b) - d(a));
	}
	return {
		rows,
		counts,
		facets: {
			systems: [...systems].sort(compareNatural),
			builders: [...builders]
				.map(([addr, pool]) => ({ addr, pool }))
				.sort(
					(a, b) => compareNatural(a.pool ?? '', b.pool ?? '') || compareNatural(a.addr, b.addr)
				),
			clients: [...clients].sort(compareNatural)
		}
	};
}
