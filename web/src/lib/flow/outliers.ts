// Builders and client groups that fail far more than the farm: the cards
// that say "62% failed" and the pools that say "2 failing". Pure, so the
// rule can be tested without a page.

import { failShare, type EdgeView, type Totals } from '#lib/model/types.ts';
import { lineId } from './kinds.ts';
import { failPercent } from './labels.ts';

/** Builds that must have ended on a line before its share can stand out. */
export const OUTLIER_MIN_FINISHED = 10;
/** How far, in share points, a line must sit above the farm. */
export const OUTLIER_MARGIN = 0.15;
/**
 * The most often a line that fails at the farm's rate may reach its count
 * by chance. Small, because a map of 1,000 builders tests every line about
 * once a second.
 */
export const OUTLIER_CHANCE = 1e-4;

/** The farm's share of finished builds that failed in the header window, or null with none. */
export function farmFailShare(t: Pick<Totals, 'built' | 'failed'>): number | null {
	const finished = t.built + t.failed;
	return finished > 0 ? t.failed / finished : null;
}

const LANCZOS = [
	0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
	-176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
	1.5056327351493116e-7
];

/** ln Γ(x) for x ≥ 1 by Lanczos with g = 7, good to about 15 digits. */
function lnGamma(x: number): number {
	x -= 1;
	let a = LANCZOS[0];
	const t = x + 7.5;
	for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
	return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * The chance that n builds, each failing with chance p, fail k or more
 * times. Sums the tail from k up and stops once the terms no longer count,
 * so it stays cheap for lines with many builds.
 */
export function failTail(k: number, n: number, p: number): number {
	if (k <= 0) return 1;
	if (k > n || p <= 0) return 0;
	if (p >= 1) return 1;
	const ln = lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
	let term = Math.exp(ln + k * Math.log(p) + (n - k) * Math.log1p(-p));
	let sum = term;
	const ratio = p / (1 - p);
	for (let i = k; i < n; i++) {
		term *= ((n - i) / (i + 1)) * ratio;
		sum += term;
		if (term < sum * 1e-12) break;
	}
	return Math.min(1, sum);
}

/**
 * Whether a line's failures stand out from the farm's in the same window:
 * over at least OUTLIER_MIN_FINISHED finished builds, its share is at least
 * twice the farm's and OUTLIER_MARGIN above it, and a line failing at the
 * farm's rate would reach its count less than OUTLIER_CHANCE of the time.
 * The last test keeps noise off the cards: in a farm failing 5%, 2 of 10 is
 * 20%, but about 1 line in 12 gets there by chance. With no farm share to
 * compare with, nothing stands out.
 */
export function isFailOutlier(failed: number, finished: number, farmShare: number | null): boolean {
	if (farmShare === null || failed <= 0 || finished < OUTLIER_MIN_FINISHED) return false;
	const share = failed / finished;
	if (share < 2 * farmShare || share < farmShare + OUTLIER_MARGIN) return false;
	return failTail(failed, finished, farmShare) < OUTLIER_CHANCE;
}

/** A line's failure share when it stands out, else null. */
export function outlierShare(e: EdgeView | undefined, farmShare: number | null): number | null {
	if (!e || !isFailOutlier(e.failed, e.finished, farmShare)) return null;
	return failShare(e);
}

/** How many of these builders stand out, by their assignment lines. */
export function failingBuilders(
	addrs: readonly (string | null)[],
	edges: ReadonlyMap<string, EdgeView>,
	farmShare: number | null
): number {
	if (farmShare === null) return 0;
	let n = 0;
	for (const addr of addrs) {
		if (addr !== null && outlierShare(edges.get(lineId('assign', addr)), farmShare) !== null) n++;
	}
	return n;
}

/** The tooltip of a pool's "2 failing": the rule above, in one sentence. */
export function failingTitle(farmShare: number | null): string {
	const farm = failPercent(farmShare) ?? '0%';
	const points = Math.round(OUTLIER_MARGIN * 100);
	return `Builders failing at least twice the farm's ${farm} and ${points} percentage points above it, too often to be chance, in the selected window.`;
}
