import { describe, expect, it, vi } from 'vitest';
import { LogStore } from './store.ts';
import { cellWidth, displayText, resolveCR } from './text.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('text', () => {
	it('a character split across chunks', () => {
		const store = new LogStore();
		const lines: string[] = [];
		store.onLine = (e) => lines.push(e.text);
		const b = enc('héllo 日本\nnext\n');
		for (let i = 0; i < b.length; i++) store.push(b.subarray(i, i + 1));
		expect(lines).toEqual(['héllo 日本', 'next']);
		expect(store.raw(0)).toBe('héllo 日本');
	});

	it('\\r overwrites the line as Nix does', () => {
		expect(resolveCR('50%\r100%')).toBe('100%');
		expect(resolveCR('abcdef\rXY')).toBe('XYcdef');
		expect(resolveCR('done\r')).toBe('done');
		expect(resolveCR('plain')).toBe('plain');
	});

	it('tabs to 8', () => {
		expect(cellWidth('a\tb')).toBe(9);
		expect(cellWidth('12345678\tx')).toBe(17);
		expect(displayText('a\tb')).toBe('a       b');
	});

	it('wide characters count 2', () => {
		expect(cellWidth('日本')).toBe(4);
		expect(cellWidth('a😀b')).toBe(4);
	});

	it('combining marks count 0', () => {
		expect(cellWidth('é')).toBe(1);
		expect(cellWidth('ñ')).toBe(1);
	});

	it('ASCII and Latin-1 lines never reach the segmenter', () => {
		const spy = vi.spyOn(Intl, 'Segmenter');
		expect(cellWidth('plain ascii line with café and ÿ')).toBe(32);
		expect(cellWidth('Latin Extended: ā ő ž')).toBe(21);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('invalid UTF-8 becomes U+FFFD', () => {
		const store = new LogStore();
		store.push(new Uint8Array([0x61, 0xff, 0x62, 0x0a]));
		expect(store.raw(0)).toBe('a�b');
	});

	it('bidi controls become markers', () => {
		expect(displayText('abc‮def')).toBe('abc⟨U+202E⟩def');
		expect(displayText('a\u0007b')).toBe('ab');
	});
});
