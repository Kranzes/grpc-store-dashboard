// A small FarmStore for panel tests, rendered on the server. Every query
// answers from the fields given, and the store records calls.

import { emptyMap } from '#lib/model/reconcile.ts';
import type {
	DrvView,
	EdgeDetailView,
	FarmStore,
	SchedulerView,
	Topology
} from '#lib/model/types.ts';

export type FakeStore = FarmStore & { calls: string[] };

const SCHEDULER: SchedulerView = {
	queued: 0,
	unplaceable: 0,
	assigned: 0,
	workersUp: 0,
	clients: 0,
	slots: 0,
	free: 0,
	assignedPerSec: 0,
	queuedPerMin: null,
	systems: []
};

const TOPOLOGY: Topology = {
	version: 1,
	clientGroups: [],
	workers: [],
	workerSystems: [],
	retired: [],
	hasCache: true,
	upstreamWorkers: [],
	upstreamRows: 0
};

export function drvView(name: string, over: Partial<DrvView> = {}): DrvView {
	return {
		drvPath: `/nix/store/${'a'.repeat(32)}-${name}.drv`,
		name,
		phase: 'assigned',
		system: 'x86_64-linux',
		features: [],
		workerAddr: null,
		clientIds: [],
		identities: [],
		queuedMs: null,
		assignedMs: null,
		finishedMs: null,
		finishedServerMs: null,
		cpHintMs: 0,
		inputs: 0,
		inputSources: [],
		inputsUnknown: 0,
		fetchedBytes: 0,
		cacheChecked: false,
		outputs: [],
		outputBytes: 0,
		reason: null,
		status: null,
		errorSent: false,
		errorText: null,
		assignId: 0,
		buildPhase: null,
		buildPhaseStartedMs: null,
		buildStartedMs: null,
		reportsStarts: false,
		...over
	};
}

export function fakeStore(
	over: Partial<Omit<FarmStore, 'edgeDetail' | 'drv'>> & {
		detail?: EdgeDetailView;
		drvs?: readonly DrvView[];
	} = {}
): FakeStore {
	const calls: string[] = [];
	const { detail, drvs = [], ...fields } = over;
	return {
		status: { kind: 'live', sinceMs: 0 },
		meta: null,
		topology: TOPOLOGY,
		workers: emptyMap(),
		clientGroups: emptyMap(),
		scheduler: SCHEDULER,
		cache: null,
		pools: emptyMap(),
		edges: emptyMap(),
		totals: {
			windowMinutes: 15,
			queued: 0,
			running: 0,
			built: 0,
			failed: 0,
			cached: 0,
			since: null
		},
		linesSince: null,
		frame: 1,
		setWindowMinutes: () => {},
		drv: (path, via) => {
			calls.push(`drv ${path} ${via ?? '-'}`);
			return drvs.find((d) => d.drvPath === path);
		},
		edgeDetail: (ids, limit) => {
			calls.push(`edgeDetail ${ids.join(',')} ${limit ?? '-'}`);
			return detail;
		},
		drvsForWorker: () => [],
		drvsForClientGroup: () => [],
		clientGroup: () => undefined,
		drvsQueued: () => [],
		drvsForCache: () => [],
		upstream: null,
		substitutersOf: () => [],
		builds: () => ({
			rows: [],
			counts: { failed: 0, assigned: 0, built: 0, other: 0 },
			facets: { systems: [], builders: [], clients: [] },
			coverage: {
				sinceMs: null,
				source: 'page',
				complete: false,
				full: false,
				loading: false,
				restartMs: null
			}
		}),
		build: () => undefined,
		ensureHistory: () => {},
		loadOlderBuilds: () => {},
		finishedBuild: async () => null,
		browserMs: (ms) => ms,
		...fields,
		calls
	};
}
