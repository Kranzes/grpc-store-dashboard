import { describe, expect, it } from 'vitest';
import { queueTrend } from './trend.ts';

describe('queue trend', () => {
	it('says which way the queue goes, per minute', () => {
		expect(queueTrend(34.4, 591)).toEqual({
			up: true,
			text: '▲ 34/min',
			spoken: 'growing by 34 a minute'
		});
		expect(queueTrend(-120, 591)).toEqual({
			up: false,
			text: '▼ 120/min',
			spoken: 'shrinking by 120 a minute'
		});
		expect(queueTrend(2400, 50_000)?.text).toBe('▲ 2,400/min');
	});

	it('says nothing without a minute of samples, or near 0', () => {
		expect(queueTrend(null, 591)).toBeNull();
		expect(queueTrend(0.4, 0)).toBeNull();
		expect(queueTrend(-0.4, 3)).toBeNull();
		// Under 2% of the queue a minute is noise.
		expect(queueTrend(11, 591)).toBeNull();
		expect(queueTrend(12, 591)?.up).toBe(true);
		// A drained queue still says how fast it went.
		expect(queueTrend(-100, 0)?.text).toBe('▼ 100/min');
		expect(queueTrend(1, 0)?.text).toBe('▲ 1/min');
	});
});
