// SGR escapes into styled segments: bold, dim, italic, underline, inverse,
// the 16 colors, 256 colors and truecolor, with colon sub-parameters such as
// ESC[38:5:208m. It drops every other CSI, OSC and escape, OSC 8 links
// included. The 16 colors are theme tokens; contrast.ts adjusts an exact color
// for contrast once, and the color draws inline as light-dark().

import { exactColor, nearest16, xterm256, type Rgb } from './contrast.ts';

/** A color: -1 for the default, 0 to 15 for the theme's 16, or an exact RGB. */
export type Color = number | Rgb;

export type SgrState = Readonly<{
	fg: Color;
	bg: Color;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
}>;

export const PLAIN: SgrState = Object.freeze({
	fg: -1,
	bg: -1,
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	inverse: false
});

/** How a segment draws: class names from the fixed table, and an inline style for exact colors. */
export type Look = Readonly<{ c: string; s: string }>;

export type Segment = { text: string; look: Look };

/** At most this many looks with exact colors per log; later ones use the nearest of the 16. */
export const EXACT_LOOKS = 4096;

/** Looks interned per log, so equal styles share one object. */
export class Looks {
	readonly #byKey = new Map<string, Look>();
	#exact = 0;

	get exactCount(): number {
		return this.#exact;
	}

	of(st: SgrState): Look {
		let fg = st.inverse ? st.bg : st.fg;
		let bg = st.inverse ? (st.fg === -1 ? 7 : st.fg) : st.bg;
		const exact = typeof fg !== 'number' || typeof bg !== 'number';
		const key = `${fg}|${bg}|${+st.bold}${+st.dim}${+st.italic}${+st.underline}`;
		const had = this.#byKey.get(key);
		if (had) return had;
		if (exact && this.#exact >= EXACT_LOOKS) {
			// Past the cap, the nearest of the 16.
			if (typeof fg !== 'number') fg = nearest16(fg);
			if (typeof bg !== 'number') bg = nearest16(bg);
			return this.of({ ...st, inverse: false, fg, bg });
		}
		if (exact) this.#exact++;
		const cls: string[] = [];
		const css: string[] = [];
		// A background forces the text to --fg, so a highlight never sits behind colored text.
		if (bg !== -1) {
			if (typeof bg === 'number') cls.push(`ab${bg}`);
			else
				css.push(
					`--tint: ${exactColor(bg)}`,
					'background: color-mix(in srgb, var(--tint) 22%, transparent)'
				);
			cls.push('abg');
		} else if (st.dim) cls.push('adim');
		else if (fg !== -1) {
			if (typeof fg === 'number') cls.push(`af${fg}`);
			else css.push(`color: ${exactColor(fg)}`);
		}
		if (st.bold) cls.push('abold');
		if (st.italic) cls.push('aital');
		if (st.underline) cls.push('aul');
		const look: Look = { c: cls.join(' '), s: css.join('; ') };
		this.#byKey.set(key, look);
		return look;
	}
}

/** The parameters of one SGR sequence, colon sub-parameters kept together: "38:5:208". */
function apply(st: SgrState, params: string): SgrState {
	const s = { ...st } as { -readonly [K in keyof SgrState]: SgrState[K] };
	const parts = params === '' ? ['0'] : params.split(';');
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.includes(':')) {
			const sub = p.split(':').map((x) => (x === '' ? 0 : Number(x)));
			const [code, mode] = sub;
			if (code === 38 || code === 48) {
				// 38:5:n, 38:2:r:g:b or 38:2:<colorspace>:r:g:b
				let color: Color | null = null;
				if (mode === 5) color = indexed(sub[2]);
				else if (mode === 2) {
					const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
					color = rgbOf(rgb);
				}
				if (color !== null) {
					if (code === 38) s.fg = color;
					else s.bg = color;
				}
			} else if (code === 4) s.underline = mode !== 0;
			continue;
		}
		const n = p === '' ? 0 : Number(p);
		if (!Number.isFinite(n)) continue;
		if (n === 0) Object.assign(s, PLAIN);
		else if (n === 1) s.bold = true;
		else if (n === 2) s.dim = true;
		else if (n === 3) s.italic = true;
		else if (n === 4) s.underline = true;
		else if (n === 7) s.inverse = true;
		else if (n === 22) s.bold = s.dim = false;
		else if (n === 23) s.italic = false;
		else if (n === 24) s.underline = false;
		else if (n === 27) s.inverse = false;
		else if (n >= 30 && n <= 37) s.fg = n - 30;
		else if (n === 39) s.fg = -1;
		else if (n >= 40 && n <= 47) s.bg = n - 40;
		else if (n === 49) s.bg = -1;
		else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
		else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
		else if (n === 38 || n === 48) {
			const mode = Number(parts[i + 1]);
			let color: Color | null = null;
			if (mode === 5) {
				color = indexed(Number(parts[i + 2]));
				i += 2;
			} else if (mode === 2) {
				color = rgbOf(parts.slice(i + 2, i + 5).map(Number));
				i += 4;
			} else i += 1;
			if (color !== null) {
				if (n === 38) s.fg = color;
				else s.bg = color;
			}
		}
	}
	return s;
}

/** 256-color index: 0 to 15 are the theme's 16, the rest exact. */
function indexed(n: number): Color | null {
	if (!Number.isInteger(n) || n < 0 || n > 255) return null;
	return n < 16 ? n : xterm256(n);
}

function rgbOf(v: number[]): Rgb | null {
	if (v.length < 3 || v.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return null;
	return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
}

/**
 * Walk a line's escapes: `text` for each run of text between them, `sgr`
 * for each SGR sequence's parameters. Every other escape is skipped.
 */
function scan(line: string, text: (t: string) => void, sgr: (params: string) => void) {
	let i = 0;
	const n = line.length;
	while (i < n) {
		if (line.charCodeAt(i) !== 0x1b) {
			let j = i;
			while (j < n && line.charCodeAt(j) !== 0x1b) j++;
			text(line.slice(i, j));
			i = j;
			continue;
		}
		const next = line.charCodeAt(i + 1);
		if (next === 0x5b) {
			// CSI: parameters, intermediates, a final byte. Drop one cut off at the end.
			let j = i + 2;
			while (j < n && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3f) j++;
			while (j < n && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) j++;
			if (j >= n) return;
			if (line[j] === 'm') {
				const params = line.slice(i + 2, j);
				if (/^[\d;:]*$/.test(params)) sgr(params);
			}
			i = j + 1;
		} else if (next === 0x5d) {
			// OSC, OSC 8 links included, runs up to BEL or ST and is dropped; the
			// link's label stays as text.
			let j = i + 2;
			while (
				j < n &&
				line.charCodeAt(j) !== 0x07 &&
				!(line.charCodeAt(j) === 0x1b && line[j + 1] === '\\')
			)
				j++;
			i = j >= n ? n : line.charCodeAt(j) === 0x07 ? j + 1 : j + 2;
		} else {
			// Any other escape: ESC, intermediates such as "(" and a final byte.
			let j = i + 1;
			while (j < n && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) j++;
			i = j + 1;
		}
	}
}

/**
 * One line, with no newline and \r already resolved, into segments, from the
 * style in effect at its start. Returns the style at its end.
 */
export function parseLine(
	line: string,
	start: SgrState,
	looks: Looks
): { segments: Segment[]; end: SgrState } {
	const segments: Segment[] = [];
	let st = start;
	let text = '';
	const flush = () => {
		if (text) segments.push({ text, look: looks.of(st) });
		text = '';
	};
	scan(
		line,
		(t) => (text += t),
		(params) => {
			flush();
			st = apply(st, params);
		}
	);
	flush();
	return { segments, end: st };
}

/** A line's text without its escapes, exactly as parseLine's segments spell it. */
export function plainText(line: string): string {
	if (!line.includes('\x1b')) return line;
	let out = '';
	scan(
		line,
		(t) => (out += t),
		() => {}
	);
	return out;
}

/** The style at the end of a line, without building segments. */
export function stateAfter(line: string, start: SgrState): SgrState {
	if (!line.includes('\x1b')) return start;
	let st = start;
	scan(
		line,
		() => {},
		(params) => (st = apply(st, params))
	);
	return st;
}
