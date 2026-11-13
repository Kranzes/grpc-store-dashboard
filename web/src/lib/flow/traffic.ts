// How a line draws its traffic: width and dot density from its rate, scaled
// by the busiest line on the map, its failure marks, and the order lines
// paint in.

import { failShare, type EdgeView, type RateUnit } from '#lib/model/types.ts';
import { countsFailures, type DrawnLine } from './kinds.ts';
import { failSlots } from './marks.ts';

/**
 * Lines below this share of the busiest line drawn look idle. Small, so
 * builder cards next to a big pool still show their traffic.
 */
export const ACTIVE_FLOOR = 1 / 2000;

export type Traffic = Readonly<{
	active: boolean;
	/** Line width in px, in 0.5 px steps. */
	width: number;
	/** Dot density, 1 to 4, or 0 when idle. */
	level: 0 | 1 | 2 | 3 | 4;
}>;

const IDLE: Traffic = { active: false, width: 0, level: 0 };

/**
 * Quantised, so small changes in a line's rate leave its look alone. sqrt,
 * so small flows stay visible next to big ones.
 */
export function traffic(rate: number, max: number): Traffic {
	if (!(rate > 0 && max > 0 && rate >= max * ACTIVE_FLOOR)) return IDLE;
	const norm = Math.sqrt(Math.min(1, rate / max));
	return {
		active: true,
		width: 1.5 + Math.round(norm * 12) / 2,
		level: Math.min(4, Math.max(1, Math.ceil(norm * 4))) as Traffic['level']
	};
}

/**
 * The largest rate in `unit` among the lines drawn. The store has the lines
 * of every builder and every pool; only the drawn ones set the scale. The
 * cache hits line is drawn thin at any rate, so it sets no scale either:
 * a farm with many cache hits would thin every request and assignment line.
 */
export function maxRate(
	drawn: readonly DrawnLine[],
	rates: ReadonlyMap<string, EdgeView>,
	unit: RateUnit
): number {
	let max = 0;
	for (const e of drawn) {
		if (e.kind === 'hit') continue;
		const v = rates.get(e.id);
		if (v && v.unit === unit && v.rate > max) max = v.rate;
	}
	return max;
}

/** What one line looks like now, from the store's numbers. */
export type LineLook = Readonly<
	Traffic & {
		/** Red slots out of 10 among its dots: assignment and request lines that failed builds. */
		fails: number;
		/** The cache hits line, a thin dashed lookup that never carries dots. */
		lookup: boolean;
		/** The lookup's hits per second are above 0, so it shows its color. */
		hits: boolean;
	}
>;

/** Every drawn line's look, by id. Numbers, so a look changes only with its level. */
export function lineLooks(
	drawn: readonly DrawnLine[],
	rates: ReadonlyMap<string, EdgeView>
): Map<string, LineLook> {
	const max = { builds: maxRate(drawn, rates, 'builds'), bytes: maxRate(drawn, rates, 'bytes') };
	const looks = new Map<string, LineLook>();
	for (const line of drawn) {
		const ev = rates.get(line.id);
		const lookup = line.kind === 'hit';
		// A lookup never draws as active: no width scale, no dots.
		const t = ev && !lookup ? traffic(ev.rate, max[ev.unit]) : IDLE;
		looks.set(line.id, {
			...t,
			fails: ev && countsFailures(line.kind) ? failSlots(failShare(ev)) : 0,
			lookup,
			hits: lookup && (ev?.rate ?? 0) > 0
		});
	}
	return looks;
}

/**
 * The order lines paint in, bottom first: every idle line, then every
 * active one, each in the order drawn. Lines that share a track overlap
 * exactly, and an idle line's grey painted over an active line would cut a
 * dark core through it. The cache hits line comes first in the layout and
 * never turns active, so it paints under everything.
 */
export function paintOrder(
	drawn: readonly DrawnLine[],
	looks: ReadonlyMap<string, LineLook>
): string[] {
	const idle: string[] = [];
	const active: string[] = [];
	for (const line of drawn) (looks.get(line.id)?.active ? active : idle).push(line.id);
	return [...idle, ...active];
}
