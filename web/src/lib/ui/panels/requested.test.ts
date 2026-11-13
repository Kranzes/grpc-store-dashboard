import { describe, expect, it } from 'vitest';
import type { DrvPhase } from '#lib/model/types.ts';
import { isTracked, noClientCaption, streamsCaption } from './requested.ts';

describe('requested by', () => {
	it('counts waiting streams only while the scheduler tracks the derivation', () => {
		expect(streamsCaption(1, true)).toBe('1 stream waiting on it');
		expect(streamsCaption(3, true)).toBe('3 streams waiting on it');
		// After DrvGone the streams may be gone too.
		expect(streamsCaption(1, false)).toBe('1 stream asked for it');
		expect(streamsCaption(2, false)).toBe('2 streams asked for it');
		expect(noClientCaption(true)).toBe('No client is waiting on it.');
		expect(noClientCaption(false)).toBe('No client was waiting on it.');
	});

	it('treats every outcome of DrvGone and a cache hit as finished', () => {
		const finished: DrvPhase[] = ['built', 'failed', 'cancelled', 'dropped', 'cached'];
		for (const p of finished) expect(isTracked(p), p).toBe(false);
		for (const p of ['queued', 'unplaceable', 'assigned'] as const)
			expect(isTracked(p), p).toBe(true);
	});
});
