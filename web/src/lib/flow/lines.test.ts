import { describe, expect, it } from 'vitest';
import { CACHE_ID, OTHER_CLIENTS, SCHEDULER_ID, UPSTREAM_ID } from '#lib/model/types.ts';
import {
	kindName,
	lineEnds,
	lineHeading,
	lineTitle,
	nodeLines,
	type DrawnLine,
	type LineNames
} from './lines.ts';

const workers = new Set(['10.0.0.13:50051', 'pool:50051']);
const names: LineNames = {
	isBuilder: (addr) => workers.has(addr),
	groupLabel: (g) => (g === 'g3' ? 'ci-runner-3' : undefined)
};
const text = (flow: Parameters<typeof lineTitle>[0], ids: string[]) =>
	lineTitle(flow, ids, names).text;

describe('lineEnds', () => {
	it('names both ends, the own end and the shared one', () => {
		expect(lineEnds('assign:10.0.0.13:50051', names.isBuilder)).toEqual({
			flow: 'assign',
			endpoint: { kind: 'builder', addr: '10.0.0.13:50051' },
			source: SCHEDULER_ID,
			target: 'worker:10.0.0.13:50051',
			own: 'worker:10.0.0.13:50051',
			hub: SCHEDULER_ID
		});
		expect(lineEnds('publish:pool:x86_64-linux', names.isBuilder)).toMatchObject({
			endpoint: { kind: 'pool', system: 'x86_64-linux' },
			source: 'pool:x86_64-linux',
			target: CACHE_ID,
			own: 'pool:x86_64-linux',
			hub: CACHE_ID
		});
		expect(lineEnds('fetch:10.0.0.13:50051', names.isBuilder)).toMatchObject({
			source: CACHE_ID,
			target: 'worker:10.0.0.13:50051'
		});
		expect(lineEnds(`want:${OTHER_CLIENTS}`, names.isBuilder)).toMatchObject({
			source: `clients:${OTHER_CLIENTS}`,
			target: SCHEDULER_ID,
			own: `clients:${OTHER_CLIENTS}`
		});
		expect(lineEnds('cached:scheduler', names.isBuilder)).toMatchObject({
			source: SCHEDULER_ID,
			target: CACHE_ID,
			own: null
		});
		expect(lineEnds('nonsense', names.isBuilder)).toBeNull();
		expect(lineEnds('bogus:x', names.isBuilder)).toBeNull();
	});

	it('takes a known builder address before a pool', () => {
		expect(lineEnds('assign:pool:50051', names.isBuilder)?.own).toBe('worker:pool:50051');
		expect(lineEnds('assign:pool:aarch64-linux', names.isBuilder)?.own).toBe('pool:aarch64-linux');
		// A builder that left is no longer known, but its id still names a builder.
		expect(lineEnds('assign:10.0.0.99:50051', names.isBuilder)?.own).toBe('worker:10.0.0.99:50051');
	});
});

describe('lineTitle', () => {
	it('names each kind and its varying end in one phrase, and counts bundles', () => {
		expect(text('assign', ['assign:10.0.0.13:50051'])).toBe('Assignments to 10.0.0.13:50051');
		expect(text('assign', ['assign:pool:x86_64-linux'])).toBe(
			'Assignments to the x86_64-linux pool'
		);
		expect(text('publish', ['publish:10.0.0.13:50051'])).toBe('Publishes from 10.0.0.13:50051');
		expect(text('fetch', ['fetch:pool:x86_64-linux'])).toBe('Fetches to the x86_64-linux pool');
		expect(text('request', ['want:g3'])).toBe('Requests from ci-runner-3');
		expect(text('request', [`want:${OTHER_CLIENTS}`])).toBe('Requests from other clients');
		expect(text('request', ['want:'])).toBe('Requests from unknown client');
		expect(text('hit', ['cached:scheduler'])).toBe('Cache hits, scheduler to cache');

		const builders = (kind: string, n: number) =>
			Array.from({ length: n }, (_, i) => `${kind}:10.0.1.${i}:50051`);
		expect(text('assign', builders('assign', 11))).toBe('Assignments to 11 builders');
		expect(text('assign', [...builders('assign', 14), 'assign:pool:x86_64-linux'])).toBe(
			'Assignments to 14 builders and 1 pool'
		);
		expect(text('assign', ['assign:pool:a', 'assign:pool:b'])).toBe('Assignments to 2 pools');
		expect(text('assign', ['assign:pool:a', 'assign:10.0.0.13:50051'])).toBe(
			'Assignments to 1 builder and 1 pool'
		);
		expect(text('publish', builders('publish', 4))).toBe('Publishes from 4 builders');
		expect(text('fetch', builders('fetch', 12))).toBe('Fetches to 12 builders');
		const groups = Array.from({ length: 8 }, (_, i) => `want:g${i}`);
		expect(text('request', [...groups, `want:${OTHER_CLIENTS}`])).toBe(
			'Requests from 9 client groups'
		);
	});

	it('counts a builder named pool:50051 as a builder', () => {
		expect(text('assign', ['assign:pool:50051'])).toBe('Assignments to pool:50051');
		expect(text('assign', ['assign:pool:50051', 'assign:pool:x86_64-linux'])).toBe(
			'Assignments to 1 builder and 1 pool'
		);
	});

	it('leaves out ids of another kind', () => {
		expect(text('assign', ['assign:10.0.0.13:50051', 'publish:10.0.0.13:50051'])).toBe(
			'Assignments to 10.0.0.13:50051'
		);
	});

	it('marks the address, identity or system for the mono face', () => {
		expect(lineTitle('assign', ['assign:10.0.0.13:50051'], names).parts).toEqual([
			{ text: 'Assignments to ', mono: false },
			{ text: '10.0.0.13:50051', mono: true }
		]);
		expect(lineTitle('publish', ['publish:pool:x86_64-linux'], names).parts).toEqual([
			{ text: 'Publishes from the ', mono: false },
			{ text: 'x86_64-linux', mono: true },
			{ text: ' pool', mono: false }
		]);
		expect(lineTitle('request', [`want:${OTHER_CLIENTS}`], names).parts).toEqual([
			{ text: 'Requests from other clients', mono: false }
		]);
	});
});

describe('lineHeading', () => {
	const heading = (flow: Parameters<typeof lineHeading>[0], ids: string[]) =>
		lineHeading(flow, ids, names);

	it('names only the end that varies, under the kind in the kicker', () => {
		expect(kindName('fetch')).toBe('Fetches');
		expect(heading('assign', ['assign:10.0.0.13:50051']).parts).toEqual([
			{ text: '10.0.0.13:50051', mono: true }
		]);
		expect(heading('fetch', ['fetch:pool:x86_64-linux']).parts).toEqual([
			{ text: 'x86_64-linux', mono: true },
			{ text: ' pool', mono: false }
		]);
		expect(heading('request', ['want:g3']).text).toBe('ci-runner-3');
		expect(heading('request', [`want:${OTHER_CLIENTS}`]).text).toBe('Other clients');
		const six = Array.from({ length: 6 }, (_, i) => `assign:10.0.1.${i}:50051`);
		expect(heading('assign', six).text).toBe('6 builders');
		expect(heading('request', ['want:g1', 'want:g3']).text).toBe('2 client groups');
	});

	it('gives the cache hits line, whose ends are both shared, "Scheduler to cache"', () => {
		expect(kindName('hit')).toBe('Cache hits');
		expect(heading('hit', ['cached:scheduler']).text).toBe('Scheduler to cache');
	});
});

describe('nodeLines', () => {
	const drawn: DrawnLine[] = [
		{ id: 'cached:scheduler', kind: 'hit' },
		{ id: 'want:g1', kind: 'request' },
		{ id: `want:${OTHER_CLIENTS}`, kind: 'request' },
		{ id: 'assign:a', kind: 'assign' },
		{ id: 'publish:a', kind: 'publish' },
		{ id: 'fetch:a', kind: 'fetch' },
		{ id: 'assign:pool:x86_64-linux', kind: 'assign' },
		{ id: 'publish:pool:x86_64-linux', kind: 'publish' },
		{ id: 'fetch:pool:x86_64-linux', kind: 'fetch' }
	];

	it('nodeLines lists the rows of each node kind', () => {
		expect(nodeLines({ kind: 'builder', addr: 'a' }, drawn, true)).toEqual([
			{
				flow: 'assign',
				edgeIds: ['assign:a'],
				label: 'Assignments',
				name: 'Assignments from the scheduler'
			},
			{
				flow: 'publish',
				edgeIds: ['publish:a'],
				label: 'Publishes',
				name: 'Publishes to the cache'
			},
			{
				flow: 'fetch',
				edgeIds: ['fetch:a'],
				label: 'Fetches (estimated)',
				name: 'Fetches from the cache (estimated)'
			}
		]);
		// Without a cache a builder has only its assignments.
		expect(nodeLines({ kind: 'builder', addr: 'a' }, [], false)).toEqual([
			{
				flow: 'assign',
				edgeIds: ['assign:a'],
				label: 'Assignments',
				name: 'Assignments from the scheduler'
			}
		]);
		// A builder inside a collapsed pool keeps its own ids.
		expect(nodeLines({ kind: 'builder', addr: 'b' }, drawn, true).map((r) => r.edgeIds)).toEqual([
			['assign:b'],
			['publish:b'],
			['fetch:b']
		]);
		expect(
			nodeLines({ kind: 'pool', system: 'x86_64-linux' }, drawn, true).map((r) => r.edgeIds)
		).toEqual([
			['assign:pool:x86_64-linux'],
			['publish:pool:x86_64-linux'],
			['fetch:pool:x86_64-linux']
		]);
		// A folded group opens its own request line.
		expect(nodeLines({ kind: 'clients', group: 'g7' }, drawn, true)).toEqual([
			{
				flow: 'request',
				edgeIds: ['want:g7'],
				label: 'Requests',
				name: 'Requests to the scheduler'
			}
		]);
		expect(nodeLines({ kind: 'scheduler' }, drawn, true)).toEqual([
			{
				flow: 'request',
				edgeIds: ['want:g1', `want:${OTHER_CLIENTS}`],
				label: 'Requests',
				name: 'Requests from clients'
			},
			{
				flow: 'assign',
				edgeIds: ['assign:a', 'assign:pool:x86_64-linux'],
				label: 'Assignments',
				name: 'Assignments to builders'
			},
			{ flow: 'hit', edgeIds: ['cached:scheduler'], label: 'Cache hits', name: 'Cache hits' }
		]);
		expect(nodeLines({ kind: 'cache' }, drawn, true)).toEqual([
			{
				flow: 'publish',
				edgeIds: ['publish:a', 'publish:pool:x86_64-linux'],
				label: 'Publishes',
				name: 'Publishes from builders'
			},
			{
				flow: 'fetch',
				edgeIds: ['fetch:a', 'fetch:pool:x86_64-linux'],
				label: 'Fetches (estimated)',
				name: 'Fetches to builders (estimated)'
			},
			{ flow: 'hit', edgeIds: ['cached:scheduler'], label: 'Cache hits', name: 'Cache hits' }
		]);
		// No drawn line of a kind, no row for it.
		expect(nodeLines({ kind: 'scheduler' }, [{ id: 'assign:a', kind: 'assign' }], false)).toEqual([
			{
				flow: 'assign',
				edgeIds: ['assign:a'],
				label: 'Assignments',
				name: 'Assignments to builders'
			}
		]);
	});
});

describe('substitute lines', () => {
	it('run from the upstream card to a builder or pool', () => {
		expect(lineEnds('substitute:10.0.0.13:50051', names.isBuilder)).toMatchObject({
			flow: 'substitute',
			source: UPSTREAM_ID,
			target: 'worker:10.0.0.13:50051',
			own: 'worker:10.0.0.13:50051',
			hub: UPSTREAM_ID
		});
		expect(lineEnds('substitute:pool:x86_64-linux', names.isBuilder)?.own).toBe(
			'pool:x86_64-linux'
		);
	});

	it('are called substitutions, to a builder, a pool or a bundle', () => {
		expect(kindName('substitute')).toBe('Substitutions');
		expect(text('substitute', ['substitute:10.0.0.13:50051'])).toBe(
			'Substitutions to 10.0.0.13:50051'
		);
		expect(text('substitute', ['substitute:pool:x86_64-linux'])).toBe(
			'Substitutions to the x86_64-linux pool'
		);
		expect(
			text('substitute', [
				'substitute:10.0.0.13:50051',
				'substitute:10.0.0.14:50051',
				'substitute:pool:x86_64-linux'
			])
		).toBe('Substitutions to 2 builders and 1 pool');
		expect(
			lineHeading('substitute', ['substitute:pool:x86_64-linux', 'substitute:a'], names).text
		).toBe('1 builder and 1 pool');
	});

	it('nodeLines: builders and pools with a line list it, and the upstream card lists the bundle', () => {
		const drawn: DrawnLine[] = [
			{ id: 'substitute:a', kind: 'substitute' },
			{ id: 'substitute:pool:x86_64-linux', kind: 'substitute' },
			{ id: 'fetch:a', kind: 'fetch' }
		];
		const has = (id: string) => id === 'substitute:a' || id === 'substitute:pool:x86_64-linux';
		expect(nodeLines({ kind: 'builder', addr: 'a' }, drawn, true, has).at(-1)).toEqual({
			flow: 'substitute',
			edgeIds: ['substitute:a'],
			label: 'Substitutions',
			name: 'Substitutions from substituters'
		});
		// A builder without upstream substituters has no such row.
		expect(nodeLines({ kind: 'builder', addr: 'b' }, drawn, true, has).map((r) => r.flow)).toEqual([
			'assign',
			'publish',
			'fetch'
		]);
		expect(
			nodeLines({ kind: 'pool', system: 'x86_64-linux' }, drawn, true, has).at(-1)!.edgeIds
		).toEqual(['substitute:pool:x86_64-linux']);
		expect(nodeLines({ kind: 'upstream' }, drawn, true, has)).toEqual([
			{
				flow: 'substitute',
				edgeIds: ['substitute:a', 'substitute:pool:x86_64-linux'],
				label: 'Substitutions',
				name: 'Substitutions to builders'
			}
		]);
		// The cache is unchanged.
		expect(nodeLines({ kind: 'cache' }, drawn, true, has).map((r) => r.flow)).toEqual(['fetch']);
	});
});
