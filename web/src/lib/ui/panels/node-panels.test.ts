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
	capacity: 8,
	units: 0,
	running: 6,
	up: true,
	draining: false,
	retired: false,
	goneAt: null,
	drainReason: null,
	restingUntil: null,
	diskFree: 3 * 1024 ** 3,
	diskTotal: 200 * 1024 ** 3,
	minFree: 10 * 1024 ** 3,
	version: '1.0',
	cpuBusy: null,
	cpuIowait: null,
	cpuCores: null,
	memUsed: null,
	memTotal: null,
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
	drainingPublishUnavailable: 0,
	drainingResting: 0,
	offline: 0,
	running: 4,
	slots: 16,
	queuedCanTake: 0,
	occupied: 4,
	builderSlots: 8,
	needed: 1,
	spare: 1,
	cpuBusy: null,
	cpuIowait: null,
	cpuCores: null,
	memUsed: null,
	memTotal: null,
	loadBuilders: 0,
	history: [],
	historySince: null,
	idle: 0,
	idleSince: null,
	idleBefore: false,
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
			draining: 5,
			drainingLowDisk: 1,
			drainingStopping: 1,
			drainingLocalDaemon: 1,
			drainingPublishUnavailable: 1
		});
		expect(body).toContain(
			'Draining: 1 low on disk, 1 stopping, 1 with no nix-daemon, 1 with publishing failing, 1 without a reason.'
		);
	});

	it('says how many builders the work needs, and how many idle', () => {
		const now = Date.now();
		let body = renderPool({ ...POOL, idle: 1, idleSince: now - 23 * 60_000 });
		expect(facts(body).slice(4, 6)).toEqual([
			['Needed now', '1 of 2 online (1 spare)'],
			['Idle', '1, longest 23m23 minutes']
		]);
		expect(body).toContain(
			'If an autoscaler follows the scheduler, it asks for the needed builders.'
		);
		// Idle since before the page connected: only a bound.
		body = renderPool({ ...POOL, idle: 2, idleSince: now - 5 * 60_000, idleBefore: true });
		expect(facts(body)[5]).toEqual(['Idle', '2, longest over 5m5 minutes']);
		body = renderPool({ ...POOL, needed: null });
		expect(facts(body)[4]).toEqual(['Needed now', 'Unknown']);
	});

	it('puts CPU and RAM under the slots, and says how many builders report them', () => {
		const GiB = 1024 ** 3;
		const load = { cpuBusy: 4, cpuIowait: 2, cpuCores: 16, memUsed: 8 * GiB, memTotal: 32 * GiB };
		let body = renderPool({ ...POOL, ...load, loadBuilders: 1 });
		expect(facts(body).slice(5, 7)).toEqual([
			['CPU', '25%'],
			['RAM', '25%']
		]);
		expect(facts(body)).toContainEqual(['I/O wait', '13%']);
		expect(meterIn(body, 'CPU')).toBeCloseTo(0.25);
		expect(body).toContain('CPU and RAM of 1 of 2 builders: the others do not report them.');
		body = renderPool({ ...POOL, ...load, loadBuilders: 2 });
		expect(body).not.toContain('do not report them');
		// Builders that measure no I/O wait, as on macOS: no figure rather than 0%.
		body = renderPool({ ...POOL, ...load, cpuIowait: null, loadBuilders: 2 });
		expect(facts(body).map(([label]) => label)).toContain('CPU');
		expect(facts(body).map(([label]) => label)).not.toContain('I/O wait');
		// No builder reports: neither shows.
		body = renderPool(POOL);
		expect(facts(body).map(([label]) => label)).not.toContain('CPU');
		expect(facts(body).map(([label]) => label)).not.toContain('I/O wait');
	});

	it('puts the slots meter under Assigned slots, filled to the share in use', () => {
		const body = renderPool(POOL);
		expect(meterIn(body, 'Assigned slots')).toBeCloseTo(POOL.running / POOL.slots);
		expect(body.match(/p-meter/g)).toHaveLength(1);
	});
});
