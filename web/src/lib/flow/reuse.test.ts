import { describe, expect, it } from 'vitest';
import type { Topology } from '#lib/model/types.ts';
import { layoutTopology, type Layout, type LayoutNode } from './layout.ts';
import { Tokens } from './focus.ts';
import { reuseNode, reuseNodes } from './reuse.ts';

const workers = (n: number) =>
	Array.from({ length: n }, (_, i) => `10.0.0.${String(i).padStart(2, '0')}:50051`);

const topo = (n: number, version: number): Topology => ({
	version,
	clientGroups: ['ci'],
	workers: workers(n),
	workerSystems: workers(n).map(() => 'x86_64-linux'),
	retired: [],
	hasCache: true,
	upstreamWorkers: [],
	upstreamRows: 0
});

/** Lay out 10, then 11, then 10 builders of one system as cards, as Flow.svelte does. */
function sequence(): Layout[] {
	const out: Layout[] = [];
	const cards = new Map([['x86_64-linux', false]]);
	let prev: Layout | undefined;
	for (const [n, v] of [
		[10, 1],
		[11, 2],
		[10, 3]
	]) {
		prev = layoutTopology(topo(n, v), prev, cards);
		out.push(prev);
	}
	return out;
}

const find = <T extends { id: string }>(items: readonly T[], id: string): T =>
	items.find((n) => n.id === id)!;

describe('lane headings in the layout', () => {
	it('widen the builders heading for a second column without moving it', () => {
		const [a, b, c] = sequence().map((l) => find(l.nodes, 'lane:builders'));
		expect([b.x, b.y, b.ref]).toEqual([a.x, a.y, a.ref]);
		expect(b.w).toBeGreaterThan(a.w);
		expect(c.w).toBe(a.w);
	});
});

describe('reuseNodes', () => {
	it.each([
		['width', { w: 300 }],
		['height', { h: 100 }]
	])('rebuilds a node whose %s alone changed, and counts it as moved', (_, change) => {
		const n: LayoutNode = { id: 'x', kind: 'builder', x: 0, y: 0, w: 220, h: 88, ref: 'w' };
		const old = reuseNode(undefined, n);
		expect(reuseNode(old, n)).toBe(old);
		const next: LayoutNode = { ...n, ...change };
		const rebuilt = reuseNode(old, next);
		expect(rebuilt).not.toBe(old);
		expect([rebuilt.width, rebuilt.height]).toEqual([next.w, next.h]);
		expect(reuseNodes([old], [next])).toMatchObject({ changed: true, moved: true });
	});

	it('keeps unchanged nodes by identity', () => {
		const [a, b] = sequence();
		const first = reuseNodes([], a.nodes);
		const second = reuseNodes(first.nodes, b.nodes);
		// The first builder keeps its slot, size and data.
		const id = `worker:${workers(1)[0]}`;
		expect(find(second.nodes, id)).toBe(find(first.nodes, id));
		const again = reuseNodes(second.nodes, b.nodes);
		expect(again.changed).toBe(false);
		expect(again.moved).toBe(false);
		expect(again.nodes.every((n, i) => n === second.nodes[i])).toBe(true);
	});

	it('keeps a pool while its cells stay the same, and rebuilds it when one changes', () => {
		const cells = ['a', null, 'b'];
		const n: LayoutNode = {
			id: 'pool:x',
			kind: 'pool',
			x: 0,
			y: 0,
			w: 300,
			h: 200,
			ref: 'x',
			count: 2,
			cells,
			rows: 1
		};
		const old = reuseNode(undefined, n);
		expect(reuseNode(old, { ...n, cells: [...cells] })).toBe(old);
		const joined = reuseNode(old, { ...n, count: 3, cells: ['a', 'c', 'b'] });
		expect(joined).not.toBe(old);
		expect(joined.data.cells).toEqual(['a', 'c', 'b']);
		// New cells change the node but not the picture's shape, so no refit.
		const r = reuseNodes([old], [{ ...n, count: 3, cells: ['a', 'c', 'b'] }]);
		expect(r).toMatchObject({ changed: true, moved: false });
		expect(reuseNodes([old], [{ ...n, h: 212 }]).moved).toBe(true);
	});
});

describe('focus tokens', () => {
	it('live nodes carry their token, headings and lanes do not', () => {
		const [a, b] = sequence();
		const tokens = new Tokens();
		const nodes = reuseNodes([], a.nodes, tokens.token).nodes;
		for (const n of nodes) {
			const live = ['clients', 'scheduler', 'builder', 'pool', 'cache'].includes(n.type ?? '');
			expect(n.class, n.id).toBe(live ? `farm-live ${tokens.token(n.id)}` : 'passive');
		}
		// A kept object keeps its token, since the token depends only on the id.
		const again = reuseNodes(nodes, b.nodes, tokens.token).nodes;
		const id = `worker:${workers(1)[0]}`;
		expect(find(again, id)).toBe(find(nodes, id));
		expect(find(again, id).class).toBe(`farm-live ${tokens.token(id)}`);
	});
});
