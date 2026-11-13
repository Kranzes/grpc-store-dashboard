import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LogEngine } from './engine.ts';
import { HEAD_MAX, MiB, TAIL_MAX } from './limits.ts';

const enc = new TextEncoder();

/** A failed stdenv log of about `mib` MiB: phases with filler lines, and an error at the end. */
function failedLog(mib: number): Uint8Array {
	const out: string[] = [];
	let size = 0;
	const phases = ['unpackPhase', 'configurePhase', 'buildPhase'];
	for (let p = 0; size < mib * MiB; p++) {
		const name = p < phases.length ? phases[p] : `step${p}Phase`;
		out.push(`Running phase: ${name}`);
		for (let i = 0; i < 20_000; i++) {
			const l = `cc -O2 -c src/file${p}_${i}.c -o file${p}_${i}.o ${'x'.repeat(40)}`;
			out.push(l);
			size += l.length + 1;
		}
	}
	out.push('Running phase: checkPhase', 'src/last.c:12:5: error: oops', 'make: *** [all] Error 1');
	return enc.encode(out.join('\n') + '\n');
}

function info(log: Uint8Array, offset: number) {
	let k = offset;
	while (k < log.length && log[k - 1] !== 10) k++;
	let firstLine = 0;
	for (let i = 0; i < k; i++) if (log[i] === 10) firstLine++;
	return { offset: k, firstLine, size: log.length };
}

describe('LogEngine, a failed build whose tail comes first', () => {
	const log = failedLog(80);
	const head = log.subarray(0, HEAD_MAX);
	const t = info(log, log.length - TAIL_MAX);
	const tail = log.subarray(t.offset);
	const lines = log.reduce((n, b) => n + (b === 10 ? 1 : 0), 0);

	it('shows the tail before the head ends, then puts the head in front', () => {
		const e = new LogEngine();
		e.beginCall(1, 'head', { offset: 0, firstLine: 0, size: log.length });
		e.zstd(1, zstdCompressSync(head.subarray(0, MiB)));
		e.beginCall(2, 'tail', t, { tailFirst: true });
		e.zstd(2, zstdCompressSync(tail));
		expect(e.endCall(2)).toBeNull();
		e.settle();
		// The end is in: the last line and the first error, with exact numbers.
		expect(e.progress().lines).toBe(lines);
		const first = e.errors().first!;
		expect(first).toBe(lines - 1);
		expect(e.store.gap).toEqual({ firstHidden: 1, lastHidden: t.firstLine });
		// The tail's lines before its first header stay at the top level.
		expect(e.tree.chain(e.store.slotOf(t.firstLine + 1) as number)).toEqual([]);
		const tailGroups = e.groups().length;
		const errRow = e.reveal(first) as number;
		// The head arrives in its own call, as after a break, and ends.
		e.endCall(1, false);
		e.beginCall(3, 'more', null, { of: 1 });
		e.zstd(3, zstdCompressSync(head.subarray(MiB)));
		const moved = e.endCall(3)!;
		expect(moved).not.toBeNull();
		e.settle();
		// Rows above grew by `shift`; the error is that much lower, its groups still open.
		expect(e.reveal(first)).toBe(errRow + moved.shift);
		expect(moved.shift).toBeGreaterThan(0);
		// Every old group has a new id, after the head's.
		expect(moved.remap).toHaveLength(tailGroups);
		expect(moved.remap.every((id) => id !== null && id >= e.groups().length - tailGroups)).toBe(
			true
		);
		// The head's groups come folded, and the gap is the lines between.
		const headGroups = e.groups().filter((g) => g.id < e.groups().length - tailGroups);
		expect(headGroups.length).toBeGreaterThan(0);
		expect(headGroups.every((g) => e.rows.folded.has(g.id))).toBe(true);
		const h = e.store.head;
		expect(e.store.gap).toEqual({ firstHidden: h.count + 1, lastHidden: t.firstLine });
		expect(e.store.lineOf(0)).toBe(1);
		expect(e.progress().lines).toBe(lines);
		expect(e.errors().first).toBe(first);
	});

	it('a built build still waits for the head', () => {
		const e = new LogEngine();
		e.beginCall(1, 'head', { offset: 0, firstLine: 0, size: log.length });
		e.zstd(1, zstdCompressSync(head));
		e.beginCall(2, 'tail', t);
		e.zstd(2, zstdCompressSync(tail));
		e.endCall(2);
		e.settle();
		expect(e.store.parts).toHaveLength(1);
		expect(e.endCall(1)).toBeNull();
		e.settle();
		expect(e.store.parts).toHaveLength(2);
		expect(e.progress().lines).toBe(lines);
	});

	it('a head that broke goes on in a more call, and the tail waits for it', () => {
		const e = new LogEngine();
		e.beginCall(1, 'head', { offset: 0, firstLine: 0, size: log.length });
		e.zstd(1, zstdCompressSync(head.subarray(0, MiB)));
		e.beginCall(2, 'tail', t);
		e.zstd(2, zstdCompressSync(tail));
		e.endCall(2);
		e.endCall(1, false);
		e.beginCall(3, 'more', { offset: MiB, firstLine: 0, size: log.length }, { of: 1 });
		e.zstd(3, zstdCompressSync(head.subarray(MiB)));
		e.endCall(3);
		e.settle();
		expect(e.store.parts).toHaveLength(2);
		expect(e.store.head.bytes).toBe(e.headComplete);
		expect(e.progress()).toMatchObject({ lines, idle: true });
	});

	it('a tail that broke goes on in a more call, after the head', () => {
		const e = new LogEngine();
		e.beginCall(1, 'head', { offset: 0, firstLine: 0, size: log.length });
		e.zstd(1, zstdCompressSync(head.subarray(0, MiB)));
		e.beginCall(2, 'tail', t);
		e.zstd(2, zstdCompressSync(tail.subarray(0, MiB)));
		e.endCall(2, false);
		e.beginCall(4, 'more', { offset: t.offset + MiB, firstLine: 0, size: log.length }, { of: 2 });
		e.zstd(4, zstdCompressSync(tail.subarray(MiB)));
		e.endCall(4);
		e.zstd(1, zstdCompressSync(head.subarray(MiB)));
		e.endCall(1);
		e.settle();
		expect(e.store.parts).toHaveLength(2);
		expect(e.store.tail.firstLine).toBe(t.firstLine);
		expect(e.progress().lines).toBe(lines);
	});
});

describe('LogEngine, one call past 64 MiB', () => {
	// store.test.ts checks what the ring keeps. This checks that a follow call turns it on.
	it('a follow call keeps its log as a head and a ring', () => {
		const text = ['Running phase: buildPhase', 'make'];
		const e = new LogEngine();
		e.beginCall(1, 'head', { offset: 0, firstLine: 0, size: 0 }, { whole: true });
		e.zstd(1, zstdCompressSync(enc.encode(text.join('\n') + '\n')));
		e.endCall(1);
		e.settle();
		expect(e.store.ring).toBe(true);
		expect(e.progress().lines).toBe(text.length);
	});

	it('a fold stays with its group when the ring drops the groups before it', () => {
		const log = failedLog(90);
		const e = new LogEngine();
		e.beginCall(1, 'head', null);
		const feed = (from: number, to: number) => {
			for (let k = from; k < to; k += MiB) e.push(log.subarray(k, Math.min(to, k + MiB)));
			return e.settle();
		};
		feed(0, 80 * MiB);
		const header = (id: number) => e.store.lineOf(e.groups()[id].headerSlot);
		// The tail's groups: the first goes when the ring moves on, the tenth stays.
		const tail = e.groups().filter((g) => g.headerSlot > e.store.head.count);
		const first = header(tail[0].id)!;
		const line = header(tail[9].id);
		e.fold([tail[9].id], false, null);
		const moved = feed(80 * MiB, log.length)!;
		expect(e.store.gap!.lastHidden).toBeGreaterThan(first);
		const now = e.groups().find((g) => header(g.id) === line)!;
		expect([...e.rows.folded]).toEqual([now.id]);
		// The viewer hears how ids moved; the head's groups keep theirs.
		expect(moved.remap[tail[9].id]).toBe(now.id);
		expect(moved.remap[0]).toBe(0);
	}, 20_000);
});
