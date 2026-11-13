import { describe, expect, it } from 'vitest';
import { EXACT_LOOKS, Looks, PLAIN, parseLine, plainText, stateAfter } from './ansi.ts';
import { xterm256 } from './contrast.ts';

const E = '\x1b';

describe('ansi', () => {
	it("256-color 0 to 15 use the theme's 16", () => {
		const looks = new Looks();
		const { segments } = parseLine(`${E}[38;5;1mred${E}[38;5;12mbrblue${E}[0m`, PLAIN, looks);
		expect(segments.map((s) => [s.text, s.look.c, s.look.s])).toEqual([
			['red', 'af1', ''],
			['brblue', 'af12', '']
		]);
	});

	it('256-color 16 to 255 and truecolor keep their own color', () => {
		const looks = new Looks();
		const { segments } = parseLine(`${E}[38;5;208morange ${E}[38;2;30;60;160mblue`, PLAIN, looks);
		expect(segments[0].look.c).toBe('');
		expect(segments[0].look.s).toMatch(
			/^color: light-dark\(rgb\(\d+ \d+ \d+\), rgb\(\d+ \d+ \d+\)\)$/
		);
		expect(segments[1].look.s).toMatch(/^color: light-dark\(/);
		expect(xterm256(208)).toEqual([255, 135, 0]);
	});

	it('colon sub-parameters', () => {
		const looks = new Looks();
		const a = parseLine(`${E}[38:5:208mx`, PLAIN, looks).segments[0].look;
		const b = parseLine(`${E}[38;5;208mx`, PLAIN, looks).segments[0].look;
		expect(a).toBe(b);
		const c = parseLine(`${E}[38:2::30:60:160mx`, PLAIN, looks).segments[0].look;
		const d = parseLine(`${E}[38;2;30;60;160mx`, PLAIN, looks).segments[0].look;
		expect(c).toBe(d);
		expect(parseLine(`${E}[4:3mx`, PLAIN, looks).segments[0].look.c).toBe('aul');
	});

	it('state carries across lines and checkpoints', () => {
		const looks = new Looks();
		const st = stateAfter(`${E}[1;32mgreen starts`, PLAIN);
		const next = parseLine('still green', st, looks);
		expect(next.segments[0].look.c).toBe('af2 abold');
		expect(stateAfter(`${E}[0m`, st)).toEqual(PLAIN);
		// A background forces the text to the foreground color, so a tint never puts color on color.
		expect(parseLine(`${E}[31;42mx`, PLAIN, looks).segments[0].look.c).toBe('ab2 abg');
		// Dim draws muted, inverse swaps.
		expect(parseLine(`${E}[2mx`, PLAIN, looks).segments[0].look.c).toBe('adim');
		expect(parseLine(`${E}[7;31mx`, PLAIN, looks).segments[0].look.c).toBe('ab1 abg');
	});

	it('OSC and other CSI are dropped', () => {
		const line = `a${E}]8;;javascript:alert(1)${E}\\label${E}]8;;${E}\\b${E}[2Kc${E}[?25ld${E}(Be`;
		expect(plainText(line)).toBe('alabelbcde');
		const looks = new Looks();
		expect(
			parseLine(line, PLAIN, looks)
				.segments.map((s) => s.text)
				.join('')
		).toBe('alabelbcde');
	});

	it('past 4,096 exact styles new ones fall back to the nearest of the 16', () => {
		const looks = new Looks();
		for (let i = 0; i < EXACT_LOOKS + 50; i++) {
			const r = i % 256;
			const g = Math.floor(i / 256) % 256;
			looks.of(stateAfter(`${E}[38;2;${r};${g};77m`, PLAIN));
		}
		expect(looks.exactCount).toBe(EXACT_LOOKS);
		const late = looks.of(stateAfter(`${E}[38;2;250;10;10m`, PLAIN));
		expect(late.s).toBe('');
		expect(late.c).toMatch(/^af(1|9)$/);
	});
});
