import { describe, expect, it } from 'vitest';
import { LogEngine } from './engine.ts';
import { MAX_CELLS } from './rows.ts';

const enc = new TextEncoder();
function engine(lines: readonly string[], cols = 10, wrap = true): LogEngine {
	const e = new LogEngine();
	e.setLayout(cols, wrap);
	e.push(enc.encode(lines.map((l) => `${l}\n`).join('')));
	e.settle();
	return e;
}

const LOG = [
	'first line',
	'Running phase: unpackPhase',
	'a'.repeat(25),
	'short',
	'Running phase: buildPhase',
	'b'.repeat(10),
	'c'.repeat(11),
	'Running phase: installPhase',
	'done'
];

describe('rows', () => {
	it('rows per line with wrap', () => {
		const e = engine(LOG);
		// The line before the first phase; unpack header, 3 rows, 1; build header, 1, 2; install header, 1.
		expect(e.rows.total).toBe(1 + 1 + 3 + 1 + 1 + 1 + 2 + 1 + 1);
		const r = e.render(0, e.rows.total);
		expect(r.map((x) => x.kind)).toEqual([
			'line',
			'header',
			'line',
			'line',
			'line',
			'line',
			'header',
			'line',
			'line',
			'line',
			'header',
			'line'
		]);
		expect(r.filter((x) => x.slot === 2).map((x) => x.segs!.map((s) => s[0]).join(''))).toEqual([
			'aaaaaaaaaa',
			'aaaaaaaaaa',
			'aaaaa'
		]);
		// Line numbers on a line's first row only.
		expect(r.filter((x) => x.slot === 2).map((x) => x.line)).toEqual([3, null, null]);
	});

	it('a width change recomputes the sums', () => {
		const e = engine(LOG);
		const before = e.rows.total;
		e.setLayout(100, true);
		expect(e.rows.total).toBe(before - 3);
		e.setLayout(5, true);
		expect(e.rows.total).toBe(2 + 1 + 5 + 1 + 1 + 2 + 3 + 1 + 1);
		e.setLayout(5, false);
		expect(e.rows.total).toBe(12 - 3);
	});

	it('long lines stop at 10,000 cells', () => {
		const e = engine(['x'.repeat(MAX_CELLS + 500)], 1000);
		const r = e.render(0, e.rows.total);
		expect(r.at(-1)!.kind).toBe('more');
		expect(r.at(-1)!.more!.cells).toBe(500);
		const drawn = r
			.filter((x) => x.kind === 'line')
			.reduce((n, x) => n + x.segs!.reduce((m, s) => m + s[0].length, 0), 0);
		expect(drawn).toBe(MAX_CELLS);
		const off = engine(['x'.repeat(MAX_CELLS + 500)], 1000, false);
		expect(off.rows.total).toBe(2);
	});

	it("a folded group's lines take no rows and keep their numbers", () => {
		const e = engine(LOG);
		const unpack = e.tree.groups.find((g) => g.name === 'unpackPhase')!;
		e.fold([unpack.id], false, null);
		const r = e.render(0, e.rows.total);
		const numbered = r.filter((x) => x.line !== null).map((x) => x.line);
		// 2 (the header) then 5: lines 3 and 4 are folded away.
		expect(numbered).toEqual([1, 2, 5, 6, 7, 8, 9]);
	});

	it('lineOfRow and rowOfLine agree across folds', () => {
		const e = engine(LOG);
		e.fold([e.tree.groups[1].id], false, null);
		for (let slot = 0; slot < e.store.slots; slot++) {
			if (e.rows.rowsOf(slot) === 0) continue;
			const row = e.rows.rowOfSlot(slot);
			expect(e.rows.slotOfRow(row).slot).toBe(slot);
		}
	});

	it('a fold change recomputes only from the group on', () => {
		const e = engine(LOG);
		const build = e.tree.groups.find((g) => g.name === 'buildPhase')!;
		const rowBefore = e.rows.rowOfSlot(3);
		e.fold([build.id], false, null);
		expect(e.rows.rowOfSlot(3)).toBe(rowBefore);
		expect(e.rows.rowOfSlot(7)).toBe(e.rows.rowOfSlot(4) + 1);
	});

	it('lines that arrive in a folded group stay hidden, with a new header or in pieces', () => {
		const e = engine(LOG.slice(0, 7));
		const build = e.tree.groups.find((g) => g.name === 'buildPhase')!;
		e.fold([build.id], false, null);
		const folded = e.rows.total;
		// Half a line, then its end: no group held the slot the first time.
		e.push(enc.encode('dd'));
		e.settle();
		e.push(enc.encode('d\n'));
		e.settle();
		expect(e.rows.total).toBe(folded);
		// A line of the folded group and a new header in the same settle.
		e.push(enc.encode('eee\nRunning phase: installPhase\ndone\n'));
		e.settle();
		expect(e.rows.total).toBe(folded + 2);
		e.fold([build.id], true, null);
		expect(e.rows.total).toBe(
			engine([...LOG.slice(0, 7), 'ddd', 'eee', ...LOG.slice(7)]).rows.total
		);
	});

	it('Expand all after Collapse all gives the unfolded sums', () => {
		const e = engine(LOG);
		const total = e.rows.total;
		e.foldAll(false, null);
		// The line before the first phase, and three phases' header rows.
		expect(e.rows.total).toBe(4);
		e.foldAll(true, null);
		expect(e.rows.total).toBe(total);
	});
});
