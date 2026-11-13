import { describe, expect, it } from 'vitest';
import type { EdgeView } from '#lib/model/types.ts';
import { parseLineId, type LineKind } from './kinds.ts';
import { builders, demo12, demo30, demo50Cards, farm, upstreamFarm } from './fixtures.ts';
import { lineGeometry } from './geometry.ts';
import {
	labelObstacles,
	labelOrder,
	labelOrigin,
	labelSize,
	labelSlots,
	labelText,
	overlaps,
	PILL,
	placeLabels,
	readoutText,
	scaleBox,
	slotBox,
	sumLines,
	type Box,
	type Size
} from './labels.ts';
import { GAP, layoutTopology, type Layout } from './layout.ts';

const ev = (
	rate: number,
	finished = 0,
	failed = 0,
	unit: EdgeView['unit'] = 'builds'
): EdgeView => ({
	rate,
	unit,
	finished,
	failed
});

/** About 5 px a character, as 10 px text measures. */
const measure = (s: string) => s.length * 5;

/** Typical label texts per kind, with failures on assignment and request lines. */
const TYPICAL: Record<LineKind, EdgeView> = {
	request: ev(12, 50, 4),
	assign: ev(0.4, 38, 3),
	hit: ev(4),
	publish: ev(38 * 2 ** 20, 0, 0, 'bytes'),
	fetch: ev(4.2 * 2 ** 20, 0, 0, 'bytes'),
	substitute: ev(2.1 * 2 ** 20, 0, 0, 'bytes')
};

function setup(l: Layout, views: (kind: LineKind, id: string) => EdgeView = (k) => TYPICAL[k]) {
	const lines = lineGeometry(l);
	const slots = labelSlots(lines);
	const sizes = new Map<string, Size>();
	for (const line of lines) {
		const t = labelText(line.kind, views(line.kind, line.id));
		if (t) sizes.set(line.id, labelSize(t, measure));
	}
	const obstacles = labelObstacles(l.nodes, lines);
	const order = labelOrder(lines);
	return {
		lines,
		slots,
		sizes,
		obstacles,
		order,
		placed: placeLabels(slots, sizes, obstacles, order)
	};
}

/** Labels placed away from their slot: publish and fetch labels at their fallback. */
function fallbacks({ slots, sizes, placed }: ReturnType<typeof setup>): string[] {
	return slots
		.filter((s) => placed.has(s.id) && placed.get(s.id)!.y !== slotBox(s, sizes.get(s.id)!).y)
		.map((s) => s.id);
}

function expectApart(placed: ReadonlyMap<string, Box>, l: Layout) {
	const boxes = [...placed];
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			expect(overlaps(boxes[i][1], boxes[j][1]), `${boxes[i][0]} and ${boxes[j][0]}`).toBe(false);
		}
		for (const n of l.nodes)
			expect(overlaps(boxes[i][1], n), `${boxes[i][0]} on ${n.id}`).toBe(false);
	}
}

describe('labelText', () => {
	it('labelText per kind, with and without failures', () => {
		// The client card shows the request rate, so the label shows only failures.
		expect(labelText('request', ev(12, 100, 8))).toEqual({ rate: null, fail: '8% failed' });
		expect(labelText('request', ev(12))).toBeNull();
		expect(labelText('assign', ev(12, 100, 8))).toEqual({
			rate: '720 assigned/min',
			fail: '8% failed'
		});
		expect(labelText('assign', ev(0.4))).toEqual({ rate: '24 assigned/min', fail: null });
		expect(labelText('hit', ev(4, 10, 5))).toEqual({ rate: '240 hits/min', fail: null });
		expect(labelText('publish', ev(38 * 2 ** 20, 0, 0, 'bytes'))).toEqual({
			rate: '38 MiB/s',
			fail: null
		});
		expect(labelText('fetch', ev(4.2 * 2 ** 20, 0, 0, 'bytes'))).toEqual({
			rate: '≈ 4.2 MiB/s',
			fail: null
		});
		// Any failure shows, however small, and a share below 1 never reads 100%.
		expect(labelText('assign', ev(2, 1000, 3))?.fail).toBe('<1% failed');
		expect(labelText('assign', ev(2, 1000, 999))?.fail).toBe('99% failed');
		expect(labelText('assign', ev(2, 10, 10))?.fail).toBe('100% failed');
		expect(labelText('request', ev(2, 10, 0))).toBeNull();
	});

	it('idle lines without failures have no label', () => {
		expect(labelText('assign', ev(0))).toBeNull();
		expect(labelText('assign', ev(0, 20, 0))).toBeNull();
		expect(labelText('publish', ev(0, 0, 0, 'bytes'))).toBeNull();
		expect(labelText('assign', undefined)).toBeNull();
		// An idle line with failures says only that.
		expect(labelText('assign', ev(0, 12, 1))).toEqual({ rate: null, fail: '8% failed' });
	});

	it('the readout adds up a bundle and names the window', () => {
		const edges = new Map([
			['assign:a', ev(0.5, 20, 1)],
			['assign:b', ev(0.8, 30, 1)]
		]);
		const sum = sumLines(['assign:a', 'assign:b', 'assign:gone'], edges);
		expect(sum).toEqual({ rate: 1.3, finished: 50, failed: 2 });
		expect(readoutText('assign', sum, 'last 15m')).toEqual({
			rate: '78 assigned/min',
			fail: '4% failed (last 15m)'
		});
		expect(readoutText('assign', sum, 'since 23:41')).toEqual({
			rate: '78 assigned/min',
			fail: '4% failed (since 23:41)'
		});
		expect(readoutText('assign', sumLines(['assign:a'], new Map()), 'last 15m')).toEqual({
			rate: '0 assigned/min',
			fail: null
		});
		expect(readoutText('fetch', { rate: 2 ** 20, finished: 0, failed: 0 }, 'x')).toEqual({
			rate: '≈ 1 MiB/s',
			fail: null
		});
	});
});

describe('labelSize', () => {
	it('fits the wider line, and a failure line adds its capitals and the gap above them', () => {
		const rate = '12 assigned/min';
		const one = labelSize({ rate, fail: null }, measure);
		const two = labelSize({ rate, fail: '8% failed' }, measure);
		const failOnly = labelSize({ rate: null, fail: '8% failed' }, measure);
		expect(two.h - one.h).toBe(PILL.cap + PILL.rowGap);
		expect(failOnly.h).toBe(one.h);
		// The rate is the wider line here, so the failure line adds no width.
		expect(two.w).toBe(one.w);
		// The failure line's bar and the space after it count toward its width.
		expect(one.w - failOnly.w).toBe(
			measure(rate) - (PILL.bar + PILL.barGap + measure('8% failed'))
		);
		// A fractional width rounds up, so the text never clips.
		const width = (px: number) => labelSize({ rate: 'x', fail: null }, () => px).w;
		expect(width(40.2)).toBe(width(41));
		expect(width(40.2)).toBeGreaterThan(width(40));
	});
});

describe('labelSlots', () => {
	it("slots sit beside the card at the line's own end", () => {
		const l = demo12();
		const lines = lineGeometry(l);
		const slots = new Map(labelSlots(lines).map((s) => [s.id, s]));
		expect(slots.size).toBe(l.lines.length);
		const one = labelSize({ rate: '24 assigned/min', fail: null }, measure);
		const two = labelSize({ rate: '24 assigned/min', fail: '8% failed' }, measure);
		const box = (id: string, size: Size) => slotBox(slots.get(id)!, size);
		const card = (id: string) => l.nodes.find((n) => n.id === id)!;
		const mid = (id: string) => card(id).y + card(id).h / 2;
		const left = (id: string) => card(id).x;
		const right = (id: string) => card(id).x + card(id).w;
		/** The y of a line's end at `end`: 0 for its source, -1 for its target. */
		const stub = (id: string, end: 0 | -1) => lines.find((g) => g.id === id)!.points.at(end)![1];
		// Assignments: the label ends PILL.gap left of the card, centered on the
		// line's end, whether it has one line or two.
		for (const [addr, size] of [
			['10.0.1.10:50051', one],
			['10.0.0.13:50051', two]
		] as const) {
			const b = box(`assign:${addr}`, size);
			expect(left(`worker:${addr}`) - (b.x + b.w), addr).toBe(PILL.gap);
			expect(b.y + b.h / 2, addr).toBe(stub(`assign:${addr}`, -1));
		}
		// Publish: PILL.gap right of the card, its bottom PILL.band above the
		// input, so it clears the stub that leaves above the input.
		const a0 = 'worker:10.0.1.10:50051';
		const pub = box('publish:10.0.1.10:50051', one);
		expect(pub.x - right(a0)).toBe(PILL.gap);
		expect(mid(a0) - (pub.y + pub.h)).toBe(PILL.band);
		expect(pub.y + pub.h).toBeLessThan(stub('publish:10.0.1.10:50051', 0));
		// Fetch: its top PILL.band below the input, under its own stub.
		const a3 = 'worker:10.0.1.13:50051';
		const fetch = box('fetch:10.0.1.13:50051', one);
		expect(fetch.x - right(a3)).toBe(PILL.gap);
		expect(fetch.y - mid(a3)).toBe(PILL.band);
		expect(fetch.y).toBeGreaterThan(stub('fetch:10.0.1.13:50051', -1));
		// Requests: PILL.gap right of the client card, centered on its stub.
		const c = 'clients:ci-runner-1';
		const req = box('want:ci-runner-1', one);
		expect(req.x - right(c)).toBe(PILL.gap);
		expect(req.y + req.h / 2).toBe(stub('want:ci-runner-1', 0));
		// Cache hits: centered on the top run.
		const run = lines.find((g) => g.id === 'cached:scheduler')!.points.slice(1, 3);
		const hit = box('cached:scheduler', one);
		expect(hit.x + hit.w / 2).toBe((run[0][0] + run[1][0]) / 2);
		expect(hit.y + hit.h / 2).toBe(run[0][1]);
		// Pools: on the line's end at the pool's input.
		const d30 = demo30();
		const p = d30.nodes.find((n) => n.id === 'pool:x86_64-linux')!;
		const poolLine = lineGeometry(d30).find((g) => g.id === 'assign:pool:x86_64-linux')!;
		const pool = labelSlots([poolLine])[0];
		expect([pool.x, pool.y, pool.align]).toEqual([
			p.x - PILL.gap,
			poolLine.points.at(-1)![1],
			'end'
		]);
	});
});

describe('placeLabels', () => {
	it('placeLabels drops a label that would cover a card or a heading', () => {
		const card: Box = { x: 100, y: 0, w: 100, h: 50 };
		const heading: Box = { x: 0, y: -40, w: 300, h: 24 };
		const slots = [
			{ id: 'on-card', kind: 'assign', x: 120, y: 20, align: 'end', band: 'mid' },
			{ id: 'on-heading', kind: 'request', x: 10, y: -30, align: 'start', band: 'mid' },
			{ id: 'clear', kind: 'request', x: 10, y: 20, align: 'start', band: 'mid' },
			{ id: 'no-text', kind: 'request', x: 10, y: 100, align: 'start', band: 'mid' }
		] as const;
		const size = { w: 50, h: 17 };
		const sizes = new Map([
			['on-card', size],
			['on-heading', size],
			['clear', size]
		]);
		const placed = placeLabels(
			slots,
			sizes,
			{ nodes: [card, heading], buses: [] },
			slots.map((s) => s.id)
		);
		expect([...placed.keys()]).toEqual(['clear']);
	});

	it('no two placed labels overlap at 12 and 50 builders and with a pool', () => {
		const twelve = demo12();
		const s12 = setup(twelve);
		expectApart(s12.placed, twelve);
		// Nothing collides on the demo's layout: every line keeps its label,
		// in its own slot. The aarch64 cards' publish and fetch labels clear
		// the two-line assignment labels of the x86_64 cards across the group gap.
		expect([...s12.placed.keys()].sort()).toEqual(s12.lines.map((l) => l.id).sort());
		expect(fallbacks(s12)).toEqual([]);
		for (const l of [demo50Cards(), demo30()]) expectApart(setup(l).placed, l);
	});

	it("a pool's two-line label wins over its neighbour's fetch label", () => {
		const s = setup(demo30());
		const id = 'assign:pool:x86_64-linux';
		const pool = s.placed.get(id)!;
		// The pool's label sits in its own slot.
		expect(pool).toEqual(
			slotBox(
				s.slots.find((x) => x.id === id)!,
				s.sizes.get(id)!
			)
		);
		// Fetch labels whose slot it covers come later in the order and give way.
		const rivals = s.slots.filter(
			(x) => x.kind === 'fetch' && overlaps(slotBox(x, s.sizes.get(x.id)!), pool)
		);
		expect(rivals.length).toBeGreaterThan(0);
		for (const r of rivals)
			expect(s.placed.get(r.id), r.id).not.toEqual(slotBox(r, s.sizes.get(r.id)!));
	});

	it("one column of 3 rows moves the middle row's publish and fetch labels off the buses", () => {
		const l = layoutTopology(farm({ 'x86_64-linux': 3 }), undefined, new Map());
		const [top, mid, low] = builders('x86_64-linux', 3);
		const lines = lineGeometry(l);
		const obstacles = labelObstacles(l.nodes, lines);
		const card = (addr: string) => l.nodes.find((n) => n.ref === addr)!;
		const cy = (addr: string) => card(addr).y + card(addr).h / 2;
		// Labels that reach 10 px past where the buses start, whatever the gaps.
		const reach = Math.max(...obstacles.buses.map((b) => b.x)) - (card(mid).x + card(mid).w) + 10;
		const wide = new Map(lines.map((g) => [g.id, { w: reach, h: 17 }]));
		const placed = placeLabels(labelSlots(lines), wide, obstacles, labelOrder(lines));
		const out = PILL.band + PILL.fallback;
		// The middle row: its slots sit on the buses, so both labels go 10 px further out.
		expect(placed.get(`publish:${mid}`)!.y + 17).toBe(cy(mid) - out);
		expect(placed.get(`fetch:${mid}`)!.y).toBe(cy(mid) + out);
		// The other rows keep their slots.
		expect(placed.get(`publish:${top}`)!.y + 17).toBe(cy(top) - PILL.band);
		expect(placed.get(`fetch:${low}`)!.y).toBe(cy(low) + PILL.band);
		for (const [id, b] of placed) {
			if (!id.startsWith('publish:') && !id.startsWith('fetch:')) continue;
			for (const bus of obstacles.buses) expect(overlaps(b, bus), `${id} on a bus`).toBe(false);
		}
	});

	it('labels in a column gap drop', () => {
		const l = demo50Cards();
		// A label starts 4 px from its card, so one wider than the gap less 4 px
		// reaches the next column. Every label with a unit is, at real farm rates.
		const { placed } = setup(l, (kind) =>
			kind === 'publish' ? ev(380 * 2 ** 20, 0, 0, 'bytes') : TYPICAL[kind]
		);
		const cards = l.nodes.filter((n) => n.kind === 'builder');
		const at = (x: number, y: number) => cards.some((n) => n.x === x && n.y === y);
		let dropped = 0;
		for (const n of cards) {
			// A card column one gap to the right, on the same row.
			if (at(n.x + n.w + GAP.column, n.y)) {
				expect(placed.has(`publish:${n.ref}`), `publish:${n.ref}`).toBe(false);
				expect(placed.has(`fetch:${n.ref}`), `fetch:${n.ref}`).toBe(false);
				dropped++;
			}
			// And one to the left.
			if (at(n.x - GAP.column - n.w, n.y)) expect(placed.has(`assign:${n.ref}`)).toBe(false);
		}
		expect(dropped).toBeGreaterThan(20);
		// The group's outer sides keep theirs.
		const first = cards.find((n) => n.x === Math.min(...cards.map((c) => c.x)))!;
		expect(placed.has(`assign:${first.ref}`)).toBe(true);
	});

	it('the order does not change when rates change', () => {
		const upstream = layoutTopology(upstreamFarm({ 'aarch64-linux': 4, 'x86_64-linux': 8 }));
		for (const l of [demo12(), upstream]) {
			const calm = setup(l);
			// Higher rates that keep the widths keep the same labels in the same boxes.
			const busy = setup(l, (kind) => {
				const t = TYPICAL[kind];
				return { ...t, rate: t.unit === 'bytes' ? t.rate * 1.02 : t.rate * 1.5 };
			});
			expect(busy.order).toEqual(calm.order);
			expect([...busy.placed]).toEqual([...calm.placed]);
		}
		// Assignments first, then requests, publishes, fetches, substitutions and
		// cache hits, each in layout order.
		const { order, lines } = setup(upstream);
		const kinds = order.map((id) => parseLineId(id)?.kind);
		expect([...new Set(kinds)]).toEqual([
			'assign',
			'request',
			'publish',
			'fetch',
			'substitute',
			'hit'
		]);
		// Bright lines go first.
		const bright = new Set(['publish:10.0.0.13:50051']);
		expect(labelOrder(lines, bright)[0]).toBe('publish:10.0.0.13:50051');
	});
});

describe('scaled labels', () => {
	it('keep the side that touches their line in place', () => {
		const box = { x: 100, y: 50, w: 80, h: 20 };
		// An assignment label ends at its builder: its right edge and middle stay.
		const end = { align: 'end', band: 'mid' } as const;
		expect(labelOrigin(end)).toEqual([1, 0.5]);
		expect(scaleBox(box, end, 0.5)).toEqual({ x: 140, y: 55, w: 40, h: 10 });
		// A publish label sits above its stub: its left and bottom edges stay.
		const above = { align: 'start', band: 'above' } as const;
		expect(scaleBox(box, above, 0.5)).toEqual({ x: 100, y: 60, w: 40, h: 10 });
		// A fetch label hangs below: its left and top edges stay.
		expect(scaleBox(box, { align: 'start', band: 'below' }, 0.5)).toEqual({
			x: 100,
			y: 50,
			w: 40,
			h: 10
		});
		expect(labelOrigin({ align: 'center', band: 'mid' })).toEqual([0.5, 0.5]);
		expect(scaleBox(box, end, 1)).toBe(box);
	});
});

describe('substitute labels', () => {
	const twelve = layoutTopology(upstreamFarm({ 'aarch64-linux': 4, 'x86_64-linux': 8 }));
	const thirty = layoutTopology(upstreamFarm({ 'aarch64-linux': 10, 'x86_64-linux': 20 }));
	const fifty = layoutTopology(
		upstreamFarm({ 'aarch64-linux': 17, 'x86_64-linux': 33 }),
		undefined,
		new Map([
			['aarch64-linux', false],
			['x86_64-linux', false]
		])
	);

	it('sits on its own stub, right of the card, clear of the fetch label', () => {
		const addr = '10.0.0.13:50051';
		const lines = lineGeometry(twelve);
		const slots = new Map(labelSlots(lines).map((s) => [s.id, s]));
		const card = twelve.nodes.find((n) => n.ref === addr)!;
		const end = lines.find((g) => g.id === `substitute:${addr}`)!.points.at(-1)!;
		expect(slots.get(`substitute:${addr}`)).toMatchObject({
			x: card.x + card.w + PILL.gap,
			y: end[1],
			align: 'start',
			band: 'mid'
		});
		// A one-line pill there starts below the fetch label's slot.
		const one = labelSize({ rate: '2.1 MiB/s', fail: null }, measure);
		const sub = slotBox(slots.get(`substitute:${addr}`)!, one);
		const fetch = slotBox(slots.get(`fetch:${addr}`)!, one);
		expect(sub.y).toBeGreaterThanOrEqual(fetch.y + fetch.h);
	});

	it('no fetch or publish label covers a substitute line beyond its stub', () => {
		for (const l of [twelve, thirty, fifty]) {
			const { placed, obstacles, lines } = setup(l);
			const runs = obstacles.buses.filter((b) =>
				lines.some(
					(g) =>
						g.kind === 'substitute' &&
						g.points.some((p, i) => i > 0 && p[1] === b.y + b.h / 2 && g.points[i - 1][1] === p[1])
				)
			);
			expect(runs.length).toBeGreaterThan(0);
			for (const [id, box] of placed) {
				if (!id.startsWith('publish:') && !id.startsWith('fetch:')) continue;
				for (const r of runs) expect(overlaps(box, r), `${id} on a substitute run`).toBe(false);
			}
		}
	});

	it('keeps every label in its own slot on the demo and the pools of 60 and 200 builders, and none overlaps at 30 and 50', () => {
		// The substitute label sits under the fetch label, and the fetch label
		// clears the next group's two-line assignment label, so neither needs
		// its fallback or drops.
		const pools60 = layoutTopology(upstreamFarm({ 'aarch64-linux': 20, 'x86_64-linux': 40 }));
		const pools200 = layoutTopology(upstreamFarm({ 'aarch64-linux': 67, 'x86_64-linux': 133 }));
		for (const l of [twelve, pools60, pools200]) {
			const s = setup(l);
			expectApart(s.placed, l);
			expect([...s.placed.keys()].sort()).toEqual(s.lines.map((g) => g.id).sort());
			expect(fallbacks(s)).toEqual([]);
		}
		// Where labels do drop or move, none overlaps another or a card.
		for (const l of [thirty, fifty]) expectApart(setup(l).placed, l);
	});
});
