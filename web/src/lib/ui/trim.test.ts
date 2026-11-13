import { describe, expect, it } from 'vitest';
import { capShift } from './trim.ts';

describe('capShift', () => {
	it('is where the capitals start in a line box one cap tall', () => {
		// Ascent 0.9, descent 0.2, capitals 0.7: the content area is 1.1 tall,
		// centred on a 0.7 line, so the baseline sits 0.7 down and the
		// capitals start right at the top.
		expect(capShift({ cap: 70, ascent: 90, descent: 20, size: 100 })).toBeCloseTo(0);
		// A deep ascent pushes them down; a deep descent pulls them up.
		expect(capShift({ cap: 70, ascent: 110, descent: 20, size: 100 })).toBeCloseTo(0.1);
		expect(capShift({ cap: 70, ascent: 90, descent: 40, size: 100 })).toBeCloseTo(-0.1);
	});

	it('is in em, whatever size it was measured at', () => {
		expect(capShift({ cap: 7, ascent: 11, descent: 2, size: 10 })).toBeCloseTo(0.1);
	});
});
