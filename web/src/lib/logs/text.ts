// Log text as the viewer shows it: Nix's rule for \r, tabs to 8, cell
// widths, bidi controls as visible markers and no other control
// characters. Pure, for the log worker.

const decoder = new TextDecoder('utf-8', { fatal: false });

/** A complete line's bytes as text; invalid UTF-8 becomes U+FFFD. */
export function decodeLine(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

/** The end of `bytes` without a UTF-8 sequence that is cut off, for a line still being written. */
export function completePrefix(bytes: Uint8Array): number {
	const i = bytes.length;
	// Walk back over at most 3 continuation bytes to the lead byte.
	let k = 0;
	while (k < 3 && i - k - 1 >= 0 && (bytes[i - k - 1] & 0xc0) === 0x80) k++;
	const lead = i - k - 1;
	if (lead < 0) return i;
	const b = bytes[lead];
	const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
	return need > k + 1 ? lead : i;
}

/**
 * Nix's rule for carriage returns: a \r not followed by \n moves back to the
 * start of the line, and what comes after overwrites what was there. So
 * "50%\r100%" shows "100%".
 */
export function resolveCR(line: string): string {
	if (!line.includes('\r')) return line;
	const out: string[] = [];
	let pos = 0;
	for (const ch of line) {
		if (ch === '\r') {
			pos = 0;
			continue;
		}
		out[pos++] = ch;
	}
	return out.join('');
}

/** Bidi controls that could reorder what a reader sees. */
const BIDI = /[‪-‮⁦-⁩]/;
export function isBidi(ch: string): boolean {
	return BIDI.test(ch);
}

/** The marker shown for a bidi control: ⟨U+202E⟩. */
export function bidiMarker(ch: string): string {
	return `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/** C0 controls but tab and ESC, and DEL, which the viewer drops. */
export function isDropped(code: number): boolean {
	return (code < 0x20 && code !== 0x09 && code !== 0x1b) || code === 0x7f;
}

let segmenter: Intl.Segmenter | null = null;

/** Two cells: East Asian wide and fullwidth characters, and emoji. */
function wide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

/** Zero cells: combining marks and other marks that join the character before. */
const MARK = /^\p{M}$/u;

/** The cells of one grapheme. */
function graphemeCells(g: string): number {
	const cp = g.codePointAt(0)!;
	if (MARK.test(g)) return 0;
	// An emoji presentation sequence takes two cells.
	if (g.includes('️') || wide(cp)) return 2;
	return 1;
}

/**
 * Cells of a line's visible text, with no ANSI, \r resolved and tabs to the
 * next multiple of 8. A line of code points below U+0300 takes one cell
 * per code point, found without Intl.Segmenter.
 */
export function cellWidth(text: string): number {
	let cells = 0;
	let simple = true;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0x300) {
			simple = false;
			break;
		}
		if (c === 9) cells += 8 - (cells % 8);
		else if (!isDropped(c)) cells++;
	}
	if (simple) return cells;
	return segmentedWidth(text);
}

function segmentedWidth(text: string): number {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	let cells = 0;
	for (const { segment } of segmenter.segment(text)) {
		if (segment === '\t') cells += 8 - (cells % 8);
		else if (segment.length === 1 && isDropped(segment.charCodeAt(0))) continue;
		else if (isBidi(segment)) cells += bidiMarker(segment).length;
		else cells += graphemeCells(segment);
	}
	return cells;
}

/** Graphemes of a line with their cells, for wrapping at exact cell positions. */
export function graphemes(text: string): { g: string; cells: number }[] {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
	const out: { g: string; cells: number }[] = [];
	for (const { segment } of segmenter.segment(text))
		out.push({ g: segment, cells: graphemeCells(segment) });
	return out;
}

/** Whether a line can be cut by code unit: every code point below U+0300 and no tab. */
export function isSimple(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0x300 || c === 9) return false;
	}
	return true;
}

/**
 * Walks what `text` shows from cell `col`, with tabs to the next multiple of
 * 8, bidi controls as markers and other controls dropped. It hands out runs
 * split at each marker and returns the cell after it.
 */
export function displayRuns(
	text: string,
	col: number,
	run: (text: string, bidi: boolean) => void
): number {
	let buf = '';
	for (const ch of text) {
		const c = ch.charCodeAt(0);
		if (c === 9) {
			const n = 8 - (col % 8);
			buf += ' '.repeat(n);
			col += n;
		} else if (isDropped(c)) continue;
		else if (isBidi(ch)) {
			if (buf) run(buf, false);
			buf = '';
			const m = bidiMarker(ch);
			run(m, true);
			col += m.length;
		} else {
			buf += ch;
			col++;
		}
	}
	if (buf) run(buf, false);
	return col;
}

/**
 * What a line shows, given its text without escapes: tabs as spaces to the
 * next multiple of 8, bidi controls as markers, other controls gone.
 */
export function displayText(text: string): string {
	let simple = true;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x20 || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
			simple = false;
			break;
		}
	}
	if (simple) return text;
	let out = '';
	displayRuns(text, 0, (t) => {
		out += t;
	});
	return out;
}
