// Builders for WatchEvents and reducers in tests.

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import {
	ClientGoneSchema,
	ClientStateSchema,
	CountersSchema,
	DrvCachedSchema,
	DrvGoneSchema,
	DrvGone_Outcome,
	DrvStateSchema,
	ResetSchema,
	SnapshotDoneSchema,
	StatsSchema,
	SystemStatsSchema,
	WatchEventSchema,
	WorkerStateSchema,
	type WatchEvent
} from '#lib/gen/events_pb.ts';
import type { SourceSink } from '#lib/source/types.ts';
import { FarmReducer, type ApplyResult, type ReducerOptions } from './reducer.ts';
import type { ConnectionStatus } from './types.ts';

export type Ev = WatchEvent['event'];

export const T0 = 1_800_000_000_000;

/** A stable fake store path: 32 hash characters derived from the name. */
export function drvPath(name: string): string {
	const abc = '0123456789abcdfghijklmnpqrsvwxyz';
	let h = 2166136261;
	let hash = '';
	for (let i = 0; i < 32; i++) {
		for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
		h = Math.imul(h ^ i, 16777619) >>> 0;
		hash += abc[h % 32];
	}
	return `${hash}-${name}.drv`;
}

export const E = {
	reset: (init: MessageInitShape<typeof ResetSchema> = {}): Ev => ({
		case: 'reset',
		value: create(ResetSchema, {
			instance: 'inst-a',
			version: '1.2.3',
			defaultSystem: 'x86_64-linux',
			cacheUrl: 'https://cache.test',
			servingSinceMs: BigInt(T0 - 7_200_000),
			...init
		})
	}),
	done: (): Ev => ({ case: 'snapshotDone', value: create(SnapshotDoneSchema) }),
	worker: (addr: string, init: MessageInitShape<typeof WorkerStateSchema> = {}): Ev => ({
		case: 'worker',
		value: create(WorkerStateSchema, {
			addr,
			systems: ['x86_64-linux'],
			maxJobs: 4,
			up: true,
			...init
		})
	}),
	client: (id: number, identity: string): Ev => ({
		case: 'client',
		value: create(ClientStateSchema, { id: BigInt(id), identity, connectedMs: BigInt(T0) })
	}),
	clientGone: (id: number): Ev => ({
		case: 'clientGone',
		value: create(ClientGoneSchema, { id: BigInt(id) })
	}),
	drv: (path: string, init: MessageInitShape<typeof DrvStateSchema> = {}): Ev => ({
		case: 'drv',
		value: create(DrvStateSchema, { drvPath: path, system: 'x86_64-linux', ...init })
	}),
	gone: (
		path: string,
		outcome: DrvGone_Outcome,
		init: MessageInitShape<typeof DrvGoneSchema> = {}
	): Ev => ({
		case: 'drvGone',
		value: create(DrvGoneSchema, { drvPath: path, outcome, ...init })
	}),
	cached: (path: string, clientId: number, system = 'x86_64-linux'): Ev => ({
		case: 'cached',
		value: create(DrvCachedSchema, { drvPath: path, system, clientId: BigInt(clientId) })
	}),
	stats: (
		totals: MessageInitShape<typeof CountersSchema> = {},
		systems: MessageInitShape<typeof SystemStatsSchema>[] = []
	): Ev => ({
		case: 'stats',
		value: create(StatsSchema, {
			totals: create(CountersSchema, totals),
			systems: systems.map((s) => create(SystemStatsSchema, s))
		})
	})
};

/** Hands out seq numbers the way a scheduler does. */
export class Stream {
	constructor(
		public seq = 41n,
		public timeMs = T0
	) {}

	/** Reset, the body and SnapshotDone, all carrying the current seq. */
	snapshot(reset: Ev, ...body: Ev[]): WatchEvent[] {
		return [reset, ...body, E.done()].map((event) => this.#ev(this.seq, event));
	}

	/** Deltas, each one seq higher than the one before. */
	next(...events: Ev[]): WatchEvent[] {
		return events.map((event) => this.#ev(++this.seq, event));
	}

	/** An event with an explicit seq, for gap tests. */
	raw(seq: bigint, event: Ev): WatchEvent {
		return this.#ev(seq, event);
	}

	#ev(seq: bigint, event: Ev): WatchEvent {
		return create(WatchEventSchema, { seq, timeMs: BigInt(this.timeMs), event });
	}
}

/** A new reducer after a complete snapshot of `reset` and `body` at T0. */
export function started(options: ReducerOptions, reset: Ev, ...body: Ev[]) {
	const r = new FarmReducer(options);
	const s = new Stream();
	r.beginStream();
	const res = r.apply(s.snapshot(reset, ...body), T0);
	return { r, s, res };
}

/** A sink that applies batches to `r` at Date.now(), with optional hooks. */
export function reducerSink(
	r: FarmReducer,
	hooks: {
		status?: (s: ConnectionStatus) => void;
		applied?: (batch: readonly WatchEvent[], res: ApplyResult) => void;
	} = {}
): SourceSink {
	return {
		beginStream: () => r.beginStream(),
		events: (batch) => {
			const res = r.apply(batch, Date.now());
			hooks.applied?.(batch, res);
			return res;
		},
		status: (s) => hooks.status?.(s)
	};
}

export { DrvGone_Outcome };
