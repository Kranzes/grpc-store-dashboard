// Visible and spoken text in the map and the panels says one term per
// concept. This reads the sources: markup text,
// the attributes people see or hear, and sentence-like strings in code. The
// data layer keeps the protocol's names, so only flow and ui are read.

import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['../flow/**/*.{ts,svelte}', './**/*.{ts,svelte}'], {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/**
 * The "Not" column of the terms. Connected and disconnected stay for a
 * state, as in "No builders connected" and the connection pill, so the test
 * catches only their use for builders coming and going. "Sent" and "client
 * uploads" stay too, for the demo's network and for inputs a client sends.
 */
const NOT =
	/\b(workers?|machines?|platforms?|jobs?|drvs?|wants?|wanted|dispatch\w*|builds\/s|cache answers?|answered from the cache|upstream caches?|pending|given back|clusters?|canvas|edges?|leaders?|that (?:dis)?connected|connected or disconnected|send|sending|downloads?|downloaded|hosts?|arch)\b/i;

/** Test files and fixtures hold model data, not text people see. */
const skip = (path: string) => /\.test\.ts$|fixtures\.ts$|fake-store\.ts$|probe\.ts$/.test(path);

const strip = (code: string) =>
	code
		.replace(/\/\*[^]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
		.replace(/^\s*import\b[^;]*;/gm, '');

/** Strings in code that read as text, which hold a space or start with a capital. */
function codeStrings(code: string): string[] {
	const out: string[] = [];
	for (const m of strip(code).matchAll(
		/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
	)) {
		const s = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, '');
		if (/\S \S/.test(s) || /^[A-Z]/.test(s)) out.push(s);
	}
	return out;
}

/** Markup text and the attributes that are seen or heard, plus the strings of the script. */
function svelteStrings(src: string): string[] {
	const scripts = [...src.matchAll(/<script[^>]*>([^]*?)<\/script>/g)].map((m) => m[1]);
	const markup = src
		.replace(/<script[^>]*>[^]*?<\/script>/g, '')
		.replace(/<style[^>]*>[^]*?<\/style>/g, '')
		.replace(/<!--[^]*?-->/g, '');
	const text = [...markup.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
	const attrs = [
		...markup.matchAll(/\b(?:title|aria-label|label|placeholder|alt)="([^"{]+)"/g)
	].map((m) => m[1]);
	const exprs = [...markup.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
	return [...text, ...attrs, ...codeStrings([...scripts, ...exprs].join('\n'))];
}

describe('terms', () => {
	it('no visible or spoken string in the map or the panels uses a "Not" term', () => {
		// The glob found the sources, so an empty result means something.
		expect(Object.keys(sources).length).toBeGreaterThan(40);
		const found: string[] = [];
		for (const [path, src] of Object.entries(sources)) {
			if (skip(path)) continue;
			const strings = path.endsWith('.svelte') ? svelteStrings(src) : codeStrings(src);
			for (const s of strings) {
				const m = s.match(NOT);
				if (m) found.push(`${path}: "${m[0]}" in "${s.trim()}"`);
			}
		}
		expect(found).toEqual([]);
	});

	it('catches a "Not" term in markup, an attribute and a string', () => {
		const svelte = `<script>const a = 'Sent to the worker';</script>\n<p title="One edge">On the canvas</p>`;
		expect(svelteStrings(svelte).filter((s) => NOT.test(s))).toEqual([
			'On the canvas',
			'One edge',
			'Sent to the worker'
		]);
		// Code names, ids and comments are not text.
		expect(codeStrings(`// the worker\nconst k = 'want'; const id = \`want:\${g}\`;`)).toEqual([]);
	});
});
