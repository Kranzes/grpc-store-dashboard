import { describe, expect, it } from 'vitest';
import { HEAD_MAX, MiB, TAIL_MAX, WHOLE_MAX } from './limits.ts';
import { LogStore } from './store.ts';

const enc = new TextEncoder();
/** Line i, 1-based, of a big test log, about 100 bytes long. */
const lineText = (i: number) => `line ${i} ${'x'.repeat(80 + (i % 13))}`;

/** Lines from..to, 1-based, in pieces of about 1 MiB. */
function* pieces(from: number, to: number): Generator<Uint8Array> {
	let buf: string[] = [];
	let size = 0;
	for (let i = from; i <= to; i++) {
		const l = lineText(i);
		buf.push(l, '\n');
		size += l.length + 1;
		if (size > MiB) {
			yield enc.encode(buf.join(''));
			buf = [];
			size = 0;
		}
	}
	if (buf.length) yield enc.encode(buf.join(''));
}

/** Byte offset of line n's start in the test log. */
function offsetOf(n: number): number {
	let o = 0;
	for (let i = 1; i < n; i++) o += lineText(i).length + 1;
	return o;
}

const N = Math.ceil((WHOLE_MAX * 1.25) / 100);

let ringStore: { s: LogStore; decoded: number } | undefined;
/** Lines 1 to N in one call, as an old server sends them, and the bytes pushed. Built once. */
function oneCall() {
	if (ringStore) return ringStore;
	const s = new LogStore();
	s.ring = true;
	let decoded = 0;
	for (const p of pieces(1, N)) {
		s.push(p);
		decoded += p.length;
	}
	return (ringStore = { s, decoded });
}

describe('LogStore', () => {
	it('line numbers stay exact past 64 MiB (one call, old server)', () => {
		const { s, decoded } = oneCall();
		expect(s.gap).not.toBeNull();
		expect(s.lastLine).toBe(N);
		// The last line is the log's last line, numbered exactly.
		const last = s.slots - 1;
		expect(s.lineOf(last)).toBe(N);
		expect(s.raw(last)).toBe(lineText(N));
		// The first line after the gap has its own number.
		const firstTail = s.head.count + 1;
		const n = s.lineOf(firstTail)!;
		expect(s.raw(firstTail)).toBe(lineText(n));
		expect(s.decoded).toBe(decoded);
	});

	it('a tail placed by first_line numbers its lines exactly', () => {
		const s = new LogStore();
		const total = 200_000;
		for (const p of pieces(1, 30_000)) s.push(p);
		const tailFirst = 150_000;
		s.startTail(offsetOf(tailFirst + 1), tailFirst);
		for (const p of pieces(tailFirst + 1, total)) s.push(p);
		expect(s.gap).toMatchObject({ firstHidden: 30_001, lastHidden: tailFirst });
		expect(s.lineOf(s.head.count + 1)).toBe(tailFirst + 1);
		expect(s.raw(s.head.count + 1)).toBe(lineText(tailFirst + 1));
		expect(s.lastLine).toBe(total);
		expect(s.slotOf(100_000)).toBe('gap');
		expect(s.slotOf(tailFirst + 1)).toBe(s.head.count + 1);
		expect(s.slotOf(5)).toBe(4);
	});

	it('a tail that starts where the head ended leaves no gap', () => {
		const s = new LogStore();
		for (const p of pieces(1, 1000)) s.push(p);
		s.startTail(offsetOf(1001), 1000);
		for (const p of pieces(1001, 2000)) s.push(p);
		expect(s.gap).toBeNull();
		expect(s.lastLine).toBe(2000);
		expect(s.raw(1999)).toBe(lineText(2000));
	});

	it('the head ends at its last newline', () => {
		const s = new LogStore();
		s.push(enc.encode('one\ntwo\nthr'));
		expect(s.head.count).toBe(3);
		s.startTail(offsetOf(500), 499);
		// The cut-off "thr" is dropped.
		expect(s.head.count).toBe(2);
		expect(s.raw(1)).toBe('two');
	});

	it('the first 16 MiB and last 48 MiB are kept', () => {
		const { s } = oneCall();
		const headBytes = s.head.bytes - s.head.base;
		expect(headBytes).toBeGreaterThanOrEqual(HEAD_MAX);
		expect(headBytes).toBeLessThan(HEAD_MAX + 200);
		// A one-call log of at most 64 MiB keeps everything, with no gap.
		const small = new LogStore();
		small.ring = true;
		for (const p of pieces(1, Math.floor(WHOLE_MAX / 110))) small.push(p);
		expect(small.gap).toBeNull();
		expect(small.lastLine).toBe(Math.floor(WHOLE_MAX / 110));
		expect(small.raw(small.slots - 1)).toBe(lineText(small.lastLine));
		const t = s.tail;
		expect(t.bytes - t.base).toBeLessThanOrEqual(TAIL_MAX + 2 * MiB);
		expect(t.bytes - t.base).toBeGreaterThan(TAIL_MAX - MiB);
	});

	it('the head of a one-call log ends at its first line end past 16 MiB, wherever a piece ends', () => {
		const line = 'x'.repeat(63) + '\n';
		const fill = enc.encode(line.repeat(HEAD_MAX / 64 - 1));
		const rest = enc.encode(line.repeat(MiB / 64));
		// The line across 16 MiB ends with its piece, or goes on in the next one.
		for (const across of [['y'.repeat(127) + '\n'], ['y'.repeat(100), 'y'.repeat(27) + '\n']]) {
			const s = new LogStore();
			s.ring = true;
			s.push(fill);
			for (const p of across) s.push(enc.encode(p));
			for (let i = 0; i < 80; i++) s.push(rest);
			expect(s.head.bytes).toBe(HEAD_MAX + 64);
			expect(s.gap).not.toBeNull();
			expect(s.tail.bytes - s.tail.base).toBeLessThanOrEqual(TAIL_MAX + MiB);
		}
	});

	it('decoded byte count equals the input', () => {
		const s = new LogStore();
		let n = 0;
		for (const p of pieces(1, 5000)) {
			s.push(p);
			n += p.length;
		}
		expect(s.decoded).toBe(n);
		const raw = s.rawPages();
		expect(raw.reduce((a, b) => a + b.length, 0)).toBe(n);
	});
});
