// The 16 ANSI tokens of the log viewer are Catppuccin's terminal port
// colors through the log worker's adjust(). Each keeps its hue and reaches
// 4.5:1 on the log background, in both themes.

import { readFileSync } from 'node:fs';
import { flavors } from '@catppuccin/palette';
import { describe, expect, it } from 'vitest';
import {
	AA,
	LATTE_BG,
	MACCHIATO_BG,
	adjust,
	contrast,
	toOklab,
	toOklch,
	type Rgb
} from '#lib/logs/contrast.ts';

const hex = (h: string): Rgb =>
	[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;
const toHex = (c: Rgb) => `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;

/** Catppuccin's terminal ports, 0 to 15: [name, Latte, Macchiato]. */
const PORTS: readonly [string, string, string][] = [
	['black', '#5c5f77', '#494d64'],
	['red', '#d20f39', '#ed8796'],
	['green', '#40a02b', '#a6da95'],
	['yellow', '#df8e1d', '#eed49f'],
	['blue', '#1e66f5', '#8aadf4'],
	['magenta', '#ea76cb', '#f5bde6'],
	['cyan', '#179299', '#8bd5ca'],
	['white', '#acb0be', '#a5adcb'],
	['brblack', '#6c6f85', '#5b6078'],
	['brred', '#de293e', '#ec7486'],
	['brgreen', '#49af3d', '#8ccf7f'],
	['bryellow', '#eea02d', '#e1c682'],
	['brblue', '#456eff', '#78a1f6'],
	['brmagenta', '#fe85d8', '#f2a9dd'],
	['brcyan', '#2d9fa8', '#63cbc0'],
	['brwhite', '#bcc0cc', '#b8c0e0']
];

const css = readFileSync(new URL('./catppuccin.css', import.meta.url), 'utf8');
/** [index, Latte, Macchiato] of every --ansi-N token: light-dark()'s two hex colors. */
const tokens = [
	...css.matchAll(/--ansi-(\d+):\s*light-dark\(\s*(#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\s*\)/g)
].map((m) => [Number(m[1]), m[2], m[3]] as const);

/** The theme's custom properties, by name. */
const vars = new Map(
	[...css.replace(/\/\*[^]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
		m[1],
		m[2].trim()
	])
);

/** A token's color in one flavor, through var(), light-dark() and the palette's own colors. */
function color(name: string, flavor: 'latte' | 'macchiato'): Rgb {
	const own = /^--ctp-(latte|macchiato)-(\w+)$/.exec(name);
	if (own) {
		const colors = flavors[own[1] as 'latte' | 'macchiato'].colors as Record<
			string,
			{ hex: string }
		>;
		return hex(colors[own[2]].hex);
	}
	const value = vars.get(name) ?? '';
	const pair = /^light-dark\(\s*var\((--[\w-]+)\),\s*var\((--[\w-]+)\)\s*\)$/.exec(value);
	if (pair) return color(flavor === 'latte' ? pair[1] : pair[2], flavor);
	const one = /^var\((--[\w-]+)\)$/.exec(value);
	if (one) return color(one[1], flavor);
	throw new Error(`cannot resolve ${name}: ${value}`);
}

const hueDelta = (a: Rgb, b: Rgb) => {
	const d = Math.abs(toOklch(a).h - toOklch(b).h) % (2 * Math.PI);
	return Math.min(d, 2 * Math.PI - d);
};
/** OKLab distance, times 100 as the dataviz audit reports it. */
const deltaE = (a: Rgb, b: Rgb) => {
	const x = toOklab(a);
	const y = toOklab(b);
	return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

describe('log colors', () => {
	it('defines the 16 on the background the checks below use', () => {
		expect(tokens.map((t) => t[0])).toEqual([...Array(16).keys()]);
		expect(color('--log-bg', 'latte')).toEqual(LATTE_BG);
		expect(color('--log-bg', 'macchiato')).toEqual(MACCHIATO_BG);
	});

	it.each(tokens)(
		'--ansi-%s is the port color through adjust(), at 4.5:1 on the log background in both themes',
		(i, latte, macchiato) => {
			const [, l, m] = PORTS[i];
			expect(latte).toBe(toHex(adjust(hex(l), LATTE_BG)));
			expect(macchiato).toBe(toHex(adjust(hex(m), MACCHIATO_BG)));
			expect(contrast(hex(latte), LATTE_BG)).toBeGreaterThanOrEqual(AA);
			expect(contrast(hex(macchiato), MACCHIATO_BG)).toBeGreaterThanOrEqual(AA);
		}
	);

	it('the Latte colors keep their port hue, so yellow and green stay apart', () => {
		for (const [i, latte] of tokens) {
			const port = hex(PORTS[i][1]);
			// Grays have no hue to keep.
			if (toOklch(port).c < 0.05) continue;
			expect(hueDelta(hex(latte), port), PORTS[i][0]).toBeLessThan(0.05);
		}
		// Mixed toward the text color they were 9.1 apart, and yellow read as gray.
		const at = (n: number) => hex(tokens[n][1]);
		expect(deltaE(at(3), at(2))).toBeGreaterThan(15);
		expect(deltaE(at(11), at(10))).toBeGreaterThan(15);
	});
});
