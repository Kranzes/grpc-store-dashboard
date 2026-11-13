import { describe, expect, it } from 'vitest';
import { rovingIndex } from './keys.ts';

describe('rovingIndex', () => {
	it('steps both ways and wraps around', () => {
		expect(rovingIndex('ArrowRight', 0, 3)).toBe(1);
		expect(rovingIndex('ArrowDown', 2, 3)).toBe(0);
		expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
		expect(rovingIndex('ArrowUp', 2, 3)).toBe(1);
	});

	it('goes to the ends only when asked', () => {
		expect(rovingIndex('Home', 2, 3)).toBe(-1);
		expect(rovingIndex('Home', 2, 3, true)).toBe(0);
		expect(rovingIndex('End', 0, 3, true)).toBe(2);
		expect(rovingIndex('Enter', 0, 3, true)).toBe(-1);
	});
});
