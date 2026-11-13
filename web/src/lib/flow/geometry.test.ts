import { describe, expect, it } from 'vitest';
import { OTHER_CLIENTS } from '#lib/model/types.ts';
import { builders, demo12, demo30, farm, upstreamFarm } from './fixtures.ts';
import { handlePoint, hitLines, lineGeometry, type LineGeom, type Pt } from './geometry.ts';
import { layoutTopology, type Layout, type LayoutNode } from './layout.ts';
import { paintOrder, traffic } from './traffic.ts';

const node = (l: Layout, id: string) => l.nodes.find((n) => n.id === id)!;
const MOUSE = 6;

const arm = builders('aarch64-linux', 10);
const x86 = builders('x86_64-linux', 8);
const ids = (kind: string, addrs: string[]) => addrs.map((a) => `${kind}:${a}`);

// Points come from the layout, never from pixel values, so a test fails only
// when lines meet differently, not when a size or a gap changes.
const mid = (n: LayoutNode) => n.y + n.h / 2;
const center = (n: LayoutNode): Pt => [n.x + n.w / 2, mid(n)];
const path = (lines: readonly LineGeom[], id: string) => lines.find((g) => g.id === id)!.points;
/** Segment `i` of a line, or from its end when negative: -1 is the stub into its target. */
function segment(lines: readonly LineGeom[], id: string, i: number): [Pt, Pt] {
	const pts = path(lines, id);
	const at = i < 0 ? pts.length - 1 + i : i;
	return [pts[at], pts[at + 1]];
}
/** A point `d` px along segment `i` of a line; a negative `d` counts back from the segment's end. */
function along(lines: readonly LineGeom[], id: string, i: number, d: number): Pt {
	const [a, b] = segment(lines, id, i);
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const t = (d < 0 ? len + d : d) / len;
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** The middle of segment `i` of a line. */
function middle(lines: readonly LineGeom[], id: string, i: number): Pt {
	const [a, b] = segment(lines, id, i);
	return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
/**
 * Where line `id` turns off a trunk or bus: the y, or x, of its vertex `i`.
 * On an assignment line, vertex -3 is where it leaves its track for its
 * trunk, and vertex -2 where it leaves the trunk for its card.
 */
const vy = (lines: readonly LineGeom[], id: string, i: number) => path(lines, id).at(i)![1];
const vx = (lines: readonly LineGeom[], id: string, i: number) => path(lines, id).at(i)![0];

describe('lineGeometry', () => {
	it('draws every line in layout order, from its source handle to its target handle, in straight runs', () => {
		for (const l of [
			demo12(),
			demo30(),
			layoutTopology(upstreamFarm({ 'aarch64-linux': 4, 'x86_64-linux': 8 }))
		]) {
			const lines = lineGeometry(l);
			expect(lines.map((g) => g.id)).toEqual(l.lines.map((e) => e.id));
			for (const [i, e] of l.lines.entries()) {
				const pts = lines[i].points;
				expect(pts[0], e.id).toEqual(handlePoint(node(l, e.source), e.sourceHandle));
				expect(pts.at(-1), e.id).toEqual(handlePoint(node(l, e.target), e.targetHandle));
				for (let j = 1; j < pts.length; j++) {
					const [a, b] = [pts[j - 1], pts[j]];
					expect(a[0] === b[0] || a[1] === b[1], `${e.id} segment ${j}`).toBe(true);
				}
			}
		}
	});
});

describe('hitLines', () => {
	const hit = (lines: readonly LineGeom[], p: Pt, tol = MOUSE) => hitLines(lines, p, tol);

	it('hitLines on the 12-builder layout', () => {
		const l = demo12();
		const lines = lineGeometry(l);
		const arm4 = builders('aarch64-linux', 4);
		const all = [...arm4, ...x86];
		const row = (a: string) => `assign:${a}`;
		// The stub out of the scheduler carries every assignment.
		expect(hit(lines, middle(lines, row(arm4[0]), 0))).toEqual(ids('assign', all));
		// Past it, each group's track carries its own lines.
		const armTrack = middle(lines, row(arm4[0]), -3);
		const x86Track: Pt = [armTrack[0], vy(lines, row(x86[0]), -3)];
		expect(hit(lines, armTrack)).toEqual(ids('assign', arm4));
		expect(hit(lines, x86Track)).toEqual(ids('assign', x86));
		// Under the aarch64 column, only the x86 track runs on.
		expect(hit(lines, [center(node(l, `worker:${arm4[0]}`))[0], x86Track[1]])).toEqual(
			ids('assign', x86)
		);
		// The x86 trunk carries a row's line up to the row: between rows 1 and 2, rows 0 and 1.
		const trunk = vx(lines, row(x86[0]), -3);
		const turn = (i: number) => vy(lines, row(x86[i]), -2);
		expect(hit(lines, [trunk, (turn(1) + turn(2)) / 2])).toEqual(ids('assign', x86.slice(0, 2)));
		expect(hit(lines, [trunk, (turn(0) + turn(1)) / 2])).toEqual(ids('assign', x86.slice(0, 1)));
		// 9 px left of row 3's card: on its stub, and 9 px from the trunk. The stub wins.
		expect(hit(lines, along(lines, row(x86[3]), -1, -9))).toEqual([row(x86[3])]);
		// The publish bus into the cache carries every builder's; under the x86 column, aarch64's only.
		expect(hit(lines, along(lines, `publish:${x86[0]}`, 2, -36))).toEqual(ids('publish', all));
		const pubY = vy(lines, `publish:${x86[0]}`, -1);
		expect(hit(lines, [center(node(l, `worker:${x86[0]}`))[0], pubY])).toEqual(
			ids('publish', arm4)
		);
		expect(hit(lines, along(lines, `want:${OTHER_CLIENTS}`, 0, 50))).toEqual([
			`want:${OTHER_CLIENTS}`
		]);
		expect(hit(lines, along(lines, 'want:ci-runner-1', 0, 28))).toEqual(['want:ci-runner-1']);
		expect(hit(lines, middle(lines, 'cached:scheduler', 1))).toEqual(['cached:scheduler']);
		expect(hit(lines, middle(lines, 'cached:scheduler', 0))).toEqual(['cached:scheduler']);
		// No line runs over a card.
		expect(hit(lines, center(node(l, `worker:${x86[3]}`)))).toEqual([]);
		expect(hit(lines, center(node(l, 'clients:ci-runner-1')))).toEqual([]);
	});

	it('hitLines with a pool', () => {
		const l = demo30();
		const lines = lineGeometry(l);
		const pool = 'pool:x86_64-linux';
		expect(hit(lines, middle(lines, `assign:${pool}`, 0))).toEqual([
			...ids('assign', arm),
			`assign:${pool}`
		]);
		// The pool's track, under the card column, and its trunk down into the pool.
		const track = vy(lines, `assign:${pool}`, -3);
		expect(hit(lines, [center(node(l, `worker:${arm[0]}`))[0], track])).toEqual([`assign:${pool}`]);
		expect(hit(lines, middle(lines, `assign:${pool}`, -2))).toEqual([`assign:${pool}`]);
		// The card column's trunk crosses the pool's track on its way down to
		// rows 5 to 9. Off the crossing, each side keeps its own lines.
		const cross: Pt = [vx(lines, `assign:${arm[9]}`, -3), track];
		expect(hit(lines, [cross[0] + 3, cross[1]])).toEqual([`assign:${pool}`]);
		expect(hit(lines, [cross[0], cross[1] + 3])).toEqual(ids('assign', arm.slice(5)));
		expect(hit(lines, along(lines, `publish:${pool}`, 2, -38))).toEqual([
			...ids('publish', arm),
			`publish:${pool}`
		]);
		const pubY = vy(lines, `publish:${pool}`, -1);
		expect(hit(lines, [center(node(l, pool))[0], pubY])).toEqual(ids('publish', arm));
	});

	it('a tie between kinds goes to the later line', () => {
		const lines = lineGeometry(demo30());
		// The pool's track crosses the card column's publish trunk, which carries
		// rows 5 to 9 there. The pool's assign line comes later in the list.
		const at: Pt = [vx(lines, `publish:${arm[5]}`, 1), vy(lines, 'assign:pool:x86_64-linux', -3)];
		const publish = lines.filter((g) => g.kind === 'publish' && hitLines([g], at, 0.5).length > 0);
		expect(publish.map((g) => g.id)).toEqual(ids('publish', arm.slice(5)));
		expect(hit(lines, at)).toEqual(['assign:pool:x86_64-linux']);
		// Reversed, the publish lines come later and win.
		expect(hit([...lines].reverse(), at)).toEqual(ids('publish', arm.slice(5)).reverse());
		// Just off the crossing, the nearer line wins.
		expect(hit(lines, [at[0], at[1] - 3])).toEqual(ids('publish', arm.slice(5)));
	});

	it('where an idle line crosses an active one, the active one wins, as it paints on top', () => {
		const lines = lineGeometry(demo12());
		// The x86 track crosses column 0's fetch trunk, which carries all four
		// column-0 fetch lines there.
		const arm4 = builders('aarch64-linux', 4);
		const at: Pt = [vx(lines, `fetch:${arm4[0]}`, 1), vy(lines, `assign:${x86[0]}`, -3)];
		const fetch = ids('fetch', arm4);
		const assign = ids('assign', x86);
		const crossing = hitLines(lines, at, MOUSE);
		expect([fetch, assign]).toContainEqual(crossing);
		// The same lines with each kind in turn painted last: idle lines first,
		// then active ones (paintOrder in traffic.ts).
		const ranked = (active: (id: string) => boolean) => {
			const drawn = lines.map((l) => ({ id: l.id, kind: l.kind }));
			const looks = new Map(
				drawn.map((l) => [
					l.id,
					{ ...traffic(active(l.id) ? 1 : 0, 1), fails: 0, lookup: false, hits: false }
				])
			);
			return new Map(paintOrder(drawn, looks).map((id, i) => [id, i]));
		};
		const fetchOnTop = ranked((id) => id.startsWith('fetch:'));
		const assignOnTop = ranked((id) => id.startsWith('assign:'));
		expect(hitLines(lines, at, MOUSE, fetchOnTop)).toEqual(fetch);
		expect(hitLines(lines, at, MOUSE, assignOnTop)).toEqual(assign);
		// Only ties go by paint order: off the crossing, the nearer line still wins.
		expect(hitLines(lines, [at[0], at[1] - 2], MOUSE, assignOnTop)).toEqual(fetch);
		expect(hitLines(lines, [at[0] + 12, at[1]], MOUSE, fetchOnTop)).toEqual(assign);
	});

	it('the cache hits line is never part of a bundle', () => {
		for (const l of [demo12(), demo30()]) {
			const lines = lineGeometry(l);
			const pts = lines.find((g) => g.kind === 'hit')!.points;
			for (let i = 1; i < pts.length; i++) {
				for (const t of [0.2, 0.5, 0.8]) {
					const p: Pt = [
						pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
						pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t
					];
					expect(hit(lines, p)).toEqual(['cached:scheduler']);
				}
			}
		}
	});

	it("with three groups, the stub carries every assignment and each track its group's", () => {
		const l = layoutTopology(farm({ 'aarch64-darwin': 3, 'aarch64-linux': 3, 'x86_64-linux': 6 }));
		const lines = lineGeometry(l);
		const groups = [
			builders('aarch64-darwin', 3),
			builders('aarch64-linux', 3),
			builders('x86_64-linux', 6)
		];
		const first = (g: string[]) => `assign:${g[0]}`;
		expect(hit(lines, along(lines, first(groups[0]), 0, 8))).toEqual(ids('assign', groups.flat()));
		// Just short of the first trunk, all three tracks run side by side.
		const x = vx(lines, first(groups[0]), -3) - 8;
		for (const g of groups)
			expect(hit(lines, [x, vy(lines, first(g), -3)]), g[0]).toEqual(ids('assign', g));
		// Between neighbouring tracks, a point picks one track's group or none, never two.
		const ys = groups.map((g) => vy(lines, first(g), -3)).sort((a, b) => a - b);
		const sets = groups.map((g) => ids('assign', g));
		for (let y = ys[0]; y <= ys.at(-1)!; y++) {
			const got = hit(lines, [x, y]);
			expect(
				sets.filter((s) => s.some((id) => got.includes(id))).length,
				`y ${y}`
			).toBeLessThanOrEqual(1);
		}
	});

	it('the touch tolerance catches more', () => {
		const lines = lineGeometry(demo12());
		// 10 px below the row 0 stub of column 1, 9 px right of its trunk.
		const [tx, ty] = path(lines, 'assign:10.0.0.10:50051').at(-2)!;
		const p: Pt = [tx + 9, ty + 10];
		expect(hit(lines, p, MOUSE)).toEqual([]);
		expect(hit(lines, p, 14)).toEqual(['assign:10.0.0.10:50051']);
	});
});

describe('upstream', () => {
	const twelve = layoutTopology(upstreamFarm({ 'aarch64-linux': 4, 'x86_64-linux': 8 }));
	const pools = layoutTopology(upstreamFarm({ 'aarch64-linux': 100, 'x86_64-linux': 200 }));
	const subst = (addrs: string[]) => ids('substitute', addrs);
	const hit = (lines: LineGeom[], p: Pt) => hitLines(lines, p, MOUSE);

	it('hitLines with upstream', () => {
		const lines = lineGeometry(twelve);
		const arm4 = builders('aarch64-linux', 4);
		const all = [...arm4, ...x86];
		const s = (a: string) => `substitute:${a}`;
		// The stub at the card: every builder's line.
		expect(hit(lines, along(lines, s(arm4[0]), 0, 16))).toEqual(subst(all));
		// The bus in the channel, under the x86 column: the aarch64 column's lines only.
		const busY = vy(lines, s(arm4[0]), 2);
		expect(hit(lines, [center(node(twelve, `worker:${x86[0]}`))[0], busY])).toEqual(subst(arm4));
		// Its trunk above the channel: the rows above each point.
		const trunk = vx(lines, s(arm4[0]), 3);
		const turn = (i: number) => vy(lines, s(arm4[i]), -1);
		expect(hit(lines, [trunk, (turn(0) + turn(1)) / 2])).toEqual(subst(arm4.slice(0, 1)));
		expect(hit(lines, [trunk, (turn(1) + turn(2)) / 2])).toEqual(subst(arm4.slice(0, 2)));
		// The last block's trunk below the card: the rows further down.
		const down = vx(lines, s(x86[7]), 1);
		const below = (vy(lines, s(x86[6]), -1) + vy(lines, s(x86[7]), -1)) / 2;
		expect(hit(lines, [down, below])).toEqual(subst(x86.slice(7)));

		// Pools only: a trunk for the last pool, a jog for the other.
		const p = lineGeometry(pools);
		const a = 'substitute:pool:aarch64-linux';
		const both = [a, 'substitute:pool:x86_64-linux'];
		const x = vx(p, a, 1);
		const leave = vy(p, 'substitute:pool:x86_64-linux', -1);
		expect(hit(p, [x, (vy(p, a, 1) + leave) / 2])).toEqual(both);
		expect(hit(p, [x, (leave + vy(p, a, 2)) / 2])).toEqual([a]);
		expect(hit(p, middle(p, a, 2))).toEqual([a]);
		expect(hit(p, along(p, a, 0, 20))).toEqual(both);
	});
});
