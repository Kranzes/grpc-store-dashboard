import { describe, expect, it } from 'vitest';
import type { DrainReason } from '#lib/model/types.ts';
import { drainBadge, drainCaption, drainRow, drainState, drainTitle } from './drain.ts';

const w = (drainReason: DrainReason | null) => ({ drainReason, diskFree: null, minFree: 0 });

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
		expect(drainCaption(w('unknown'))).toBe(
			'Stopping, low on disk, no nix-daemon or publishing failing. Takes no new work.'
		);
	});
});
