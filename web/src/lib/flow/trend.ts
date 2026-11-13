// The queue's direction on the scheduler card. Whether the queue grows, not
// how long it is, answers "Do I need more builders?".

import { formatCount } from '#lib/ui/format.ts';

export type QueueTrend = Readonly<{ up: boolean; text: string; spoken: string }>;

/** A change smaller than this share of the queue a minute is noise. */
const STEADY_SHARE = 0.02;

/**
 * "▲ 34/min" while the queue grows, "▼ 120/min" while it shrinks, with
 * words for screen readers, or null without a trend yet or near 0: less
 * than one derivation a minute, or 2% of the queue.
 */
export function queueTrend(perMin: number | null, queued: number): QueueTrend | null {
	if (perMin === null) return null;
	const n = Math.round(Math.abs(perMin));
	if (n < Math.max(1, queued * STEADY_SHARE)) return null;
	const count = formatCount(n);
	return perMin > 0
		? { up: true, text: `▲ ${count}/min`, spoken: `growing by ${count} a minute` }
		: { up: false, text: `▼ ${count}/min`, spoken: `shrinking by ${count} a minute` };
}
