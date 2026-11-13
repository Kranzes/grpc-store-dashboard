import { describe, expect, it } from 'vitest';
import { LogEngine } from './engine.ts';
import { HITS_CAP } from './search.ts';

const enc = new TextEncoder();
function engine(lines: readonly string[]): LogEngine {
	const e = new LogEngine();
	e.setLayout(200, true);
	e.push(enc.encode(lines.map((l) => `${l}\n`).join('')));
	e.settle();
	return e;
}
const run = (e: LogEngine) => {
	while (e.searchStep(50));
	return e.searchInfo();
};

describe('search', () => {
	it('case toggle', () => {
		const e = engine(['Error here', 'error there', 'no']);
		e.setSearch('error', false, false);
		expect(run(e).count).toBe(2);
		e.setSearch('error', true, false);
		expect(run(e).count).toBe(1);
	});

	it('only matching lines', () => {
		const e = engine([
			'Running phase: buildPhase',
			'a',
			'hit me',
			'b',
			'Running phase: installPhase',
			'c'
		]);
		e.foldAll(false, null);
		e.setSearch('hit', false, true);
		run(e);
		const r = e.render(0, e.rows.total);
		// The match, under its group's header, whatever is folded.
		expect(r.map((x) => [x.kind, x.line])).toEqual([
			['header', 1],
			['line', 3]
		]);
	});

	it('the cap at 10,000', () => {
		const e = engine(Array.from({ length: 6000 }, () => 'x x'));
		e.setSearch('x', false, false);
		const s = run(e);
		expect(s.count).toBe(HITS_CAP);
		expect(s.capped).toBe(true);
	});

	it('a new query cancels the old one', () => {
		const e = engine(Array.from({ length: 50_000 }, (_, i) => `line ${i}`));
		e.setSearch('line', false, false);
		e.searchStep(0);
		e.setSearch('9999', false, false);
		// Only the new query's hits: lines 9999, 19999, 29999, 39999 and 49999.
		expect(run(e).count).toBe(5);
	});

	it('follow searches new lines', () => {
		const e = engine(['a needle']);
		e.setSearch('needle', false, false);
		expect(run(e).count).toBe(1);
		e.push(enc.encode('another needle\n'));
		e.settle();
		expect(run(e).count).toBe(2);
	});

	it('a gap is reported as skipped', () => {
		const e = engine(['needle', 'b']);
		e.startTail(1000, 100);
		e.push(enc.encode('needle again\n'));
		e.settle();
		e.setSearch('needle', false, false);
		const s = run(e);
		expect(s.count).toBe(2);
		expect(s.gapSkipped).toBe(true);
	});

	it('hits in folded groups count', () => {
		const e = engine([
			'Running phase: buildPhase',
			'needle',
			'Running phase: checkPhase',
			'needle'
		]);
		e.foldAll(false, null);
		e.setSearch('needle', false, false);
		expect(run(e).count).toBe(2);
		// Moving to a hit opens its group.
		const before = e.rows.total;
		const { row, line } = e.gotoHit(0);
		expect(line).toBe(2);
		expect(e.rows.total).toBe(before + 1);
		expect(e.render(row!, row! + 1)[0].segs!.some((s) => s[1].includes('hit cur'))).toBe(true);
	});
});
