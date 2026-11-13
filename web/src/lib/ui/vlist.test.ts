import { describe, expect, it } from 'vitest';
import { listWindow } from './vlist.ts';

const base = { count: 1000, height: 520, rowHeight: 52, overscan: 2, active: 0 };

/** The rows that get tabindex 0 in VirtualList. */
const tabbable = (w: ReturnType<typeof listWindow>) => w.rows.filter((i) => i === w.tabRow);

describe('listWindow', () => {
	it('renders the rows in view plus overscan', () => {
		const w = listWindow({ ...base, scrollTop: 52 * 100, active: 100 });
		expect(w.rows).toEqual(Array.from({ length: 14 }, (_, i) => 98 + i));
	});

	it('keeps the active row rendered after it scrolls out above', () => {
		const w = listWindow({ ...base, scrollTop: 52 * 500, active: 3 });
		expect(w.rows[0]).toBe(3);
		expect(w.rows[1]).toBe(498);
		expect(tabbable(w)).toEqual([3]);
	});

	it('keeps the active row rendered after it scrolls out below', () => {
		const w = listWindow({ ...base, scrollTop: 0, active: 800 });
		expect(w.rows.at(-1)).toBe(800);
		expect(w.rows.at(-2)).toBe(11);
		expect(tabbable(w)).toEqual([800]);
	});

	it('always has exactly one tab stop', () => {
		for (const scrollTop of [0, 52 * 10, 52 * 400, 52 * 990]) {
			for (const active of [0, 5, 400, 999, 5000]) {
				const w = listWindow({ ...base, scrollTop, active });
				expect(tabbable(w), `scrollTop ${scrollTop}, active ${active}`).toHaveLength(1);
				expect(new Set(w.rows).size).toBe(w.rows.length);
				expect([...w.rows].sort((a, b) => a - b)).toEqual(w.rows);
			}
		}
	});

	it('clamps the active row when the list shrinks', () => {
		const w = listWindow({ ...base, count: 3, scrollTop: 0, active: 40 });
		expect(w.rows).toEqual([0, 1, 2]);
		expect(w.tabRow).toBe(2);
	});

	it('has no rows and no tab stop when empty', () => {
		expect(listWindow({ ...base, count: 0, scrollTop: 0 })).toEqual({ rows: [], tabRow: null });
	});
});
