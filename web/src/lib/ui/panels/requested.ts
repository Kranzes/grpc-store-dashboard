// Wording for the "Requested by" part of the derivation detail.

import type { DrvPhase } from '#lib/model/types.ts';
import { plural } from '../format.ts';

/** Phases in which the scheduler still holds the derivation and its streams. */
export function isTracked(phase: DrvPhase): boolean {
	return phase === 'queued' || phase === 'unplaceable' || phase === 'assigned';
}

/**
 * Open streams only make sense while the scheduler tracks the derivation.
 * After that, the streams may have closed or moved on, so say how many asked.
 */
export function streamsCaption(streams: number, tracked: boolean): string {
	const n = plural(streams, 'stream', 'streams');
	return tracked ? `${n} waiting on it` : `${n} asked for it`;
}

export function noClientCaption(tracked: boolean): string {
	return tracked ? 'No client is waiting on it.' : 'No client was waiting on it.';
}
