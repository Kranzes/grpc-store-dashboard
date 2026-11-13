import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
	CounterSampleSchema,
	CountersSchema,
	FinishedBuildSchema,
	RecentBuildsBatchSchema,
	DrvGone_Status as Status,
	DrvState_Cause as Cause,
	DrvState_Phase as Phase,
	InputSourceSchema,
	SubstituterTrafficSchema,
	WorkerState_DrainReason as Drain,
	OutputSchema
} from '#lib/gen/events_pb.ts';
import { MockFarm, mockOptions } from '#lib/source/mock.ts';
import { ANY_QUERY } from './builds.ts';
import {
	DrvGone_Outcome as Outcome,
	E,
	Stream,
	T0,
	drvPath,
	started,
	type Ev
} from './fixtures.ts';
import { FarmReducer } from './reducer.ts';
import { ERRORS_KEPT, OTHER_CLIENTS, parseEdgeId } from './types.ts';

const A = '10.0.0.10:50051';
const B = '10.0.1.11:50051';
const Q1 = drvPath('q1');
const Q2 = drvPath('q2');
const A1 = drvPath('a1');
const N1 = drvPath('hello-2.12');
const C1 = drvPath('cached-1');

/** Two workers, two clients, a queued, an unplaceable and an assigned drv. */
function farm(options = {}) {
	return started(
		options,
		E.reset(),
		E.worker(A, { systems: ['x86_64-linux', 'i686-linux'], features: ['kvm'], maxJobs: 4 }),
		E.worker(B, { systems: ['aarch64-linux'], maxJobs: 2, draining: true }),
		E.client(1, 'ci-runner-1'),
		E.client(2, 'oidc:sso:alice'),
		E.drv(Q1, { clientIds: [1n], queuedMs: BigInt(T0 - 60_000), cpHintMs: 3000n }),
		E.drv(Q2, {
			phase: Phase.UNPLACEABLE,
			clientIds: [2n],
			features: ['cuda'],
			reason: 'no worker offers cuda',
			queuedMs: BigInt(T0 - 30_000),
			cpHintMs: 1000n
		}),
		E.drv(A1, {
			phase: Phase.ASSIGNED,
			clientIds: [1n, 2n],
			workerAddr: A,
			assignId: 7n,
			queuedMs: BigInt(T0 - 90_000),
			assignedMs: BigInt(T0 - 20_000),
			inputs: 5,
			inputsUnknown: 2,
			inputSources: [
				create(InputSourceSchema, { workerAddr: A, paths: 2, narBytes: 2000n }),
				create(InputSourceSchema, { workerAddr: B, paths: 1, narBytes: 500n })
			]
		})
	);
}

describe('snapshot', () => {
	it('builds state and marks the stream live only at SnapshotDone', () => {
		const r = new FarmReducer();
		const s = new Stream();
		r.beginStream();
		const [reset, w, done] = s.snapshot(E.reset(), E.worker(A));
		expect(r.apply([reset, w], T0)).toEqual({ ok: true, snapshotDone: false });
		expect(r.phase).toBe('snapshot');
		expect(r.apply([done], T0)).toEqual({ ok: true, snapshotDone: true });
		expect(r.phase).toBe('live');
	});

	it('derives workers, groups, scheduler and edges', () => {
		const { r, res } = farm();
		expect(res).toEqual({ ok: true, snapshotDone: true });
		const v = r.views(T0, 15);
		// Sorted by native system, then addr.
		expect(v.topology.workers).toEqual([B, A]);
		expect(v.topology.workerSystems).toEqual(['aarch64-linux', 'x86_64-linux']);
		expect(v.topology.clientGroups).toEqual(['ci-runner-1', 'oidc:sso:alice']);
		expect(v.topology.hasCache).toBe(true);
		expect(v.meta).toMatchObject({
			instance: 'inst-a',
			version: '1.2.3',
			defaultSystem: 'x86_64-linux',
			cacheUrl: 'https://cache.test'
		});

		expect(v.workers.get(A)).toMatchObject({
			addr: A,
			systems: ['x86_64-linux', 'i686-linux'],
			features: ['kvm'],
			maxJobs: 4,
			running: 1,
			up: true,
			draining: false,
			retired: false,
			// Q1 waits for an x86 slot; Q2 is unplaceable and does not count.
			queuedCanTake: 1
		});
		expect(v.workers.get(B)).toMatchObject({ running: 0, draining: true, queuedCanTake: 0 });

		expect(v.clientGroups.get('ci-runner-1')).toEqual({
			id: 'ci-runner-1',
			label: 'ci-runner-1',
			clients: 1,
			waiting: 2,
			wantsPerSec: 0
		});
		expect(v.clientGroups.get('oidc:sso:alice')).toMatchObject({ clients: 1, waiting: 2 });

		expect(v.scheduler).toMatchObject({
			queued: 2,
			unplaceable: 1,
			assigned: 1,
			workersUp: 2,
			clients: 2,
			// B is draining, so only A's slots count.
			slots: 4,
			free: 3,
			assignedPerSec: 0
		});
		expect(v.cache).toMatchObject({ url: 'https://cache.test', hitsPerSec: 0, hitRatio: null });

		expect([...v.edges.keys()].sort()).toEqual(
			[
				`assign:${A}`,
				`assign:${B}`,
				`publish:${A}`,
				`publish:${B}`,
				`fetch:${A}`,
				`fetch:${B}`,
				'assign:pool:x86_64-linux',
				'publish:pool:x86_64-linux',
				'fetch:pool:x86_64-linux',
				'assign:pool:aarch64-linux',
				'publish:pool:aarch64-linux',
				'fetch:pool:aarch64-linux',
				'cached:scheduler',
				'want:ci-runner-1',
				'want:oidc:sso:alice'
			].sort()
		);
		// Where an edge runs is the layout's business, covered in layout.test.ts.
		// Every line of a kind has the kind's unit.
		const units = new Set([...v.edges].map(([id, e]) => `${parseEdgeId(id)!.flow} ${e.unit}`));
		expect(units).toEqual(
			new Set(['assign builds', 'want builds', 'cached builds', 'publish bytes', 'fetch bytes'])
		);
	});

	it('has no cache node or cache edges without a cache', () => {
		const { r } = started({}, E.reset({ cacheUrl: '' }), E.worker(A));
		const v = r.views(T0, 15);
		expect(v.topology.hasCache).toBe(false);
		expect(v.cache).toBeNull();
		expect([...v.edges.keys()]).toEqual([`assign:${A}`, 'assign:pool:x86_64-linux']);
	});

	it('answers drill-down queries', () => {
		const { r } = farm();
		const a1 = r.drv(A1)!;
		expect(a1).toMatchObject({
			drvPath: A1,
			name: 'a1',
			phase: 'assigned',
			system: 'x86_64-linux',
			workerAddr: A,
			clientIds: [1, 2],
			identities: ['ci-runner-1', 'oidc:sso:alice'],
			queuedMs: T0 - 90_000,
			assignedMs: T0 - 20_000,
			finishedMs: null,
			inputs: 5,
			inputsUnknown: 2,
			reason: null
		});
		expect(a1.inputSources).toEqual([
			{ workerAddr: A, paths: 2, narBytes: 2000, local: true },
			{ workerAddr: B, paths: 1, narBytes: 500, local: false }
		]);
		expect(a1).toMatchObject({ fetchedBytes: 500, outputBytes: 0 });
		expect(r.drv(Q2)).toMatchObject({ phase: 'unplaceable', reason: 'no worker offers cuda' });
		expect(r.drv(drvPath('nope'))).toBeUndefined();
		// The same view object until something changes.
		expect(r.drv(A1)).toBe(a1);

		expect(r.drvsForWorker(A).map((d) => d.drvPath)).toEqual([A1]);
		expect(r.drvsForWorker(B)).toEqual([]);
		// Higher critical path first.
		expect(r.drvsQueued().map((d) => d.drvPath)).toEqual([Q1, Q2]);
		expect(r.drvsQueued(1).map((d) => d.drvPath)).toEqual([Q1]);
		// Assigned first, then the queue.
		expect(r.drvsForClientGroup('oidc:sso:alice').map((d) => d.drvPath)).toEqual([A1, Q2]);
		expect(r.drvsForClientGroup('ci-runner-1').map((d) => d.drvPath)).toEqual([A1, Q1]);
		expect(r.drvsForClientGroup('nobody')).toEqual([]);
	});

	it('orders the queue like the scheduler: followers and age count', () => {
		const old = drvPath('old');
		const fan = drvPath('fan');
		const hint = drvPath('hint');
		const { r } = started(
			{},
			E.reset(),
			// 60 s of waiting is worth 240 s of critical path.
			E.drv(old, { queuedMs: BigInt(T0 - 60_000), cpHintMs: 0n, clientIds: [1n] }),
			E.drv(hint, { queuedMs: BigInt(T0), cpHintMs: 200_000n, clientIds: [1n] }),
			// Two extra followers are worth 60 s.
			E.drv(fan, { queuedMs: BigInt(T0), cpHintMs: 0n, clientIds: [1n, 2n, 3n] })
		);
		expect(r.drvsQueued().map((d) => d.name)).toEqual(['old', 'hint', 'fan']);
	});
});

describe('deltas', () => {
	it('counts traffic and derives rates that decay to zero', () => {
		const { r, s } = farm();
		const now = T0 + 1000;
		const res = r.apply(
			s.next(
				// The first Stats after the snapshot is the base for cache rates.
				E.stats(),
				E.drv(N1, { cause: Cause.WANTED, clientIds: [1n], cacheChecked: true, cpHintMs: 1000n }),
				E.drv(N1, {
					cause: Cause.ASSIGNED,
					phase: Phase.ASSIGNED,
					clientIds: [1n],
					workerAddr: A,
					assignedMs: BigInt(T0 + 500),
					inputSources: [create(InputSourceSchema, { workerAddr: B, paths: 3, narBytes: 1000n })]
				}),
				E.gone(N1, Outcome.BUILT, {
					workerAddr: A,
					outputs: [create(OutputSchema, { path: '/nix/store/x-hello', narSize: 5000n })]
				}),
				E.cached(C1, 2),
				E.stats({ cacheHits: 1n, cacheMisses: 1n })
			),
			now
		);
		expect(res).toEqual({ ok: true, snapshotDone: false });
		const v = r.views(now, 15);
		// One event per 10 s window.
		expect(v.clientGroups.get('ci-runner-1')!.wantsPerSec).toBe(0.1);
		expect(v.clientGroups.get('oidc:sso:alice')!.wantsPerSec).toBe(0.1);
		expect(v.edges.get('want:ci-runner-1')!.rate).toBe(0.1);
		expect(v.edges.get(`assign:${A}`)!.rate).toBe(0.1);
		expect(v.edges.get(`fetch:${A}`)!.rate).toBe(100);
		expect(v.edges.get(`publish:${A}`)!.rate).toBe(500);
		expect(v.edges.get(`assign:${B}`)!.rate).toBe(0);
		expect(v.edges.get('cached:scheduler')!.rate).toBe(0.1);
		// Each pool's edges carry the sum of its builders' edges.
		expect(v.edges.get('assign:pool:x86_64-linux')!.rate).toBe(0.1);
		expect(v.edges.get('publish:pool:x86_64-linux')!.rate).toBe(500);
		expect(v.edges.get('fetch:pool:x86_64-linux')!.rate).toBe(100);
		expect(v.edges.get('assign:pool:aarch64-linux')!.rate).toBe(0);
		expect(v.scheduler.assignedPerSec).toBe(0.1);
		expect(v.cache).toMatchObject({
			hitsPerSec: 0.1,
			missesPerSec: 0.1,
			publishedBytesPerSec: 500,
			fetchedBytesPerSec: 100
		});
		expect(v.workers.get(A)).toMatchObject({ running: 1, builtPerMin: 1 });

		const later = r.views(now + 25_000, 15);
		for (const e of later.edges.values()) expect(e.rate).toBe(0);
		expect(later.workers.get(A)!.builtPerMin).toBe(1);
		expect(r.views(now + 70_000, 15).workers.get(A)!.builtPerMin).toBe(0);
	});

	it('keeps finished and cached drvs for drill-down', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.drv(N1, { cause: Cause.WANTED, clientIds: [1n] }),
				E.drv(N1, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, clientIds: [1n], workerAddr: A }),
				E.gone(N1, Outcome.BUILT, {
					workerAddr: A,
					outputs: [create(OutputSchema, { path: '/nix/store/x-hello', narSize: 5000n })]
				}),
				E.cached(C1, 2)
			),
			T0 + 1000
		);
		expect(r.drv(N1)).toMatchObject({
			phase: 'built',
			workerAddr: A,
			finishedMs: T0,
			identities: ['ci-runner-1'],
			outputs: [{ path: '/nix/store/x-hello', narSize: 5000 }],
			outputBytes: 5000
		});
		expect(r.drv(C1)).toMatchObject({ phase: 'cached', identities: ['oidc:sso:alice'] });
		// Assigned first, then recent results, newest first.
		expect(r.drvsForWorker(A).map((d) => d.drvPath)).toEqual([A1, N1]);
		expect(r.drvsForWorker(A, 1).map((d) => d.drvPath)).toEqual([A1]);
		expect(r.drvsForCache().map((d) => d.drvPath)).toEqual([C1, N1]);
		// Gone from the in-flight indexes.
		expect(r.counts()).toMatchObject({ drvs: 3, assigned: 1 });
		expect(r.views(T0 + 1000, 15).clientGroups.get('ci-runner-1')!.waiting).toBe(2);
	});

	it('bounds the recent ring', () => {
		const { r, s } = farm({ recentLimit: 3 });
		const paths = [1, 2, 3, 4, 5].map((i) => drvPath(`r${i}`));
		r.apply(s.next(...paths.map((p) => E.cached(p, 1))), T0);
		expect(r.drv(paths[0])).toBeUndefined();
		expect(r.drv(paths[1])).toBeUndefined();
		expect(r.drv(paths[4])).toMatchObject({ phase: 'cached' });
		expect(r.counts().recent).toBe(3);
	});

	it('moves drvs between queue and workers', () => {
		const { r, s } = farm();
		r.apply(
			s.next(E.drv(A1, { cause: Cause.REQUEUED, clientIds: [1n, 2n], reason: 'worker gone' })),
			T0
		);
		let v = r.views(T0, 15);
		expect(v.workers.get(A)!.running).toBe(0);
		expect(v.scheduler).toMatchObject({ queued: 3, assigned: 0, free: 4 });
		expect(r.drv(A1)).toMatchObject({ phase: 'queued', workerAddr: null, reason: 'worker gone' });
		expect(r.drvsForWorker(A)).toEqual([]);

		r.apply(
			s.next(
				E.drv(Q2, {
					cause: Cause.PLACEABILITY,
					phase: Phase.QUEUED,
					clientIds: [2n],
					features: ['cuda']
				})
			),
			T0
		);
		v = r.views(T0, 15);
		expect(v.scheduler.unplaceable).toBe(0);
		// Q1 and the requeued A1; Q2 needs cuda, which A does not offer.
		expect(v.workers.get(A)!.queuedCanTake).toBe(2);
	});

	it('counts the queued work each builder can take', () => {
		const { r, s } = farm();
		const K = drvPath('needs-kvm');
		const I = drvPath('i686');
		const P = drvPath('big');
		r.apply(
			s.next(
				E.drv(K, { clientIds: [1n], features: ['kvm'] }),
				E.drv(I, { clientIds: [1n], system: 'i686-linux' }),
				E.drv(P, { clientIds: [1n], features: ['kvm', 'big-parallel'] })
			),
			T0
		);
		// A offers x86_64 and i686 with kvm: Q1, K and I. P also needs big-parallel.
		expect(r.views(T0, 15).workers.get(A)!.queuedCanTake).toBe(3);
		expect(r.views(T0, 15).workers.get(B)!.queuedCanTake).toBe(0);
		// Assigned elsewhere: no longer queued.
		r.apply(s.next(E.drv(K, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A })), T0);
		expect(r.views(T0, 15).workers.get(A)!.queuedCanTake).toBe(2);
	});

	it('tracks followers per client group', () => {
		const { r, s } = farm();
		// Alice stops waiting on A1, then a new client of hers wants Q1.
		r.apply(
			s.next(
				E.drv(A1, {
					cause: Cause.FOLLOWERS,
					phase: Phase.ASSIGNED,
					workerAddr: A,
					clientIds: [1n]
				}),
				E.client(3, 'oidc:sso:alice'),
				E.drv(Q1, { cause: Cause.FOLLOWERS, clientIds: [1n, 3n] })
			),
			T0 + 1000
		);
		const v = r.views(T0 + 1000, 15);
		expect(v.clientGroups.get('oidc:sso:alice')).toMatchObject({
			clients: 2,
			waiting: 2,
			wantsPerSec: 0.1
		});
		expect(r.drvsForClientGroup('oidc:sso:alice').map((d) => d.drvPath)).toEqual([Q1, Q2]);
		expect(r.drv(Q1)!.identities).toEqual(['ci-runner-1', 'oidc:sso:alice']);
	});

	it('handles a drv that names a client before its ClientState', () => {
		const { r } = started({}, E.reset(), E.drv(Q1, { clientIds: [9n] }), E.client(9, 'late'));
		expect(r.views(T0, 15).clientGroups.get('late')).toMatchObject({ clients: 1, waiting: 1 });
	});

	it('keeps a drv view until something changes, unless an identity is still unknown', () => {
		const { r, s } = started(
			{},
			E.reset(),
			E.client(1, 'ci'),
			E.client(2, 'ci'),
			E.drv(Q1, { clientIds: [1n, 2n] }),
			E.drv(Q2, { clientIds: [3n] })
		);
		// Two streams of one identity: complete, so it is kept.
		const q1 = r.drv(Q1)!;
		expect(q1.identities).toEqual(['ci']);
		expect(r.drv(Q1)).toBe(q1);
		// Client 3 has not announced itself yet.
		expect(r.drv(Q2)!.identities).toEqual([]);
		r.apply(s.next(E.client(3, 'late')), T0);
		expect(r.drv(Q2)!.identities).toEqual(['late']);
	});

	it('lets an idle group linger, then drops it', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.drv(Q2, { cause: Cause.FOLLOWERS, phase: Phase.UNPLACEABLE, clientIds: [] }),
				E.drv(A1, {
					cause: Cause.FOLLOWERS,
					phase: Phase.ASSIGNED,
					workerAddr: A,
					clientIds: [1n]
				}),
				E.clientGone(2)
			),
			T0
		);
		let v = r.views(T0 + 1000, 15);
		expect(v.clientGroups.get('oidc:sso:alice')).toMatchObject({ clients: 0, waiting: 0 });
		// Still shown 30 s later, before the next re-rank, and gone after the linger time.
		expect(r.views(T0 + 30_000, 15).topology.clientGroups).toContain('oidc:sso:alice');
		v = r.views(T0 + 95_000, 15);
		expect(v.topology.clientGroups).toEqual(['ci-runner-1']);
		expect(v.clientGroups.has('oidc:sso:alice')).toBe(false);
	});

	it('shows the busiest 9 groups and folds the rest into other clients', () => {
		const body = [];
		// Group gN waits on N drvs, so g12 is the busiest.
		let id = 1;
		for (let g = 1; g <= 12; g++) {
			body.push(E.client(id, `g${g}`));
			for (let k = 0; k < g * 3; k++)
				body.push(E.drv(drvPath(`g${g}-${k}`), { clientIds: [BigInt(id)] }));
			id++;
		}
		const { r, s } = started({}, E.reset(), ...body);
		const v = r.views(T0, 15);
		expect(v.topology.clientGroups).toHaveLength(10);
		expect(v.topology.clientGroups.at(-1)).toBe(OTHER_CLIENTS);
		expect(new Set(v.topology.clientGroups.slice(0, 9))).toEqual(
			new Set(['g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11', 'g12'])
		);
		const other = v.clientGroups.get(OTHER_CLIENTS)!;
		expect(other).toMatchObject({
			label: 'other clients',
			clients: 3,
			waiting: (1 + 2 + 3) * 3
		});
		expect(v.edges.has(`want:${OTHER_CLIENTS}`)).toBe(true);
		expect(r.drvsForClientGroup(OTHER_CLIENTS, 1000)).toHaveLength(18);

		// A new group while the list is full waits in "other clients".
		r.apply(
			s.next(
				E.client(99, 'newcomer'),
				E.drv(drvPath('n'), { cause: Cause.WANTED, clientIds: [99n] })
			),
			T0 + 1000
		);
		const v2 = r.views(T0 + 1000, 15);
		expect(v2.topology).toBe(v.topology);
		expect(v2.clientGroups.get(OTHER_CLIENTS)).toMatchObject({ clients: 4, waiting: 19 });
	});

	it('gives 10 groups a card each, and folds two when an 11th comes', () => {
		const body = [];
		for (let g = 1; g <= 10; g++) {
			body.push(E.client(g, `g${g}`));
			for (let k = 0; k < g; k++)
				body.push(E.drv(drvPath(`g${g}-${k}`), { clientIds: [BigInt(g)] }));
		}
		const { r, s } = started({}, E.reset(), ...body);
		const v = r.views(T0, 15);
		expect(v.topology.clientGroups).toHaveLength(10);
		expect(v.topology.clientGroups).not.toContain(OTHER_CLIENTS);

		// An 11th comes before the next ranking. The quietest shown group folds
		// with it at once, so the column keeps 10 cards.
		r.apply(s.next(E.client(11, 'newcomer'), E.drv(drvPath('n'), { clientIds: [11n] })), T0 + 1000);
		const groups = r.views(T0 + 1000, 15).topology.clientGroups;
		expect(groups).toHaveLength(10);
		expect(groups.at(-1)).toBe(OTHER_CLIENTS);
		expect(groups).not.toContain('g1');
		expect(groups).not.toContain('newcomer');
	});

	it('swaps a group in only when it is clearly busier', () => {
		const body = [E.client(1, 'a'), E.client(2, 'b'), E.client(3, 'c'), E.client(4, 'd')];
		const add = (id: number, n: number, tag: string) => {
			for (let k = 0; k < n; k++)
				body.push(E.drv(drvPath(`${tag}-${k}`), { clientIds: [BigInt(id)] }));
		};
		add(1, 20, 'a');
		add(2, 10, 'b');
		add(3, 6, 'c');
		add(4, 1, 'd');
		const { r, s } = started({ maxCards: 3, rerankMs: 1000 }, E.reset(), ...body);
		expect(r.views(T0, 15).topology.clientGroups).toEqual(['a', 'b', OTHER_CLIENTS]);
		// c grows a bit: not enough to replace b.
		const more = [];
		for (let k = 6; k < 12; k++)
			more.push(E.drv(drvPath(`c-${k}`), { cause: Cause.WANTED, clientIds: [3n] }));
		r.apply(s.next(...more), T0 + 100);
		expect(r.views(T0 + 2000, 15).topology.clientGroups).toEqual(['a', 'b', OTHER_CLIENTS]);
		// c becomes much busier: it takes b's place, a keeps its own.
		const lots = [];
		for (let k = 12; k < 40; k++)
			lots.push(E.drv(drvPath(`c-${k}`), { cause: Cause.WANTED, clientIds: [3n] }));
		r.apply(s.next(...lots), T0 + 2100);
		expect(r.views(T0 + 4000, 15).topology.clientGroups).toEqual(['a', 'c', OTHER_CLIENTS]);
	});
});

describe('stream checks', () => {
	it('reports a seq gap and then wants a new Reset', () => {
		const { r, s } = farm();
		const res = r.apply([s.raw(s.seq + 2n, E.stats())], T0);
		expect(res.ok).toBe(false);
		expect(res.ok === false && res.error).toMatch(/seq jumped from 41 to 43/);
		expect(r.phase).toBe('idle');
		// The old state stays visible until the next snapshot.
		expect(r.views(T0, 15).workers.size).toBe(2);
		const again = r.apply(s.next(E.stats()), T0);
		expect(again.ok === false && again.error).toMatch(/did not start with Reset/);
	});

	it('rejects a snapshot event with the wrong seq', () => {
		const r = new FarmReducer();
		const s = new Stream(10n);
		r.beginStream();
		const [reset] = s.snapshot(E.reset());
		const res = r.apply([reset, s.raw(11n, E.worker(A))], T0);
		expect(res.ok === false && res.error).toMatch(/snapshot event has seq 11, expected 10/);
	});

	it('needs a Reset first on every new stream', () => {
		const { r, s } = farm();
		r.beginStream();
		expect(r.apply(s.next(E.stats()), T0).ok).toBe(false);
	});

	it('skips unknown events but still checks their seq', () => {
		const { r, s } = farm();
		const unknown = s.raw(s.seq + 1n, { case: undefined });
		s.seq++;
		expect(r.apply([unknown, ...s.next(E.stats())], T0)).toEqual({ ok: true, snapshotDone: false });
	});

	it('rebuilds from a new snapshot of the same instance and keeps traffic history', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.drv(A1, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A, clientIds: [1n] })
			),
			T0
		);
		r.beginStream();
		const s2 = new Stream(500n, T0 + 2000);
		const res = r.apply(
			s2.snapshot(
				E.reset(),
				E.worker(A),
				E.client(1, 'ci-runner-1'),
				E.drv(Q1, { clientIds: [1n] })
			),
			T0 + 2000
		);
		expect(res).toEqual({ ok: true, snapshotDone: true });
		const v = r.views(T0 + 2000, 15);
		expect(r.counts()).toMatchObject({ drvs: 1, queued: 1, assigned: 0, clients: 1 });
		// B was not in the new snapshot: it went away while we were disconnected.
		expect(v.workers.get(B)).toMatchObject({ up: false });
		expect(v.topology.workers).toEqual([B, A]);
		// Same instance: the assignment rate measured before is kept.
		expect(v.edges.get(`assign:${A}`)!.rate).toBe(0.1);
		// Deltas continue from the new seq.
		expect(r.apply(s2.next(E.stats()), T0 + 2000).ok).toBe(true);
		// Gone workers leave the map after the linger time.
		expect(r.views(T0 + 2000 + 11 * 60_000, 15).topology.workers).toEqual([A]);
	});

	it('drops everything when the scheduler instance changes', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.drv(A1, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A, clientIds: [1n] }),
				E.cached(C1, 1)
			),
			T0
		);
		r.beginStream();
		const s2 = new Stream(3n, T0 + 1000);
		r.apply(s2.snapshot(E.reset({ instance: 'inst-b', version: '2.0.0' }), E.worker(A)), T0 + 1000);
		const v = r.views(T0 + 1000, 15);
		expect(v.meta).toMatchObject({ instance: 'inst-b', version: '2.0.0' });
		expect(v.topology.workers).toEqual([A]);
		expect(v.edges.get(`assign:${A}`)!.rate).toBe(0);
		expect(r.drv(C1)).toBeUndefined();
		expect(r.counts()).toMatchObject({ drvs: 0, clients: 0, workers: 1, recent: 0 });
	});
});

describe('totals', () => {
	function withHistory(servingAgoMs: number, minutes: number) {
		const r = new FarmReducer();
		const s = new Stream();
		r.beginStream();
		const history = [];
		// 100 builds, 10 failures, 20 cache hits and 5 misses a minute.
		for (let k = minutes; k >= 1; k--) {
			const n = BigInt(minutes - k + 1);
			history.push(
				create(CounterSampleSchema, {
					timeMs: BigInt(T0 - k * 60_000),
					counters: create(CountersSchema, {
						built: 100n * n,
						failed: 10n * n,
						cacheHits: 20n * n,
						cacheMisses: 5n * n
					})
				})
			);
		}
		const m = BigInt(minutes + 1);
		r.apply(
			[
				...s.snapshot(E.reset({ history, servingSinceMs: BigInt(T0 - servingAgoMs) })),
				...s.next(
					E.stats({ built: 100n * m, failed: 10n * m, cacheHits: 20n * m, cacheMisses: 5n * m })
				)
			],
			T0
		);
		return r;
	}

	it('counts the window from history and Stats', () => {
		const r = withHistory(3 * 3600_000, 30);
		const t = r.views(T0, 5).totals;
		expect(t).toEqual({
			windowMinutes: 5,
			queued: 0,
			running: 0,
			built: 500,
			failed: 50,
			cached: 100,
			since: null
		});
		expect(r.views(T0, 15).totals).toMatchObject({ built: 1500, since: null });
		// Halfway between two samples.
		expect(r.views(T0 + 30_000, 5).totals.built).toBe(450);
		expect(r.views(T0, 30).totals).toMatchObject({ built: 3000, failed: 300, since: null });
		// Only 30 minutes of history: count from its oldest sample, and say so.
		expect(r.views(T0, 60).totals).toMatchObject({
			built: 3000,
			since: { fromMs: T0 - 30 * 60_000, cause: 'history' }
		});
		// The 61 samples a scheduler keeps cover the 1 h window.
		expect(withHistory(3 * 3600_000, 61).views(T0, 60).totals).toMatchObject({
			built: 6000,
			since: null
		});
		expect(r.views(T0, 5).cache!.hitRatio).toBeCloseTo(100 / 125);
	});

	it('counts from the scheduler start while the window reaches before it', () => {
		const r = withHistory(3 * 60_000, 2);
		const t = r.views(T0, 5).totals;
		expect(t.since).toEqual({ fromMs: T0 - 3 * 60_000, cause: 'restart' });
		expect(t.built).toBe(300);
	});

	it('says where line counts start until the page was live for the whole window', () => {
		// The header has 30 minutes of history; the lines start at T0, when the page went live.
		const r = withHistory(3 * 3600_000, 30);
		const page = { fromMs: T0, cause: 'page' };
		expect(r.views(T0, 15).totals.since).toBeNull();
		expect(r.views(T0, 15).linesSince).toEqual(page);
		// A 5 minute window reads the current 30 s bucket and the 10 before it.
		expect(r.views(T0 + 300_000 - 1, 5).linesSince).toEqual(page);
		expect(r.views(T0 + 300_000, 5).linesSince).toBeNull();
		expect(r.views(T0 + 300_000, 15).linesSince).toEqual(page);
		// Before any snapshot nothing is live.
		expect(new FarmReducer().views(T0, 15).linesSince).toEqual(page);
	});

	it('says line counts restarted with a new scheduler instance', () => {
		const r = withHistory(3 * 3600_000, 30);
		r.beginStream();
		const s2 = new Stream(1n, T0 + 60_000);
		r.apply(s2.snapshot(E.reset({ instance: 'inst-b' })), T0 + 60_000);
		r.apply(s2.next(E.stats()), T0 + 65_000);
		const restart = { fromMs: T0 + 60_000, cause: 'restart' };
		expect(r.views(T0 + 70_000, 15).linesSince).toEqual(restart);
	});
});

describe('queue table', () => {
	const C = '10.0.0.12:50051';
	const D = '10.0.1.13:50051';
	const OFF = '10.0.0.14:50051';
	const x86 = ['x86_64-linux', 'i686-linux'];
	const assigned = (addr: string, n: number, cause = Cause.SNAPSHOT) =>
		Array.from({ length: n }, (_, i) =>
			E.drv(drvPath(`${addr}-${i}`), {
				cause,
				phase: Phase.ASSIGNED,
				workerAddr: addr,
				clientIds: [1n],
				assignId: BigInt(i + 1)
			})
		);

	it('counts the slots of every builder that can take a row, not of exact offers', () => {
		const { r, s } = started(
			{},
			E.reset(),
			E.worker(A, { systems: x86, features: ['big-parallel', 'kvm', 'nixos-test'], maxJobs: 8 }),
			E.worker(B, { systems: x86, features: ['benchmark', 'big-parallel', 'nixos-test'] }),
			E.worker(C, { features: ['kvm'], draining: true }),
			E.worker(D, { systems: ['aarch64-linux'], maxJobs: 2 }),
			E.worker(OFF, { systems: x86, features: ['big-parallel'] }),
			E.client(1, 'ci'),
			...assigned(A, 3),
			...assigned(B, 1),
			...assigned(C, 2)
		);
		r.apply(s.next(E.worker(OFF, { systems: x86, up: false })), T0);
		r.apply(
			s.next(
				E.stats({}, [
					{ system: 'x86_64-linux', queued: 5 },
					// No builder offers exactly big-parallel: Stats has no slots for it.
					{ system: 'x86_64-linux', features: 'big-parallel', queued: 3 },
					{ system: 'x86_64-linux', features: 'kvm,nixos-test', queued: 2 },
					{ system: 'x86_64-linux', features: 'cuda', queued: 1, unplaceable: 1 },
					{ system: 'i686-linux', queued: 1 },
					{ system: 'aarch64-linux', features: 'kvm,nixos-test', queued: 2, unplaceable: 2 },
					// Offer rows add nothing but their system's bare row.
					{
						system: 'x86_64-linux',
						features: 'big-parallel,kvm,nixos-test',
						running: 3,
						slots: 8,
						free: 5
					},
					{ system: 'aarch64-linux', slots: 2, free: 2 },
					{ system: 'riscv64-linux' }
				])
			),
			T0
		);
		const row = (
			queued: number,
			unplaceable: number,
			running: number,
			slots: number,
			free: number
		) => ({
			queued,
			unplaceable,
			running,
			slots,
			free
		});
		expect(
			r.views(T0, 15).scheduler.systems.map((x) => [`${x.system} ${x.features}`.trim(), x])
		).toEqual([
			// Unplaceable work first, the larger queue first among it.
			[
				'aarch64-linux kvm,nixos-test',
				{ system: 'aarch64-linux', features: 'kvm,nixos-test', ...row(2, 2, 0, 0, 0) }
			],
			['x86_64-linux cuda', { system: 'x86_64-linux', features: 'cuda', ...row(1, 1, 0, 0, 0) }],
			// A, B and the draining C: C's running counts, its slots do not.
			['x86_64-linux', { system: 'x86_64-linux', features: '', ...row(5, 0, 6, 12, 8) }],
			// A and B offer big-parallel among others.
			[
				'x86_64-linux big-parallel',
				{ system: 'x86_64-linux', features: 'big-parallel', ...row(3, 0, 4, 12, 8) }
			],
			// Only A offers both; C has kvm without nixos-test.
			[
				'x86_64-linux kvm,nixos-test',
				{ system: 'x86_64-linux', features: 'kvm,nixos-test', ...row(2, 0, 3, 8, 5) }
			],
			// An extra system counts the builders that offer it.
			['i686-linux', { system: 'i686-linux', features: '', ...row(1, 0, 4, 12, 8) }],
			['aarch64-linux', { system: 'aarch64-linux', features: '', ...row(0, 0, 0, 2, 2) }]
		]);
	});

	it('changes with Stats, not with every assignment', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.client(1, 'ci'));
		r.apply(s.next(E.stats({}, [{ system: 'x86_64-linux', queued: 1 }])), T0);
		const before = r.views(T0, 15).scheduler.systems;
		expect(before).toEqual([
			{
				system: 'x86_64-linux',
				features: '',
				queued: 1,
				unplaceable: 0,
				running: 0,
				slots: 4,
				free: 4
			}
		]);
		r.apply(s.next(...assigned(A, 1, Cause.ASSIGNED)), T0 + 100);
		expect(r.views(T0 + 100, 15).scheduler.systems).toBe(before);
		r.apply(
			s.next(E.stats({}, [{ system: 'x86_64-linux', running: 1, slots: 4, free: 3 }])),
			T0 + 1000
		);
		expect(r.views(T0 + 1000, 15).scheduler.systems).toMatchObject([
			{ queued: 0, running: 1, slots: 4, free: 3 }
		]);
	});
});

describe('queue trend', () => {
	it("gives the queue's change per minute once it has a minute of samples", () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.client(1, 'ci'));
		// One more queued derivation every second: 60 a minute.
		for (let i = 0; i < 60; i++) {
			const at = T0 + i * 1000;
			expect(r.views(at, 15).scheduler.queuedPerMin, `${i} s`).toBeNull();
			// More views within the second take no sample.
			r.views(at + 300, 15);
			r.apply(s.next(E.drv(drvPath(`t${i}`), { clientIds: [1n] })), at + 500);
		}
		expect(r.views(T0 + 60_000, 15).scheduler.queued).toBe(60);
		expect(r.views(T0 + 60_000, 15).scheduler.queuedPerMin).toBe(60);
		// The queue drains by 30 over the next 30 s: the minute nets 0.
		for (let i = 0; i < 30; i++) {
			const at = T0 + 61_000 + i * 1000;
			r.apply(s.next(E.gone(drvPath(`t${i}`), Outcome.BUILT)), at - 500);
			r.views(at, 15);
		}
		expect(r.views(T0 + 90_000, 15).scheduler.queuedPerMin).toBe(0);
	});

	it('starts over with a new scheduler instance', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.client(1, 'ci'));
		for (let i = 0; i <= 60; i++) {
			r.apply(s.next(E.drv(drvPath(`t${i}`), { clientIds: [1n] })), T0 + i * 1000 + 500);
			r.views(T0 + i * 1000, 15);
		}
		expect(r.views(T0 + 61_000, 15).scheduler.queuedPerMin).not.toBeNull();
		r.beginStream();
		const s2 = new Stream(1n, T0 + 62_000);
		r.apply(s2.snapshot(E.reset({ instance: 'inst-b' }), E.worker(A)), T0 + 62_000);
		expect(r.views(T0 + 63_000, 15).scheduler.queuedPerMin).toBeNull();
	});
});

describe('server clock', () => {
	it('converts scheduler times to browser time', () => {
		const r = new FarmReducer();
		// The scheduler's clock is 5 s behind the browser.
		const s = new Stream(1n, T0 - 5000);
		r.beginStream();
		r.apply(
			s.snapshot(
				E.reset({ servingSinceMs: BigInt(T0 - 3600_000 - 5000) }),
				E.drv(Q1, { queuedMs: BigInt(T0 - 65_000) })
			),
			T0
		);
		expect(r.serverOffsetMs).toBe(5000);
		expect(r.drv(Q1)!.queuedMs).toBe(T0 - 60_000);
		expect(r.views(T0, 5).meta!.servingSinceMs).toBe(T0 - 3600_000);
		// A delayed batch does not move the estimate; a faster one does.
		s.timeMs = T0 - 9000;
		r.apply(s.next(E.stats()), T0);
		expect(r.serverOffsetMs).toBe(5000);
		s.timeMs = T0 - 4000;
		r.apply(s.next(E.stats()), T0);
		expect(r.serverOffsetMs).toBe(4000);
		expect(r.drv(Q1)!.queuedMs).toBe(T0 - 61_000);
	});

	it('keeps the scheduler time of a finish for links, while the browser time follows the estimate', () => {
		const r = new FarmReducer();
		const s = new Stream(1n, T0 - 5000);
		r.beginStream();
		r.apply(s.snapshot(E.reset(), E.worker(A)), T0);
		r.apply(
			s.next(
				E.drv(N1, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A }),
				E.gone(N1, Outcome.BUILT, { workerAddr: A })
			),
			T0
		);
		const finish = { finishedMs: T0, finishedServerMs: T0 - 5000 };
		expect(r.drv(N1)).toMatchObject(finish);
		expect(r.build(N1, 0)).toMatchObject(finish);
		// A faster batch moves the estimate by a second. Links keep their time.
		s.timeMs = T0 - 4000;
		r.apply(s.next(E.stats()), T0);
		const moved = { finishedMs: T0 - 1000, finishedServerMs: T0 - 5000 };
		expect(r.drv(N1)).toMatchObject(moved);
		expect(r.build(N1, 0)).toMatchObject(moved);
	});
});

describe('builder drill-down', () => {
	const X = drvPath('flaky');
	const Y = drvPath('other');
	const assign = (path: string, id: bigint) =>
		E.drv(path, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, workerAddr: A, clientIds: [id] });

	for (const first of [Outcome.FAILED, Outcome.CANCELLED, Outcome.DROPPED]) {
		it(`lists a drv once when it ended ${Outcome[first]} and then built on the same builder`, () => {
			const { r, s } = farm();
			r.apply(
				s.next(
					E.drv(X, { cause: Cause.WANTED, clientIds: [1n] }),
					assign(X, 1n),
					E.gone(X, first, { workerAddr: A }),
					E.drv(Y, { cause: Cause.WANTED, clientIds: [2n] }),
					assign(Y, 2n),
					E.gone(Y, Outcome.BUILT, { workerAddr: A }),
					E.drv(X, { cause: Cause.WANTED, clientIds: [2n] }),
					assign(X, 2n)
				),
				T0
			);
			const rows = () => r.drvsForWorker(A, 500).map((d) => [d.drvPath, d.phase]);
			expect(rows()).toEqual([
				[A1, 'assigned'],
				[X, 'assigned'],
				[Y, 'built']
			]);
			r.apply(s.next(E.gone(X, Outcome.BUILT, { workerAddr: A })), T0 + 1000);
			// The newest outcome only; the panel keys its rows by path.
			expect(rows()).toEqual([
				[A1, 'assigned'],
				[X, 'built'],
				[Y, 'built']
			]);
		});
	}

	it('keeps one slot per drv in the recent results', () => {
		const { r, s } = farm({ workerRecentLimit: 2 });
		r.apply(
			s.next(
				E.drv(Y, { cause: Cause.WANTED, clientIds: [2n] }),
				assign(Y, 2n),
				E.gone(Y, Outcome.BUILT, { workerAddr: A }),
				E.drv(X, { cause: Cause.WANTED, clientIds: [1n] }),
				assign(X, 1n),
				E.gone(X, Outcome.FAILED, { workerAddr: A }),
				E.drv(X, { cause: Cause.WANTED, clientIds: [1n] }),
				assign(X, 1n),
				E.gone(X, Outcome.BUILT, { workerAddr: A })
			),
			T0
		);
		expect(r.drvsForWorker(A).map((d) => [d.drvPath, d.phase])).toEqual([
			[A1, 'assigned'],
			[X, 'built'],
			[Y, 'built']
		]);
	});

	it('drops repeated systems and features and keeps the native system first', () => {
		const { r, s } = started(
			{},
			E.reset(),
			// binfmt emulation and --extra-system can both name aarch64-linux.
			E.worker(A, {
				systems: ['x86_64-linux', 'aarch64-linux', 'aarch64-linux', 'x86_64-linux'],
				features: ['kvm', 'kvm']
			})
		);
		expect(r.views(T0, 15).workers.get(A)).toMatchObject({
			systems: ['x86_64-linux', 'aarch64-linux'],
			features: ['kvm']
		});
		r.apply(
			s.next(E.worker(A, { systems: ['aarch64-linux', 'riscv64-linux', 'aarch64-linux'] })),
			T0
		);
		const v = r.views(T0, 15);
		expect(v.workers.get(A)!.systems).toEqual(['aarch64-linux', 'riscv64-linux']);
		expect(v.topology.workerSystems).toEqual(['aarch64-linux']);
	});

	it('marks a cache hit as checked', () => {
		const { r, s } = farm();
		r.apply(s.next(E.cached(C1, 2)), T0);
		expect(r.drv(C1)).toMatchObject({ phase: 'cached', cacheChecked: true, inputs: 0 });
	});
});

describe('complete state', () => {
	it('is complete from SnapshotDone to the next Reset, gaps after it included', () => {
		const { r, s } = farm();
		expect(r.complete).toBe(true);
		// A gap after the snapshot leaves a complete, if stale, state.
		expect(r.apply([s.raw(s.seq + 2n, E.stats())], T0).ok).toBe(false);
		r.beginStream();
		expect(r.complete).toBe(true);
		const [reset, w] = new Stream(7n).snapshot(E.reset(), E.worker(A));
		r.apply([reset, w], T0);
		expect(r.complete).toBe(false);
		// The stream dies before SnapshotDone: still not complete.
		r.beginStream();
		expect(r.complete).toBe(false);
		// Nor after a seq error inside the next snapshot.
		const s3 = new Stream(9n);
		const [reset3] = s3.snapshot(E.reset());
		expect(r.apply([reset3, s3.raw(10n, E.worker(A))], T0).ok).toBe(false);
		expect(r.complete).toBe(false);
		r.beginStream();
		r.apply(new Stream(12n).snapshot(E.reset(), E.worker(A)), T0);
		expect(r.complete).toBe(true);
	});

	it('never shows a client group twice after the instance changes', () => {
		const r = new FarmReducer();
		r.beginStream();
		const body = () => [
			E.client(1, 'ci'),
			E.client(2, 'alice'),
			...Array.from({ length: 10 }, (_, i) => E.drv(drvPath(`d${i}`), { clientIds: [1n] }))
		];
		r.apply(new Stream().snapshot(E.reset(), E.worker(A), ...body()), T0);
		expect(r.views(T0, 15).topology.clientGroups).toEqual(['ci', 'alice']);

		// A new scheduler's snapshot, looked at before it is complete.
		r.beginStream();
		const snap = new Stream(7n).snapshot(E.reset({ instance: 'inst-b' }), E.worker(B), ...body());
		r.apply(snap.slice(0, 4), T0 + 5000);
		const unique = (t: number) => {
			const groups = r.views(t, 15).topology.clientGroups;
			expect(new Set(groups).size).toBe(groups.length);
			return groups;
		};
		unique(T0 + 5500);

		// The stream died; the next one completes.
		r.beginStream();
		r.apply(
			new Stream(20n).snapshot(E.reset({ instance: 'inst-b' }), E.worker(B), ...body()),
			T0 + 6000
		);
		expect(unique(T0 + 6000)).toEqual(['ci', 'alice']);
		for (let t = T0 + 6500; t <= T0 + 76_000; t += 500) unique(t);
		expect(unique(T0 + 76_000)).toEqual(['ci', 'alice']);
	});

	it('still knows a client group that was folded into other clients', () => {
		const a1 = drvPath('alice-1');
		const { r, s } = started(
			{ maxCards: 2, rerankMs: 1000 },
			E.reset(),
			E.worker(A),
			E.client(1, 'alice'),
			E.drv(a1, { clientIds: [1n] })
		);
		expect(r.views(T0, 15).topology.clientGroups).toEqual(['alice']);
		expect(r.clientGroup(OTHER_CLIENTS, T0)).toBeUndefined();

		// Bob is much busier and takes the only place, and Carol comes too, so
		// two groups fold into other clients.
		const busy = [E.client(2, 'bob'), E.client(3, 'bob'), E.client(4, 'bob'), E.client(5, 'carol')];
		for (let i = 0; i < 6; i++)
			busy.push(E.drv(drvPath(`bob-${i}`), { cause: Cause.WANTED, clientIds: [2n] }));
		r.apply(s.next(...busy), T0 + 100);
		const v = r.views(T0 + 5000, 15);
		expect(v.topology.clientGroups).toEqual(['bob', OTHER_CLIENTS]);
		expect(v.clientGroups.has('alice')).toBe(false);
		expect(r.clientGroup('alice', T0 + 5000)).toEqual({
			id: 'alice',
			label: 'alice',
			clients: 1,
			waiting: 1,
			wantsPerSec: 0
		});
		expect(r.clientGroup('bob', T0 + 5000)).toEqual(v.clientGroups.get('bob'));
		expect(r.clientGroup(OTHER_CLIENTS, T0 + 5000)).toEqual(v.clientGroups.get(OTHER_CLIENTS));

		// Gone once its clients left and it idled out.
		r.apply(
			s.next(E.drv(a1, { cause: Cause.FOLLOWERS, clientIds: [] }), E.clientGone(1)),
			T0 + 6000
		);
		r.views(T0 + 70_000, 15);
		expect(r.clientGroup('alice', T0 + 70_000)).toBeUndefined();
		expect(r.clientGroup('nobody', T0 + 70_000)).toBeUndefined();
	});
});

describe('cache rates', () => {
	it('counts every miss from the counters, follower Wants included', () => {
		const { r, s } = farm();
		r.apply(s.next(E.stats({ cacheHits: 100n, cacheMisses: 50n })), T0);
		// Ten drvs, each wanted by two clients, and both Wants missed the cache.
		const wants = [];
		for (let i = 0; i < 10; i++) {
			const p = drvPath(`miss-${i}`);
			wants.push(E.drv(p, { cause: Cause.WANTED, clientIds: [1n], cacheChecked: true }));
			wants.push(E.drv(p, { cause: Cause.FOLLOWERS, clientIds: [1n, 2n], cacheChecked: true }));
		}
		r.apply(s.next(...wants, E.stats({ cacheHits: 105n, cacheMisses: 70n })), T0 + 1000);
		const v = r.views(T0 + 1000, 15);
		// 20 misses and 5 hits in the 10 s window.
		expect(v.cache).toMatchObject({ missesPerSec: 2, hitsPerSec: 0.5 });
		expect(v.edges.get('cached:scheduler')!.rate).toBe(0.5);
	});

	it('takes the first Stats after a Reset as the base', () => {
		const { r, s } = farm();
		// The counters jumped since the last history sample: not a burst.
		r.apply(s.next(E.stats({ cacheHits: 600n, cacheMisses: 600n })), T0);
		expect(r.views(T0, 15).cache).toMatchObject({ hitsPerSec: 0, missesPerSec: 0 });
		r.apply(s.next(E.stats({ cacheHits: 601n, cacheMisses: 600n })), T0 + 1000);
		expect(r.views(T0 + 1000, 15).cache!.hitsPerSec).toBe(0.1);

		// A reconnect to the same instance skips what happened in between.
		r.beginStream();
		const s2 = new Stream(900n, T0 + 30_000);
		r.apply(
			[...s2.snapshot(E.reset()), ...s2.next(E.stats({ cacheHits: 700n, cacheMisses: 650n }))],
			T0 + 30_000
		);
		expect(r.views(T0 + 30_000, 15).cache).toMatchObject({ hitsPerSec: 0, missesPerSec: 0 });
		r.apply(s2.next(E.stats({ cacheHits: 703n, cacheMisses: 650n })), T0 + 31_000);
		expect(r.views(T0 + 31_000, 15).cache).toMatchObject({ hitsPerSec: 0.3, missesPerSec: 0 });
	});
});

describe('server clock after a failover', () => {
	it('forgets the old leader clock when the instance changes', () => {
		const r = new FarmReducer();
		// The old scheduler's clock runs 3 minutes ahead.
		r.beginStream();
		r.apply(new Stream(41n, T0 + 180_000).snapshot(E.reset()), T0);
		expect(r.serverOffsetMs).toBe(-180_000);
		// The new scheduler's clock is right; its events arrive after 50 ms.
		r.beginStream();
		const s2 = new Stream(1n, T0 + 4950);
		r.apply(
			s2.snapshot(E.reset({ instance: 'inst-b' }), E.drv(Q1, { queuedMs: BigInt(T0 + 4950) })),
			T0 + 5000
		);
		expect(r.serverOffsetMs).toBe(50);
		expect(r.drv(Q1)!.queuedMs).toBe(T0 + 5000);
	});
});

describe('pools', () => {
	it("sums each native system's builders", () => {
		const { r } = farm();
		const v = r.views(T0, 15);
		expect([...v.pools.keys()]).toEqual(['aarch64-linux', 'x86_64-linux']);
		expect(v.pools.get('x86_64-linux')).toMatchObject({
			system: 'x86_64-linux',
			builders: 1,
			up: 1,
			draining: 0,
			offline: 0,
			running: 1,
			slots: 4,
			// Q1 only: Q2 is unplaceable.
			queuedCanTake: 1,
			features: [{ name: 'kvm', builders: 1 }],
			churnSince: { fromMs: T0, cause: 'page' }
		});
		// Up, draining and offline add up to the builders.
		expect(v.pools.get('aarch64-linux')).toMatchObject({
			builders: 1,
			up: 0,
			draining: 1,
			offline: 0,
			slots: 2,
			queuedCanTake: 0
		});
	});

	it('leaves out a builder that disconnected while draining, until it comes back', () => {
		const { r, s } = farm();
		const now = T0 + 1000;
		// B drains in farm(), then goes: an autoscaler scaling in.
		r.apply(s.next(E.worker(B, { up: false, systems: ['aarch64-linux'] })), now);
		let v = r.views(now, 15);
		expect(v.topology.retired).toEqual([B]);
		expect(v.workers.get(B)).toMatchObject({ up: false, retired: true, goneAt: now });
		expect(v.pools.has('aarch64-linux')).toBe(false);
		// A builder that disconnects without draining stays, as offline.
		r.apply(s.next(E.worker(A, { up: false })), now + 1000);
		v = r.views(now + 1000, 15);
		expect(v.workers.get(A)!.retired).toBe(false);
		expect(v.pools.get('x86_64-linux')).toMatchObject({ builders: 1, up: 0, offline: 1, left: 1 });
		// B back again: an ordinary builder.
		r.apply(s.next(E.worker(B, { systems: ['aarch64-linux'] })), now + 2000);
		v = r.views(now + 2000, 15);
		expect(v.topology.retired).toEqual([]);
		expect(v.pools.get('aarch64-linux')).toMatchObject({ builders: 1, up: 1, joined: 1, left: 1 });
	});

	it('says since when a builder is offline only when the page saw it go down', () => {
		const C = '10.0.0.12:50051';
		const D = '10.0.0.13:50051';
		const { r, s } = started({}, E.reset(), E.worker(A), E.worker(C, { up: false }), E.worker(D));
		// Offline in the first snapshot: since when is unknown, not since the page loaded.
		expect(r.views(T0 + 5000, 15).workers.get(C)).toMatchObject({ up: false, goneAt: null });
		// A goes down while the page watches.
		r.apply(s.next(E.worker(A, { up: false })), T0 + 1000);
		expect(r.views(T0 + 5000, 15).workers.get(A)!.goneAt).toBe(T0 + 1000);
		// A new stream of the same scheduler: D went down between the streams,
		// at a time nobody knows. A keeps the time the page saw.
		r.beginStream();
		const s2 = new Stream(500n, T0 + 2000);
		r.apply(s2.snapshot(E.reset(), E.worker(C, { up: false })), T0 + 2000);
		let v = r.views(T0 + 5000, 15);
		expect(v.workers.get(D)).toMatchObject({ up: false, goneAt: null });
		expect(v.workers.get(A)!.goneAt).toBe(T0 + 1000);
		expect(v.workers.get(C)!.goneAt).toBeNull();
		// C comes back, then goes down while the page watches: now it has a time.
		r.apply(s2.next(E.worker(C)), T0 + 3000);
		expect(r.views(T0 + 3000, 15).workers.get(C)).toMatchObject({ up: true, goneAt: null });
		r.apply(s2.next(E.worker(C, { up: false })), T0 + 4000);
		v = r.views(T0 + 5000, 15);
		expect(v.workers.get(C)!.goneAt).toBe(T0 + 4000);
		// The unknown ones still leave the map after the linger, counted from when the page
		// first saw them down.
		expect(r.views(T0 + 2000 + 11 * 60_000, 15).topology.workers).not.toContain(D);
	});

	it('counts a queued derivation once, if any builder of the pool can take it', () => {
		const kvm = drvPath('kvm-test');
		const { r } = started(
			{},
			E.reset(),
			E.worker('x1', { features: ['kvm', 'big-parallel'] }),
			E.worker('x2', { features: ['kvm'] }),
			E.worker('x3'),
			E.worker('q', { systems: [] }),
			E.drv(Q1, { clientIds: [1n] }),
			E.drv(kvm, { clientIds: [1n], features: ['kvm'] })
		);
		const v = r.views(T0, 15);
		const x86 = v.pools.get('x86_64-linux')!;
		expect(x86.queuedCanTake).toBe(2);
		expect(x86.features).toEqual([
			{ name: 'kvm', builders: 2 },
			{ name: 'big-parallel', builders: 1 }
		]);
		expect(v.workers.get('x3')!.queuedCanTake).toBe(1);
		expect(v.pools.get('unknown system')).toMatchObject({ builders: 1, queuedCanTake: 0 });
	});

	it('counts builders joining and leaving over 5 minutes', () => {
		const { r, s } = farm();
		const now = T0 + 1000;
		r.apply(
			s.next(
				E.worker('10.0.0.20:50051'),
				E.worker('10.0.0.21:50051'),
				E.worker(A, { up: false }),
				// Draining is not leaving.
				E.worker('10.0.0.20:50051', { draining: true })
			),
			now
		);
		expect(r.views(now, 15).pools.get('x86_64-linux')).toMatchObject({
			builders: 3,
			joined: 2,
			left: 1,
			offline: 1
		});
		r.apply(s.next(E.worker(A)), now + 1000);
		expect(r.views(now + 1000, 15).pools.get('x86_64-linux')).toMatchObject({ joined: 3, left: 1 });
		const later = r.views(now + 6 * 60_000, 15).pools.get('x86_64-linux')!;
		expect([later.joined, later.left]).toEqual([0, 0]);
		// Watching for longer than the window: the numbers are complete.
		expect(later.churnSince).toBeNull();
	});

	it('counts what a reconnect to the same instance shows changed, and starts over on a new one', () => {
		const { r } = farm();
		r.beginStream();
		const s2 = new Stream(500n, T0 + 2000);
		// B left and C joined while the stream was down; the snapshot's own workers do not count.
		r.apply(
			s2.snapshot(E.reset(), E.worker(A), E.worker('c', { systems: ['aarch64-linux'] })),
			T0 + 2000
		);
		const v = r.views(T0 + 2000, 15).pools.get('aarch64-linux')!;
		expect([v.joined, v.left]).toEqual([1, 1]);
		// B was draining before the gap, so it left on purpose.
		expect(r.views(T0 + 2000, 15).topology.retired).toEqual([B]);
		expect(v.builders).toBe(1);
		expect(r.views(T0 + 2000, 15).pools.get('x86_64-linux')).toMatchObject({ joined: 0, left: 0 });

		r.beginStream();
		const s3 = new Stream(3n, T0 + 3000);
		r.apply(s3.snapshot(E.reset({ instance: 'inst-b' }), E.worker(A)), T0 + 3000);
		const fresh = r.views(T0 + 3000, 15).pools;
		expect([...fresh.keys()]).toEqual(['x86_64-linux']);
		expect(fresh.get('x86_64-linux')).toMatchObject({
			joined: 0,
			left: 0,
			churnSince: { fromMs: T0 + 3000, cause: 'restart' }
		});
	});
});

describe('line failures', () => {
	const MIN = 60_000;
	const assign = (path: string, addr: string, ids: number[] = []) =>
		E.drv(path, {
			cause: Cause.ASSIGNED,
			phase: Phase.ASSIGNED,
			workerAddr: addr,
			clientIds: ids.map(BigInt)
		});
	/** A drv per outcome, wanted by `ids`, assigned to `addr` and ended there. */
	const builds = (tag: string, addr: string, outcomes: Outcome[], ids: number[] = []) =>
		outcomes.flatMap((o, i) => {
			const p = drvPath(`${tag}-${i}`);
			return [
				E.drv(p, { cause: Cause.WANTED, clientIds: ids.map(BigInt) }),
				assign(p, addr, ids),
				E.gone(p, o, { workerAddr: addr })
			];
		});
	const counts = (r: FarmReducer, id: string, now: number, minutes = 15) => {
		const e = r.views(now, minutes).edges.get(id);
		return e && { finished: e.finished, failed: e.failed };
	};
	const { BUILT, FAILED, CANCELLED, DROPPED } = Outcome;

	it('assign line counts built and failed in the window', () => {
		const { r, s } = started({}, E.reset(), E.worker(A));
		r.apply(s.next(...builds('b', A, [BUILT, BUILT, BUILT, FAILED])), T0 + 1000);
		expect(counts(r, `assign:${A}`, T0 + 1000)).toEqual({ finished: 4, failed: 1 });
		expect(counts(r, 'assign:pool:x86_64-linux', T0 + 1000)).toEqual({ finished: 4, failed: 1 });
		// Other kinds carry no counts.
		expect(counts(r, `publish:${A}`, T0 + 1000)).toEqual({ finished: 0, failed: 0 });
		expect(counts(r, 'cached:scheduler', T0 + 1000)).toEqual({ finished: 0, failed: 0 });
	});

	it('cancelled and dropped builds do not count', () => {
		const { r, s } = started({}, E.reset(), E.worker(A));
		r.apply(s.next(...builds('c', A, [CANCELLED, DROPPED])), T0 + 1000);
		expect(counts(r, `assign:${A}`, T0 + 1000)).toEqual({ finished: 0, failed: 0 });
		r.apply(s.next(...builds('f', A, [FAILED])), T0 + 2000);
		expect(counts(r, `assign:${A}`, T0 + 2000)).toEqual({ finished: 1, failed: 1 });
	});

	it('a 6 minute old failure counts in 15 minutes, not in 5', () => {
		const { r, s } = started({}, E.reset(), E.worker(A));
		r.apply(s.next(...builds('f', A, [FAILED])), T0 + 1000);
		const later = T0 + 1000 + 6 * MIN;
		expect(counts(r, `assign:${A}`, later, 15)).toEqual({ finished: 1, failed: 1 });
		expect(counts(r, `assign:${A}`, later, 5)).toEqual({ finished: 0, failed: 0 });
		expect(counts(r, `assign:${A}`, later, 60)).toEqual({ finished: 1, failed: 1 });
	});

	it('two views in one bucket give the same counts', () => {
		const { r, s } = started({}, E.reset(), E.worker(A));
		r.apply(s.next(...builds('f', A, [FAILED, BUILT])), T0 + 1000);
		expect(counts(r, `assign:${A}`, T0 + 2000)).toEqual({ finished: 2, failed: 1 });
		// The rate decays meanwhile; the counts hold still.
		expect(r.views(T0 + 29_000, 15).edges.get(`assign:${A}`)).toEqual({
			rate: 0,
			unit: 'builds',
			finished: 2,
			failed: 1
		});
		// The window ends on bucket boundaries, so 15 minutes later the
		// failure still counts until the bucket it fell in leaves.
		expect(counts(r, `assign:${A}`, T0 + 15 * MIN + 29_000)).toEqual({ finished: 2, failed: 1 });
		expect(counts(r, `assign:${A}`, T0 + 15 * MIN + 30_000)).toEqual({ finished: 0, failed: 0 });
	});

	it('snapshot events add nothing to any history', () => {
		const P = drvPath('in-snapshot');
		const { r } = started(
			{},
			E.reset(),
			E.worker(A),
			E.client(1, 'ci'),
			E.drv(P, {
				cause: Cause.ASSIGNED,
				phase: Phase.ASSIGNED,
				workerAddr: A,
				clientIds: [1n],
				inputSources: [create(InputSourceSchema, { workerAddr: B, paths: 1, narBytes: 500n })]
			}),
			E.gone(P, FAILED, { workerAddr: A }),
			E.drv(Q1, { cause: Cause.WANTED, clientIds: [1n] }),
			E.cached(C1, 1),
			E.stats({ cacheHits: 5n })
		);
		const v = r.views(T0, 15);
		expect(v.edges.size).toBeGreaterThan(5);
		for (const [id, e] of v.edges)
			expect([id, e.rate, e.finished, e.failed]).toEqual([id, 0, 0, 0]);
		for (const id of [`assign:${A}`, `publish:${A}`, `fetch:${A}`, 'want:ci', 'cached:scheduler'])
			expect(r.edgeDetail([id], T0 + 60_000, 15)).toMatchObject({
				total: 0,
				finished: 0,
				failed: 0
			});
	});

	it('want lines count each waiting group once', () => {
		const P = drvPath('shared');
		const { r, s } = started(
			{},
			E.reset(),
			E.worker(A),
			E.client(1, 'g1'),
			E.client(2, 'g1'),
			E.client(3, 'g2')
		);
		r.apply(
			s.next(
				E.drv(P, { cause: Cause.WANTED, clientIds: [1n, 2n, 3n] }),
				assign(P, A, [1, 2, 3]),
				E.gone(P, FAILED, { workerAddr: A })
			),
			T0 + 1000
		);
		expect(counts(r, 'want:g1', T0 + 1000)).toEqual({ finished: 1, failed: 1 });
		expect(counts(r, 'want:g2', T0 + 1000)).toEqual({ finished: 1, failed: 1 });
		expect(counts(r, `assign:${A}`, T0 + 1000)).toEqual({ finished: 1, failed: 1 });
	});

	it('a build with no clients counts only on its assign line', () => {
		const { r, s } = started(
			{},
			E.reset(),
			E.worker(A),
			E.client(1, 'g1'),
			E.drv(Q1, { clientIds: [1n] })
		);
		r.apply(s.next(...builds('orphan', A, [FAILED, BUILT])), T0 + 1000);
		expect(counts(r, `assign:${A}`, T0 + 1000)).toEqual({ finished: 2, failed: 1 });
		expect(counts(r, 'want:g1', T0 + 1000)).toEqual({ finished: 0, failed: 0 });
	});

	it('a client removed by FOLLOWERS before the failure does not count', () => {
		const P = drvPath('left-early');
		const { r, s } = started({}, E.reset(), E.worker(A), E.client(1, 'g1'), E.client(2, 'g2'));
		r.apply(
			s.next(
				E.drv(P, { cause: Cause.WANTED, clientIds: [1n, 2n] }),
				assign(P, A, [1, 2]),
				// g2's client leaves: the scheduler first drops it from the followers.
				E.drv(P, {
					cause: Cause.FOLLOWERS,
					phase: Phase.ASSIGNED,
					workerAddr: A,
					clientIds: [1n]
				}),
				E.clientGone(2),
				E.gone(P, FAILED, { workerAddr: A })
			),
			T0 + 1000
		);
		expect(counts(r, 'want:g1', T0 + 1000)).toEqual({ finished: 1, failed: 1 });
		expect(counts(r, 'want:g2', T0 + 1000)).toEqual({ finished: 0, failed: 0 });
	});

	/** Group a waits on 5 drvs and shows; b, c and d wait on one each and fold into other clients. */
	function folded(options = {}) {
		const body = [
			E.worker(A),
			E.client(1, 'a'),
			E.client(2, 'b'),
			E.client(3, 'c'),
			E.client(4, 'd')
		];
		for (let i = 0; i < 5; i++) body.push(E.drv(drvPath(`a-q${i}`), { clientIds: [1n] }));
		body.push(E.drv(drvPath('b-q'), { clientIds: [2n] }));
		body.push(E.drv(drvPath('c-q'), { clientIds: [3n] }));
		body.push(E.drv(drvPath('d-q'), { clientIds: [4n] }));
		const f = started({ maxCards: 2, ...options }, E.reset(), ...body);
		expect(f.r.views(T0, 15).topology.clientGroups).toEqual(['a', OTHER_CLIENTS]);
		return f;
	}

	it('folded groups count on other clients', () => {
		const { r, s } = folded();
		r.apply(
			s.next(
				...builds('b', A, [FAILED, BUILT], [2]),
				...builds('c', A, [FAILED, BUILT, BUILT], [3])
			),
			T0 + 1000
		);
		expect(counts(r, `want:${OTHER_CLIENTS}`, T0 + 1000)).toEqual({ finished: 5, failed: 2 });
		expect(counts(r, 'want:a', T0 + 1000)).toEqual({ finished: 0, failed: 0 });
	});

	it('pool lines add up their builders', () => {
		const addrs = Array.from({ length: 13 }, (_, i) => `10.0.0.${i + 20}:50051`);
		const { r, s } = started(
			{},
			E.reset(),
			...addrs.map((a) => E.worker(a)),
			E.worker(B, { systems: ['aarch64-linux'] })
		);
		// Builder i fails i % 3 builds and builds 2.
		const events = addrs.flatMap((a, i) =>
			builds(`p${i}`, a, [...Array<Outcome>(i % 3).fill(FAILED), BUILT, BUILT])
		);
		r.apply(s.next(...events), T0 + 1000);
		const v = r.views(T0 + 1000, 15);
		let finished = 0;
		let failed = 0;
		for (const a of addrs) {
			const e = v.edges.get(`assign:${a}`)!;
			finished += e.finished;
			failed += e.failed;
		}
		expect([finished, failed]).toEqual([13 * 2 + 12, 12]);
		expect(v.edges.get('assign:pool:x86_64-linux')).toMatchObject({ finished, failed });
		expect(v.edges.get('assign:pool:aarch64-linux')).toMatchObject({ finished: 0, failed: 0 });
	});

	it('a pool line keeps the failures of a builder that left', () => {
		const addrs = Array.from({ length: 13 }, (_, i) => `10.0.0.${i + 20}:50051`);
		const X = addrs[4];
		const { r, s } = started({}, E.reset(), ...addrs.map((a) => E.worker(a)));
		r.apply(s.next(...builds('x', X, [FAILED, FAILED, FAILED])), T0 + 1000);
		r.apply(s.next(E.worker(X, { up: false })), T0 + 2000);
		expect(counts(r, `assign:${X}`, T0 + 2000)).toEqual({ finished: 3, failed: 3 });
		// Ten minutes after it disconnected, it leaves the map with its own history.
		const later = T0 + 2000 + 10 * MIN + 5000;
		const v = r.views(later, 15);
		expect(v.topology.workers).not.toContain(X);
		expect(v.edges.has(`assign:${X}`)).toBe(false);
		expect(v.edges.get('assign:pool:x86_64-linux')).toMatchObject({ finished: 3, failed: 3 });
	});

	it('a group that leaves takes its counts', () => {
		const { r, s } = folded({ rerankMs: 1000 });
		r.apply(s.next(...builds('b', A, [FAILED], [2]), ...builds('c', A, [FAILED], [3])), T0 + 1000);
		expect(counts(r, `want:${OTHER_CLIENTS}`, T0 + 1000)).toEqual({ finished: 2, failed: 2 });
		// b's last client leaves; a minute later the group is gone.
		r.apply(s.next(E.clientGone(2)), T0 + 2000);
		let now = T0 + 2000 + 61_000;
		expect(r.views(now, 15).topology.clientGroups).toEqual(['a', OTHER_CLIENTS]);
		expect(r.clientGroup('b', now)).toBeUndefined();
		expect(counts(r, `want:${OTHER_CLIENTS}`, now)).toEqual({ finished: 1, failed: 1 });

		// A shown group goes the same way, and its line with it.
		r.apply(s.next(...builds('a', A, [FAILED], [1])), now);
		expect(counts(r, 'want:a', now)).toEqual({ finished: 1, failed: 1 });
		r.apply(s.next(E.clientGone(1)), now + 1000);
		now += 1000 + 61_000;
		const v = r.views(now, 15);
		// Two groups left, so each has its card again.
		expect(v.topology.clientGroups).toEqual(['c', 'd']);
		expect(v.edges.has('want:a')).toBe(false);
		expect(v.edges.get('want:c')).toMatchObject({ finished: 1, failed: 1 });
	});

	it('a reconnect to the same instance keeps the counts, and a new instance drops them', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.client(1, 'g1'));
		r.apply(s.next(...builds('f', A, [FAILED, BUILT], [1])), T0 + 1000);
		const before = { finished: 2, failed: 1 };
		expect(counts(r, `assign:${A}`, T0 + 1000)).toEqual(before);

		r.beginStream();
		r.apply(
			new Stream(500n, T0 + 2000).snapshot(E.reset(), E.worker(A), E.client(1, 'g1')),
			T0 + 2000
		);
		expect(counts(r, `assign:${A}`, T0 + 2000)).toEqual(before);
		expect(counts(r, 'assign:pool:x86_64-linux', T0 + 2000)).toEqual(before);
		expect(counts(r, 'want:g1', T0 + 2000)).toEqual(before);

		r.beginStream();
		r.apply(
			new Stream(3n, T0 + 3000).snapshot(
				E.reset({ instance: 'inst-b' }),
				E.worker(A),
				E.client(1, 'g1')
			),
			T0 + 3000
		);
		const none = { finished: 0, failed: 0 };
		expect(counts(r, `assign:${A}`, T0 + 3000)).toEqual(none);
		expect(counts(r, 'assign:pool:x86_64-linux', T0 + 3000)).toEqual(none);
		expect(counts(r, 'want:g1', T0 + 3000)).toEqual(none);
	});
});

describe('line detail', () => {
	const BUCKET = 30_000;
	const { BUILT, FAILED } = Outcome;
	const remote = (bytes: number, from = B) =>
		create(InputSourceSchema, { workerAddr: from, paths: 1, narBytes: BigInt(bytes) });
	const output = (bytes: number) =>
		create(OutputSchema, { path: '/nix/store/x-out', narSize: BigInt(bytes) });

	/** Applies events at `now` on both clocks, so the server offset stays 0. */
	function at(r: FarmReducer, s: Stream, now: number, ...events: Ev[]) {
		s.timeMs = now;
		const res = r.apply(s.next(...events), now);
		expect(res.ok, res.ok ? '' : res.error).toBe(true);
	}
	/** Wanted by `ids` and assigned to `addr` at `now`. */
	function start(path: string, addr: string, now: number, ids = [1], inputs = [remote(0)]) {
		return [
			E.drv(path, { cause: Cause.WANTED, clientIds: ids.map(BigInt) }),
			E.drv(path, {
				cause: Cause.ASSIGNED,
				phase: Phase.ASSIGNED,
				workerAddr: addr,
				clientIds: ids.map(BigInt),
				assignedMs: BigInt(now),
				inputSources: inputs
			})
		];
	}
	const end = (path: string, addr: string, o: Outcome, outputs = [output(1000)]) =>
		E.gone(path, o, { workerAddr: addr, outputs: o === BUILT ? outputs : [] });
	const paths = (items: readonly { drv: { drvPath: string } }[]) => items.map((i) => i.drv.drvPath);
	const nulls = (n: number) => Array<null>(n).fill(null);

	it('edgeDetail on one assign line', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.worker(B), E.client(1, 'g'));
		const D = [0, 1, 2, 3].map((i) => drvPath(`d${i}`));
		// Three builds in the first bucket, then one still building in the next.
		const outcomes = [BUILT, FAILED, BUILT];
		for (let i = 0; i < 3; i++) {
			const t = T0 + 1000 * (i + 1);
			at(r, s, t, ...start(D[i], A, t), end(D[i], A, outcomes[i]));
		}
		at(r, s, T0 + 31_000, ...start(D[3], A, T0 + 31_000));
		const now = T0 + 32_000;
		const v = r.views(now, 15);
		const d = r.edgeDetail([`assign:${A}`], now, 15)!;
		expect(d).toMatchObject({
			edgeIds: [`assign:${A}`],
			flow: 'assign',
			unit: 'builds',
			count: 1,
			windowMinutes: 15,
			total: 4,
			finished: 3,
			failed: 1,
			since: { cause: 'page' },
			rows: [],
			estimate: false
		});
		// The 10 s rate, as on the map: only the last assignment is that recent.
		expect(d.rate).toBe(0.1);
		expect(d.rate).toBe(v.edges.get(`assign:${A}`)!.rate);
		// 30 whole buckets, the last one the first after the snapshot.
		expect(d.series).toEqual({
			startMs: T0 + BUCKET - 15 * 60_000,
			bucketMs: BUCKET,
			values: [...nulls(29), 3 / 30],
			failed: [...nulls(29), 1 / 30]
		});
		expect(d.items.map((i) => [i.drv.drvPath, i.drv.phase, i.atMs, i.via, i.bytes])).toEqual([
			[D[3], 'assigned', T0 + 31_000, `assign:${A}`, 0],
			[D[2], 'built', T0 + 3000, `assign:${A}`, 0],
			[D[1], 'failed', T0 + 2000, `assign:${A}`, 0],
			[D[0], 'built', T0 + 1000, `assign:${A}`, 0]
		]);
		const five = r.edgeDetail([`assign:${A}`], now, 5)!;
		expect(five).toMatchObject({ windowMinutes: 5, total: 4, finished: 3, failed: 1 });
		expect(five.series.values).toHaveLength(10);
		// The header's longer windows: half the line history, and all of it.
		for (const [minutes, buckets] of [
			[30, 60],
			[60, 120]
		]) {
			const w = r.edgeDetail([`assign:${A}`], now, minutes)!;
			expect(w).toMatchObject({ windowMinutes: minutes, total: 4, finished: 3, failed: 1 });
			expect(w.series.values).toHaveLength(buckets);
			expect(w.series.values.at(-1)).toBe(3 / 30);
		}
	});

	it('a bundle adds up rate, series and counts, with rows busiest first and unknown ids skipped', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.worker(B), E.client(1, 'g'));
		const t = T0 + 25_000;
		at(r, s, t, ...start(drvPath('a0'), A, t), end(drvPath('a0'), A, FAILED));
		for (let i = 1; i <= 3; i++) {
			const p = drvPath(`b${i}`);
			at(r, s, t + i, ...start(p, B, t + i), end(p, B, BUILT));
		}
		const now = T0 + 31_000;
		r.views(now, 15);
		const d = r.edgeDetail(
			[`assign:${A}`, 'assign:10.9.9.9:1', `publish:${A}`, `assign:${B}`, `assign:${A}`, 'bogus'],
			now,
			15
		)!;
		expect(d).toMatchObject({
			edgeIds: [`assign:${A}`, `assign:${B}`],
			flow: 'assign',
			count: 2,
			rate: 0.4,
			total: 4,
			finished: 4,
			failed: 1
		});
		expect(d.rows).toEqual([
			{ edgeId: `assign:${B}`, rate: 0.3, total: 3, finished: 3, failed: 0 },
			{ edgeId: `assign:${A}`, rate: 0.1, total: 1, finished: 1, failed: 1 }
		]);
		expect(d.series.values.at(-1)).toBe(4 / 30);
		expect(d.series.failed!.at(-1)).toBe(1 / 30);
		expect(paths(d.items)).toEqual([drvPath('b3'), drvPath('b2'), drvPath('b1'), drvPath('a0')]);
		// The first known id sets the kind.
		const p = r.edgeDetail(['assign:gone', `publish:${A}`, `assign:${B}`], now, 15)!;
		expect(p).toMatchObject({
			edgeIds: [`publish:${A}`],
			flow: 'publish',
			unit: 'bytes',
			rows: []
		});
		expect(p.series.failed).toBeNull();
		// Still a bundle when only one of its lines is left.
		expect(r.edgeDetail([`assign:${A}`, 'assign:gone'], now, 15)!.rows).toHaveLength(1);
		expect(r.edgeDetail(['assign:10.9.9.9:1', 'lane:builders'], now, 15)).toBeUndefined();
		expect(r.edgeDetail([], now, 15)).toBeUndefined();
	});

	it('a pool line has one row per builder', () => {
		const addrs = Array.from({ length: 13 }, (_, i) => `10.0.0.${i + 20}:50051`);
		const { r, s } = started(
			{},
			E.reset(),
			...addrs.map((a) => E.worker(a)),
			E.worker(B, { systems: ['aarch64-linux'] }),
			E.client(1, 'g')
		);
		// Builder i builds i % 4 drvs. The last one also fails two and leaves on purpose.
		let t = T0 + 20_000;
		addrs.forEach((a, i) => {
			for (let j = 0; j < i % 4; j++) {
				const p = drvPath(`p${i}-${j}`);
				at(r, s, ++t, ...start(p, a, t), end(p, a, BUILT));
			}
		});
		const last = addrs[12];
		for (let j = 0; j < 2; j++) {
			const p = drvPath(`last-${j}`);
			at(r, s, ++t, ...start(p, last, t), end(p, last, FAILED));
		}
		at(r, s, ++t, E.worker(last, { draining: true }));
		at(r, s, ++t, E.worker(last, { up: false }));
		const now = T0 + 25_000;
		r.views(now, 15);
		// The retired builder is off the map, but its builds still count in the pool's history.
		const d = r.edgeDetail(['assign:pool:x86_64-linux'], now, 15)!;
		expect(d).toMatchObject({ count: 12, total: 20, finished: 20, failed: 2 });
		// Busiest first; equal rates keep the map's order.
		const order = [3, 7, 11, 2, 6, 10, 1, 5, 9, 0, 4, 8];
		expect(d.rows.map((x) => x.edgeId)).toEqual(order.map((i) => `assign:${addrs[i]}`));
		expect(d.rows.map((x) => x.total)).toEqual(order.map((i) => i % 4));
		expect(d.rows[0]).toEqual({
			edgeId: `assign:${addrs[3]}`,
			rate: 0.3,
			total: 3,
			finished: 3,
			failed: 0
		});

		// In a bundle the pool is one row with its own numbers.
		const b = r.edgeDetail(['assign:pool:x86_64-linux', `assign:${B}`], now, 15)!;
		expect(b.count).toBe(13);
		expect(b.rows.map((x) => [x.edgeId, x.total, x.failed])).toEqual([
			['assign:pool:x86_64-linux', 20, 2],
			[`assign:${B}`, 0, 0]
		]);
		// Publish rows name each builder's publish line.
		const pub = r.edgeDetail(['publish:pool:x86_64-linux'], now, 15)!;
		expect(pub.rows[0]).toMatchObject({ edgeId: `publish:${addrs[3]}`, total: 3000 });
		expect(r.edgeDetail(['assign:pool:riscv64-linux'], now, 15)).toBeUndefined();
	});

	it('other clients has one row per folded group', () => {
		const body = [E.worker(A), E.client(1, 'a'), E.client(2, 'b'), E.client(3, 'c')];
		for (let i = 0; i < 5; i++) body.push(E.drv(drvPath(`a-q${i}`), { clientIds: [1n] }));
		body.push(E.drv(drvPath('b-q'), { clientIds: [2n] }));
		body.push(E.drv(drvPath('c-q'), { clientIds: [3n] }));
		const { r, s } = started({ maxCards: 2 }, E.reset(), ...body);
		expect(r.views(T0, 15).topology.clientGroups).toEqual(['a', OTHER_CLIENTS]);
		const [b0, c0, c1] = ['b0', 'c0', 'c1'].map(drvPath);
		let t = T0 + 20_000;
		at(r, s, ++t, ...start(b0, A, t, [2]), end(b0, A, FAILED));
		at(r, s, ++t, ...start(c0, A, t, [3]), end(c0, A, BUILT));
		at(r, s, ++t, ...start(c1, A, t, [3]), end(c1, A, BUILT));
		const now = T0 + 25_000;
		r.views(now, 15);
		const d = r.edgeDetail([`want:${OTHER_CLIENTS}`], now, 15)!;
		expect(d).toMatchObject({
			flow: 'want',
			unit: 'builds',
			count: 2,
			rate: 0.3,
			total: 3,
			finished: 3,
			failed: 1
		});
		expect(d.rows).toEqual([
			{ edgeId: 'want:c', rate: 0.2, total: 2, finished: 2, failed: 0 },
			{ edgeId: 'want:b', rate: 0.1, total: 1, finished: 1, failed: 1 }
		]);
		expect(d.items.map((i) => [i.drv.drvPath, i.via])).toEqual([
			[c1, 'want:c'],
			[c0, 'want:c'],
			[b0, 'want:b']
		]);
		// A folded group's own line answers too.
		expect(r.edgeDetail(['want:b'], now, 15)).toMatchObject({
			edgeIds: ['want:b'],
			count: 1,
			total: 1,
			failed: 1,
			rows: []
		});
	});

	it('items per kind', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.worker(B), E.client(1, 'g'));
		const [D1, D2, D3, D4, H] = ['d1', 'd2', 'd3', 'd4', 'hit'].map(drvPath);
		at(r, s, T0 + 1000, ...start(D1, A, T0 + 1000, [1], [remote(500)]));
		at(r, s, T0 + 2000, end(D1, A, BUILT, [output(5000)]));
		at(r, s, T0 + 3000, ...start(D2, A, T0 + 3000), end(D2, A, FAILED));
		// Built, but its only input came from the same builder and it has no outputs.
		at(r, s, T0 + 5000, ...start(D3, A, T0 + 5000, [1], [remote(300, A)]), end(D3, A, BUILT, []));
		at(r, s, T0 + 7000, ...start(D4, A, T0 + 7000, [1], [remote(700)]));
		at(r, s, T0 + 8000, E.cached(H, 1));
		const now = T0 + 9000;
		r.views(now, 15);
		const items = (id: string, limit?: number) => r.edgeDetail([id], now, 15, limit)!.items;

		expect(items(`assign:${A}`).map((i) => [i.drv.drvPath, i.drv.phase])).toEqual([
			[D4, 'assigned'],
			[D3, 'built'],
			[D2, 'failed'],
			[D1, 'built']
		]);
		expect(items(`publish:${A}`).map((i) => [i.drv.drvPath, i.atMs, i.bytes])).toEqual([
			[D1, T0 + 2000, 5000]
		]);
		expect(items(`fetch:${A}`).map((i) => [i.drv.drvPath, i.atMs, i.bytes])).toEqual([
			[D4, T0 + 7000, 700],
			[D1, T0 + 1000, 500]
		]);
		expect(r.edgeDetail([`fetch:${A}`], now, 15)!.estimate).toBe(true);
		expect(items('want:g').map((i) => [i.drv.drvPath, i.drv.phase, i.atMs])).toEqual([
			[H, 'cached', T0 + 8000],
			[D4, 'assigned', T0 + 7000],
			[D3, 'built', T0 + 5000],
			[D2, 'failed', T0 + 3000],
			[D1, 'built', T0 + 1000]
		]);
		expect(items('cached:scheduler').map((i) => [i.drv.drvPath, i.via, i.atMs])).toEqual([
			[H, 'cached:scheduler', T0 + 8000]
		]);
		expect(paths(items(`assign:${A}`, 2))).toEqual([D4, D3]);
		expect(items(`assign:${B}`)).toEqual([]);
	});

	it('items stay within their bounds, once per path, newest first', () => {
		// A builder keeps what it builds now and its last `limit` results.
		const limit = 5;
		const f = started({ workerRecentLimit: limit }, E.reset(), E.worker(A), E.client(1, 'g'));
		let t = T0 + 1000;
		const built = Array.from({ length: 40 }, (_, i) => drvPath(`many-${i}`));
		for (const p of built) at(f.r, f.s, ++t, ...start(p, A, t), end(p, A, BUILT));
		// It fails, and builds again on the same builder: in flight and in the recent list.
		const X = drvPath('retried');
		at(f.r, f.s, ++t, ...start(X, A, t), end(X, A, FAILED));
		at(f.r, f.s, ++t, ...start(X, A, t));
		const hits = Array.from({ length: 70 }, (_, i) => drvPath(`hit-${i}`));
		for (const h of hits) at(f.r, f.s, ++t, E.cached(h, 1));
		at(f.r, f.s, ++t, E.cached(hits[69], 1));
		const later = t + 1000;
		f.r.views(later, 15);
		// A limit above every bound, so each list stops at its own.
		const many = (id: string) => paths(f.r.edgeDetail([id], later, 15, 1000)!.items);
		const newestFirst = (ps: readonly string[]) => [...new Set(ps.toReversed())];

		expect(many(`assign:${A}`)).toEqual([X, ...built.toReversed().slice(0, limit - 1)]);
		const wanted = [...built, X, X, ...hits, hits[69]];
		const wants = many('want:g');
		expect(wants.length).toBeLessThan(new Set(wanted).size);
		expect(wants).toEqual(newestFirst(wanted).slice(0, wants.length));
		const cached = many('cached:scheduler');
		expect(cached.length).toBeLessThan(hits.length);
		expect(cached).toEqual(newestFirst([...hits, hits[69]]).slice(0, cached.length));
	});

	it('a path that failed on 60 builders takes one item of their bundle', () => {
		const ws = Array.from({ length: 60 }, (_, i) => `10.0.3.${i}:50051`);
		const g = started({}, E.reset(), ...ws.map((w) => E.worker(w)), E.client(1, 'g'));
		let t = T0 + 1000;
		ws.forEach((w, i) => {
			const p = drvPath(`own-${i}`);
			at(g.r, g.s, ++t, ...start(p, w, t), end(p, w, BUILT));
		});
		const Y = drvPath('broken');
		for (const w of ws) at(g.r, g.s, ++t, ...start(Y, w, t), end(Y, w, FAILED));
		g.r.views(t, 15);
		const limit = 50;
		const ids = ws.map((w) => `assign:${w}`);
		const bundle = g.r.edgeDetail(ids, t, 15, limit)!.items;
		// The newest item 60 times over, and still room for the others.
		const own = ws.map((_, i) => drvPath(`own-${i}`)).toReversed();
		expect(paths(bundle)).toEqual([Y, ...own.slice(0, limit - 1)]);
		expect(bundle[0]).toMatchObject({ via: `assign:${ws[59]}`, atMs: t });
	});

	it('cache hits outlive 600 publishes that push them out of the cache ring', () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.client(1, 'g'));
		const hits = [0, 1, 2, 3, 4].map((i) => drvPath(`hit-${i}`));
		at(r, s, T0 + 1000, ...hits.map((h) => E.cached(h, 1)));
		for (let i = 0; i < 600; i++) {
			const p = drvPath(`pub-${i}`);
			at(r, s, T0 + 2000 + i, ...start(p, A, T0 + 2000 + i), end(p, A, BUILT));
		}
		expect(r.drvsForCache(1000).some((d) => d.phase === 'cached')).toBe(false);
		const now = T0 + 3000;
		r.views(now, 15);
		expect(paths(r.edgeDetail(['cached:scheduler'], now, 15)!.items)).toEqual(hits.toReversed());
	});

	it('a drv that five clients of one group want takes one slot in its recent list', () => {
		const clients = [1, 2, 3, 4, 5].map((i) => E.client(i, 'g'));
		const { r, s } = started({}, E.reset(), E.worker(A), ...clients);
		const D = Array.from({ length: 31 }, (_, i) => drvPath(`one-${i}`));
		D.forEach((p, i) =>
			at(r, s, T0 + 1000 + i, E.drv(p, { cause: Cause.WANTED, clientIds: [1n] }))
		);
		const X = drvPath('five');
		at(r, s, T0 + 2000, E.drv(X, { cause: Cause.WANTED, clientIds: [1n, 2n, 3n, 4n, 5n] }));
		const now = T0 + 3000;
		r.views(now, 15);
		const d = r.edgeDetail(['want:g'], now, 15, 100)!;
		// Five slots would have pushed the four oldest Wants out.
		expect(paths(d.items)).toEqual([X, ...D.toReversed()]);
		// It still counts as five Wants.
		expect(d.total).toBe(36);
	});

	it("an offline builder's line still answers until the builder leaves", () => {
		const { r, s } = started({}, E.reset(), E.worker(A), E.worker(B), E.client(1, 'g'));
		for (let i = 0; i < 2; i++) {
			const p = drvPath(`f${i}`);
			at(r, s, T0 + 1000 + i, ...start(p, A, T0 + 1000 + i), end(p, A, FAILED));
		}
		at(r, s, T0 + 5000, E.worker(A, { up: false }));
		let now = T0 + 6000;
		r.views(now, 15);
		const d = r.edgeDetail([`assign:${A}`], now, 15)!;
		expect(d).toMatchObject({ count: 1, total: 2, finished: 2, failed: 2 });
		expect(d.items).toHaveLength(2);
		now = T0 + 5000 + 10 * 60_000 + 5000;
		r.views(now, 15);
		expect(r.edgeDetail([`assign:${A}`], now, 15)).toBeUndefined();
		expect(r.edgeDetail([`assign:${A}`, `assign:${B}`], now, 15)!.edgeIds).toEqual([`assign:${B}`]);
	});

	it('drv(path, via) finds a drv that left the recent ring', () => {
		const { r, s } = started({ recentLimit: 4 }, E.reset(), E.worker(A), E.client(1, 'g'));
		const H = drvPath('hit');
		at(r, s, T0 + 1000, E.cached(H, 1));
		const D = Array.from({ length: 6 }, (_, i) => drvPath(`r${i}`));
		D.forEach((p, i) => at(r, s, T0 + 2000 + i, ...start(p, A, T0 + 2000 + i), end(p, A, BUILT)));
		expect(r.drv(D[0])).toBeUndefined();
		expect(r.drv(H)).toBeUndefined();
		expect(r.drv(D[5])).toMatchObject({ phase: 'built' });
		for (const via of [`assign:${A}`, `publish:${A}`, `fetch:${A}`, 'want:g'])
			expect(r.drv(D[0], via), via).toMatchObject({ drvPath: D[0], phase: 'built' });
		expect(r.drv(H, 'cached:scheduler')).toMatchObject({ drvPath: H, phase: 'cached' });
		expect(r.drv(H, 'want:g')).toMatchObject({ drvPath: H, phase: 'cached' });
		expect(r.drv(D[0], 'assign:10.9.9.9:1')).toBeUndefined();
		expect(r.drv(D[0], 'cached:scheduler')).toBeUndefined();
		expect(r.drv(D[0], 'nonsense')).toBeUndefined();
	});

	it('series is null before SnapshotDone and across a reconnect gap, and partial is true when the window starts before the data', () => {
		const r = new FarmReducer();
		const s = new Stream(41n, T0 - 60_000);
		r.beginStream();
		const snap = s.snapshot(E.reset(), E.worker(A));
		// The snapshot takes a minute to stream: nothing is live before SnapshotDone.
		r.apply(snap.slice(0, 2), T0 - 60_000);
		r.apply(snap.slice(2), T0);
		// Live for 3 minutes, Stats every 5 s, one assignment.
		for (let t = T0 + 5000; t < T0 + 180_000; t += 5000)
			at(r, s, t, ...(t === T0 + 10_000 ? start(drvPath('x'), A, t, []) : []), E.stats());
		// The stream drops, and a new one is live 2 minutes later.
		r.beginStream();
		const s2 = new Stream(900n, T0 + 300_000);
		r.apply(s2.snapshot(E.reset(), E.worker(A)), T0 + 300_000);
		for (let t = T0 + 305_000; t < T0 + 420_000; t += 5000) at(r, s2, t, E.stats());

		const now = T0 + 420_500;
		const d = r.edgeDetail([`assign:${A}`], now, 15)!;
		expect(d.series.startMs).toBe(T0 - 16 * BUCKET);
		const live = (first: number) => [first, 0, 0, 0, 0, 0, ...nulls(4), 0, 0, 0, 0];
		expect(d.series.values).toEqual([...nulls(16), ...live(1 / 30)]);
		expect(d.series.failed).toEqual([...nulls(16), ...live(0)]);
		expect(d.since).toEqual({ fromMs: T0, cause: 'page' });
		// Five minutes start inside the live data.
		const five = r.edgeDetail([`assign:${A}`], now, 5)!;
		expect(five.series.values).toEqual([0, 0, ...nulls(4), 0, 0, 0, 0]);
		expect(five.since).toBeNull();
		// views() says the same of the lines' window.
		expect(r.views(now, 15).linesSince).not.toBeNull();
		expect(r.views(now, 5).linesSince).toBeNull();
	});

	it('line histories match the counters', { timeout: 60_000 }, () => {
		const farm = new MockFarm(mockOptions({ builders: 50, seed: 11 }), T0);
		const r = new FarmReducer();
		r.beginStream();
		const snapshot = farm.snapshot();
		expect(r.apply(snapshot, T0).ok).toBe(true);
		const reset = snapshot[0].event;
		const farmCache = reset.case === 'reset' ? reset.value.cacheSubstituterUrl : '';
		const base = farm.inspect().counters;
		// Upstream NAR bytes in the Stats totals. The farm cache's are not upstream traffic.
		let firstStats: number | null = null;
		let lastStats = 0;
		let substitutePools: string[] = [];
		let substituteAtFirst = 0;
		let t = T0;
		while (t < T0 + 5 * 60_000) {
			t += 1000;
			const batch = farm.advance(t);
			const res = r.apply(batch, t);
			expect(res.ok, res.ok ? '' : res.error).toBe(true);
			for (const e of batch) {
				if (e.event.case !== 'stats') continue;
				lastStats = 0;
				for (const x of e.event.value.totals!.substituters)
					if (x.url !== farmCache) lastStats += Number(x.narBytes);
			}
			// The first Stats is the base, so the line also counts what builders reported before it.
			if (firstStats === null && batch.some((e) => e.event.case === 'stats')) {
				firstStats = lastStats;
				substitutePools = [...r.views(t, 60).pools.keys()].map((p) => `substitute:pool:${p}`);
				substituteAtFirst = r.edgeDetail(substitutePools, t, 60, 0)?.total ?? 0;
			}
		}
		const c = farm.inspect().counters;
		const d = (k: keyof typeof c) => c[k] - base[k];
		const v = r.views(t, 60);
		const all = (kind: string) => v.topology.workers.map((a) => `${kind}:${a}`);

		const assign = r.edgeDetail(all('assign'), t, 60, 0)!;
		expect(d('failed')).toBeGreaterThan(0);
		expect(assign.total).toBe(d('assigned'));
		expect(assign.finished).toBe(d('built') + d('failed'));
		expect(assign.failed).toBe(d('failed'));
		// Float32 buckets round byte amounts above 2^24 per bucket.
		const publish = r.edgeDetail(all('publish'), t, 60, 0)!;
		expect(publish.total / d('publishedBytes')).toBeCloseTo(1, 6);
		const upstream = lastStats - firstStats!;
		expect(upstream).toBeGreaterThan(0);
		const substitute = r.edgeDetail(substitutePools, t, 60, 0)!.total - substituteAtFirst;
		expect(substitute / upstream).toBeCloseTo(1, 6);
		// The pools' own histories hold the same.
		const pools = [...v.pools.keys()].map((p) => `assign:pool:${p}`);
		const byPool = r.edgeDetail(pools, t, 60, 0)!;
		expect([byPool.total, byPool.finished, byPool.failed]).toEqual([
			assign.total,
			assign.finished,
			assign.failed
		]);
	});
});

describe('failure reasons', () => {
	const assigned = (path: string) =>
		E.drv(path, { phase: Phase.ASSIGNED, workerAddr: A, cause: Cause.ASSIGNED });

	const TEXT = "Cannot build 'f'.\nReason: builder timed out.";
	const result = (
		outcome: Outcome,
		status: Status,
		error: string,
		want: { status: string | null; errorSent: boolean; errorText: string | null }
	) => ({ name: `${Outcome[outcome]} ${Status[status]}`, outcome, status, error, want });

	it.each([
		result(Outcome.FAILED, Status.TIMED_OUT, TEXT, {
			status: 'timed-out',
			errorSent: true,
			errorText: TEXT
		}),
		result(Outcome.FAILED, Status.PERMANENT_FAILURE, 'x', {
			status: 'build-failed',
			errorSent: true,
			errorText: 'x'
		}),
		// An empty error sends no text.
		result(Outcome.FAILED, Status.OUTPUT_REJECTED, '', {
			status: 'output-rejected',
			errorSent: false,
			errorText: null
		}),
		result(Outcome.FAILED, Status.UNSPECIFIED, '', {
			status: null,
			errorSent: false,
			errorText: null
		}),
		result(Outcome.BUILT, Status.SUBSTITUTED, '', {
			status: 'substituted',
			errorSent: false,
			errorText: null
		}),
		// A cancelled or dropped build has no result, whatever the event says.
		result(Outcome.CANCELLED, Status.MISC_FAILURE, 'x', {
			status: null,
			errorSent: false,
			errorText: null
		}),
		result(Outcome.DROPPED, Status.BUILT, '', { status: null, errorSent: false, errorText: null })
	])('$name gives status $want.status', ({ outcome, status, error, want }) => {
		const { r, s } = farm();
		const F = drvPath('f');
		r.apply(s.next(assigned(F), E.gone(F, outcome, { workerAddr: A, status, error })), T0 + 1000);
		expect(r.drv(F)).toMatchObject(want);
	});

	it('strips ANSI escapes and keeps at most the last 4096 characters', () => {
		const { r, s } = farm();
		const F = drvPath('f');
		const long = 'x'.repeat(5000) + 'END';
		r.apply(
			s.next(
				E.gone(A1, Outcome.FAILED, {
					workerAddr: A,
					status: Status.PERMANENT_FAILURE,
					error: '\x1b[31;1merror:\x1b[0m Cannot build \x1b]8;;https://x\x07link\x1b]8;;\x07.'
				}),
				E.gone(F, Outcome.FAILED, { workerAddr: A, status: Status.MISC_FAILURE, error: long })
			),
			T0 + 1000
		);
		expect(r.drv(A1)!.errorText).toBe('error: Cannot build link.');
		const text = r.drv(F)!.errorText!;
		expect(text).toHaveLength(4096);
		expect(text.endsWith('END')).toBe(true);
	});

	it('the 257th failure drops the oldest text and keeps its errorSent', () => {
		const { r, s } = farm();
		const paths = Array.from({ length: ERRORS_KEPT + 1 }, (_, i) => drvPath(`f${i}`));
		r.apply(
			s.next(
				...paths.map((p, i) =>
					E.gone(p, Outcome.FAILED, {
						workerAddr: A,
						status: Status.PERMANENT_FAILURE,
						error: `text ${i}`
					})
				)
			),
			T0 + 1000
		);
		// The recent ring keeps the oldest record, without its text.
		const [oldest, second] = paths;
		expect(r.drv(oldest)).toMatchObject({
			errorSent: true,
			errorText: null
		});
		expect(r.drv(second)!.errorText).toBe('text 1');
		expect(r.drv(paths[ERRORS_KEPT])!.errorText).toBe(`text ${ERRORS_KEPT}`);
	});

	it('a view built before the text dropped out loses the text too', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.gone(A1, Outcome.FAILED, { workerAddr: A, status: Status.TIMED_OUT, error: 'first' })
			),
			T0 + 1000
		);
		expect(r.drv(A1)!.errorText).toBe('first');
		r.apply(
			s.next(
				...Array.from({ length: ERRORS_KEPT }, (_, i) =>
					E.gone(drvPath(`g${i}`), Outcome.FAILED, {
						workerAddr: B,
						status: Status.PERMANENT_FAILURE,
						error: 'x'
					})
				)
			),
			T0 + 2000
		);
		expect(r.drv(A1)).toMatchObject({ errorSent: true, errorText: null });
	});

	it('a path that fails on two builders keeps each run its own text', () => {
		const { r, s } = farm();
		const F = drvPath('f');
		r.apply(
			s.next(
				assigned(F),
				E.gone(F, Outcome.FAILED, { workerAddr: A, status: Status.TIMED_OUT, error: 'on A' })
			),
			T0 + 1000
		);
		r.apply(
			s.next(
				E.drv(F, { phase: Phase.ASSIGNED, workerAddr: B, cause: Cause.ASSIGNED }),
				E.gone(F, Outcome.FAILED, {
					workerAddr: B,
					status: Status.PERMANENT_FAILURE,
					error: 'on B'
				})
			),
			T0 + 2000
		);
		const run = (w: string) => r.drvsForWorker(w).find((d) => d.drvPath === F)!;
		expect(run(A)).toMatchObject({ workerAddr: A, status: 'timed-out', errorText: 'on A' });
		expect(run(B)).toMatchObject({ workerAddr: B, status: 'build-failed', errorText: 'on B' });
	});
});

describe('drain reasons and disk', () => {
	const GiB = 1024 ** 3;

	it('maps each Load reason, and UNSPECIFIED while draining gives unknown', () => {
		const { r, s } = farm();
		const now = T0 + 1000;
		r.apply(
			s.next(
				E.worker('s', { draining: true, drainReason: Drain.STOPPING }),
				E.worker('l', {
					draining: true,
					drainReason: Drain.LOW_DISK,
					diskFreeBytes: BigInt(3 * GiB),
					diskTotalBytes: BigInt(200 * GiB),
					minFreeBytes: BigInt(10 * GiB),
					version: '0.4.0'
				}),
				E.worker('d', { draining: true, drainReason: Drain.LOCAL_DAEMON }),
				E.worker('u', { draining: true }),
				// A reason without draining means nothing.
				E.worker('up', { drainReason: Drain.LOW_DISK })
			),
			now
		);
		const v = r.views(now, 15);
		expect(v.workers.get('s')!.drainReason).toBe('stopping');
		expect(v.workers.get('l')).toMatchObject({
			drainReason: 'low-disk',
			diskFree: 3 * GiB,
			diskTotal: 200 * GiB,
			minFree: 10 * GiB,
			version: '0.4.0'
		});
		expect(v.workers.get('d')!.drainReason).toBe('local-daemon');
		expect(v.workers.get('u')!.drainReason).toBe('unknown');
		expect(v.workers.get('up')).toMatchObject({ drainReason: null, diskFree: null, minFree: 0 });
		// Pools count each reason.
		expect(v.pools.get('x86_64-linux')).toMatchObject({
			draining: 4,
			drainingLowDisk: 1,
			drainingStopping: 1,
			drainingLocalDaemon: 1
		});
	});

	it('keeps the last disk report when an update has none', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.worker('l', { diskFreeBytes: BigInt(50 * GiB), diskTotalBytes: BigInt(200 * GiB) }),
				E.worker('l', { draining: true, drainReason: Drain.LOW_DISK })
			),
			T0 + 1000
		);
		expect(r.views(T0 + 1000, 15).workers.get('l')).toMatchObject({
			diskFree: 50 * GiB,
			diskTotal: 200 * GiB
		});
	});

	it('a builder that disconnects while low on disk is not retired and keeps its cell; one stopping is', () => {
		const { r, s } = farm();
		const now = T0 + 1000;
		r.apply(
			s.next(
				E.worker('l', { draining: true, drainReason: Drain.LOW_DISK }),
				E.worker('s', { draining: true, drainReason: Drain.STOPPING }),
				E.worker('l', { up: false }),
				E.worker('s', { up: false })
			),
			now
		);
		const v = r.views(now, 15);
		expect(v.topology.retired).toEqual(['s']);
		expect(v.workers.get('l')).toMatchObject({ up: false, retired: false, drainReason: null });
		expect(v.workers.get('s')!.retired).toBe(true);
		// l is an offline cell of the pool; s counts only under "left".
		expect(v.pools.get('x86_64-linux')).toMatchObject({ builders: 2, up: 1, offline: 1, left: 2 });
	});

	it('a snapshot without a low-disk builder does not retire it', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				E.worker('l', { draining: true, drainReason: Drain.LOW_DISK }),
				E.worker('s', { draining: true, drainReason: Drain.STOPPING })
			),
			T0 + 1000
		);
		r.beginStream();
		const s2 = new Stream(900n, T0 + 2000);
		r.apply(s2.snapshot(E.reset(), E.worker(A)), T0 + 2000);
		const t = r.views(T0 + 2000, 15).topology;
		expect(t.retired).toContain('s');
		expect(t.retired).not.toContain('l');
	});
});

describe('upstream', () => {
	const NIXOS = 'https://cache.nixos.org';
	const COMMUNITY = 'https://nix-community.cachix.org';
	const FARM = 'https://cache.farm.example';
	const MiB = 2 ** 20;
	type Sub = { url: string; nar?: number; download?: number; paths?: number; failures?: number };
	const sub = (x: Sub) =>
		create(SubstituterTrafficSchema, {
			url: x.url,
			narBytes: BigInt(x.nar ?? 0),
			downloadBytes: BigInt(x.download ?? 0),
			paths: BigInt(x.paths ?? 0),
			failures: BigInt(x.failures ?? 0)
		});
	/** A builder that reports, with its substituters' cumulative counts. */
	const w = (addr: string, subs: Sub[], init: Parameters<typeof E.worker>[1] = {}) =>
		E.worker(addr, { version: '0.4.0', substituters: subs.map(sub), ...init });
	const reset = (init: Parameters<typeof E.reset>[0] = {}) =>
		E.reset({ cacheSubstituterUrl: FARM, ...init });

	it('live deltas feed the line, and snapshot events only set the base', () => {
		const { r, s } = started(
			{},
			reset(),
			w('a', [
				{ url: FARM, nar: 100 * MiB },
				{ url: NIXOS, nar: 50 * MiB }
			])
		);
		const t = T0 + 1000;
		r.apply(
			s.next(
				w('a', [
					{ url: FARM, nar: 140 * MiB },
					{ url: NIXOS, nar: 60 * MiB }
				])
			),
			t
		);
		const d = r.edgeDetail(['substitute:a'], t, 15)!;
		// The farm cache's traffic is not upstream traffic.
		expect(d.total).toBe(10 * MiB);
		expect(d.unit).toBe('bytes');
		expect(r.views(t, 15).edges.get('substitute:a')!.rate).toBeGreaterThan(0);
	});

	it('a decrease sets a new base and adds nothing', () => {
		const { r, s } = started({}, reset(), w('a', [{ url: NIXOS, nar: 50 * MiB }]));
		const t = T0 + 1000;
		r.apply(s.next(w('a', [{ url: NIXOS, nar: 5 * MiB }])), t);
		expect(r.edgeDetail(['substitute:a'], t, 15)!.total).toBe(0);
		r.apply(s.next(w('a', [{ url: NIXOS, nar: 7 * MiB }])), t + 1000);
		expect(r.edgeDetail(['substitute:a'], t + 1000, 15)!.total).toBe(2 * MiB);
	});

	it('leaves the farm cache out when the scheduler names it, and lists it when not', () => {
		const named = started({}, reset(), w('a', [{ url: FARM }, { url: NIXOS }])).r.views(T0, 15);
		expect(named.workers.get('a')!.substituters).toEqual([NIXOS]);
		expect(named.upstream!.substituters.map((x) => x.url)).toEqual([NIXOS]);
		expect(named.upstream!.farmCache).toMatchObject({ url: FARM, builders: 1 });
		expect(named.topology.upstreamRows).toBe(2);

		const unnamed = started(
			{},
			reset({ cacheSubstituterUrl: '' }),
			w('a', [{ url: FARM }, { url: NIXOS }])
		).r.views(T0, 15);
		expect(unnamed.workers.get('a')!.substituters).toEqual([FARM, NIXOS]);
		expect(unnamed.upstream!.farmCache).toBeNull();
		expect(unnamed.topology.upstreamRows).toBe(2);
	});

	it('reduces substituter URLs that come with a user, a password or a query', () => {
		const { r } = started(
			{},
			reset({ cacheSubstituterUrl: 'https://ci:token@cache.farm.example?priority=10' }),
			w('a', [
				{ url: 'https://ci:token@cache.farm.example?priority=10', nar: MiB },
				{ url: 'https://me:pw@cache.nixos.org/?trusted=1#x', nar: MiB }
			])
		);
		const v = r.views(T0, 15);
		expect(v.meta!.cacheSubstituterUrl).toBe(FARM);
		expect(v.workers.get('a')!.substituters).toEqual(['https://cache.nixos.org/']);
		expect(v.upstream!.farmCache).toMatchObject({ url: FARM });
		expect(r.substitutersOf('a', T0).map((x) => x.url)).toEqual(['https://cache.nixos.org/']);
	});

	it('upstreamWorkers and upstreamRows follow lists, leaving builders and the farm cache URL', () => {
		const { r, s } = started({}, reset(), w('a', []), w('b', [{ url: FARM }]));
		let v = r.views(T0, 15);
		expect(v.topology.upstreamWorkers).toEqual([]);
		expect(v.upstream).toBeNull();
		const version = (x: typeof v) => x.topology;
		let before = version(v);

		// A list goes from empty to not empty.
		r.apply(s.next(w('a', [{ url: NIXOS }, { url: COMMUNITY }])), T0 + 1000);
		v = r.views(T0 + 1000, 15);
		expect(v.topology).not.toBe(before);
		expect(v.topology.upstreamWorkers).toEqual(['a']);
		expect(v.topology.upstreamRows).toBe(2);
		before = v.topology;
		// Counts alone change nothing.
		r.apply(s.next(w('a', [{ url: NIXOS, nar: 9 }, { url: COMMUNITY }])), T0 + 2000);
		expect(r.views(T0 + 2000, 15).topology).toBe(before);

		// The farm cache URL changes: b's list now holds an upstream one.
		r.beginStream();
		const s2 = new Stream(800n, T0 + 3000);
		r.apply(
			s2.snapshot(
				reset({ cacheSubstituterUrl: 'https://other.example' }),
				w('a', [{ url: NIXOS }, { url: COMMUNITY }]),
				w('b', [{ url: FARM }])
			),
			T0 + 3000
		);
		v = r.views(T0 + 3000, 15);
		expect(v.topology.upstreamWorkers).toEqual(['a', 'b']);
		expect(v.topology.upstreamRows).toBe(3);

		// A builder leaves for good.
		r.apply(s2.next(w('b', [{ url: FARM }], { up: false })), T0 + 4000);
		v = r.views(T0 + 4000 + 11 * 60_000, 15);
		expect(v.topology.upstreamWorkers).toEqual(['a']);
		expect(v.topology.upstreamRows).toBe(2);
	});

	it('a builder that does not report gets no line and counts as unreported', () => {
		const { r } = started(
			{},
			reset(),
			w('a', [{ url: NIXOS }]),
			E.worker('old', { version: '' }),
			w('none', [{ url: FARM }])
		);
		const v = r.views(T0, 15);
		expect(v.edges.has('substitute:a')).toBe(true);
		expect(v.edges.has('substitute:old')).toBe(false);
		// Lists only the farm cache: no upstream, no line.
		expect(v.edges.has('substitute:none')).toBe(false);
		expect(v.upstream).toMatchObject({ builders: 1, unreported: 1 });
	});

	it('substitute edges exist only for upstream builders, and pool lines add theirs up', () => {
		const { r, s } = started(
			{},
			reset(),
			w('a', [{ url: NIXOS }]),
			w('b', [{ url: NIXOS }]),
			w('c', []),
			w('arm', [{ url: NIXOS }], { systems: ['aarch64-linux'] })
		);
		const t = T0 + 1000;
		r.apply(
			s.next(w('a', [{ url: NIXOS, nar: 10 * MiB }]), w('b', [{ url: NIXOS, nar: 30 * MiB }])),
			t
		);
		const v = r.views(t, 15);
		const ids = [...v.edges.keys()].filter((k) => k.startsWith('substitute:')).sort();
		expect(ids).toEqual([
			'substitute:a',
			'substitute:arm',
			'substitute:b',
			'substitute:pool:aarch64-linux',
			'substitute:pool:x86_64-linux'
		]);
		const pool = v.edges.get('substitute:pool:x86_64-linux')!.rate;
		const sum = v.edges.get('substitute:a')!.rate + v.edges.get('substitute:b')!.rate;
		// Rates keep three digits.
		expect(pool / sum).toBeCloseTo(1, 2);
		const d = r.edgeDetail(['substitute:pool:x86_64-linux'], t, 15)!;
		expect(d.rows.map((x) => x.edgeId)).toEqual(['substitute:b', 'substitute:a']);
		expect(d.total).toBe(40 * MiB);
	});

	it('counts builders per URL, and takes window totals from the history for each window', () => {
		const at = (min: number, nar: number, paths = 0) =>
			create(CounterSampleSchema, {
				timeMs: BigInt(T0 - min * 60_000),
				counters: create(CountersSchema, {
					substituters: [
						sub({ url: NIXOS, nar, download: nar / 2, paths }),
						sub({ url: FARM, nar })
					]
				})
			});
		// One sample a minute for the last 70 minutes: 1 MiB a minute from cache.nixos.org.
		const history = Array.from({ length: 70 }, (_, i) => at(70 - i, (i + 1) * MiB, i + 1));
		const { r, s } = started(
			{},
			reset({ history }),
			w('a', [{ url: FARM }, { url: NIXOS }, { url: COMMUNITY }]),
			w('b', [{ url: NIXOS }]),
			w('c', [{ url: COMMUNITY }], { up: false })
		);
		r.apply(
			s.next(
				E.stats({
					substituters: [
						sub({ url: NIXOS, nar: 71 * MiB, download: (71 * MiB) / 2, paths: 71 }),
						sub({ url: FARM, nar: 71 * MiB })
					]
				})
			),
			T0
		);
		for (const minutes of [5, 15, 30, 60]) {
			const u = r.views(T0, minutes).upstream!;
			const nixos = u.substituters.find((x) => x.url === NIXOS)!;
			expect(nixos.narBytes, `${minutes}m`).toBe(minutes * MiB);
			expect(nixos.downloadBytes).toBe((minutes * MiB) / 2);
			expect(nixos.paths).toBe(minutes);
			expect(u.narBytes).toBe(minutes * MiB);
			expect(u.since).toBeNull();
			// The busiest first, then by builders.
			expect(u.substituters.map((x) => [x.url, x.builders])).toEqual([
				[NIXOS, 2],
				[COMMUNITY, 1]
			]);
			expect(u.farmCache).toMatchObject({ narBytes: minutes * MiB });
		}
		// A window before the history: counted from where the data starts.
		const young = started(
			{},
			reset({ history: [at(3, MiB)], servingSinceMs: BigInt(T0 - 4 * 60_000) }),
			w('a', [{ url: NIXOS }])
		).r;
		expect(young.views(T0, 15).upstream!.since).not.toBeNull();
	});

	it('the card rates come from Stats, after the first one', () => {
		const { r, s } = started({}, reset(), w('a', [{ url: NIXOS }]));
		const stats = (nar: number) =>
			E.stats({ substituters: [sub({ url: NIXOS, nar }), sub({ url: FARM, nar: nar * 3 })] });
		r.apply(s.next(stats(500 * MiB)), T0 + 1000);
		expect(r.views(T0 + 1000, 15).upstream!.narBytesPerSec).toBe(0);
		r.apply(s.next(stats(510 * MiB)), T0 + 2000);
		const u = r.views(T0 + 2000, 15).upstream!;
		expect(u.narBytesPerSec).toBeGreaterThan(0);
		expect(u.substituters[0].narBytesPerSec).toBe(u.narBytesPerSec);
		expect(u.farmCache).toBeNull();
	});

	it('substitutersOf lists the configured URLs first, then others it used', () => {
		const { r, s } = started(
			{},
			reset(),
			w('a', [{ url: FARM }, { url: COMMUNITY }, { url: NIXOS }])
		);
		r.apply(
			s.next(
				w('a', [
					{ url: FARM, nar: 5 },
					{ url: COMMUNITY },
					{ url: NIXOS, nar: 3 * MiB, paths: 2, failures: 1 },
					{ url: 'https://zzz.example', nar: 7 }
				])
			),
			T0 + 1000
		);
		const list = r.substitutersOf('a', T0 + 1000);
		expect(list.map((x) => x.url)).toEqual([COMMUNITY, NIXOS, 'https://zzz.example']);
		expect(list[1]).toMatchObject({ narBytes: 3 * MiB, paths: 2, failures: 1 });
		expect(list[1].narBytesPerSec).toBeGreaterThan(0);
		expect(list[0].narBytesPerSec).toBe(0);
		expect(r.substitutersOf('nobody', T0)).toEqual([]);
	});

	it('edgeDetail on a substitute bundle has a row per builder, no items, and is measured', () => {
		const { r, s } = started({}, reset(), w('a', [{ url: NIXOS }]), w('b', [{ url: NIXOS }]));
		r.apply(
			s.next(
				E.drv(A1, { phase: Phase.ASSIGNED, cause: Cause.ASSIGNED, workerAddr: 'a' }),
				w('a', [{ url: NIXOS, nar: 3 * MiB }])
			),
			T0 + 1000
		);
		const d = r.edgeDetail(['substitute:a', 'substitute:b'], T0 + 1000, 15)!;
		expect(d).toMatchObject({ flow: 'substitute', unit: 'bytes', estimate: false, count: 2 });
		expect(d.rows).toHaveLength(2);
		expect(d.items).toEqual([]);
		expect(d.series.failed).toBeNull();
	});

	it('a WorkerView keeps its identity when only substituter counts change', () => {
		const { r, s } = started({}, reset(), w('a', [{ url: NIXOS }]));
		const before = r.views(T0, 15).workers.get('a')!;
		r.apply(s.next(w('a', [{ url: NIXOS, nar: 9 * MiB, paths: 3 }])), T0 + 1000);
		const after = r.views(T0 + 1000, 15).workers.get('a')!;
		expect(after.substituters).toBe(before.substituters);
		expect(after).toEqual(before);
	});
});

describe('build progress', () => {
	const assigned = (init: Record<string, unknown> = {}) =>
		E.drv(A1, {
			phase: Phase.ASSIGNED,
			clientIds: [1n, 2n],
			workerAddr: A,
			assignId: 7n,
			queuedMs: BigInt(T0 - 90_000),
			assignedMs: BigInt(T0 - 20_000),
			...init
		});

	it('a progress update sets phase, phase start and start and counts nothing', () => {
		const { r, s } = farm();
		const before = r.views(T0 + 1000, 15);
		const recent = r.counts().recent;
		const edge = r.edgeDetail([`assign:${A}`], T0 + 1000, 15);
		r.apply(
			s.next(
				assigned({
					cause: Cause.PROGRESS,
					buildPhase: 'buildPhase',
					buildStartedMs: BigInt(T0 - 18_000),
					buildPhaseStartedMs: BigInt(T0 - 5_000)
				})
			),
			T0 + 1000
		);
		expect(r.drv(A1)).toMatchObject({
			phase: 'assigned',
			buildPhase: 'buildPhase',
			buildStartedMs: T0 - 18_000,
			buildPhaseStartedMs: T0 - 5_000,
			assignId: 7
		});
		const after = r.views(T0 + 1000, 15);
		expect(after.totals).toEqual(before.totals);
		expect(after.edges).toEqual(before.edges);
		expect(after.workers.get(A)).toEqual(before.workers.get(A));
		expect(r.counts().recent).toBe(recent);
		// The line's history and counts stay; only its items' views show the phase.
		const { items: itemsAfter, ...lineAfter } = r.edgeDetail([`assign:${A}`], T0 + 1000, 15)!;
		const { items: itemsBefore, ...lineBefore } = edge!;
		expect(lineAfter).toEqual(lineBefore);
		expect(itemsAfter.map((i) => i.drv.drvPath)).toEqual(itemsBefore.map((i) => i.drv.drvPath));
	});

	it('an assignment clears the phase', () => {
		const { r, s } = farm();
		r.apply(
			s.next(
				assigned({
					cause: Cause.PROGRESS,
					buildPhase: 'checkPhase',
					buildStartedMs: BigInt(T0 - 18_000),
					buildPhaseStartedMs: BigInt(T0 - 5_000)
				}),
				E.drv(A1, { cause: Cause.REQUEUED, clientIds: [1n], reason: 'given back' }),
				assigned({ cause: Cause.ASSIGNED, workerAddr: B, assignId: 8n })
			),
			T0 + 1000
		);
		expect(r.drv(A1)).toMatchObject({
			workerAddr: B,
			assignId: 8,
			buildPhase: null,
			buildStartedMs: null,
			buildPhaseStartedMs: null
		});
	});

	it('a builder counts as reporting starts after its first build_started_ms', () => {
		const { r, s } = farm();
		expect(r.drv(A1)?.reportsStarts).toBe(false);
		r.apply(
			s.next(assigned({ cause: Cause.PROGRESS, buildStartedMs: BigInt(T0 - 1000) })),
			T0 + 1000
		);
		expect(r.drv(A1)).toMatchObject({ reportsStarts: true, buildPhase: null });
		// Another build on that builder, not started yet: "Waiting to start" now holds.
		r.apply(
			s.next(
				E.drv(N1, { cause: Cause.WANTED, clientIds: [1n] }),
				E.drv(N1, { cause: Cause.ASSIGNED, phase: Phase.ASSIGNED, clientIds: [1n], workerAddr: A })
			),
			T0 + 2000
		);
		expect(r.drv(N1)).toMatchObject({ reportsStarts: true, buildStartedMs: null });
	});

	it('a reset forgets which builders report starts', () => {
		const { r, s } = farm();
		r.apply(
			s.next(assigned({ cause: Cause.PROGRESS, buildStartedMs: BigInt(T0 - 1000) })),
			T0 + 1000
		);
		expect(r.drv(A1)?.reportsStarts).toBe(true);
		r.beginStream();
		r.apply(
			s.snapshot(
				E.reset({ instance: 'inst-b' }),
				E.worker(A, { maxJobs: 4 }),
				E.client(1, 'ci-runner-1'),
				assigned({ clientIds: [1n] })
			),
			T0 + 2000
		);
		expect(r.drv(A1)?.reportsStarts).toBe(false);
	});

	it('a snapshot carries the phase', () => {
		const { r } = started(
			{},
			E.reset(),
			E.worker(A),
			E.client(1, 'ci-runner-1'),
			assigned({
				clientIds: [1n],
				buildPhase: 'configurePhase',
				buildStartedMs: BigInt(T0 - 10_000),
				buildPhaseStartedMs: BigInt(T0 - 2_000)
			})
		);
		expect(r.drv(A1)).toMatchObject({ buildPhase: 'configurePhase', reportsStarts: true });
	});
});

describe('builds', () => {
	/** A build of `path` on A: assigned, then gone with `outcome`. */
	const run = (path: string, id: number, outcome: Outcome, error = '') => [
		E.drv(path, { cause: Cause.WANTED, clientIds: [1n] }),
		E.drv(path, {
			cause: Cause.ASSIGNED,
			phase: Phase.ASSIGNED,
			clientIds: [1n],
			workerAddr: A,
			assignId: BigInt(id),
			assignedMs: BigInt(T0)
		}),
		E.gone(path, outcome, {
			workerAddr: A,
			status: outcome === Outcome.FAILED ? Status.PERMANENT_FAILURE : Status.BUILT,
			error
		})
	];
	const message = (line: string) =>
		`error: Cannot build '/nix/store/x.drv'.\n       Reason: builder failed with exit code 2.\n       Last 1 log lines:\n       > ${line}`;
	const finished = (
		path: string,
		id: number,
		outcome: Outcome,
		over: Record<string, unknown> = {}
	) =>
		create(FinishedBuildSchema, {
			drvPath: path,
			system: 'x86_64-linux',
			workerAddr: A,
			outcome,
			assignId: BigInt(id),
			assignedMs: BigInt(T0 - 600_000),
			finishedMs: BigInt(T0 - 500_000),
			...over
		});
	const rows = (r: FarmReducer) => r.builds(ANY_QUERY, T0 + 10_000).rows;

	it('the builds ring keeps 10,000 and failures 2,000 apart from #recent', () => {
		const { r, s } = farm();
		const events: Ev[] = [];
		// 3,000 failures, then 9,000 builds that work.
		for (let i = 0; i < 12_000; i++)
			events.push(...run(drvPath(`b${i}`), i + 100, i < 3000 ? Outcome.FAILED : Outcome.BUILT));
		r.apply(s.next(...events), T0 + 1000);
		const finishedRows = rows(r).filter((x) => x.state !== 'assigned');
		// The builds ring holds the newest 10,000: 1,000 failures and 9,000 built.
		// The failures ring holds the newest 2,000 failures, so 1,000 more.
		expect(finishedRows.filter((x) => x.state === 'built')).toHaveLength(9000);
		const failed = finishedRows.filter((x) => x.state === 'failed').map((x) => x.name);
		expect(failed).toHaveLength(2000);
		expect(failed).toContain('b1000');
		expect(failed).not.toContain('b999');
	});

	it('cache hits never enter the rings', () => {
		const { r, s } = farm();
		r.apply(s.next(E.cached(C1, 2), E.cached(drvPath('c2'), 1)), T0 + 1000);
		expect(rows(r).filter((x) => x.state !== 'assigned')).toEqual([]);
	});

	it('history rows merge by path and assign id and live rows win', () => {
		const { r, s } = farm();
		r.apply(s.next(...run(N1, 9, Outcome.BUILT)), T0 + 1000);
		r.mergeHistory(
			create(RecentBuildsBatchSchema, {
				builds: [
					finished(N1, 9, Outcome.FAILED),
					finished(N1, 8, Outcome.FAILED),
					finished(drvPath('older'), 3, Outcome.BUILT)
				],
				complete: true
			}),
			false
		);
		const finishedRows = rows(r).filter((x) => x.state !== 'assigned');
		// Failures first, then by finish, newest first.
		expect(finishedRows.map((x) => [x.name, x.assignId, x.state, x.from])).toEqual([
			['hello-2.12', 8, 'failed', 'history'],
			['hello-2.12', 9, 'built', 'live'],
			['older', 3, 'built', 'history']
		]);
		expect(r.history.complete).toBe(true);
		// A second answer adds nothing twice.
		r.mergeHistory(
			create(RecentBuildsBatchSchema, { builds: [finished(N1, 8, Outcome.FAILED)] }),
			true
		);
		expect(rows(r).filter((x) => x.state !== 'assigned')).toHaveLength(3);
	});

	it('a new instance clears the rings, a reconnect keeps them', () => {
		const { r, s } = farm();
		r.apply(s.next(...run(N1, 9, Outcome.BUILT)), T0 + 1000);
		expect(r.startHistory()).toBe(true);
		const reconnect = (instance: string) => {
			r.beginStream();
			r.apply(
				s.snapshot(E.reset({ instance }), E.worker(A), E.client(1, 'ci-runner-1')),
				T0 + 2000
			);
		};
		reconnect('inst-a');
		expect(rows(r).map((x) => x.name)).toEqual(['hello-2.12']);
		expect(r.startHistory()).toBe(false);
		reconnect('inst-b');
		expect(rows(r)).toEqual([]);
		expect(r.startHistory()).toBe(true);
		expect(r.builds(ANY_QUERY, T0 + 3000).coverage.restartMs).not.toBeNull();
	});

	it('a failed row keeps its error line, not the text', () => {
		const { r, s } = farm();
		const text = message("main.c:41:5: error: implicit declaration of function 'strlcpy'");
		r.apply(s.next(...run(N1, 9, Outcome.FAILED, text)), T0 + 1000);
		const [row] = rows(r).filter((x) => x.state === 'failed');
		expect(row.errorLine).toBe("main.c:41:5: error: implicit declaration of function 'strlcpy'");
		expect(Object.values(row)).not.toContain(text);
		// The derivation panel still has the text, from #errors.
		expect(r.drv(N1)?.errorText).toContain('Cannot build');
	});

	it('history text never enters #errors', () => {
		const { r } = farm();
		r.mergeHistory(
			create(RecentBuildsBatchSchema, {
				builds: [finished(N1, 4, Outcome.FAILED, { error: message('FAIL: tests/foo-3') })]
			}),
			true
		);
		const [row] = rows(r);
		expect(row.errorLine).toBe('FAIL: tests/foo-3');
		expect(r.drv(N1)).toBeUndefined();
		expect(r.errorTextOf(N1)).toBeNull();
	});

	it('full is set when a merge drops what it added', () => {
		const { r, s } = farm();
		const events: Ev[] = [];
		for (let i = 0; i < 2000; i++) events.push(...run(drvPath(`f${i}`), i + 1, Outcome.FAILED));
		r.apply(s.next(...events), T0 + 1000);
		expect(r.history.full).toBe(false);
		// Older failures than every one the page holds: the ring drops them at once.
		r.mergeHistory(
			create(RecentBuildsBatchSchema, {
				builds: Array.from({ length: 10 }, (_, i) =>
					finished(drvPath(`old${i}`), 90_000 + i, Outcome.FAILED, {
						finishedMs: BigInt(T0 - 900_000 - i)
					})
				)
			}),
			true
		);
		expect(r.history.full).toBe(true);
	});
});
