import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { PoolToggles } from '#lib/flow/pools.svelte.ts';
import type { PoolView, WorkerView } from '#lib/model/types.ts';
import { formatCount } from '../format.ts';
import BuilderPanel from './BuilderPanel.svelte';
import { fakeStore } from './fake-store.ts';
import PoolPanel from './PoolPanel.svelte';

const BUILDER: WorkerView = {
	addr: '10.0.0.10:50051',
	systems: ['x86_64-linux'],
	features: [],
	maxJobs: 8,
	running: 6,
	up: true,
	draining: false,
	retired: false,
	goneAt: null,
	drainReason: null,
	diskFree: 3 * 1024 ** 3,
	diskTotal: 200 * 1024 ** 3,
	minFree: 10 * 1024 ** 3,
	version: '1.0',
	substituters: [],
	builtPerMin: 12,
	failedPerMin: 3,
	queuedCanTake: 0
};

const POOL: PoolView = {
	system: 'x86_64-linux',
	builders: 2,
	up: 2,
	draining: 0,
	drainingLowDisk: 0,
	drainingStopping: 0,
	drainingLocalDaemon: 0,
	offline: 0,
	running: 4,
	slots: 16,
	queuedCanTake: 0,
	features: [],
	joined: 0,
	left: 0,
	churnSince: null
};

function renderBuilder(w: WorkerView) {
	const store = fakeStore({ workers: new Map([[w.addr, w]]) });
	const props = { store, addr: w.addr, rows: [], onselectderivation() {}, onopenlines() {} };
	return render(BuilderPanel, { props }).body.replace(/\s+/g, ' ');
}

function renderPool(pool: PoolView) {
	const store = fakeStore({ pools: new Map([[pool.system, pool]]) });
	const props = {
		store,
		system: pool.system,
		pools: new PoolToggles(),
		rows: [],
		onopenbuilder() {},
		onopenlines() {}
	};
	return render(PoolPanel, { props }).body.replace(/\s+/g, ' ');
}

/** The facts lists' labels and values, in order, as people see them. */
const facts = (html: string) =>
	[...html.matchAll(/<dt[^>]*>([^]*?)<\/dt>\s*<dd[^>]*>([^]*?)<\/dd>/g)].map((m) =>
		[m[1], m[2]].map((x) => x.replace(/<[^>]*>/g, '').trim())
	);

/** The fill of the meter in the fact labelled `label`, or null when that fact has none. */
function meterIn(body: string, label: string): number | null {
	const group = new RegExp(`<div><dt[^>]*>\\s*${label}\\s*</dt>(.*?)</div>`).exec(body)?.[1];
	if (group === undefined) throw new Error(`no fact labelled ${label}`);
	const meter = /<dd[^>]*\bclass="p-meter\b[^>]*>(.*?)<\/dd>/.exec(group)?.[1];
	if (meter === undefined) return null;
	return Number(/scaleX\(\s*([\d.]+)\s*\)/.exec(meter)?.[1]);
}

describe('BuilderPanel', () => {
	it('puts the slots meter under Assigned slots, filled to the share in use', () => {
		const body = renderBuilder(BUILDER);
		expect(meterIn(body, 'Assigned slots')).toBeCloseTo(BUILDER.running / BUILDER.maxJobs);
		expect(body.match(/p-meter/g)).toHaveLength(1);
	});

	it('counts its builds of the last minute under a caption of its own', () => {
		const body = renderBuilder(BUILDER);
		expect(facts(body.slice(body.indexOf('Last 1m'))).slice(0, 2)).toEqual([
			['Built', formatCount(BUILDER.builtPerMin)],
			['Failed', formatCount(BUILDER.failedPerMin)]
		]);
	});
});

describe('PoolPanel', () => {
	it('says low-disk drains stay as offline, in two sentences', () => {
		const body = renderPool(POOL);
		expect(body).toContain(
			'Offline builders stay 10m. Drained ones leave at once, unless they drained for low disk.'
		);
	});

	it('counts draining builders by reason', () => {
		const body = renderPool({
			...POOL,
			draining: 4,
			drainingLowDisk: 1,
			drainingStopping: 1,
			drainingLocalDaemon: 1
		});
		expect(body).toContain(
			'Draining: 1 low on disk, 1 stopping, 1 with no nix-daemon, 1 without a reason.'
		);
	});

	it('puts the slots meter under Assigned slots, filled to the share in use', () => {
		const body = renderPool(POOL);
		expect(meterIn(body, 'Assigned slots')).toBeCloseTo(POOL.running / POOL.slots);
		expect(body.match(/p-meter/g)).toHaveLength(1);
	});
});
