import { constants, createZstdCompress, zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZstdStream } from './decode.ts';

// Text that does not compress to nothing, so a stream has several blocks.
let seed = 7;
const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const text =
	Array.from(
		{ length: 20_000 },
		(_, i) =>
			`line ${i}: ${Array.from({ length: 1 + (i % 40) }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join('')}`
	).join('\n') + '\n';
const input = new TextEncoder().encode(text);

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

describe('ZstdStream', () => {
	it('a stream split at every byte boundary decodes the same', () => {
		const z = new Uint8Array(zstdCompressSync(input));
		for (const step of [1, 7, 64, 1000, z.length]) {
			const got: Uint8Array[] = [];
			const s = new ZstdStream((b) => got.push(b.slice()));
			for (let i = 0; i < z.length; i += step) s.push(z.subarray(i, i + step));
			s.push(new Uint8Array(0), true);
			expect(new TextDecoder().decode(concat(got))).toBe(text);
			expect(s.bytes).toBe(input.length);
		}
	});

	it('a flushed message decodes before the next arrives', async () => {
		const c = createZstdCompress();
		const chunks: Uint8Array[] = [];
		c.on('data', (d: Buffer) => chunks.push(new Uint8Array(d)));
		const got: Uint8Array[] = [];
		const s = new ZstdStream((b) => got.push(b.slice()));
		const flush = () =>
			new Promise<void>((resolve) => c.flush(constants.ZSTD_e_flush, () => resolve()));
		c.write(new TextEncoder().encode('first line\n'));
		await flush();
		for (const ch of chunks.splice(0)) s.push(ch);
		expect(new TextDecoder().decode(concat(got))).toBe('first line\n');
		c.write(new TextEncoder().encode('second line\n'));
		await flush();
		for (const ch of chunks.splice(0)) s.push(ch);
		expect(new TextDecoder().decode(concat(got))).toBe('first line\nsecond line\n');
		c.end();
	});

	it('a broken stream keeps what decoded', () => {
		const z = new Uint8Array(zstdCompressSync(input));
		const got: Uint8Array[] = [];
		const s = new ZstdStream((b) => got.push(b.slice()));
		const half = Math.floor(z.length / 2);
		expect(s.push(z.subarray(0, half))).toBe(true);
		// The stream stops in the middle of a frame.
		s.push(new Uint8Array(0), true);
		expect(s.failed).not.toBeNull();
		expect(s.push(new Uint8Array([1]))).toBe(false);
		// What arrived is the start of the log.
		const kept = new TextDecoder().decode(concat(got));
		expect(kept.length).toBeGreaterThan(0);
		expect(text.startsWith(kept)).toBe(true);
	});
});
