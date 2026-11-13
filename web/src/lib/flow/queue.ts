// The scheduler card's "Queue by system": rows with unplaceable derivations
// folded into one row first, then the largest queues. The scheduler panel's
// table keeps every row.

import type { SystemQueueView } from '#lib/model/types.ts';

/** Rows the card shows, the folded row included. */
const QUEUE_ROWS = 4;

/** Width of a row's bar track in px. */
export const QUEUE_TRACK = 64;

/** A queue above 0 fills at least this much of its track, so its bar never looks empty. */
const MIN_FILL = 2 / QUEUE_TRACK;

export type QueueBar = Readonly<{
	row: SystemQueueView;
	/** The bar's share of its track: 0 for an empty queue, else at least 2 px. */
	fill: number;
}>;

export type QueueCard = Readonly<{
	/**
	 * Rows with unplaceable derivations, folded into one, and the systems they
	 * are for, each once. Two rows of one system that need different features
	 * count as one system. null while there are none.
	 */
	stuck: Readonly<{
		rows: readonly SystemQueueView[];
		systems: readonly string[];
		unplaceable: number;
	}> | null;
	/** The largest queues, scaled to the largest. */
	bars: readonly QueueBar[];
	/** Rows left out, not counting the folded ones. */
	more: number;
}>;

/**
 * The card's rows: one folded row for every row with unplaceable work, which
 * comes first, then the largest queues in the slots left.
 */
export function queueCard(systems: readonly SystemQueueView[]): QueueCard {
	const stuckRows = systems.filter((r) => r.unplaceable > 0);
	const rest = systems.filter((r) => r.unplaceable <= 0).sort((a, b) => b.queued - a.queued);
	const stuck = stuckRows.length
		? {
				rows: stuckRows,
				systems: [...new Set(stuckRows.map((r) => r.system))],
				unplaceable: stuckRows.reduce((n, r) => n + r.unplaceable, 0)
			}
		: null;
	const shown = rest.slice(0, Math.max(0, QUEUE_ROWS - (stuck ? 1 : 0)));
	const peak = Math.max(1, ...shown.map((r) => r.queued));
	return {
		stuck,
		bars: shown.map((row) => ({
			row,
			fill: row.queued > 0 ? Math.max(MIN_FILL, row.queued / peak) : 0
		})),
		more: rest.length - shown.length
	};
}

/** A row's features as words: "cuda, kvm". */
export function featureText(features: string): string {
	return features.replaceAll(',', ', ');
}

/** A row's need as words: "riscv64-linux", "x86_64-linux, needs cuda, kvm". */
export function needText(r: Pick<SystemQueueView, 'system' | 'features'>): string {
	return r.features ? `${r.system}, needs ${featureText(r.features)}` : r.system;
}

/** The folded row's tooltip, naming every row it holds. */
export function stuckTitle(rows: readonly SystemQueueView[]): string {
	return `No connected builder offers what these need: ${rows.map(needText).join('; ')}`;
}
