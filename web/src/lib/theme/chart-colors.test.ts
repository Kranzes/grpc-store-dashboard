// The map's colors as the browser resolves them in each flavor, measured
// the way the dataviz skill's validator measures them: OKLab ΔE ×100, the
// Machado (2009) simulation for color-blind readers, and WCAG contrast.

import { readFileSync } from 'node:fs';
import { flavors } from '@catppuccin/palette';
import { describe, expect, it } from 'vitest';
import { contrast, toOklab, toRgb, type Lab, type Rgb } from '#lib/logs/contrast.ts';

type Flavor = 'latte' | 'macchiato';
const FLAVORS: Flavor[] = ['latte', 'macchiato'];

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (path: string) => strip(readFileSync(new URL(path, import.meta.url), 'utf8'));
const theme = read('./catppuccin.css');
const nodes = read('../flow/nodes/nodes.css');

/** A value with its whitespace collapsed, and none just inside parentheses. */
const squeeze = (v: string) =>
	v.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

/** The theme's custom properties, by name. */
const tokens = new Map(
	[...theme.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], squeeze(m[2])])
);

/** The declarations of one rule of nodes.css, by property. */
function rule(selector: string): Map<string, string> {
	const at = nodes.indexOf(`\n${selector} {`);
	if (at < 0) throw new Error(`no rule ${selector}`);
	const body = nodes.slice(at, nodes.indexOf('\n}', at));
	return new Map([...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], squeeze(m[2])]));
}

/** A function's arguments, split at its top-level commas. */
function args(inner: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ',' && depth === 0) {
			out.push(inner.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(inner.slice(start).trim());
	return out;
}

const hex = (h: string): Rgb =>
	[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb;

/**
 * A color value in one flavor: a hex, var(), light-dark(), color-mix() in
 * srgb or oklab, or oklch(from … l c h). An out-of-gamut color is clipped
 * per channel, as an sRGB screen shows it.
 */
function resolve(value: string, flavor: Flavor): Rgb {
	const v = value.trim();
	if (v.startsWith('#')) return hex(v);
	const fn = /^([\w-]+)\((.*)\)$/.exec(v);
	if (!fn) throw new Error(`cannot resolve ${v}`);
	const [, name, inner] = fn;
	if (name === 'var') {
		const own = tokens.get(inner);
		if (own) return resolve(own, flavor);
		const ctp = /^--ctp-(latte|macchiato)-(\w+)$/.exec(inner);
		if (!ctp) throw new Error(`unknown ${inner}`);
		const colors = flavors[ctp[1] as Flavor].colors as Record<string, { hex: string }>;
		return hex(colors[ctp[2]].hex);
	}
	const a = args(inner);
	if (name === 'light-dark') return resolve(a[flavor === 'latte' ? 0 : 1], flavor);
	if (name === 'color-mix') {
		const space = a[0].replace('in ', '');
		const first = /^(.*) (\d+)%$/.exec(a[1])!;
		const p = Number(first[2]) / 100;
		const x = resolve(first[1], flavor);
		const y = resolve(a[2], flavor);
		if (space === 'srgb') return x.map((c, i) => c * p + y[i] * (1 - p)) as unknown as Rgb;
		const [lx, ly] = [toOklab(x), toOklab(y)];
		return toRgb(lx.map((c, i) => c * p + ly[i] * (1 - p)) as Lab);
	}
	if (name === 'oklch') {
		const m = /^from (.+) ([\d.]+|l) ([\d.]+|c) ([\d.]+|h)$/.exec(inner);
		if (!m) throw new Error(`cannot resolve ${v}`);
		const [L, A, B] = toOklab(resolve(m[1], flavor));
		const c0 = Math.hypot(A, B);
		const h0 = Math.atan2(B, A);
		const l = m[2] === 'l' ? L : Number(m[2]);
		const c = m[3] === 'c' ? c0 : Number(m[3]);
		const h = m[4] === 'h' ? h0 : (Number(m[4]) * Math.PI) / 180;
		return toRgb([l, c * Math.cos(h), c * Math.sin(h)]);
	}
	throw new Error(`cannot resolve ${v}`);
}

const token = (name: string, flavor: Flavor) => resolve(`var(${name})`, flavor);

const lin = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const delin = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Machado, Oliveira and Fernandes (2009) at severity 1, on linear sRGB. */
const MACHADO = {
	protan: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998]
	],
	deutan: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881]
	]
};

function seen(c: Rgb, kind?: keyof typeof MACHADO): Lab {
	if (!kind) return toOklab(c);
	const l = c.map(lin);
	const m = MACHADO[kind];
	const out = m.map((row) =>
		delin(Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2])))
	);
	return toOklab(out as unknown as Rgb);
}

/** OKLab distance ×100, for normal vision or one kind of color blindness. */
function deltaE(a: Rgb, b: Rgb, kind?: keyof typeof MACHADO): number {
	const [x, y] = [seen(a, kind), seen(b, kind)];
	return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** OKLCH lightness, which is OKLab's. */
const lightness = (c: Rgb) => toOklab(c)[0];

describe('line colors', () => {
	// The buses top to bottom. Each block's fetch trunk also runs 12 px from
	// the next column's assignment trunk.
	const BUSES = ['publish', 'assign', 'fetch', 'substitute'];

	it.each(FLAVORS)('lines that run side by side stay apart, also when color-blind, in %s', (f) => {
		for (let i = 1; i < BUSES.length; i++) {
			const a = token(`--flow-${BUSES[i - 1]}`, f);
			const b = token(`--flow-${BUSES[i]}`, f);
			const pair = `${BUSES[i - 1]} and ${BUSES[i]}`;
			// The validator's target for neighbors, and its floor for normal vision.
			expect(Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan')), pair).toBeGreaterThan(8);
			expect(deltaE(a, b), pair).toBeGreaterThan(15);
		}
	});
});

describe('pool cells', () => {
	const node = (f: Flavor) => token('--bg-node', f);
	/** A load step's fill: its own color, or the cell's mix at the step's share. */
	function fill(level: number, f: Flavor): Rgb {
		const own = rule(`.pool-cell.l${level}`);
		const mix = rule('.pool-cell').get('background')!;
		return resolve(
			own.get('background-color') ?? mix.replace('var(--mix, 0%)', own.get('--mix')!),
			f
		);
	}
	/** The stripe's color in the draining cell's gradient. */
	const stripe = (f: Flavor) => {
		const gradient = rule('.pool-cell.draining').get('background-image')!;
		const stop = args(/^linear-gradient\((.*)\)$/.exec(gradient)![1]).find((s) =>
			s.endsWith(' 37% 63%')
		)!;
		return resolve(stop.replace(/ 37% 63%$/, ''), f);
	};

	it.each(FLAVORS)('load steps read in order against the node, in %s', (f) => {
		// The validator's ordinal checks: the lightest step 2:1 against its
		// surface, and 0.06 of OKLCH lightness between neighbors.
		expect(contrast(fill(1, f), node(f))).toBeGreaterThanOrEqual(2);
		const l = [node(f), fill(1, f), fill(2, f), fill(3, f)].map(lightness);
		for (let i = 1; i < l.length; i++) expect(Math.abs(l[i] - l[i - 1])).toBeGreaterThan(0.06);
	});

	it.each(FLAVORS)(
		'the draining stripe stands out from its edge, apart from queued, in %s',
		(f) => {
			const c = stripe(f);
			expect(contrast(c, node(f))).toBeGreaterThan(4.5);
			// Not the queued yellow, which in Macchiato is also the warning text's color.
			expect(deltaE(c, token('--state-queued', f))).toBeGreaterThan(8);
		}
	);

	it("the stripe is the draining dot's peach in Macchiato", () => {
		expect(stripe('macchiato')).toEqual(token('--state-unplaceable', 'macchiato'));
	});
});
