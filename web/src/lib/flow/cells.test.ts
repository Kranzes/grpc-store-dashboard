import { describe, expect, it } from 'vitest';
import type { WorkerView } from '#lib/model/types.ts';
import { builderFeatures, cellLevel, cellOf, cellsOf, featureSummary } from './cells.ts';

const w = (addr: string, o: Partial<WorkerView> = {}): WorkerView => ({
	addr,
	systems: ['x86_64-linux'],
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

describe('cells', () => {
	it('steps load into idle, up to half, more than half, and full', () => {
		expect([0, 1, 4, 5, 7, 8, 9].map((r) => cellLevel(r, 8))).toEqual([0, 1, 1, 2, 2, 3, 3]);
		expect(cellLevel(3, 0)).toBe(0);
	});

	it('names the builder, its load and its state', () => {
		const a = w('a', { running: 3 });
		expect(cellOf('a', a)).toEqual({
			addr: 'a',
			level: 1,
			state: 'up',
			title: 'a · 3/8 assigned',
			view: a
		});
		expect(cellOf('a', w('a', { draining: true })).title).toBe('a · 0/8 assigned · draining');
		// With its reason, and free disk when that is why.
		const low = { draining: true, drainReason: 'low-disk' as const };
		expect(
			cellOf('a', w('a', { ...low, running: 6, maxJobs: 16, diskFree: 3.1 * 1024 ** 3 })).title
		).toBe('a · 6/16 assigned · draining, low on disk, 3.1 GiB free');
		expect(cellOf('a', w('a', low)).title).toBe('a · 0/8 assigned · draining, low on disk');
		expect(cellOf('a', w('a', { draining: true, drainReason: 'stopping' })).title).toBe(
			'a · 0/8 assigned · draining, stopping'
		);
		expect(cellOf('a', w('a', { draining: true, drainReason: 'local-daemon' })).title).toBe(
			'a · 0/8 assigned · draining, no nix-daemon'
		);
		expect(cellOf('a', w('a', { up: false })).state).toBe('offline');
		expect(cellOf('a', undefined).state).toBe('offline');
	});

	it("keeps a cell while its builder's view keeps its identity", () => {
		const a = w('a');
		const b = w('b', { running: 2 });
		const workers = new Map([
			['a', a],
			['b', b]
		]);
		const first = cellsOf(['a', null, 'b'], workers);
		expect(first[1]).toBeNull();
		const same = cellsOf(['a', null, 'b'], workers, first);
		expect(same[0]).toBe(first[0]);
		expect(same[2]).toBe(first[2]);
		workers.set('b', w('b', { running: 8 }));
		const next = cellsOf(['a', null, 'b'], workers, same);
		expect(next[0]).toBe(first[0]);
		expect(next[2]).not.toBe(first[2]);
		expect(next[2]!.level).toBe(3);
		// A new builder in a free cell gets a cell of its own.
		workers.set('c', w('c'));
		expect(cellsOf(['a', 'c', 'b'], workers, next)[1]!.addr).toBe('c');
		// A builder that moved to another cell gets a new cell object there.
		expect(cellsOf(['b', 'c', 'a'], workers, next)[0]!.addr).toBe('b');
	});

	it('sums up features, the rarest first, and names a single leftover', () => {
		expect(featureSummary([], 10)).toBe('No extra features');
		const four = [
			{ name: 'kvm', builders: 80 },
			{ name: 'big-parallel', builders: 40 },
			{ name: 'nixos-test', builders: 12_345 },
			{ name: 'benchmark', builders: 1 }
		];
		expect(featureSummary(four, 20_000)).toBe(
			'benchmark 1 · big-parallel 40 · kvm 80 · nixos-test 12.3k'
		);
		expect(featureSummary([...four, { name: 'apple-virt', builders: 2 }], 20_000)).toBe(
			'benchmark 1 · apple-virt 2 · big-parallel 40 · +2'
		);
	});

	it('counts only the features some builders of the pool lack', () => {
		// A 20-builder pool where every builder but 12 offers kvm.
		const pool = [
			{ name: 'benchmark', builders: 20 },
			{ name: 'big-parallel', builders: 20 },
			{ name: 'nixos-test', builders: 20 },
			{ name: 'kvm', builders: 8 }
		];
		expect(featureSummary(pool, 20)).toBe('kvm 8 · benchmark · big-parallel · nixos-test');
		expect(featureSummary([...pool, { name: 'cuda', builders: 2 }], 20)).toBe(
			'cuda 2 · kvm 8 · benchmark · +2'
		);
		// Every builder offers everything: names only.
		expect(featureSummary(pool.slice(0, 2), 20)).toBe('benchmark · big-parallel');
	});

	it("puts a builder's rarest features first, by its pool's counts", () => {
		const pool = [
			{ name: 'big-parallel', builders: 19 },
			{ name: 'nixos-test', builders: 19 },
			{ name: 'kvm', builders: 8 }
		];
		expect(builderFeatures(['big-parallel', 'kvm', 'nixos-test'], pool)).toEqual([
			'kvm',
			'big-parallel',
			'nixos-test'
		]);
		// A feature the pool does not list yet goes last.
		expect(builderFeatures(['new', 'kvm'], pool)).toEqual(['kvm', 'new']);
		expect(builderFeatures(['b', 'a'], undefined)).toEqual(['a', 'b']);
	});
});
