// Why a builder drains, in the words of its card, its cell and the panels.

import type { DrainReason, PoolView, WorkerView } from '#lib/model/types.ts';
import { formatBytes, formatCount } from './format.ts';

type Drain = Pick<WorkerView, 'drainReason' | 'diskFree' | 'minFree'>;

/** Each known reason in a few words, as the badge, the panel's state and the pool row say it. */
const REASON: Readonly<Record<Exclude<DrainReason, 'unknown'>, string>> = {
	'low-disk': 'low disk',
	stopping: 'stopping',
	'local-daemon': 'no nix-daemon',
	'publish-unavailable': 'publishing failing'
};

const reasonOf = (w: Drain): string | null =>
	w.drainReason === null || w.drainReason === 'unknown' ? null : REASON[w.drainReason];

/** The card's badge while draining: "Low disk", "Stopping", "No nix-daemon", "Publishing failing" or "Draining". */
export function drainBadge(w: Drain): string {
	const r = reasonOf(w);
	return r === null ? 'Draining' : r[0].toUpperCase() + r.slice(1);
}

/** The badge's tooltip, with the full reason. */
export function drainTitle(w: Drain): string {
	if (w.drainReason === 'stopping')
		return 'Stopping: the builder was told to stop. It finishes its builds, then disconnects.';
	if (w.drainReason === 'local-daemon')
		return "No nix-daemon: the builder's nix-daemon does not answer. It takes no new work until it does.";
	if (w.drainReason === 'publish-unavailable')
		return "Publishing failing: the builder's last publishes to the cache failed. It takes no new work for a while, then tries again.";
	if (w.drainReason !== 'low-disk')
		return 'Draining: the builder takes no new work. It does not say why.';
	const below =
		w.diskFree !== null && w.minFree > 0
			? `${formatBytes(w.diskFree)} free is below its --min-free of ${formatBytes(w.minFree)}`
			: 'it has less free disk than its --min-free';
	return `Low on disk: ${below}. It takes no new work until it has more.`;
}

/**
 * The builder panel's state: "Draining (low disk)", "Draining (stopping)",
 * "Draining (no nix-daemon)", "Draining (publishing failing)" or "Draining".
 */
export function drainState(w: Drain): string {
	const r = reasonOf(w);
	return r === null ? 'Draining' : `Draining (${r})`;
}

/** The builder panel's caption while draining. */
export function drainCaption(w: Drain): string {
	if (w.drainReason === 'low-disk')
		return 'Low on disk: the builder has less free disk than its --min-free, so it takes no new work. Its builds keep running, and it takes work again once it has space.';
	if (w.drainReason === 'stopping')
		return 'Stopping: the builder was told to stop. It finishes the builds it has, then disconnects.';
	if (w.drainReason === 'local-daemon')
		return "No nix-daemon: the builder's nix-daemon does not answer, so it takes no new work. It takes work again once its nix-daemon answers.";
	if (w.drainReason === 'publish-unavailable')
		return "Publishing failing: the builder's publishes to the cache keep failing, so it takes no new work. It tries again after a while.";
	return 'Stopping, low on disk, no nix-daemon or publishing failing. Takes no new work.';
}

/** A pool cell's state after its load: "draining, low on disk, 3.1 GiB free". */
export function drainCell(w: Drain): string {
	if (w.drainReason === 'stopping') return 'draining, stopping';
	if (w.drainReason === 'local-daemon') return 'draining, no nix-daemon';
	if (w.drainReason === 'publish-unavailable') return 'draining, publishing failing';
	if (w.drainReason !== 'low-disk') return 'draining';
	return w.diskFree === null
		? 'draining, low on disk'
		: `draining, low on disk, ${formatBytes(w.diskFree)} free`;
}

/**
 * The pool row's badge: "Draining · low disk", "Draining · stopping",
 * "Draining · no nix-daemon", "Draining · publishing failing" or "Draining".
 */
export function drainRow(w: Drain): string {
	const r = reasonOf(w);
	return r === null ? 'Draining' : `Draining · ${r}`;
}

type PoolDrains = Pick<
	PoolView,
	| 'draining'
	| 'drainingLowDisk'
	| 'drainingStopping'
	| 'drainingLocalDaemon'
	| 'drainingPublishUnavailable'
>;

/** How many of a pool's builders drain for a reason they gave. */
export function knownDrains(p: PoolDrains): number {
	return (
		p.drainingLowDisk + p.drainingStopping + p.drainingLocalDaemon + p.drainingPublishUnavailable
	);
}

/** A pool's draining builders by reason: "1 low on disk, 1 stopping". '' with none. */
export function poolDrains(p: PoolDrains) {
	const unknown = p.draining - knownDrains(p);
	const parts: string[] = [];
	if (p.drainingLowDisk > 0) parts.push(`${formatCount(p.drainingLowDisk)} low on disk`);
	if (p.drainingStopping > 0) parts.push(`${formatCount(p.drainingStopping)} stopping`);
	if (p.drainingLocalDaemon > 0)
		parts.push(`${formatCount(p.drainingLocalDaemon)} with no nix-daemon`);
	if (p.drainingPublishUnavailable > 0)
		parts.push(`${formatCount(p.drainingPublishUnavailable)} with publishing failing`);
	if (unknown > 0) parts.push(`${formatCount(unknown)} without a reason`);
	return parts.join(', ');
}
