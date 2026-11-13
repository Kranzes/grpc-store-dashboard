import { describe, expect, it } from 'vitest';
import {
	AA,
	LATTE_BG,
	MACCHIATO_BG,
	adjust,
	contrast,
	toOklch,
	xterm256,
	type Rgb
} from './contrast.ts';

const hueDelta = (a: Rgb, b: Rgb) => {
	const d = Math.abs(toOklch(a).h - toOklch(b).h) % (2 * Math.PI);
	return Math.min(d, 2 * Math.PI - d);
};

describe('contrast', () => {
	it('a color that passes is unchanged', () => {
		const c: Rgb = [20, 20, 120];
		expect(contrast(c, LATTE_BG)).toBeGreaterThan(AA);
		expect(adjust(c, LATTE_BG)).toEqual(c);
	});

	it('a dark blue on Macchiato is lifted to 4.5:1 with its hue kept', () => {
		const c: Rgb = [30, 60, 160];
		expect(contrast(c, MACCHIATO_BG)).toBeLessThan(AA);
		const a = adjust(c, MACCHIATO_BG);
		expect(contrast(a, MACCHIATO_BG)).toBeGreaterThanOrEqual(AA);
		expect(toOklch(a).l).toBeGreaterThan(toOklch(c).l);
		expect(hueDelta(a, c)).toBeLessThan(0.05);
	});

	it('a pale yellow on Latte is darkened to 4.5:1 with its hue kept', () => {
		const c: Rgb = [250, 240, 150];
		const a = adjust(c, LATTE_BG);
		expect(contrast(a, LATTE_BG)).toBeGreaterThanOrEqual(AA);
		expect(toOklch(a).l).toBeLessThan(toOklch(c).l);
		expect(hueDelta(a, c)).toBeLessThan(0.08);
	});

	it('an out-of-gamut result loses chroma, not hue', () => {
		// Saturated blue made much lighter cannot keep its chroma.
		const c: Rgb = [0, 0, 255];
		const a = adjust(c, MACCHIATO_BG);
		expect(contrast(a, MACCHIATO_BG)).toBeGreaterThanOrEqual(AA);
		expect(toOklch(a).c).toBeLessThan(toOklch(c).c);
		expect(hueDelta(a, c)).toBeLessThan(0.08);
	});

	it('grays and black and white reach 4.5:1 in both themes', () => {
		for (const v of [0, 40, 90, 128, 180, 230, 255]) {
			const g: Rgb = [v, v, v];
			expect(contrast(adjust(g, LATTE_BG), LATTE_BG)).toBeGreaterThanOrEqual(AA);
			expect(contrast(adjust(g, MACCHIATO_BG), MACCHIATO_BG)).toBeGreaterThanOrEqual(AA);
		}
	});

	it('every one of the 256 indexes and 1,000 random truecolor values reach 4.5:1 in both themes', () => {
		const colors: Rgb[] = [];
		for (let n = 16; n < 256; n++) colors.push(xterm256(n));
		let seed = 11;
		const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 256;
		for (let i = 0; i < 1000; i++) colors.push([rnd(), rnd(), rnd()]);
		for (const c of colors) {
			expect(contrast(adjust(c, LATTE_BG), LATTE_BG), String(c)).toBeGreaterThanOrEqual(AA);
			expect(contrast(adjust(c, MACCHIATO_BG), MACCHIATO_BG), String(c)).toBeGreaterThanOrEqual(AA);
		}
	});
});
