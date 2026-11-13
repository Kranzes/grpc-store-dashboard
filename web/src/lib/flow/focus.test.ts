import { describe, expect, it } from 'vitest';
import { CACHE_ID, OTHER_CLIENTS, SCHEDULER_ID, UPSTREAM_ID } from '#lib/model/types.ts';
import { builders, demo12, demo30, upstreamFarm } from './fixtures.ts';
import { layoutTopology } from './layout.ts';
import { Tokens, brightIds, focusCss, focusIndex } from './focus.ts';

const sorted = (s: Iterable<string>) => [...s].sort();
const x86 = builders('x86_64-linux', 20);
const arm = builders('aarch64-linux', 10);
const POOL = 'pool:x86_64-linux';
const EXPANDED = new Map([['x86_64-linux', false]]);

describe('brightIds', () => {
	it('brightIds for a node, a line and a bundle', () => {
		const ix = focusIndex(demo12());
		const addr = '10.0.0.13:50051';
		expect(sorted(brightIds({ kind: 'node', nodeId: `worker:${addr}` }, ix))).toEqual(
			sorted([
				`worker:${addr}`,
				`assign:${addr}`,
				`publish:${addr}`,
				`fetch:${addr}`,
				SCHEDULER_ID,
				CACHE_ID
			])
		);
		expect(
			sorted(brightIds({ kind: 'lines', flow: 'assign', edgeIds: [`assign:${addr}`] }, ix))
		).toEqual(sorted([`assign:${addr}`, SCHEDULER_ID, `worker:${addr}`]));
		const two = x86.slice(0, 2);
		expect(
			sorted(
				brightIds({ kind: 'lines', flow: 'publish', edgeIds: two.map((a) => `publish:${a}`) }, ix)
			)
		).toEqual(
			sorted([...two.map((a) => `publish:${a}`), ...two.map((a) => `worker:${a}`), CACHE_ID])
		);
		// The scheduler lights every line it ends, and everything at their other ends.
		const sched = brightIds({ kind: 'node', nodeId: SCHEDULER_ID }, ix);
		expect(sched.has('cached:scheduler')).toBe(true);
		expect(sched.has(`want:${OTHER_CLIENTS}`)).toBe(true);
		expect(sched.has(`clients:${OTHER_CLIENTS}`)).toBe(true);
		expect(sched.has(`publish:${addr}`)).toBe(false);
		expect(brightIds(null, ix).size).toBe(0);
	});

	it("a builder in a collapsed pool lights the pool's line", () => {
		const ix = focusIndex(demo30());
		const addr = x86[4];
		expect(
			sorted(brightIds({ kind: 'lines', flow: 'assign', edgeIds: [`assign:${addr}`] }, ix))
		).toEqual(sorted([`assign:${POOL}`, SCHEDULER_ID, POOL]));
		// Its node lights the pool, the pool's lines and their other ends.
		expect(sorted(brightIds({ kind: 'node', nodeId: `worker:${addr}` }, ix))).toEqual(
			sorted([POOL, `assign:${POOL}`, `publish:${POOL}`, `fetch:${POOL}`, SCHEDULER_ID, CACHE_ID])
		);
	});

	it("an expanded pool's line lights its members", () => {
		const ix = focusIndex(demo30(EXPANDED));
		const bright = brightIds({ kind: 'lines', flow: 'assign', edgeIds: [`assign:${POOL}`] }, ix);
		expect(sorted(bright)).toEqual(
			sorted([...x86.map((a) => `assign:${a}`), ...x86.map((a) => `worker:${a}`), SCHEDULER_ID])
		);
		// A bundle that held the pool lights its members too.
		const bundle = brightIds(
			{ kind: 'lines', flow: 'assign', edgeIds: [`assign:${arm[0]}`, `assign:${POOL}`] },
			ix
		);
		expect(bundle.size).toBe(bright.size + 2);
		// So does the pool's node.
		const node = brightIds({ kind: 'node', nodeId: POOL }, ix);
		expect(node.has(`worker:${x86[19]}`)).toBe(true);
		expect(node.has(`fetch:${x86[19]}`)).toBe(true);
	});

	it("a folded group's request line lights other clients", () => {
		const ix = focusIndex(demo12());
		expect(
			sorted(brightIds({ kind: 'lines', flow: 'request', edgeIds: ['want:folded'] }, ix))
		).toEqual(sorted([`want:${OTHER_CLIENTS}`, `clients:${OTHER_CLIENTS}`, SCHEDULER_ID]));
	});

	it('a gone builder leaves nothing to focus', () => {
		const ix = focusIndex(demo12());
		expect(brightIds({ kind: 'node', nodeId: 'worker:10.9.9.9:50051' }, ix).size).toBe(0);
		expect(
			brightIds({ kind: 'lines', flow: 'assign', edgeIds: ['assign:10.9.9.9:50051'] }, ix).size
		).toBe(0);
		// A bundle keeps the members that are still there.
		const kept = brightIds(
			{ kind: 'lines', flow: 'assign', edgeIds: ['assign:10.9.9.9:50051', `assign:${x86[0]}`] },
			ix
		);
		expect(sorted(kept)).toEqual(sorted([`assign:${x86[0]}`, `worker:${x86[0]}`, SCHEDULER_ID]));
	});
});

describe('focusCss', () => {
	it('focusCss lists one selector per bright id and nothing else', () => {
		const tokens = new Tokens();
		const css = focusCss(new Set(['assign:a', 'worker:a', 'scheduler']), tokens.token);
		const selectors = css
			.slice(0, css.indexOf('{'))
			.split(',')
			.map((s) => s.trim());
		expect(selectors).toEqual([
			`.farm-map.focusing .${tokens.token('assign:a')}`,
			`.farm-map.focusing .${tokens.token('worker:a')}`,
			`.farm-map.focusing .${tokens.token('scheduler')}`
		]);
		expect(css.match(/\{/g)).toHaveLength(1);
		expect(focusCss(new Set(), tokens.token)).toBe('');
	});
});

describe('Tokens', () => {
	it('retain forgets ids that are no longer drawn and never reuses a token', () => {
		const tokens = new Tokens();
		const a = tokens.token('worker:a b');
		expect(a).toMatch(/^fx-[0-9a-z]+$/);
		expect(tokens.token('worker:a b')).toBe(a);
		const b = tokens.token('worker:b');
		expect(b).not.toBe(a);
		tokens.retain(new Set(['worker:b']));
		expect(tokens.size).toBe(1);
		expect(tokens.token('worker:b')).toBe(b);
		// An id that comes back gets a new token.
		const again = tokens.token('worker:a b');
		expect(again).not.toBe(a);
		expect(again).not.toBe(b);
	});
});

describe('upstream', () => {
	const mixed = layoutTopology(upstreamFarm({ 'aarch64-linux': 10, 'x86_64-linux': 20 }));

	it('the upstream card lights every substitute line and their builders', () => {
		const ix = focusIndex(mixed);
		const bright = brightIds({ kind: 'node', nodeId: UPSTREAM_ID }, ix);
		const lines = mixed.lines.filter((e) => e.kind === 'substitute').map((e) => e.id);
		expect(lines).toHaveLength(11);
		for (const id of lines) expect(bright.has(id), id).toBe(true);
		expect(bright.has(POOL)).toBe(true);
		expect(bright.has(`fetch:${arm[0]}`)).toBe(false);
	});

	it("a builder lights its own substitute line, and one in a collapsed pool the pool's", () => {
		const ix = focusIndex(mixed);
		expect(brightIds({ kind: 'node', nodeId: `worker:${arm[0]}` }, ix)).toContain(
			`substitute:${arm[0]}`
		);
		const inPool = brightIds({ kind: 'node', nodeId: `worker:${x86[3]}` }, ix);
		expect(inPool).toContain(`substitute:${POOL}`);
		expect(inPool).toContain(UPSTREAM_ID);
		const line = brightIds(
			{ kind: 'lines', flow: 'substitute', edgeIds: [`substitute:${x86[3]}`] },
			ix
		);
		expect(sorted(line)).toEqual(sorted([`substitute:${POOL}`, UPSTREAM_ID, POOL]));
	});
});
