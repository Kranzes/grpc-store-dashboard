// The queued count on a group's heading: one number for the group, where
// every card used to repeat its own.

import { offers } from '#lib/model/sched.ts';
import type { SystemQueueView } from '#lib/model/types.ts';

/** What a builder offers: its systems and features. */
export type Offer = Readonly<{
	systems: readonly string[];
	features: readonly string[];
}>;

/**
 * Queued derivations that at least one builder of a group can take: one of
 * its systems and every feature the row needs. Each row of the scheduler's
 * queue table counts once, however many builders can take it, so mixed
 * feature sets add up to their union. It leaves out unplaceable ones, as a
 * pool's count does.
 */
export function groupBacklog(rows: readonly SystemQueueView[], builders: readonly Offer[]): number {
	let n = 0;
	for (const r of rows) {
		const placeable = r.queued - r.unplaceable;
		if (placeable <= 0) continue;
		const needs = r.features ? r.features.split(',') : [];
		if (builders.some((b) => offers(b.systems, b.features, r.system, needs))) n += placeable;
	}
	return n;
}
