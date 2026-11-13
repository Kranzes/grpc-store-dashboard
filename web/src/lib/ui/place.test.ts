import { describe, expect, it } from 'vitest';
import { beside } from './place.ts';

describe('beside', () => {
	it('sits past the pointer, flips before the edge, and stops at 0', () => {
		expect(beside(100, 50, 400, 12)).toBe(112);
		expect(beside(380, 50, 400, 12)).toBe(318);
		expect(beside(380, 50, 400, 16, 12)).toBe(318);
		expect(beside(30, 50, 60, 12)).toBe(0);
	});
});
