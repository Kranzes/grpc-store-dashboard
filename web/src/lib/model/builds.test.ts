import { describe, expect, it } from 'vitest';
import {
	ANY_QUERY,
	assignedText as assignedLine,
	queryBuilds,
	type QueryContext
} from './builds.ts';
import { drvPath } from './fixtures.ts';
import { OTHER_CLIENTS, type BuildQuery, type BuildRow } from './types.ts';

const NOW = 1_800_000_000_000;
const A = '10.0.0.10:50051';
const B = '10.0.1.11:50051';

function row(name: string, over: Partial<BuildRow> = {}): BuildRow {
	return {
		drvPath: drvPath(name),
		name,
		system: 'x86_64-linux',
		worker: A,
		assignId: 1,
		state: 'built',
		status: null,
		errorLine: null,
		assignedMs: NOW - 120_000,
		startedMs: null,
		reportsStarts: false,
		finishedMs: NOW - 60_000,
		finishedServerMs: NOW - 60_000,
		phase: null,
		phaseStartedMs: null,
		requestedBy: [],
		from: 'live',
		...over
	};
}

const ctx: QueryContext = {
	now: NOW,
	poolOf: (addr) => (addr === A ? 'x86_64-linux' : addr === B ? 'aarch64-linux' : null),
	shownClients: new Set(['oidc:sso:alice'])
};

const q = (over: Partial<BuildQuery> = {}): BuildQuery => ({ ...ANY_QUERY, ...over });
const names = (rows: readonly BuildRow[]) => rows.map((r) => r.name);

describe('queryBuilds', () => {
	const rows = [
		row('built-old', { finishedMs: NOW - 600_000 }),
		row('failed-old', { state: 'failed', finishedMs: NOW - 500_000 }),
		row('running', { state: 'assigned', finishedMs: null, startedMs: NOW - 30_000 }),
		row('built-new', { finishedMs: NOW - 10_000 }),
		row('failed-new', { state: 'failed', finishedMs: NOW - 20_000 }),
		row('waiting', { state: 'assigned', finishedMs: null, assignedMs: NOW - 5_000 }),
		row('cancelled', { state: 'cancelled', finishedMs: NOW - 1_000 })
	];

	it('failures first, then assigned, then finished', () => {
		expect(names(queryBuilds(rows, q(), ctx).rows)).toEqual([
			'failed-new',
			'failed-old',
			'waiting',
			'running',
			'cancelled',
			'built-new',
			'built-old'
		]);
		expect(names(queryBuilds(rows, q({ sort: 'newest' }), ctx).rows)).toEqual([
			'cancelled',
			'waiting',
			'built-new',
			'failed-new',
			'running',
			'failed-old',
			'built-old'
		]);
	});

	it('an assigned row reads Running, a phase, Waiting to start or Assigned by what its builder reported', () => {
		expect(assignedLine(row('a', { state: 'assigned', startedMs: NOW, phase: 'buildPhase' }))).toBe(
			'buildPhase'
		);
		expect(assignedLine(row('a', { state: 'assigned', startedMs: NOW }))).toBe('Running');
		expect(assignedLine(row('a', { state: 'assigned', reportsStarts: true }))).toBe(
			'Waiting to start'
		);
		expect(assignedLine(row('a', { state: 'assigned' }))).toBe('Assigned');
	});

	describe('filters', () => {
		const all = [
			row('hello-2.12.1', { requestedBy: ['oidc:sso:alice'] }),
			row('zlib-1.3.1', { worker: B, system: 'aarch64-linux', requestedBy: ['ci-runner-1'] }),
			row('curl-8.12.1', { state: 'failed', finishedMs: NOW - 3_600_000 }),
			row('linux-6.12.21', { state: 'assigned', finishedMs: null })
		];

		it.each<[string, Partial<BuildQuery>, string[]]>([
			['one state', { states: new Set(['failed']) }, ['curl-8.12.1']],
			['two states', { states: new Set(['failed', 'assigned']) }, ['curl-8.12.1', 'linux-6.12.21']],
			['system', { system: 'aarch64-linux' }, ['zlib-1.3.1']],
			['builder', { builder: B }, ['zlib-1.3.1']],
			['pool', { pool: 'x86_64-linux' }, ['curl-8.12.1', 'hello-2.12.1', 'linux-6.12.21']],
			['client', { client: 'oidc:sso:alice' }, ['hello-2.12.1']],
			['other clients', { client: OTHER_CLIENTS }, ['zlib-1.3.1']],
			['name in any case', { q: 'HELLO' }, ['hello-2.12.1']],
			['hash prefix', { q: drvPath('zlib-1.3.1').slice(0, 6) }, ['zlib-1.3.1']],
			// Builds in progress always pass.
			['finished within', { withinMs: 900_000 }, ['hello-2.12.1', 'linux-6.12.21', 'zlib-1.3.1']]
		])('by %s', (_, over, want) => {
			expect(names(queryBuilds(all, q(over), ctx).rows).sort()).toEqual(want);
		});

		it('count the state chips under every other filter', () => {
			const query = q({ system: 'x86_64-linux', states: new Set(['built']) });
			expect(queryBuilds(all, query, ctx).counts).toEqual({
				failed: 1,
				assigned: 1,
				built: 1,
				other: 0
			});
		});
	});

	it('"Finished within" follows the time of each query', () => {
		const all = [row('hello-2.12.1', { finishedMs: NOW - 60_000 })];
		const within = q({ withinMs: 900_000 });
		expect(names(queryBuilds(all, within, ctx).rows)).toEqual(['hello-2.12.1']);
		expect(queryBuilds(all, within, { ...ctx, now: NOW + 900_000 }).rows).toEqual([]);
	});

	it('a pasted /nix/store path matches its derivation', () => {
		const all = [row('hello-2.12.1'), row('hello-2.12.2')];
		const path = `/nix/store/${drvPath('hello-2.12.1')}`;
		expect(names(queryBuilds(all, q({ q: path }), ctx).rows)).toEqual(['hello-2.12.1']);
		expect(names(queryBuilds(all, q({ q: `  ${drvPath('hello-2.12.2')} ` }), ctx).rows)).toEqual([
			'hello-2.12.2'
		]);
	});

	it('longest sorts assigned builds by elapsed time', () => {
		const all = [
			row('quick', { assignedMs: NOW - 70_000, finishedMs: NOW - 60_000 }),
			row('long-running', { state: 'assigned', finishedMs: null, startedMs: NOW - 900_000 }),
			row('slow', { assignedMs: NOW - 700_000, finishedMs: NOW - 100_000 }),
			row('fresh', { state: 'assigned', finishedMs: null, assignedMs: NOW - 1_000 })
		];
		expect(names(queryBuilds(all, q({ sort: 'longest' }), ctx).rows)).toEqual([
			'long-running',
			'slow',
			'quick',
			'fresh'
		]);
	});

	it('facets list systems, builders with pools, and clients', () => {
		const all = [
			row('a', { requestedBy: ['oidc:sso:bob', 'ci-runner-1'] }),
			row('b', { worker: B, system: 'aarch64-linux' }),
			row('c', { worker: '10.0.9.9:50051', system: 'riscv64-linux', requestedBy: ['oidc:sso:bob'] })
		];
		expect(queryBuilds(all, q({ states: new Set(['failed']) }), ctx).facets).toEqual({
			systems: ['aarch64-linux', 'riscv64-linux', 'x86_64-linux'],
			builders: [
				{ addr: '10.0.9.9:50051', pool: null },
				{ addr: B, pool: 'aarch64-linux' },
				{ addr: A, pool: 'x86_64-linux' }
			],
			clients: ['ci-runner-1', 'oidc:sso:bob']
		});
	});
});
