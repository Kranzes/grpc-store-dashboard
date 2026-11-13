import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { FromWorker, SearchInfo, ToWorker } from './protocol.ts';

const enc = new TextEncoder();

// worker.ts as the viewer talks to it: messages in through self.onmessage,
// answers out through self.postMessage.
const posts: FromWorker[] = [];
const g = globalThis as unknown as {
	self: { postMessage: (m: FromWorker) => void; onmessage?: (e: { data: ToWorker }) => void };
};
g.self = { postMessage: (m) => posts.push(m) };
await import('./worker.ts');
const send = (m: ToWorker) => g.self.onmessage!({ data: m });

/** The last search answer, once the worker has posted nothing for 300 ms. */
async function searched(): Promise<SearchInfo> {
	let n = -1;
	while (n !== posts.length) {
		n = posts.length;
		await new Promise((ok) => setTimeout(ok, 300));
	}
	return posts.findLast((m) => m.t === 'search')!.s;
}

describe('worker search', () => {
	it('searches a query typed while the last one still runs', async () => {
		const lines: string[] = [];
		for (let i = 0; i < 300_000; i++) lines.push(`cc -O2 -c src/file${i}.c -o file${i}.o`);
		lines.push('undefined reference to foo');
		send({ t: 'call', call: 1, part: 'head', info: { offset: 0, firstLine: 0, size: 0 } });
		send({ t: 'zstd', call: 1, data: zstdCompressSync(enc.encode(lines.join('\n') + '\n')) });
		send({ t: 'end', call: 1, complete: true });
		send({ t: 'search', text: 'undefined', caseSensitive: false, onlyMatching: false });
		// The next keystroke, before the first slice's timer fires.
		send({ t: 'search', text: 'undefined r', caseSensitive: false, onlyMatching: false });
		expect(await searched()).toMatchObject({ complete: true, count: 1 });
	}, 20_000);

	it('searches lines that arrive after the search ended, and the rest of an open line', async () => {
		send({ t: 'restart' });
		send({ t: 'call', call: 2, part: 'head', info: { offset: 0, firstLine: 0, size: 0 } });
		send({ t: 'zstd', call: 2, data: zstdCompressSync(enc.encode('a needle\nhay ne')) });
		send({ t: 'search', text: 'needle', caseSensitive: false, onlyMatching: false });
		expect(await searched()).toMatchObject({ complete: true, count: 1 });
		// The open line ends with a hit, and a new line has one.
		send({ t: 'zstd', call: 2, data: zstdCompressSync(enc.encode('edle\nanother needle\n')) });
		expect(await searched()).toMatchObject({ complete: true, count: 3 });
	}, 20_000);
});

describe('worker groups', () => {
	it('gives a group its header line, also past the hidden middle of a log', async () => {
		send({ t: 'restart' });
		posts.length = 0;
		const head = 'Running phase: unpackPhase\nunpacking\n';
		// The tail starts 1000 lines in, at line 1001.
		const before = head + 'x\n'.repeat(998);
		const tail = 'Running phase: buildPhase\nmake\n';
		const size = enc.encode(before + tail).length;
		const info = { offset: enc.encode(before).length, firstLine: 1000, size };
		send({ t: 'call', call: 1, part: 'head', info: { offset: 0, firstLine: 0, size } });
		send({ t: 'zstd', call: 1, data: zstdCompressSync(enc.encode(head)) });
		send({ t: 'end', call: 1, complete: true });
		send({ t: 'call', call: 2, part: 'tail', info });
		send({ t: 'zstd', call: 2, data: zstdCompressSync(enc.encode(tail)) });
		send({ t: 'end', call: 2, complete: true });
		// Wait for the tree that holds the tail's group too.
		const groups = await vi.waitFor(
			() => {
				const last = posts.findLast((m) => m.t === 'groups');
				expect(last?.groups.map((x) => x.name)).toEqual(['unpackPhase', 'buildPhase']);
				return last!.groups;
			},
			{ timeout: 5_000 }
		);
		const line = (name: string) => groups.find((x) => x.name === name)!;
		expect(line('unpackPhase')).toMatchObject({ line: 1, lastLine: 2 });
		expect(line('buildPhase')).toMatchObject({ line: 1001, lastLine: 1002 });
	});
});
