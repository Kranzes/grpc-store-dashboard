import { describe, expect, it } from 'vitest';
import type { Topology, WorkerView } from '#lib/model/types.ts';
import { matches, poolList, poolMembers } from './pool.ts';

const w = (addr: string, o: Partial<WorkerView> = {}): WorkerView => ({
	addr,
	systems: ['x86_64-linux', 'i686-linux'],
	features: [],
	maxJobs: 8,
	running: 0,
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
	queuedCanTake: 0,
	...o
});

const farm = [
	w('10.0.0.9:50051', { running: 4 }),
	w('10.0.0.10:50051', { running: 8, features: ['kvm', 'big-parallel'] }),
	w('10.0.0.11:50051', { running: 2, maxJobs: 2, features: ['kvm'] }),
	w('10.0.0.12:50051', { draining: true, running: 1 }),
	w('10.0.0.13:50051', { up: false })
];
const addrs = (ws: WorkerView[]) => ws.map((x) => x.addr.split(':')[0]);
const list = (o: Partial<Parameters<typeof poolList>[1]> = {}) =>
	addrs(poolList(farm, { query: '', sort: 'address', filter: 'all', ...o }));

describe('poolMembers', () => {
	it("picks a pool's builders by native system, unknown ones included", () => {
		const t: Topology = {
			version: 1,
			clientGroups: [],
			workers: ['a', 'b', 'c', 'd'],
			workerSystems: ['aarch64-linux', 'x86_64-linux', '', 'x86_64-linux'],
			retired: ['d'],
			hasCache: true,
			upstreamWorkers: [],
			upstreamRows: 0
		};
		expect(poolMembers(t, 'x86_64-linux')).toEqual(['b']);
		expect(poolMembers(t, 'unknown system')).toEqual(['c']);
	});
});

describe('poolList', () => {
	it('sorts by address in numeric order', () => {
		expect(list()).toEqual(['10.0.0.9', '10.0.0.10', '10.0.0.11', '10.0.0.12', '10.0.0.13']);
	});

	it('sorts builders taking work first, then by share of slots and assigned slots', () => {
		expect(list({ sort: 'busiest' })).toEqual([
			'10.0.0.10',
			'10.0.0.11',
			'10.0.0.9',
			'10.0.0.12',
			'10.0.0.13'
		]);
		// Idle first means spare capacity, so draining and offline builders come last.
		expect(list({ sort: 'idle' })).toEqual([
			'10.0.0.9',
			'10.0.0.11',
			'10.0.0.10',
			'10.0.0.12',
			'10.0.0.13'
		]);
	});

	it('filters draining and offline builders', () => {
		expect(list({ filter: 'draining' })).toEqual(['10.0.0.12']);
		expect(list({ filter: 'offline' })).toEqual(['10.0.0.13']);
	});

	it('searches addresses and features, every word, ignoring case', () => {
		expect(list({ query: '10.0.0.1' })).toEqual([
			'10.0.0.10',
			'10.0.0.11',
			'10.0.0.12',
			'10.0.0.13'
		]);
		expect(list({ query: 'KVM' })).toEqual(['10.0.0.10', '10.0.0.11']);
		expect(list({ query: 'kvm big' })).toEqual(['10.0.0.10']);
		expect(list({ query: 'kvm', filter: 'offline' })).toEqual([]);
		expect(matches(farm[0], '  ')).toBe(true);
		expect(matches(farm[0], 'i686')).toBe(true);
	});

	it('leaves its input alone', () => {
		const before = farm.slice();
		poolList(farm, { query: '', sort: 'busiest', filter: 'all' });
		expect(farm).toEqual(before);
	});
});
