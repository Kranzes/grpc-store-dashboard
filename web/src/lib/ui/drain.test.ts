import { describe, expect, it } from 'vitest';
import type { DrainReason } from '#lib/model/types.ts';
import { formatClockMinutes } from './format.ts';
import { drainBadge, drainCaption, drainRow, drainState, drainTitle, poolDrains } from './drain.ts';

const w = (drainReason: DrainReason | null, restingUntil: number | null = null) => ({
	drainReason,
	diskFree: null,
	minFree: 0,
	restingUntil
});

describe('drain', () => {
	it('names each reason on the card, the panel and the pool row', () => {
		const say = (r: DrainReason | null) => [drainBadge(w(r)), drainState(w(r)), drainRow(w(r))];
		expect(say('low-disk')).toEqual(['Low disk', 'Draining (low disk)', 'Draining · low disk']);
		expect(say('stopping')).toEqual(['Stopping', 'Draining (stopping)', 'Draining · stopping']);
		expect(say('local-daemon')).toEqual([
			'No nix-daemon',
			'Draining (no nix-daemon)',
			'Draining · no nix-daemon'
		]);
		expect(say('publish-unavailable')).toEqual([
			'Publishing failing',
			'Draining (publishing failing)',
			'Draining · publishing failing'
		]);
		expect(say('resting')).toEqual(['Resting', 'Draining (resting)', 'Draining · resting']);
		expect(say('unknown')).toEqual(['Draining', 'Draining', 'Draining']);
	});

	it('says why in the tooltip and the caption', () => {
		const p = w('publish-unavailable');
		expect(drainTitle(p)).toBe(
			"Publishing failing: the builder's last publishes to the cache failed. It takes no new work for a while, then tries again."
		);
		expect(drainCaption(p)).toBe(
			"Publishing failing: the builder's publishes to the cache keep failing, so it takes no new work. It tries again after a while."
		);
		const until = 1_800_000_000_000;
		expect(drainTitle(w('resting', until))).toBe(
			`Resting: the builder failed to run several builds in a row, so the scheduler sends it no new builds until ${formatClockMinutes(until)}.`
		);
		expect(drainTitle(w('resting'))).toContain('no new builds for a while.');
		expect(drainCaption(w('unknown'))).toBe(
			'Stopping, low on disk, no nix-daemon or publishing failing. Takes no new work.'
		);
	});

	it("counts a pool's resting builders with the others that drain", () => {
		const pool = {
			draining: 3,
			drainingLowDisk: 0,
			drainingStopping: 1,
			drainingLocalDaemon: 0,
			drainingPublishUnavailable: 0,
			drainingResting: 2
		};
		expect(poolDrains(pool)).toBe('1 stopping, 2 resting');
	});
});
