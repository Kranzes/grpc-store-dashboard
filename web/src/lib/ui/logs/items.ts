// The build list's rows in the order shown, with section heads under
// "Failures first". Pure, so tests run it on plain rows.

import { stateFilterOf } from '#lib/model/builds.ts';
import { buildKey, type BuildRow } from '#lib/model/types.ts';
import type { LogsSort } from '../nav.ts';

export type Item =
	| { kind: 'head'; label: string; key: string }
	| { kind: 'row'; row: BuildRow; key: string };

export const keyOf = (r: BuildRow) => buildKey(r.drvPath, r.assignId);

/**
 * The rows of `live` in the key order of `order`, which is the held order or
 * the live one, then the selected build first when it left the filter.
 */
export function listItems(
	live: readonly BuildRow[],
	order: readonly string[],
	sort: LogsSort,
	selected: string | null,
	selectedRow: BuildRow | null
): Item[] {
	const byKey = new Map(live.map((r) => [keyOf(r), r]));
	const rows: BuildRow[] = [];
	for (const k of order) {
		const r = byKey.get(k);
		if (r) rows.push(r);
	}
	if (selectedRow && selected && !byKey.has(selected)) rows.unshift(selectedRow);
	if (sort !== 'failures') return rows.map((row) => ({ kind: 'row', row, key: keyOf(row) }));
	const out: Item[] = [];
	// A section can come back: after the selected build, or when a held row
	// changed state. Its head then needs a key of its own.
	const heads = new Map<string, number>();
	let section = '';
	for (const row of rows) {
		const f = stateFilterOf(row);
		const s = f === 'failed' ? 'Failed' : f === 'assigned' ? 'Assigned' : 'Finished';
		if (s !== section) {
			section = s;
			const n = heads.get(s) ?? 0;
			heads.set(s, n + 1);
			out.push({ kind: 'head', label: s, key: n ? `head:${s}:${n}` : `head:${s}` });
		}
		out.push({ kind: 'row', row, key: keyOf(row) });
	}
	return out;
}
