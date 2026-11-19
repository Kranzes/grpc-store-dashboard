// A pool's last hour as two lines, slots in use and busy CPUs: their paths,
// and what a point reads as.

import { POOL_HISTORY_MINUTES, type PoolPoint } from '#lib/model/types.ts';
import { formatClockMinutes, formatPercent } from '../format.ts';

/** The plot: its height, and the room above 100% for its label and the lines' end dots. */
export const SPARK = { height: 64, pad: 12 } as const;

/** The span the plot shows. */
const SPAN_MS = POOL_HISTORY_MINUTES * 60_000;

/** Points further apart than this are not joined: the page saw nothing between them. */
const GAP_MS = 150_000;

export type SparkKey = 'slots' | 'cpu';

/** Where a point's time falls across `width`, the plot ending at `end`. */
export function sparkX(t: number, end: number, width: number): number {
	return ((t - (end - SPAN_MS)) / SPAN_MS) * width;
}

/** Where a share from 0 to 1 falls, 0 at the bottom. */
export function sparkY(share: number): number {
	return SPARK.pad + (1 - share) * (SPARK.height - SPARK.pad);
}

/**
 * The SVG path of one line. A null value or a gap of more than GAP_MS
 * between points breaks it, so the page never draws what nobody saw.
 */
export function sparkPath(points: readonly PoolPoint[], key: SparkKey, width: number): string {
	const end = points.at(-1)?.t ?? 0;
	let d = '';
	let prev: PoolPoint | null = null;
	for (const p of points) {
		const v = p[key];
		if (v === null) {
			prev = null;
			continue;
		}
		const joined = prev !== null && p.t - prev.t <= GAP_MS;
		d += `${joined ? 'L' : 'M'}${round(sparkX(p.t, end, width))} ${round(sparkY(v))}`;
		prev = p;
	}
	return d;
}

const round = (x: number) => Math.round(x * 10) / 10;

/** The index of the point nearest to `x`, or -1 with no points. */
export function nearestPoint(points: readonly PoolPoint[], x: number, width: number): number {
	const end = points.at(-1)?.t ?? 0;
	let best = -1;
	let dist = Infinity;
	for (let i = 0; i < points.length; i++) {
		const d = Math.abs(sparkX(points[i].t, end, width) - x);
		if (d < dist) {
			dist = d;
			best = i;
		}
	}
	return best;
}

/** A point as the legend reads it while it is picked, and as screen readers hear it. */
export function sparkReading(
	p: PoolPoint,
	withCpu: boolean
): { time: string; slots: string; cpu: string; spoken: string } {
	const time = formatClockMinutes(p.t);
	const slots = formatPercent(p.slots);
	const cpu = formatPercent(p.cpu);
	const parts = [`${time}`, `slots ${p.slots === null ? 'unknown' : slots}`];
	if (withCpu) parts.push(`CPU ${p.cpu === null ? 'unknown' : cpu}`);
	return { time, slots, cpu, spoken: parts.join(', ') };
}
