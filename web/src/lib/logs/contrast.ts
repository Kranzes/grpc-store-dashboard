// Colors from 256-color and truecolor escapes, kept as close to their own
// as AA allows on the log's background. In OKLCH the hue stays, the
// lightness moves away from the background until the color reaches 4.5:1,
// and the chroma drops only where that lightness is out of the sRGB gamut.
// A color that already passes stays as it is.

export type Rgb = readonly [number, number, number];

/** The log background, theme --log-bg: Latte base and Macchiato crust. */
export const LATTE_BG: Rgb = [0xef, 0xf1, 0xf5];
export const MACCHIATO_BG: Rgb = [0x18, 0x19, 0x26];

export const AA = 4.5;

const lin = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const delin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function luminance([r, g, b]: Rgb): number {
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export type Lab = [number, number, number];

export function toOklab([r, g, b]: Rgb): Lab {
	const R = lin(r);
	const G = lin(g);
	const B = lin(b);
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	];
}

/** Linear sRGB of an OKLab color, unclamped. */
function oklabToLinear([L, a, b]: Lab): Lab {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
}

const EPS = 1e-4;
const inGamut = (c: Lab) => c.every((x) => x >= -EPS && x <= 1 + EPS);

export function toRgb(lab: Lab): Rgb {
	const c = oklabToLinear(lab);
	return c.map((x) =>
		Math.round(Math.min(1, Math.max(0, delin(Math.min(1, Math.max(0, x))))) * 255)
	) as unknown as Rgb;
}

export type Lch = Readonly<{ l: number; c: number; h: number }>;

export function toOklch(rgb: Rgb): Lch {
	const [l, a, b] = toOklab(rgb);
	return { l, c: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/** The color at lightness l and hue h, with the most chroma up to c that sRGB can show. */
function atLightness(l: number, c: number, h: number): Rgb {
	const lab = (cc: number): Lab => [l, cc * Math.cos(h), cc * Math.sin(h)];
	if (inGamut(oklabToLinear(lab(c)))) return toRgb(lab(c));
	let lo = 0;
	let hi = c;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklabToLinear(lab(mid)))) lo = mid;
		else hi = mid;
	}
	return toRgb(lab(lo));
}

/**
 * The color as close to `rgb` as reaches 4.5:1 on `bg`: the same hue,
 * lightness moved away from the background as little as needed.
 */
export function adjust(rgb: Rgb, bg: Rgb): Rgb {
	if (contrast(rgb, bg) >= AA) return rgb;
	const { l, c, h } = toOklch(rgb);
	const dark = luminance(bg) < 0.18;
	// Search the lightness between the color's and the far end.
	let lo = l;
	let hi = dark ? 1 : 0;
	let best = atLightness(hi, c, h);
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		const cand = atLightness(mid, c, h);
		if (contrast(cand, bg) >= AA) {
			best = cand;
			hi = mid;
		} else lo = mid;
	}
	// Rounding to 8 bits can land just under 4.5:1; step on until it passes.
	let step = 0;
	while (contrast(best, bg) < AA && step++ < 64) {
		const t = toOklch(best);
		best = atLightness(Math.min(1, Math.max(0, t.l + (dark ? 0.004 : -0.004))), c, h);
	}
	return best;
}

/** The 256-color palette's RGB for indexes 16 to 255. */
export function xterm256(n: number): Rgb {
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return [v, v, v];
	}
	const k = n - 16;
	const step = (x: number) => (x === 0 ? 0 : 55 + x * 40);
	return [step(Math.floor(k / 36)), step(Math.floor(k / 6) % 6), step(k % 6)];
}

/** The 16 base colors as xterm draws them, for the nearest-of-16 fallback. */
const XTERM16: readonly Rgb[] = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255]
];
const XTERM16_LAB: readonly Lab[] = XTERM16.map(toOklab);

/** The nearest of the 16 by OKLab distance. */
export function nearest16(rgb: Rgb): number {
	const a = toOklab(rgb);
	let best = 0;
	let dist = Infinity;
	XTERM16_LAB.forEach((b, i) => {
		const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
		if (d < dist) {
			dist = d;
			best = i;
		}
	});
	return best;
}

const cache = new Map<number, string>();

/** `color: light-dark(<Latte>, <Macchiato>)` for an exact color, computed once per RGB. */
export function exactColor(rgb: Rgb): string {
	const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
	let css = cache.get(key);
	if (!css) {
		const a = adjust(rgb, LATTE_BG);
		const b = adjust(rgb, MACCHIATO_BG);
		css = `light-dark(rgb(${a.join(' ')}), rgb(${b.join(' ')}))`;
		cache.set(key, css);
	}
	return css;
}
