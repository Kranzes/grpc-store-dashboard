import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { parseLineId } from '#lib/flow/kinds.ts';
import { nodeLines } from '#lib/flow/lines.ts';
import { PoolToggles } from '#lib/flow/pools.svelte.ts';
import type {
	ClientGroupView,
	EdgeDetailView,
	EdgeView,
	PoolView,
	SubstituterView,
	UpstreamView,
	WorkerView
} from '#lib/model/types.ts';
import { formatClockMinutes } from '../format.ts';
import DetailPanel from './DetailPanel.svelte';
import { drvView, fakeStore, type FakeStore } from './fake-store.ts';
import { chartTitle, failCaption, lineCaption } from './line.ts';
import LinePanel from './LinePanel.svelte';
import LineRows from './LineRows.svelte';
import type { PanelNames } from './titles.ts';
import BuilderPanel from './BuilderPanel.svelte';
import UpstreamPanel from './UpstreamPanel.svelte';

const A = '10.0.0.13:50051';
const B = '10.0.0.14:50051';
const MiB = 1024 * 1024;

const worker = (addr: string, system = 'x86_64-linux'): WorkerView => ({
	addr,
	systems: [system],
	features: [],
	maxJobs: 4,
	running: 1,
	up: true,
	draining: false,
	retired: false,
	goneAt: null,
	drainReason: null,
	diskFree: null,
	diskTotal: null,
	minFree: 0,
	version: '',
	substituters: [],
	builtPerMin: 0,
	failedPerMin: 0,
	queuedCanTake: 0
});

const workers = (...addrs: string[]) => new Map(addrs.map((a) => [a, worker(a)]));

function detail(over: Partial<EdgeDetailView> = {}): EdgeDetailView {
	return {
		edgeIds: [`assign:${A}`],
		flow: 'assign',
		unit: 'builds',
		count: 1,
		rate: 0.4,
		windowMinutes: 15,
		total: 41,
		finished: 38,
		failed: 3,
		series: { startMs: 0, bucketMs: 30_000, values: [0.2, 0.4], failed: [0, 0.05] },
		since: null,
		rows: [],
		items: [],
		estimate: false,
		...over
	};
}

function names(store: FakeStore): PanelNames {
	return {
		isBuilder: (a) => store.workers.has(a),
		groupLabel: (g) => store.clientGroups.get(g)?.label
	};
}

function linePanel(
	store: FakeStore,
	edgeIds: string[],
	flow = parseLineId(edgeIds[0])!.kind,
	pools = new PoolToggles()
) {
	return render(LinePanel, {
		props: {
			store,
			pools,
			flow,
			edgeIds,
			names: names(store),
			onopennode: () => {},
			onopenlines: () => {},
			onselectderivation: () => {}
		}
	}).body;
}

/** Text without tags and with spaces collapsed, for reading what the panel says. */
const text = (html: string) =>
	html
		.replace(/<!--[^]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ');

/** The facts lists' labels and values, in order, as people see them. */
const facts = (html: string) =>
	[...html.matchAll(/<dt[^>]*>([^]*?)<\/dt>\s*<dd[^>]*>([^]*?)<\/dd>/g)].map((m) =>
		[m[1], m[2]].map((x) => x.replace(/<[^>]*>/g, '').trim())
	);

describe('LinePanel', () => {
	it('one builder line: numbers, chart, ends and the latest builds', () => {
		const items = [
			{ drv: drvView('hello', { phase: 'failed' }), via: `assign:${A}`, atMs: 1, bytes: 0 },
			{ drv: drvView('world'), via: `assign:${A}`, atMs: 0, bytes: 0 }
		];
		const store = fakeStore({ workers: workers(A), detail: detail({ items }) });
		const body = linePanel(store, [`assign:${A}`]);
		// It asks for this line's detail.
		expect(store.calls.some((c) => c.startsWith(`edgeDetail assign:${A} `))).toBe(true);
		const t = text(body);
		// One caption for the section, bare labels under it.
		expect(facts(body.slice(body.indexOf('Last 15m'))).slice(0, 3)).toEqual([
			['Now', '24 assigned/min'],
			['Assigned', '41'],
			['Failed', '3 of 38, 8%']
		]);
		expect(t).toContain(lineCaption('assign', 'one'));
		expect(t).toContain(chartTitle('assign', 'builds'));
		expect(t).not.toMatch(/so far/i);
		expect(body).toContain('role="img"');
		expect(t).toContain(`From Scheduler To ${A}`);
		expect(t).toContain('Latest on this line');
		expect(t).toContain('hello');
		// The builder context: no builder address in the detail line.
		expect(body).toContain('>x86_64-linux<');
		// One line has no breakdown.
		expect(t).not.toContain('Lines in this bundle');
	});

	it('a bundle lists one row per line, busiest first, with failure shares', () => {
		const rows = [
			{ edgeId: `assign:${A}`, rate: 0.8, total: 30, finished: 20, failed: 5 },
			{ edgeId: `assign:${B}`, rate: 0.2, total: 10, finished: 10, failed: 0 },
			{ edgeId: 'assign:pool:aarch64-linux', rate: 0.1, total: 4, finished: 4, failed: 0 }
		];
		const pools = new Map([['aarch64-linux', { builders: 34 } as PoolView]]);
		const store = fakeStore({
			workers: workers(A, B),
			pools,
			detail: detail({ edgeIds: rows.map((r) => r.edgeId), rows, count: 36 })
		});
		const body = linePanel(
			store,
			rows.map((r) => r.edgeId)
		);
		const t = text(body);
		expect(t).toContain('These lines run together on the map. Pick a row to see one line.');
		expect(t).toContain('3 lines');
		expect(body).toContain('aria-label="Lines in this bundle"');
		expect(body).toContain(`aria-label="${A}, 48 assigned per minute, 25% failed"`);
		expect(body).toContain(`aria-label="${B}, 12 assigned per minute"`);
		expect(t).toContain('aarch64-linux pool, 34 builders');
		// A bundle has no single pair of ends.
		expect(t).not.toContain('From Scheduler');
		expect(t).toContain(failCaption('assign', 'bundle').bullets[1]);
	});

	it('a pool line breaks down by builder and says who still counts', () => {
		const rows = [{ edgeId: `assign:${A}`, rate: 0.5, total: 3, finished: 3, failed: 1 }];
		const store = fakeStore({ workers: workers(A), detail: detail({ rows }) });
		const t = text(linePanel(store, ['assign:pool:x86_64-linux']));
		expect(t).toContain(lineCaption('assign', 'pool'));
		expect(t).toContain(
			"Builders on the map now. Builders that left still count in the pool's numbers."
		);
		expect(t).toContain('1 builder');
		expect(t).toContain('From Scheduler To x86_64-linux pool');
		expect(t).toContain(failCaption('assign', 'pool').bullets[1]);
	});

	it('publish and fetch lines name bytes, and fetches say they are estimates', () => {
		const pub = drvView('out', { phase: 'built', workerAddr: A });
		const store = fakeStore({
			workers: workers(A),
			detail: detail({
				edgeIds: [`publish:${A}`],
				flow: 'publish',
				unit: 'bytes',
				rate: 38 * MiB,
				total: 12 * MiB,
				finished: 0,
				failed: 0,
				series: { startMs: 0, bucketMs: 30_000, values: [MiB], failed: null },
				items: [{ drv: pub, via: `publish:${A}`, atMs: 1, bytes: 12 * MiB }]
			})
		});
		const t = text(linePanel(store, [`publish:${A}`]));
		expect(t).toContain('Now 38 MiB/s');
		expect(t).toContain('Published 12 MiB');
		expect(t).not.toContain('Failed,');
		expect(t).toContain('Published 12 MiB · x86_64-linux');
		expect(t).toContain(`From ${A} To Binary cache`);

		const fetchStore = fakeStore({
			workers: workers(A),
			detail: detail({
				edgeIds: [`fetch:${A}`],
				flow: 'fetch',
				unit: 'bytes',
				rate: 4.2 * MiB,
				total: 30 * MiB,
				series: { startMs: 0, bucketMs: 30_000, values: [MiB], failed: null },
				items: [{ drv: drvView('in'), via: `fetch:${A}`, atMs: 1, bytes: 3.4 * MiB }],
				estimate: true
			})
		});
		const f = text(linePanel(fetchStore, [`fetch:${A}`]));
		expect(f).toContain('Now ≈ 4.2 MiB/s');
		expect(f).toContain('Fetched (estimated) ≈ 30 MiB');
		expect(f).toContain('Fetches are an estimate from which builder last built each input.');
		expect(f).toContain('Fetching ≈ 3.4 MiB');
	});

	it('the cache hits line is a lookup, and its items are hits', () => {
		const store = fakeStore({
			detail: detail({
				edgeIds: ['cached:scheduler'],
				flow: 'cached',
				rate: 4,
				total: 120,
				finished: 0,
				failed: 0,
				series: { startMs: 0, bucketMs: 30_000, values: [4], failed: null },
				items: [
					{ drv: drvView('hit', { phase: 'cached' }), via: 'cached:scheduler', atMs: 1, bytes: 0 }
				]
			})
		});
		const t = text(linePanel(store, ['cached:scheduler']));
		expect(t).toContain('Now 240 hits/min');
		expect(t).toContain('No bytes travel on this line.');
		// The chip says Cached, so the row does not say "Cache hit" again.
		expect(t).toContain('Cached hit x86_64-linux');
		expect(t).not.toContain('Cache hit ·');
		expect(t).toContain('From Scheduler To Binary cache');
	});

	it('request lines explain their share, and a folded group says where it counts', () => {
		const want = detail({ edgeIds: ['want:ci'], flow: 'want', rate: 12 });
		const shown = fakeStore({
			clientGroups: new Map([['ci', { id: 'ci', label: 'ci' } as ClientGroupView]]),
			detail: want
		});
		const t = text(linePanel(shown, ['want:ci']));
		expect(t).toContain(
			'Build requests from this client group: derivations its clients ask the scheduler for, cache hits included.'
		);
		// One visible line, and the rest behind a closed disclosure.
		expect(t).toContain(
			"Share of this client group's finished builds that failed. Cache hits are left out. How failures count"
		);
		const html = linePanel(shown, ['want:ci']);
		expect(html).toMatch(/<details class="p-more"><summary>How failures count<\/summary>/);
		expect(html.match(/<li>/g)).toHaveLength(4);
		expect(t).toContain('From ci To Scheduler');
		expect(t).not.toContain('counted under other clients');

		const folded = fakeStore({ detail: want });
		expect(text(linePanel(folded, ['want:ci']))).toContain(
			'This client group is counted under other clients on the map.'
		);
		const other = text(
			linePanel(fakeStore({ detail: { ...want, edgeIds: ['want:__other'] } }), ['want:__other'])
		);
		expect(other).toContain('counts twice');
		expect(other).toContain('From Other clients To Scheduler');
	});

	// dashboard.e2e.ts checks that a substitute line lists no builds and says why.
	it('a substitute line is measured: plain bytes, no "≈"', () => {
		const store = fakeStore({
			workers: workers(A),
			detail: detail({
				edgeIds: [`substitute:${A}`],
				flow: 'substitute',
				unit: 'bytes',
				rate: 2.1 * MiB,
				total: 9 * MiB,
				finished: 0,
				failed: 0,
				series: { startMs: 0, bucketMs: 30_000, values: [MiB, 2 * MiB], failed: null }
			})
		});
		const t = text(linePanel(store, [`substitute:${A}`]));
		expect(t).toContain('Now 2.1 MiB/s Substituted 9 MiB');
		expect(t).not.toContain('≈');
		expect(t).toContain(lineCaption('substitute', 'one'));
		expect(t).toContain(chartTitle('substitute', 'bytes'));
		expect(t).toContain('From Substituters To');
	});

	it('without an answer it says the builder or the line left', () => {
		const gone = text(linePanel(fakeStore(), [`assign:${A}`]));
		expect(gone).toContain('This builder left the map. Builders leave 10m after they disconnect');
		// The ends still lead to the nodes.
		expect(gone).toContain(`From Scheduler To ${A}`);
		expect(text(linePanel(fakeStore(), ['assign:a', 'assign:b']))).toContain(
			'This line is no longer on the map.'
		);
		expect(text(linePanel(fakeStore({ workers: workers(A) }), [`assign:${A}`]))).toContain(
			'This line is no longer on the map.'
		);
	});
});

describe('LineRows', () => {
	const edges = new Map<string, EdgeView>([
		[`assign:${A}`, { rate: 0.4, unit: 'builds', finished: 38, failed: 3 }],
		[`publish:${A}`, { rate: 12 * MiB, unit: 'bytes', finished: 0, failed: 0 }],
		[`assign:${B}`, { rate: 0.6, unit: 'builds', finished: 2, failed: 0 }]
	]);

	it('a builder lists its lines with rate and failure share', () => {
		const store = fakeStore({ edges });
		const rows = nodeLines({ kind: 'builder', addr: A }, [], true);
		const body = render(LineRows, { props: { store, rows, onopenlines: () => {} } }).body;
		const t = text(body);
		expect(t).toContain('Lines');
		expect(t).toContain('Assignments 24 assigned/min · 8% failed');
		expect(t).toContain('Publishes 12 MiB/s');
		// An estimate of nothing is just 0.
		expect(t).toContain('Fetches (estimated) 0 B/s');
		// The failure share covers the window, so the section says which.
		expect(t).toContain('Lines Last 15m');
		expect(body).toContain(
			'aria-label="Assignments from the scheduler, 24 assigned per minute, 8% failed in the last 15 minutes"'
		);
	});

	it('says an hour window in words', () => {
		const totals = { ...fakeStore().totals, windowMinutes: 60 };
		const store = fakeStore({ edges, totals });
		const rows = nodeLines({ kind: 'builder', addr: A }, [], true);
		const body = render(LineRows, { props: { store, rows, onopenlines: () => {} } }).body;
		expect(body).toContain('8% failed in the last 1 hour"');
	});

	it('says "Since 23:41" while line counts cover less than the window', () => {
		// The header totals cover the window, the lines only since the page went live.
		const fromMs = Date.UTC(2026, 10, 8, 23, 41);
		const at = formatClockMinutes(fromMs);
		const store = fakeStore({ edges, linesSince: { fromMs, cause: 'page' } });
		const rows = nodeLines({ kind: 'builder', addr: A }, [], true);
		const body = render(LineRows, { props: { store, rows, onopenlines: () => {} } }).body;
		expect(body).toContain(
			`aria-label="Assignments from the scheduler, 24 assigned per minute, 8% failed since ${at}"`
		);
		expect(text(body)).toContain(`Lines Since ${at}`);
		expect(body).toContain(`title="Counting since this page opened at ${at}:`);
		expect(body).not.toMatch(/so far/i);
	});

	it('leaves the time caption out when no row shows a failure share', () => {
		const quiet = new Map<string, EdgeView>([
			[`publish:${A}`, { rate: 12 * MiB, unit: 'bytes', finished: 0, failed: 0 }]
		]);
		const store = fakeStore({ edges: quiet });
		const rows = nodeLines({ kind: 'builder', addr: A }, [], true);
		const t = text(render(LineRows, { props: { store, rows, onopenlines: () => {} } }).body);
		expect(t).not.toContain('Last 15m');
	});

	it('a bundle adds up its lines', () => {
		const store = fakeStore({ edges });
		const drawn = [...edges.keys()].map((id) => ({
			id,
			kind: id.slice(0, id.indexOf(':')) as 'assign'
		}));
		const rows = nodeLines({ kind: 'scheduler' }, drawn, true);
		const t = text(render(LineRows, { props: { store, rows, onopenlines: () => {} } }).body);
		expect(t).toContain('Assignments 60 assigned/min · 8% failed');
	});

	it('a folded group takes its rate from the fallback, and no rows means no section', () => {
		const store = fakeStore();
		const rows = nodeLines({ kind: 'clients', group: 'ci' }, [], true);
		const fallback = (id: string): EdgeView | undefined =>
			id === 'want:ci' ? { rate: 5, unit: 'builds', finished: 0, failed: 0 } : undefined;
		const t = text(
			render(LineRows, { props: { store, rows, fallback, onopenlines: () => {} } }).body
		);
		expect(t).toContain('Requests 300 requests/min');
		const none = render(LineRows, { props: { store, rows: [], onopenlines: () => {} } }).body;
		expect(text(none).trim()).toBe('');
	});
});

// dashboard.e2e.ts checks the kicker, title and Back of builder, bundle and pool lines.
describe('DetailPanel', () => {
	it("names the cache hits line's two ends for screen readers", () => {
		const body = render(DetailPanel, {
			props: {
				store: fakeStore({ detail: detail() }),
				pools: new PoolToggles(),
				view: { kind: 'lines', flow: 'hit', edgeIds: ['cached:scheduler'] },
				below: null,
				returnTo: null,
				depth: 1,
				restored: false,
				lines: [],
				onclose: () => {},
				onback: () => {},
				onselectderivation: () => {},
				onopennode: () => {},
				onopenbuilder: () => {},
				onopenlines: () => {}
			}
		}).body;
		expect(body).toContain('aria-label="Cache hits, scheduler to cache"');
	});
});

describe('UpstreamPanel', () => {
	const NIXOS = 'https://cache.nixos.org';
	const sub = (url: string, over: Partial<SubstituterView> = {}): SubstituterView => ({
		url,
		builders: 2,
		narBytesPerSec: MiB,
		narBytes: 6 * 1024 * MiB,
		downloadBytes: 2 * 1024 * MiB,
		paths: 2140,
		failures: 3,
		...over
	});
	const upstream = (over: Partial<UpstreamView> = {}): UpstreamView => ({
		substituters: [
			sub(NIXOS),
			sub('https://nix-community.cachix.org', { failures: 0, downloadBytes: 0 })
		],
		narBytesPerSec: 2 * MiB,
		narBytes: 9 * 1024 * MiB,
		builders: 2,
		downloading: 1,
		unreported: 0,
		since: null,
		farmCache: sub('https://cache.farm.example', { builders: 2 }),
		...over
	});
	function panel(store: FakeStore) {
		return render(UpstreamPanel, {
			props: { store, rows: [], onopenbuilder: () => {}, onopenlines: () => {} }
		}).body;
	}

	it('says where builders get inputs, lists every substituter and the farm cache', () => {
		const ws = workers(A, B);
		ws.set(A, { ...worker(A), version: '1', substituters: [NIXOS] });
		const store = fakeStore({
			workers: ws,
			upstream: upstream(),
			meta: {
				instance: 'i',
				version: '1',
				defaultSystem: 'x86_64-linux',
				cacheUrl: 'https://cache.farm.example',
				cacheSubstituterUrl: 'https://cache.farm.example',
				servingSinceMs: 0
			},
			topology: {
				version: 1,
				clientGroups: [],
				workers: [A, B],
				workerSystems: ['x86_64-linux', 'x86_64-linux'],
				retired: [],
				hasCache: true,
				upstreamWorkers: [A],
				upstreamRows: 3
			}
		});
		const t = text(panel(store));
		expect(t).toContain("Where builders get inputs that neither they nor the farm's cache have.");
		expect(t).toContain('Now 2 MiB/s Substituted 9 GiB Substituting 1 of 2');
		expect(t).toContain(
			'https://cache.nixos.org on 2 builders · 1 MiB/s · 6 GiB, 2,140 paths 2 GiB on the wire · 3 failed substitutions'
		);
		expect(t).toContain(
			'https://nix-community.cachix.org on 2 builders · 1 MiB/s · 6 GiB, 2,140 paths Farm cache'
		);
		expect(t).toContain('Farm cache https://cache.farm.example');
		expect(t).not.toContain('does not say which substituter is its own cache');
		expect(t).toContain('Builders, busiest first');
	});

	it('says when the farm does not name its cache, and when builders do not report', () => {
		const store = fakeStore({ upstream: upstream({ farmCache: null, unreported: 2 }) });
		const t = text(panel(store));
		expect(t).not.toContain('Farm cache');
		expect(t).toContain('This farm does not say which substituter is its own cache');
		expect(t).toContain('2 builders do not report their substituters.');
	});
});

describe('BuilderPanel substituters', () => {
	function panel(store: FakeStore) {
		return render(BuilderPanel, {
			props: { store, addr: A, rows: [], onselectderivation: () => {}, onopenlines: () => {} }
		}).body;
	}

	it("lists the builder's substituters as chips, idle ones muted", () => {
		const ws = workers(A);
		ws.set(A, { ...worker(A), version: '1', substituters: ['https://cache.nixos.org'] });
		const store = fakeStore({
			workers: ws,
			substitutersOf: () => [
				{
					url: 'https://cache.nixos.org',
					narBytesPerSec: 2.1 * MiB,
					narBytes: 1,
					paths: 1,
					failures: 0
				},
				{ url: 'https://cache.lab.example', narBytesPerSec: 0, narBytes: 0, paths: 0, failures: 0 }
			]
		});
		const body = panel(store);
		expect(text(body)).toContain('Substituters cache.nixos.org 2.1 MiB/s cache.lab.example 0 B/s');
		expect(body).toMatch(/<li [^>]*class="[^"]*idle[^"]*"[^>]*>cache\.lab\.example/);
		expect(body).not.toMatch(/<li [^>]*class="[^"]*idle[^"]*"[^>]*>cache\.nixos\.org/);
	});

	it('says when there are none, or the builder does not report them', () => {
		const ws = workers(A);
		ws.set(A, { ...worker(A), version: '1' });
		expect(text(panel(fakeStore({ workers: ws })))).toContain('No substituters configured.');
		// B reports, so A is the one that does not.
		const mixed = workers(A, B);
		mixed.set(B, { ...worker(B), version: '1' });
		expect(text(panel(fakeStore({ workers: mixed })))).toContain(
			'Substituters This builder does not report its substituters.'
		);
	});

	it('has no section on a farm where no builder reports, which the caption says once', () => {
		const t = text(panel(fakeStore({ workers: workers(A, B) })));
		expect(t).toContain('This farm does not report drain reasons, free disk, substituters');
		expect(t).not.toContain('Substituters');
		expect(t).not.toContain('This builder does not report its substituters.');
	});
});
