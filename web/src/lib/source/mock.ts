// In-browser farm simulator. It emits the same WatchEvents a scheduler
// would, following every rule in proto/events.proto: Reset with history,
// a snapshot, contiguous seq, Stats every second, and the scheduler's own
// rules for placeability, followers, requeues and orphans.
//
// The simulation is a discrete-event loop on a seeded PRNG, so a seed and
// the same sequence of advance() times always give the same events.

import { create } from '@bufbuild/protobuf';
import {
	ClientGoneSchema,
	ClientStateSchema,
	CounterSampleSchema,
	DrvCachedSchema,
	DrvGoneSchema,
	DrvGone_Outcome,
	DrvGone_Status,
	DrvStateSchema,
	DrvState_Cause,
	DrvState_Phase,
	FinishedBuildSchema,
	RecentBuildsBatchSchema,
	InputSourceSchema,
	OutputSchema,
	ResetSchema,
	SnapshotDoneSchema,
	StatsSchema,
	SystemStatsSchema,
	WatchEventSchema,
	SubstituterTrafficSchema,
	WorkerStateSchema,
	WorkerState_DrainReason,
	type DrvState,
	type FinishedBuild,
	type InputSource,
	type RecentBuildsBatch,
	type WatchEvent
} from '#lib/gen/events_pb.ts';
import {
	COUNTER_KEYS,
	ZERO_COUNTERS,
	countersToProto,
	offers,
	priority,
	substitutersToProto,
	type CounterSample,
	type CounterValues,
	type SubstituterCounts
} from '#lib/model/sched.ts';
import { drvName } from '#lib/model/types.ts';
import {
	hash32,
	NIX_BASE32,
	normal,
	phaseAt,
	planLog,
	tail,
	type LogEnding,
	type LogPlan
} from './mock-log.ts';
import type { LogBackend, RecentBuildsRequest, Source, SourceSink } from './types.ts';

/** Real NixOS test logs the `nixoslog` option can show, from nixos-logs.ts. */
export const NIXOS_LOGS = ['openbao', 'nat', 'openssh'] as const;
export type NixosLog = (typeof NIXOS_LOGS)[number];

export type MockOptions = Readonly<{
	/** Number of builders. */
	builders: number;
	/** Native systems. */
	systems: readonly string[];
	/** Each system's share of the builders, in the order of `systems`. */
	shares: readonly number[];
	/** Target number of derivations queued or assigned. */
	inFlight: number;
	/** Target events per second at speed 1. Sets the mean build time. */
	rate: number;
	/** Simulation speed: durations are divided by it. */
	speed: number;
	seed: number;
	/** Skip one seq every this many seconds, to exercise reconnects. 0 means never. */
	gapEvery: number;
	/** Whether the scheduler has a binary cache. */
	cache: boolean;
	/**
	 * Cloud builders that join or leave per minute at speed 1, like an
	 * autoscaler that follows the queue. Owned machines stay. While it is on,
	 * spot instances also get interrupted. 0 means a fixed farm.
	 */
	churn: number;
	/** Share of builds that fail on ordinary builders, 0 to 1. */
	fail: number;
	/** The first this many builders the farm creates fail 80% of their builds. */
	failing: number;
	/**
	 * Minutes the scheduler has served when the page opens, so the header's
	 * window can still be filling. 0 means three to four hours.
	 */
	uptime: number;
	/**
	 * The last this many builders the farm creates start low on disk and
	 * drain, then recover after 5 minutes at speed 1.
	 */
	lowdisk: number;
	/**
	 * Upstream substituters, 0 to 3: cache.nixos.org on every builder, then
	 * nix-community.cachix.org on Linux builders, then the lab's own cache on
	 * owned metal. 0 means builders list none, and the map has no upstream card.
	 */
	upstream: number;
	/** Builders serve build logs. false: the Logs tab says the farm serves none. */
	logs: boolean;
	/** Scales the length of every build log, 0.01 to 100. */
	logsize: number;
	/**
	 * A real log every NixOS test build shows instead of its own. Only dev
	 * and test builds have the logs; a production build's worker ignores it.
	 */
	nixoslog: NixosLog | null;
	/** Finished builds from before the page opened, in the scheduler's rings, 0 to 2000. */
	history: number;
	/** Builders report each running build's start and phase. false: as builders without that report. */
	progress: boolean;
}>;

export const DEFAULT_SYSTEMS = Object.freeze(['x86_64-linux', 'aarch64-linux']);

/** Without counts, the first system gets 2 shares and each other system 1. */
const defaultShare = (k: number) => (k === 0 ? 2 : 1);

export function mockOptions(overrides: Partial<MockOptions> = {}): MockOptions {
	const builders = clampInt(overrides.builders ?? 12, 1, 1000);
	const systems = overrides.systems?.length ? [...overrides.systems] : [...DEFAULT_SYSTEMS];
	const shares =
		overrides.shares?.length === systems.length &&
		overrides.shares.every((n) => Number.isInteger(n) && n > 0)
			? [...overrides.shares]
			: systems.map((_, k) => defaultShare(k));
	return Object.freeze({
		builders,
		systems,
		shares,
		inFlight: clampInt(overrides.inFlight ?? builders * 64, 0, 50_000),
		rate: clampNum(overrides.rate ?? builders * 4.5, 1, 10_000),
		speed: clampNum(overrides.speed ?? 1, 0.05, 50),
		seed: Math.trunc(overrides.seed ?? 1) >>> 0,
		gapEvery: clampNum(overrides.gapEvery ?? 0, 0, 86_400),
		cache: overrides.cache ?? true,
		churn: clampNum(overrides.churn ?? 0, 0, 600),
		fail: clampNum(overrides.fail ?? 0.05, 0, 1),
		failing: clampInt(overrides.failing ?? 0, 0, 1000),
		uptime: clampNum(overrides.uptime ?? 0, 0, 1440),
		lowdisk: clampInt(overrides.lowdisk ?? 0, 0, 1000),
		upstream: clampInt(overrides.upstream ?? 3, 0, 3),
		logs: overrides.logs ?? true,
		logsize: clampNum(overrides.logsize ?? 1, 0.01, 100),
		nixoslog: overrides.nixoslog ?? null,
		history: clampInt(overrides.history ?? 300, 0, 2000),
		progress: overrides.progress ?? true
	});
}

/**
 * Options from a query string such as location.search: builders, systems
 * (comma-separated, each optionally name:count), inflight, rate, speed,
 * seed, gaps (seconds), cache (0 or 1), churn (builders per minute), fail
 * (share, 0 to 1), failing (a number of builders), uptime (minutes), lowdisk (a number
 * of builders), upstream (0 to 3 substituters), logs (0 or 1), logsize (0.01 to 100),
 * nixoslog (openbao, nat or openssh, in dev and test builds only), history
 * (0 to 2000 builds) and progress (0 or 1). Unknown or malformed
 * values fall back to the defaults, and a malformed system entry is dropped.
 */
export function parseMockOptions(query: string | URLSearchParams): MockOptions {
	const params = new URLSearchParams(query);
	const num = (k: string) => {
		const v = params.get(k);
		if (v === null || v.trim() === '') return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	// name or name:count. A count is that system's share of the builders.
	// When every system has one, the counts are the builder counts.
	const entries = (params.get('systems') ?? '')
		.split(',')
		.map((s) => /^([\w.-]+)(?::(\d+))?$/.exec(s.trim()))
		.filter((m) => m !== null && (m[2] === undefined || Number(m[2]) > 0))
		.map((m) => ({ system: m![1], count: m![2] === undefined ? undefined : Number(m![2]) }));
	const counted = entries.filter((e) => e.count !== undefined).length;
	const shares = entries.map((e, k) => e.count ?? defaultShare(k));
	const cache = params.get('cache');
	const flag = (k: string) => {
		const v = params.get(k);
		return v === null ? undefined : !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
	};
	return mockOptions({
		builders:
			num('builders') ??
			(entries.length && counted === entries.length
				? shares.reduce((a, b) => a + b, 0)
				: undefined),
		systems: entries.length ? entries.map((e) => e.system) : undefined,
		shares: counted ? shares : undefined,
		inFlight: num('inflight'),
		rate: num('rate'),
		speed: num('speed'),
		seed: num('seed'),
		gapEvery: num('gaps'),
		cache: cache === null ? undefined : flag('cache'),
		churn: num('churn'),
		fail: num('fail'),
		failing: num('failing'),
		uptime: num('uptime'),
		lowdisk: num('lowdisk'),
		upstream: num('upstream'),
		logs: flag('logs'),
		logsize: num('logsize'),
		nixoslog: NIXOS_LOGS.find((n) => n === params.get('nixoslog')),
		history: num('history'),
		progress: flag('progress')
	});
}

/** 10.0.<system>.<n> for hosts below 256, the first 246 builders, then the next /16 up. */
function hostAddr(system: number, n: number): string {
	return `10.${(n >> 8) & 255}.${system}.${n & 255}:50051`;
}

/**
 * The kinds of builder in the demo's hybrid farm. Cloud instances register
 * by their private address and the autoscaler adds and retires them; spot
 * ones can also be interrupted. Machines the farm owns have host names and
 * stay. A cloud `kvm` builder is an x86_64 instance with nested
 * virtualization or metal, or a Graviton metal instance.
 */
type Machine = 'vm' | 'vm-spot' | 'kvm' | 'kvm-spot' | 'metal' | 'quiet' | 'own';

/** Nix's default system features, as a machine without KVM reports them. */
const NIX_DEFAULTS = ['benchmark', 'big-parallel', 'nixos-test'] as const;
/** Nix's defaults on a machine with /dev/kvm. */
const NIX_KVM = ['benchmark', 'big-parallel', 'kvm', 'nixos-test'] as const;

const MACHINES: Readonly<
	Record<Machine, { cloud: boolean; spot: boolean; features: readonly string[] }>
> = {
	// Cloud VMs without KVM, on demand or spot: x86_64 instances and Graviton.
	vm: { cloud: true, spot: false, features: NIX_DEFAULTS },
	'vm-spot': { cloud: true, spot: true, features: NIX_DEFAULTS },
	// Cloud instances with KVM, on demand or spot.
	kvm: { cloud: true, spot: false, features: NIX_KVM },
	'kvm-spot': { cloud: true, spot: true, features: NIX_KVM },
	// Own Linux metal, busy with builds, so it leaves benchmark to the quiet machine.
	metal: { cloud: false, spot: false, features: ['big-parallel', 'kvm', 'nixos-test'] },
	// The one quiet x86_64-linux machine, for benchmarks.
	quiet: { cloud: false, spot: false, features: ['benchmark', 'kvm', 'nixos-test'] },
	// Other systems, such as Macs: Nix's defaults.
	own: { cloud: false, spot: false, features: NIX_DEFAULTS }
};

const GiB = 1024 ** 3;
/** Every demo builder runs with --min-free 10G. */
const MIN_FREE = 10 * GiB;
/** Free disk of a builder that the lowdisk option starts low on disk. */
const LOW_DISK_FREE = 3.1 * GiB;
/** How long those builders stay low on disk, ms at speed 1. */
const LOW_DISK_MS = 300_000;
/** A builder reports free disk at most this often, and only after a step. */
const REPORT_MS = 2_000;

/** The farm's own cache, as builders list it among their substituters. */
const FARM_CACHE = 'https://cache.farm.example';

/** Upstream substituters in the order builders list them, and how often each serves a path. */
const UPSTREAM: readonly { url: string; weight: number; on: (w: Worker) => boolean }[] = [
	{ url: 'https://cache.nixos.org', weight: 0.75, on: () => true },
	{
		url: 'https://nix-community.cachix.org',
		weight: 0.2,
		on: (w) => w.systems[0].endsWith('-linux')
	},
	// The lab's cache, next to its own machines.
	{ url: 'https://cache.lab.example', weight: 0.05, on: (w) => !w.cloud && w.machine !== 'own' }
];

/**
 * How often an input nobody here built is missing on the builder, a missing
 * input's NAR in median bytes, and the share of it that crosses the wire.
 */
const MISSING = 0.03;
const INPUT_NAR = 6e6;
const WIRE_SHARE = 0.35;

type Traffic = { nar: number; download: number; paths: number; failures: number };

/** The store's disk: 200 GiB on cloud VMs, 500 GiB on Macs, 1000 GiB on own metal. */
function diskSize(machine: Machine, system: string): number {
	if (MACHINES[machine].cloud) return 200 * GiB;
	return (system.endsWith('-darwin') ? 500 : 1000) * GiB;
}

/** Mean time between interruptions of one spot builder, ms at speed 1. */
const SPOT_MEAN_MS = 50 * 60_000;
/** The warning before a spot builder is reclaimed, ms at speed 1. */
const SPOT_WARNING_MS = 120_000;

const repeat = <T>(x: T, n: number): T[] => Array.from({ length: Math.max(0, n) }, () => x);

/**
 * One system's builders by kind, cloud first. x86_64-linux: about 20% cloud
 * VMs on demand, 30% cloud VMs on spot, 30% cloud instances with KVM, half
 * of them spot, and 20% own metal, one of them the quiet machine.
 * aarch64-linux, all Graviton: about 25% VMs on demand, 55% VMs on spot and
 * 20% metal with KVM. Others are owned machines with Nix's defaults.
 */
export function machineMix(system: string, n: number): Machine[] {
	if (system === 'x86_64-linux') {
		const metal = Math.round(n * 0.2);
		const vm = Math.round(n * 0.2);
		const kvm = Math.round(n * 0.3);
		const kvmSpot = Math.floor(kvm / 2);
		return [
			...repeat<Machine>('vm', vm),
			...repeat<Machine>('vm-spot', n - metal - vm - kvm),
			...repeat<Machine>('kvm', kvm - kvmSpot),
			...repeat<Machine>('kvm-spot', kvmSpot),
			...repeat<Machine>('quiet', Math.min(1, metal)),
			...repeat<Machine>('metal', metal - 1)
		];
	}
	if (system === 'aarch64-linux') {
		const vm = Math.round(n * 0.25);
		const kvm = Math.round(n * 0.2);
		return [
			...repeat<Machine>('vm', vm),
			...repeat<Machine>('vm-spot', n - vm - kvm),
			...repeat<Machine>('kvm', kvm)
		];
	}
	return repeat<Machine>('own', n);
}

/** Host names of owned machines: metal-x86-03, mac-02. */
function ownName(system: string, machine: Machine, k: number): string {
	const nn = String(k).padStart(2, '0');
	if (system === 'x86_64-linux') return machine === 'quiet' ? 'metal-x86-quiet' : `metal-x86-${nn}`;
	if (system === 'aarch64-darwin') return `mac-${nn}`;
	if (system === 'x86_64-darwin') return `mac-intel-${nn}`;
	return `${system}-${nn}`;
}

function clampInt(v: number, lo: number, hi: number) {
	return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
}
function clampNum(v: number, lo: number, hi: number) {
	return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

// ------------------------------------------------------------------ random

class Rng {
	#a: number;
	constructor(seed: number) {
		this.#a = (seed ^ 0x9e3779b9) >>> 0;
	}
	/** mulberry32: small, fast, good enough for a simulation. */
	next(): number {
		this.#a = (this.#a + 0x6d2b79f5) >>> 0;
		let t = this.#a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	int(lo: number, hi: number): number {
		return lo + Math.floor(this.next() * (hi - lo + 1));
	}
	chance(p: number): boolean {
		return this.next() < p;
	}
	pick<T>(xs: readonly T[]): T {
		return xs[Math.floor(this.next() * xs.length)];
	}
	exp(mean: number): number {
		return -Math.log(1 - this.next()) * mean;
	}
	normal(): number {
		return normal(this.next(), this.next());
	}
	logNormal(median: number, sigma: number): number {
		return median * Math.exp(sigma * this.normal());
	}
	/** 32 characters of Nix's base32 alphabet. */
	hash(): string {
		let s = '';
		for (let i = 0; i < 32; i++) s += NIX_BASE32[Math.floor(this.next() * 32)];
		return s;
	}
}

// ------------------------------------------------------------------- heaps

class Heap<T> {
	readonly #xs: T[] = [];
	constructor(readonly less: (a: T, b: T) => boolean) {}
	peek(): T | undefined {
		return this.#xs[0];
	}
	push(x: T) {
		const xs = this.#xs;
		xs.push(x);
		let i = xs.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!this.less(xs[i], xs[p])) break;
			[xs[i], xs[p]] = [xs[p], xs[i]];
			i = p;
		}
	}
	pop(): T | undefined {
		const xs = this.#xs;
		if (xs.length === 0) return undefined;
		const top = xs[0];
		const last = xs.pop()!;
		if (xs.length > 0) {
			xs[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < xs.length && this.less(xs[l], xs[m])) m = l;
				if (r < xs.length && this.less(xs[r], xs[m])) m = r;
				if (m === i) break;
				[xs[i], xs[m]] = [xs[m], xs[i]];
				i = m;
			}
		}
		return top;
	}
}

// ------------------------------------------------------------------- model

type Timer = { at: number; n: number; fn: () => void };

type Worker = {
	addr: string;
	machine: Machine;
	/** A cloud instance, which the autoscaler adds and retires. */
	cloud: boolean;
	/** A spot instance, which can be interrupted while churn is on. */
	spot: boolean;
	systems: string[];
	features: string[];
	maxJobs: number;
	up: boolean;
	draining: boolean;
	running: Set<Drv>;
	/** Mean time between maintenance windows, ms at speed 1. */
	cycleMs: number;
	/** Scaled in or interrupted: draining, then gone for good. */
	retiring: boolean;
	/** Fails most of its builds, by the `failing` option. */
	failing: boolean;
	/** Set while draining. */
	drainReason: 'stopping' | 'low-disk' | 'local-daemon' | null;
	diskTotal: number;
	diskFree: number;
	/** The free disk the builder last reported. */
	reportedFree: number;
	/** Something to report changed since the last report. */
	dirty: boolean;
	lastReportMs: number;
	/** Its substituters: the farm cache, then the upstream ones. */
	substituters: string[];
	/** What it took from each, since the scheduler started serving. */
	subs: Map<string, Traffic>;
	/** The same, as it last reported them. */
	reportedSubs: Map<string, Traffic>;
};

type Phase = 'queued' | 'unplaceable' | 'assigned';

/** A tracked scheduler entry. */
type Drv = {
	path: string;
	system: string;
	features: string[];
	qkey: string;
	waiters: Node[];
	phase: Phase;
	queuedMs: number;
	cp: number;
	inputs: number;
	deps: string[];
	cacheChecked: boolean;
	reason: string;
	worker: Worker | null;
	assignId: number;
	assignedMs: number;
	/** The build's duration in simulated ms, as #assign drew it. */
	plannedMs: number;
	/** When the build starts on its builder, after the assignment. */
	startedMs: number;
	/** Its log plan, made when something asks. */
	log: LogPlan | null;
	/** The start and phase the builder last reported. */
	reportedStart: boolean;
	reportedPhase: string;
	/** Input sources of the current assignment, as its first DrvState listed them. */
	sources: { list: InputSource[]; unknown: number } | null;
	/** Bumped on every queue or assignment change: stale timers compare it. */
	token: number;
};

/** A build that finished on a builder, in the scheduler's rings. */
type DoneRec = {
	path: string;
	system: string;
	worker: string;
	outcome: DrvGone_Outcome;
	status: DrvGone_Status;
	error: string;
	assignId: number;
	assignedMs: number;
	startedMs: number;
	finishedMs: number;
	plannedMs: number;
	requestedBy: string[];
	/** The builder fails most builds, by the `failing` option. */
	failing: boolean;
};

/** What the demo's log backend needs to make a build's log. */
export type DemoLogPlan = Readonly<{
	drvPath: string;
	name: string;
	system: string;
	assignId: number;
	seed: number;
	plannedMs: number;
	logsize: number;
	nixoslog: NixosLog | null;
	/** Wall ms per simulated ms. */
	speed: number;
	/** When the build started, browser ms. null: not yet. */
	startedMs: number | null;
	/** Set once the build ended. */
	ending: LogEnding | null;
	/** The builder that runs or ran it. */
	worker: string;
	/** The demo's clock, browser ms. */
	nowMs: number;
}>;

export type DemoLogEvent =
	| { kind: 'tick'; nowMs: number }
	| { kind: 'started'; startedMs: number }
	| { kind: 'ended'; ending: LogEnding; nowMs: number };

/** The scheduler keeps this many finished builds, and this many failures. */
const RING_BUILDS = 10_000;
const RING_FAILURES = 2_000;
/** History builds spread over this much simulated time before the page opened. */
const HISTORY_SPAN_MS = 30 * 60_000;

type Node = {
	path: string;
	system: string;
	features: string[];
	deps: Node[];
	dependents: Node[];
	cp: number;
	inputs: number;
	pending: number;
	state: 'blocked' | 'ready' | 'wanted' | 'done' | 'failed';
	preCached: boolean;
	job: Job;
};

type Job = {
	id: number;
	identity: string;
	connectedMs: number;
	nodes: Node[];
	ready: Node[];
	inFlight: number;
	maxBuilds: number;
	keepGoing: boolean;
	ended: boolean;
	hook: boolean;
	remaining: number;
};

/** Queued drvs of one system and feature set. */
type Queue = {
	system: string;
	features: readonly string[];
	heap: Heap<{ d: Drv; token: number; prio: number }>;
	members: Set<Drv>;
	placeable: boolean;
};

const NAMES = [
	'hello-2.12.1',
	'openssl-3.4.1',
	'zlib-1.3.1',
	'curl-8.12.1',
	'python3.12-requests-2.32.3',
	'python3.12-numpy-2.2.4',
	'rustc-1.86.0',
	'cargo-vendor',
	'linux-6.12.21',
	'glibc-2.40-66',
	'gcc-14.2.1',
	'perl5.40.0-JSON-4.10',
	'go-1.24.2',
	'nodejs-22.14.0',
	'systemd-257.3',
	'ghc-9.8.4',
	'haskell-aeson-2.2.3.0',
	'llvm-19.1.7',
	'boost-1.87.0',
	'qtbase-6.8.2',
	'sqlite-3.48.0',
	'libxml2-2.13.6',
	'ncurses-6.5',
	'bash-5.2p37',
	'coreutils-9.6',
	'gnumake-4.4.1',
	'cmake-3.31.6',
	'meson-1.7.0',
	'protobuf-29.3',
	'grpc-1.70.1'
];
const PROJECTS = ['api', 'web', 'infra', 'ml', 'mobile', 'data', 'auth', 'billing', 'search'];
const PARTS = ['server', 'client', 'tests', 'docs', 'lib', 'cli', 'image', 'bundle', 'vm-test'];
const USERS = [
	'oidc:sso:alice',
	'oidc:sso:bob',
	'oidc:sso:carol',
	'oidc:sso:dmitri',
	'oidc:sso:erin',
	'oidc:github:frank'
];
const HOOK_HOSTS = ['build-host-1', 'build-host-2', 'laptop-ilan', 'desktop-maria', 'hydra-eval'];
const GIVE_BACK_REASONS = ['given back: low on disk', 'given back: build slot lost'];

/** Nix's statuses for a failed build in the demo, by weight. */
const FAILURES: readonly [DrvGone_Status, number][] = [
	[DrvGone_Status.PERMANENT_FAILURE, 0.72],
	[DrvGone_Status.TIMED_OUT, 0.08],
	[DrvGone_Status.MISC_FAILURE, 0.08],
	[DrvGone_Status.OUTPUT_REJECTED, 0.05],
	[DrvGone_Status.LOG_LIMIT_EXCEEDED, 0.03],
	[DrvGone_Status.NOT_DETERMINISTIC, 0.02],
	[DrvGone_Status.TRANSIENT_FAILURE, 0.02]
];

/** Last lines of a failing build's log, one set per failure. */
const TAILS: readonly (readonly string[])[] = [
	[
		'gcc -O2 -c -o main.o main.c',
		"main.c:41:5: error: implicit declaration of function 'strlcpy'",
		'   41 |     strlcpy(buf, src, sizeof buf);',
		'      |     ^~~~~~~',
		'make: *** [Makefile:12: all] Error 2'
	],
	[
		'running tests',
		'test result: FAILED. 211 passed; 1 failed; 0 ignored',
		"thread 'net::tests::resolves_localhost' panicked at src/net.rs:88:9:",
		'assertion failed: addr.is_loopback()',
		'error: test failed, to rerun pass `--lib`'
	],
	[
		'============================= FAILURES =============================',
		'____________________ test_roundtrip[utf-16] ____________________',
		'E       AssertionError: assert b"\\xff\\xfe" == b""',
		'tests/test_codec.py:57: AssertionError',
		'=================== 1 failed, 803 passed in 41.22s ==================='
	],
	[
		'CMake Error at CMakeLists.txt:24 (find_package):',
		'  Could not find a package configuration file provided by "absl"',
		'-- Configuring incomplete, errors occurred!'
	]
];

/** The farm runs this long before its first snapshot, so that shows a busy farm. */
const WARMUP_MS = 60_000;

function featureKey(fs: readonly string[]): string {
	return [...fs].sort().join(',');
}

export class MockFarm {
	readonly options: MockOptions;
	readonly instance: string;
	readonly servingSinceMs: number;
	now: number;

	readonly #rng: Rng;
	/**
	 * Draws for what the scheduler of the dashboard's first years did not
	 * report: build statuses, error text, disk and substituters. A second
	 * generator, so a seed keeps its outcomes whatever these options are.
	 */
	readonly #rng2: Rng;
	readonly #timers = new Heap<Timer>((a, b) => a.at < b.at || (a.at === b.at && a.n < b.n));
	#timerN = 0;
	#seq = 0n;
	#gapPending = false;
	#muted = false;
	#out: WatchEvent[] = [];

	readonly #workers: Worker[] = [];
	/** Workers by each system they offer, in the order of #workers. */
	readonly #bySystem = new Map<string, Worker[]>();
	/** The farm at full size: each builder's system and kind, in creation order. */
	readonly #plan: { si: number; machine: Machine }[] = [];
	/** The cloud part of #plan by system and kind, with how many each has at full size. */
	readonly #cloudPlan: { si: number; machine: Machine; n: number }[] = [];
	/** Builders in the cloud part of #plan. */
	#cloudSize = 0;
	/** Host number of the next builder the autoscaler adds. */
	#nextWorker = 0;
	/** Spot interruptions so far: the builder and when its warning came. */
	readonly #interruptions: { addr: string; machine: string; warnedMs: number }[] = [];
	readonly #drvs = new Map<string, Drv>();
	readonly #queues = new Map<string, Queue>();
	readonly #jobs = new Map<number, Job>();
	#nextClient = 1;
	#assignIds = 0;
	#nAssigned = 0;
	/** The worker and output bytes of each drv path's last build, like the scheduler's lastBuilder. */
	readonly #builtOn = new Map<string, { worker: string; bytes: number }>();
	readonly #popular = new Map<string, { path: string }[]>();
	readonly #counters: CounterValues = { ...ZERO_COUNTERS };
	/** Counters.substituters: what builders reported, summed per URL. */
	readonly #subTotals = new Map<string, Traffic>();
	#history: CounterSample[] = [];
	readonly #meanBuildMs: number;
	readonly #ciRunners: string[];
	/** Features some builder of the system offers, so ordinary wants stay placeable. */
	readonly #featuresOf = new Map<string, Set<string>>();
	/** The scheduler's rings: builds that finished on a builder, and failures. Oldest first. */
	#builds: DoneRec[] = [];
	#failures: DoneRec[] = [];
	readonly #ended = new Set<(path: string, assignId: number, ending: LogEnding) => void>();

	constructor(options: MockOptions, startMs: number) {
		this.options = options;
		this.#rng = new Rng(options.seed);
		this.#rng2 = new Rng(options.seed ^ 0x51ed);
		this.instance = this.#rng.hash().slice(0, 16);
		const warmup = WARMUP_MS;
		this.now = startMs - warmup;
		const served = this.#rng.int(0, 3600_000);
		this.servingSinceMs = Math.round(
			startMs -
				(options.uptime > 0 ? Math.max(warmup, options.uptime * 60_000) : 3 * 3600_000 + served)
		);
		this.#ciRunners = Array.from(
			{ length: Math.max(4, Math.round(options.builders / 3)) },
			(_, i) => `ci-runner-${i + 1}`
		);
		this.#makePlan();
		this.#makeWorkers();
		this.#startLowOnDisk(startMs);
		for (const w of this.#workers) {
			for (const sys of w.systems) {
				let fs = this.#featuresOf.get(sys);
				if (!fs) this.#featuresOf.set(sys, (fs = new Set()));
				for (const f of w.features) fs.add(f);
			}
		}
		const slots = this.#workers.reduce((s, w) => s + w.maxJobs, 0);
		// About 3.5 events per build: want, assign, gone and the extras.
		this.#meanBuildMs = Math.min(600_000, Math.max(1_000, ((slots * 3.5) / options.rate) * 1000));
		for (const sys of options.systems) {
			this.#popular.set(
				sys,
				Array.from({ length: 400 }, () => ({ path: this.#path(this.#rng.pick(NAMES)) }))
			);
		}
		this.#every(1_000, () => this.#stats());
		this.#every(1_000, () => this.#control());
		this.#every(60_000, () => this.#sampleHistory());
		// Builders report starts and phases every 2 s of simulated time.
		if (options.progress) this.#every(REPORT_MS / options.speed, () => this.#progress());
		this.#scheduleHook();
		if (options.churn > 0 && this.#cloudSize > 0) this.#scheduleChurn();

		// Warm up quietly so the first snapshot shows a busy farm.
		this.#muted = true;
		this.advance(startMs);
		this.#muted = false;
		this.#synthesizeHistory(startMs, warmup);
		this.#synthesizeBuilds(startMs);
	}

	// ---------------------------------------------------------------- public

	/** Run the simulation up to `now` and return the events that happened. */
	advance(now: number, mute = false): WatchEvent[] {
		const wasMuted = this.#muted;
		this.#muted = wasMuted || mute;
		for (;;) {
			const t = this.#timers.peek();
			if (!t || t.at > now) break;
			this.#timers.pop();
			if (t.at > this.now) this.now = t.at;
			t.fn();
		}
		if (now > this.now) this.now = now;
		this.#muted = wasMuted;
		const out = this.#out;
		this.#out = [];
		return out;
	}

	/** Reset, then the current state, then SnapshotDone, all with the current seq. */
	snapshot(): WatchEvent[] {
		const seq = this.#seq;
		const t = BigInt(Math.round(this.now));
		const ev = (event: WatchEvent['event']) => create(WatchEventSchema, { seq, timeMs: t, event });
		const out: WatchEvent[] = [];
		out.push(
			ev({
				case: 'reset',
				value: create(ResetSchema, {
					instance: this.instance,
					servingSinceMs: BigInt(this.servingSinceMs),
					version: '0.9.0-dashboard',
					defaultSystem: this.options.systems[0] ?? '',
					cacheUrl: this.options.cache ? FARM_CACHE : '',
					cacheSubstituterUrl: this.options.cache ? FARM_CACHE : '',
					history: this.#history.map((h) =>
						create(CounterSampleSchema, {
							timeMs: BigInt(Math.round(h.t)),
							counters: this.#countersMsg(h.c, h.subs)
						})
					)
				})
			})
		);
		for (const w of this.#workers)
			if (w.up) out.push(ev({ case: 'worker', value: this.#workerMsg(w) }));
		for (const j of this.#jobs.values()) {
			out.push(
				ev({
					case: 'client',
					value: create(ClientStateSchema, {
						id: BigInt(j.id),
						identity: j.identity,
						connectedMs: BigInt(Math.round(j.connectedMs))
					})
				})
			);
		}
		for (const d of this.#drvs.values())
			out.push(ev({ case: 'drv', value: this.#drvMsg(d, DrvState_Cause.SNAPSHOT) }));
		out.push(ev({ case: 'snapshotDone', value: create(SnapshotDoneSchema) }));
		return out;
	}

	/** The next event skips one seq number. */
	injectGap(): void {
		this.#gapPending = true;
	}

	/**
	 * Events.RecentBuilds from the rings, newest first, in batches of 256,
	 * as the scheduler answers it.
	 */
	recentBuilds(req: RecentBuildsRequest): RecentBuildsBatch[] {
		const msg = (r: DoneRec, error: boolean): FinishedBuild =>
			create(FinishedBuildSchema, {
				drvPath: r.path,
				system: r.system,
				workerAddr: r.worker,
				outcome: r.outcome,
				status: r.status,
				error: error && r.outcome === DrvGone_Outcome.FAILED ? r.error : '',
				assignId: BigInt(r.assignId),
				assignedMs: BigInt(Math.round(r.assignedMs)),
				buildStartedMs: BigInt(Math.round(r.startedMs)),
				finishedMs: BigInt(Math.round(r.finishedMs)),
				requestedBy: r.requestedBy
			});
		if (req.drvPaths?.length) {
			const out: FinishedBuild[] = [];
			for (const p of req.drvPaths.slice(0, 16)) {
				const r =
					this.#failures.findLast((x) => x.path === p) ??
					this.#builds.findLast((x) => x.path === p);
				if (r) out.push(msg(r, true));
			}
			return [create(RecentBuildsBatchSchema, { builds: out })];
		}
		const ring = req.failedOnly ? this.#failures : this.#builds;
		const withError = req.withError && req.failedOnly;
		const limit = Math.min(withError ? 256 : 1000, req.limit || 256);
		const rows: FinishedBuild[] = [];
		let i = ring.length - 1;
		for (; i >= 0 && rows.length < limit; i--) {
			const r = ring[i];
			if (req.beforeMs && r.finishedMs >= req.beforeMs) continue;
			rows.push(msg(r, withError));
		}
		// Complete: the ring holds nothing older than the last row sent.
		let older = false;
		for (; i >= 0; i--) if (!req.beforeMs || ring[i].finishedMs < req.beforeMs) older = true;
		const batches: RecentBuildsBatch[] = [];
		for (let k = 0; k < rows.length || k === 0; k += 256)
			batches.push(create(RecentBuildsBatchSchema, { builds: rows.slice(k, k + 256) }));
		const last = batches[batches.length - 1];
		last.complete = !older;
		last.oldestMs = BigInt(Math.round(ring[0]?.finishedMs ?? 0));
		return batches;
	}

	/**
	 * What the demo's log backend needs for a build: a running or kept one.
	 * For a derivation this farm does not know, such as one in a link from
	 * another session, a build that worked, from its path and the seed.
	 */
	logPlan(drvPath: string, assignId: number): DemoLogPlan {
		const o = this.options;
		const base = {
			drvPath,
			name: drvName(drvPath),
			seed: o.seed,
			logsize: o.logsize,
			nixoslog: o.nixoslog,
			speed: o.speed,
			nowMs: this.now
		};
		const d = this.#drvs.get(drvPath);
		if (d && d.phase === 'assigned' && d.worker && (!assignId || d.assignId === assignId))
			return {
				...base,
				system: d.system,
				assignId: d.assignId,
				plannedMs: d.plannedMs,
				startedMs: d.startedMs <= this.now ? d.startedMs : null,
				ending: null,
				worker: d.worker.addr
			};
		const r =
			this.#builds.findLast((x) => x.path === drvPath && (!assignId || x.assignId === assignId)) ??
			this.#failures.findLast((x) => x.path === drvPath && (!assignId || x.assignId === assignId));
		if (r)
			return {
				...base,
				system: r.system,
				assignId: r.assignId,
				plannedMs: r.plannedMs,
				startedMs: r.startedMs || r.assignedMs,
				ending: { outcome: r.outcome, status: r.status, failing: r.failing },
				worker: r.worker
			};
		return {
			...base,
			system: o.systems[0] ?? 'x86_64-linux',
			assignId,
			plannedMs: 0,
			startedMs: this.now - 60_000,
			ending: { outcome: DrvGone_Outcome.BUILT, status: DrvGone_Status.BUILT },
			worker: ''
		};
	}

	/** Called with each build's ending as it happens, for the demo's log backend. Returns the unsubscribe. */
	onEnded(fn: (path: string, assignId: number, ending: LogEnding) => void): () => void {
		this.#ended.add(fn);
		return () => this.#ended.delete(fn);
	}

	/** Internal sizes, for tests. */
	inspect() {
		let queued = 0;
		let unplaceable = 0;
		for (const d of this.#drvs.values()) {
			if (d.phase !== 'assigned') queued++;
			if (d.phase === 'unplaceable') unplaceable++;
		}
		// Builders per native system, and per system and kind, connected or not;
		// per system and kind taking work; and each builder's system and kind.
		const bySystem: Record<string, number> = {};
		const byMachine: Record<string, number> = {};
		const working: Record<string, number> = {};
		const machines: Record<string, string> = {};
		for (const w of this.#workers) {
			bySystem[w.systems[0]] = (bySystem[w.systems[0]] ?? 0) + 1;
			const k = `${w.systems[0]} ${w.machine}`;
			byMachine[k] = (byMachine[k] ?? 0) + 1;
			if (this.#takesWork(w)) working[k] = (working[k] ?? 0) + 1;
			machines[w.addr] = k;
		}
		return {
			bySystem,
			byMachine,
			working,
			machines,
			interruptions: [...this.#interruptions],
			tracked: this.#drvs.size,
			queued,
			unplaceable,
			assigned: this.#nAssigned,
			clients: this.#jobs.size,
			workersUp: this.#workers.filter((w) => w.up).length,
			/** Cloud builders connected and not scaled in, and the cloud part at full size. */
			cloudUp: this.#workers.filter((w) => w.cloud && w.up && !w.retiring).length,
			cloudSize: this.#cloudSize,
			slots: this.#workers.reduce((s, w) => s + w.maxJobs, 0),
			meanBuildMs: this.#meanBuildMs,
			counters: { ...this.#counters }
		};
	}

	// ---------------------------------------------------------------- timers

	#at(at: number, fn: () => void) {
		this.#timers.push({ at, n: this.#timerN++, fn });
	}
	#after(ms: number, fn: () => void) {
		this.#at(this.now + Math.max(0, ms), fn);
	}
	/** Scaled by speed. */
	#later(ms: number, fn: () => void) {
		this.#after(ms / this.options.speed, fn);
	}
	#every(ms: number, fn: () => void) {
		const tick = () => {
			fn();
			this.#after(ms, tick);
		};
		this.#after(ms, tick);
	}

	#emit(event: WatchEvent['event']) {
		if (this.#muted) return;
		this.#seq += this.#gapPending ? 2n : 1n;
		this.#gapPending = false;
		this.#out.push(
			create(WatchEventSchema, { seq: this.#seq, timeMs: BigInt(Math.round(this.now)), event })
		);
	}

	// --------------------------------------------------------------- workers

	/** Systems take builders in proportion to their shares, and each its mix of kinds. */
	#makePlan() {
		const { builders, systems, shares } = this.options;
		const total = shares.reduce((a, b) => a + b, 0);
		const counts = systems.map(() => 0);
		for (let i = 0; i < builders; i++) {
			let r = (i * total) / builders;
			let si = 0;
			while (si < systems.length - 1 && r >= shares[si]) r -= shares[si++];
			counts[si]++;
		}
		systems.forEach((sys, si) => {
			for (const machine of machineMix(sys, counts[si])) {
				this.#plan.push({ si, machine });
				if (!MACHINES[machine].cloud) continue;
				this.#cloudSize++;
				const g = this.#cloudPlan.find((x) => x.si === si && x.machine === machine);
				if (g) g.n++;
				else this.#cloudPlan.push({ si, machine, n: 1 });
			}
		});
	}

	#makeWorkers() {
		// Owned machines are numbered per system; the quiet one has a name of its own.
		const owned = new Map<string, number>();
		this.#plan.forEach((slot, i) => {
			let addr = hostAddr(slot.si, 10 + i);
			if (!MACHINES[slot.machine].cloud) {
				const sys = this.options.systems[slot.si];
				const n = slot.machine === 'quiet' ? 0 : (owned.get(sys) ?? 0) + 1;
				if (n) owned.set(sys, n);
				addr = `${ownName(sys, slot.machine, n)}:50051`;
			}
			const w = this.#newWorker(slot, addr, i < this.options.failing);
			this.#workers.push(w);
			this.#index(w);
			// Not during the warm-up, so the first snapshot has every builder.
			this.#scheduleMaintenance(w, WARMUP_MS);
			this.#scheduleInterruption(w);
		});
		this.#nextWorker = this.#plan.length;
	}

	#newWorker(slot: { si: number; machine: Machine }, addr: string, failing: boolean): Worker {
		const sys = this.options.systems[slot.si];
		const m = MACHINES[slot.machine];
		const diskTotal = diskSize(slot.machine, sys);
		const diskFree = diskTotal * (0.4 + 0.5 * this.#rng2.next());
		const w: Worker = {
			addr,
			machine: slot.machine,
			cloud: m.cloud,
			spot: m.spot,
			systems: sys === 'x86_64-linux' ? [sys, 'i686-linux'] : [sys],
			features: [...m.features],
			maxJobs: this.#rng.pick([4, 8, 8, 16, 16, 16, 24, 32]),
			up: true,
			draining: false,
			running: new Set(),
			cycleMs: 1_500_000,
			retiring: false,
			failing,
			drainReason: null,
			diskTotal,
			diskFree,
			reportedFree: diskFree,
			dirty: false,
			lastReportMs: -Infinity,
			substituters: [],
			subs: new Map(),
			reportedSubs: new Map()
		};
		const upstream = UPSTREAM.slice(0, this.options.upstream).filter((u) => u.on(w));
		if (upstream.length > 0)
			w.substituters = [...(this.options.cache ? [FARM_CACHE] : []), ...upstream.map((u) => u.url)];
		return w;
	}

	/**
	 * Inputs a builder gathers for an assignment. Those built on other
	 * builders come from the farm cache. Each input nobody here built is
	 * missing with p MISSING and comes from an upstream substituter, picked by
	 * weight; one attempt in 400 stops early, and the next one in the list
	 * serves the path.
	 */
	#gather(w: Worker, msg: DrvState) {
		const upstream = UPSTREAM.filter((u) => w.substituters.includes(u.url));
		if (upstream.length === 0) return;
		const rng = this.#rng2;
		let used = 0;
		let farm = 0;
		for (const s of msg.inputSources) if (s.workerAddr !== w.addr) farm += Number(s.narBytes);
		if (farm > 0 && this.options.cache) {
			this.#took(w, FARM_CACHE, farm, true);
			used += farm;
		}
		const total = upstream.reduce((a, u) => a + u.weight, 0);
		for (let i = 0; i < msg.inputsUnknown; i++) {
			if (!rng.chance(MISSING)) continue;
			const bytes = Math.max(1024, Math.round(rng.logNormal(INPUT_NAR, 1.6)));
			let r = rng.next() * total;
			let k = 0;
			while (k < upstream.length - 1 && (r -= upstream[k].weight) >= 0) k++;
			if (rng.chance(1 / 400)) {
				// Stopped part-way: its bytes count, the path does not.
				this.#took(w, upstream[k].url, Math.round(bytes * rng.next()), false);
				k = (k + 1) % upstream.length;
			}
			this.#took(w, upstream[k].url, bytes, true);
			used += bytes;
		}
		if (used > 0) this.#useDisk(w, used);
	}

	/** One substitution on `w` from `url`: NAR bytes, and a path or a failure. */
	#took(w: Worker, url: string, nar: number, whole: boolean) {
		let t = w.subs.get(url);
		if (!t) w.subs.set(url, (t = { nar: 0, download: 0, paths: 0, failures: 0 }));
		t.nar += nar;
		if (url.startsWith('https://')) t.download += Math.round(nar * WIRE_SHARE);
		if (whole) t.paths++;
		else t.failures++;
		w.dirty = true;
	}

	/** Per-URL totals as a sample keeps them. */
	#subsSnapshot(): ReadonlyMap<string, SubstituterCounts> {
		const out = new Map<string, SubstituterCounts>();
		for (const [url, t] of this.#subTotals) out.set(url, { ...t });
		return out;
	}

	#countersMsg(c: Readonly<CounterValues>, subs: ReadonlyMap<string, SubstituterCounts>) {
		const msg = countersToProto(c);
		msg.substituters = substitutersToProto(subs);
		return msg;
	}

	/** The last `lowdisk` builders start low on disk, and a GC frees it after LOW_DISK_MS. */
	#startLowOnDisk(startMs: number) {
		const n = this.options.lowdisk;
		if (n <= 0) return;
		for (const w of this.#workers.slice(-n)) {
			w.draining = true;
			w.drainReason = 'low-disk';
			w.diskFree = w.reportedFree = LOW_DISK_FREE;
			this.#at(startMs + LOW_DISK_MS / this.options.speed, () => {
				if (!w.up || w.retiring || w.drainReason !== 'low-disk') return;
				this.#undrainLowDisk(w);
			});
		}
	}

	/** A GC frees 60% to 90% of the disk, and the builder takes work again. */
	#undrainLowDisk(w: Worker) {
		this.#collect(w);
		w.reportedFree = w.diskFree;
		this.#undrain(w);
	}

	#undrain(w: Worker) {
		w.draining = false;
		w.drainReason = null;
		this.#emit({ case: 'worker', value: this.#workerMsg(w) });
		this.#placeability();
		this.#fill(w);
	}

	/** A garbage collection: free disk back to 60% to 90%. */
	#collect(w: Worker) {
		w.diskFree = w.diskTotal * (0.6 + 0.3 * this.#rng2.next());
	}

	/**
	 * The builder used `bytes` of its disk. Close to --min-free, a GC frees
	 * it before the builder has to drain. Marks a report due when free disk
	 * moved by the builder's step: max(256 MiB, 5% of the last value it
	 * sent), or across --min-free.
	 */
	#useDisk(w: Worker, bytes: number) {
		w.diskFree -= bytes;
		if (w.diskFree < MIN_FREE + 20 * GiB) this.#collect(w);
		const step = Math.max(256 * 1024 ** 2, 0.05 * w.reportedFree);
		if (
			Math.abs(w.diskFree - w.reportedFree) >= step ||
			w.diskFree < MIN_FREE !== w.reportedFree < MIN_FREE
		)
			w.dirty = true;
	}

	/**
	 * The next cloud builder the autoscaler adds, at a new host number: of
	 * the system and kind furthest below its share of the plan, so the cloud
	 * keeps its mix while builders come and go.
	 */
	#newCloudWorker(): Worker {
		const have = new Map<string, number>();
		for (const w of this.#workers) {
			if (!w.cloud || w.retiring) continue;
			const k = `${w.systems[0]} ${w.machine}`;
			have.set(k, (have.get(k) ?? 0) + 1);
		}
		let slot = this.#cloudPlan[0];
		let fill = Infinity;
		for (const g of this.#cloudPlan) {
			const f = (have.get(`${this.options.systems[g.si]} ${g.machine}`) ?? 0) / g.n;
			if (f < fill) {
				slot = g;
				fill = f;
			}
		}
		return this.#newWorker(slot, hostAddr(slot.si, 10 + this.#nextWorker++), false);
	}

	// ------------------------------------------------------------ autoscaler

	#scheduleChurn() {
		this.#later(60_000 / this.options.churn, () => {
			this.#autoscale();
			this.#scheduleChurn();
		});
	}

	// The cloud part of the farm swings between 70% and 100% of its size over
	// ten minutes, like an autoscaler that follows the queue. Each step adds a
	// cloud builder of any kind or retires one; at the target size it does
	// either. It replaces interrupted spot builders the same way. Owned
	// machines stay.
	#autoscale() {
		const active = this.#workers.filter((w) => w.cloud && w.up && !w.retiring);
		const phase = (this.now * this.options.speed * 2 * Math.PI) / 600_000;
		const target = Math.round(this.#cloudSize * (0.85 + 0.15 * Math.sin(phase)));
		const grow = active.length < target || (active.length === target && this.#rng.chance(0.5));
		if (grow) this.#addWorker();
		else if (active.length > 1) this.#retire(this.#rng.pick(active));
	}

	#addWorker() {
		let w = this.#newCloudWorker();
		// Host numbers wrap after 65536 builders; skip any still in use.
		while (this.#workers.some((x) => x.addr === w.addr)) w = this.#newCloudWorker();
		this.#workers.push(w);
		this.#index(w);
		this.#emit({ case: 'worker', value: this.#workerMsg(w) });
		this.#placeability();
		this.#fill(w);
		this.#scheduleMaintenance(w);
		this.#scheduleInterruption(w);
	}

	// Scale-in: stop taking work, then disconnect for good.
	#retire(w: Worker) {
		w.retiring = true;
		w.draining = true;
		w.drainReason = 'stopping';
		this.#emit({ case: 'worker', value: this.#workerMsg(w) });
		this.#placeability();
		this.#later(this.#rng.int(10_000, 40_000), () => this.#leave(w));
	}

	/** While churn is on, a spot builder's next interruption. */
	#scheduleInterruption(w: Worker) {
		if (!w.spot || this.options.churn <= 0) return;
		this.#later(this.#rng.exp(SPOT_MEAN_MS), () => this.#interrupt(w));
	}

	// The cloud takes a spot instance back: a two-minute warning, in which the
	// builder drains, then it disconnects for good. Builds still running then
	// are lost, and the scheduler requeues them as for any worker that goes.
	#interrupt(w: Worker) {
		if (w.retiring || !this.#workers.includes(w)) return;
		w.retiring = true;
		this.#interruptions.push({
			addr: w.addr,
			machine: `${w.systems[0]} ${w.machine}`,
			warnedMs: this.now
		});
		if (this.#interruptions.length > 1000) this.#interruptions.shift();
		if (!w.up) {
			// Offline for maintenance: it never comes back.
			this.#leave(w);
			return;
		}
		if (w.drainReason !== 'stopping') {
			// A stop wins over low disk.
			w.draining = true;
			w.drainReason = 'stopping';
			this.#emit({ case: 'worker', value: this.#workerMsg(w) });
			this.#placeability();
		}
		this.#later(SPOT_WARNING_MS, () => this.#leave(w));
	}

	/**
	 * Disconnect for good: requeue what still runs there and forget the
	 * builder. One already offline has nothing to send: the scheduler lost it
	 * then, and the map shows it offline for the usual 10 minutes.
	 */
	#leave(w: Worker) {
		if (w.up) this.#disconnect(w);
		const i = this.#workers.indexOf(w);
		if (i >= 0) this.#workers.splice(i, 1);
		for (const sys of w.systems) {
			const list = this.#bySystem.get(sys);
			const j = list?.indexOf(w) ?? -1;
			if (j >= 0) list!.splice(j, 1);
		}
	}

	#workerMsg(w: Worker) {
		return create(WorkerStateSchema, {
			addr: w.addr,
			systems: w.systems,
			features: w.features,
			maxJobs: w.maxJobs,
			up: w.up,
			draining: w.draining,
			drainReason:
				w.drainReason === 'stopping'
					? WorkerState_DrainReason.STOPPING
					: w.drainReason === 'low-disk'
						? WorkerState_DrainReason.LOW_DISK
						: w.drainReason === 'local-daemon'
							? WorkerState_DrainReason.LOCAL_DAEMON
							: WorkerState_DrainReason.UNSPECIFIED,
			version: 'mock',
			diskFreeBytes: BigInt(Math.round(w.reportedFree)),
			diskTotalBytes: BigInt(Math.round(w.diskTotal)),
			minFreeBytes: BigInt(MIN_FREE),
			// Configured ones in order, with zeros while idle, as the scheduler sends them.
			substituters: w.substituters.map((url) => {
				const t = w.reportedSubs.get(url);
				return create(SubstituterTrafficSchema, {
					url,
					narBytes: BigInt(t?.nar ?? 0),
					downloadBytes: BigInt(t?.download ?? 0),
					paths: BigInt(t?.paths ?? 0),
					failures: BigInt(t?.failures ?? 0)
				});
			})
		});
	}

	#takesWork(w: Worker) {
		return w.up && !w.draining && w.maxJobs > 0;
	}

	#offers(w: Worker, system: string, features: readonly string[]) {
		return offers(w.systems, w.features, system, features);
	}

	/**
	 * The builder's next maintenance window, no sooner than `after` ms, which
	 * speed does not scale. Graviton metal, often the only builder for aarch64
	 * NixOS tests, waits for the next window while no other builder covers its
	 * work, like an operator rolling maintenance through the farm. Every other
	 * builder goes when its window comes, though it may be the only one of its
	 * system, as a Mac often is.
	 */
	#scheduleMaintenance(w: Worker, after = 0) {
		this.#after(after + this.#rng.exp(w.cycleMs) / this.options.speed, () => {
			if (!w.up || w.retiring) return;
			// Still low on disk from the lowdisk option.
			if ((this.#gravitonMetal(w) && !this.#covered(w)) || w.draining) {
				this.#scheduleMaintenance(w);
				return;
			}
			const r = this.#rng.next();
			if (r < 0.15) {
				this.#goOffline(w);
				return;
			}
			w.draining = true;
			if (r < 0.45) {
				// Low disk, below --min-free by 0.5 to 8 GiB.
				w.drainReason = 'low-disk';
				w.diskFree = w.reportedFree = MIN_FREE - (0.5 + 7.5 * this.#rng2.next()) * GiB;
			} else if (r < 0.55) {
				// Its nix-daemon stops answering for a while.
				w.drainReason = 'local-daemon';
			} else {
				w.drainReason = 'stopping';
			}
			this.#emit({ case: 'worker', value: this.#workerMsg(w) });
			this.#placeability();
			if (r < 0.45) {
				// A GC clears it up: back to work without leaving.
				this.#later(this.#rng.int(20_000, 60_000), () => {
					if (!w.up || w.retiring) return;
					this.#undrainLowDisk(w);
					this.#scheduleMaintenance(w);
				});
			} else if (r < 0.55) {
				this.#later(this.#rng.int(30_000, 120_000), () => {
					if (!w.up || w.retiring) return;
					this.#undrain(w);
					this.#scheduleMaintenance(w);
				});
			} else {
				this.#later(this.#rng.int(20_000, 90_000), () => {
					if (!w.retiring) this.#goOffline(w);
				});
			}
		});
	}

	/** aarch64-linux with KVM: Graviton metal, the only builders there for NixOS tests. */
	#gravitonMetal(w: Worker) {
		return w.systems[0] === 'aarch64-linux' && w.machine === 'kvm';
	}

	/** Another builder takes work for each of w's systems with all of w's features. */
	#covered(w: Worker) {
		return w.systems.every((sys) =>
			(this.#bySystem.get(sys) ?? []).some(
				(x) => x !== w && this.#takesWork(x) && this.#offers(x, sys, w.features)
			)
		);
	}

	/**
	 * The builder's stream ends, in the order of the scheduler's
	 * workerGoneLocked in the patch series: what ran there goes back to the queue,
	 * or is dropped when no client waits on it, then the builder is down, then
	 * queues that lost their last builder turn unplaceable, then the requeued
	 * drvs are assigned.
	 */
	#disconnect(w: Worker) {
		w.up = false;
		w.draining = false;
		w.drainReason = null;
		const ran = [...w.running];
		for (const d of ran) this.#requeue(d, 'the worker disconnected', false);
		this.#emit({ case: 'worker', value: this.#workerMsg(w) });
		this.#placeability();
		for (const d of ran) this.#tryAssign(d);
	}

	#goOffline(w: Worker) {
		if (!w.up) return;
		this.#disconnect(w);
		this.#later(this.#rng.int(30_000, 180_000), () => {
			if (w.retiring) return;
			w.up = true;
			w.draining = false;
			w.drainReason = null;
			this.#emit({ case: 'worker', value: this.#workerMsg(w) });
			this.#placeability();
			this.#fill(w);
			this.#scheduleMaintenance(w);
		});
	}

	// ---------------------------------------------------------------- queues

	#queue(d: Drv): Queue {
		let q = this.#queues.get(d.qkey);
		if (!q) {
			q = {
				system: d.system,
				features: d.features,
				heap: new Heap((a, b) => a.prio > b.prio),
				members: new Set(),
				placeable: this.#placeable(d.system, d.features)
			};
			this.#queues.set(d.qkey, q);
		}
		return q;
	}

	#index(w: Worker) {
		for (const sys of w.systems) {
			let list = this.#bySystem.get(sys);
			if (!list) this.#bySystem.set(sys, (list = []));
			list.push(w);
		}
	}

	#placeable(system: string, features: readonly string[]) {
		return (this.#bySystem.get(system) ?? []).some(
			(w) => this.#takesWork(w) && this.#offers(w, system, features)
		);
	}

	#unplaceableReason(d: Drv) {
		const offered = new Set<string>();
		for (const w of this.#workers)
			if (this.#takesWork(w) && w.systems.includes(d.system))
				for (const f of w.features) offered.add(f);
		return (
			`no connected, non-draining worker for system '${d.system}' offers features ` +
			`{${d.features.join(',')}}, the workers offer {${[...offered].sort().join(',')}}`
		);
	}

	/** Queue `d` and assign it right away if a worker has a free slot. */
	#enqueue(d: Drv) {
		const q = this.#queue(d);
		// An empty queue's flag may be stale: #placeability skips empty queues,
		// and a builder going offline requeues its drvs before it runs.
		if (q.members.size === 0) q.placeable = this.#placeable(q.system, q.features);
		d.token++;
		d.worker = null;
		d.phase = q.placeable ? 'queued' : 'unplaceable';
		q.members.add(d);
		// The mock fixes the priority at enqueue time.
		q.heap.push({ d, token: d.token, prio: priority(d.cp, d.waiters.length, d.queuedMs) });
	}

	#tryAssign(d: Drv) {
		if (d.phase !== 'queued') return;
		let best: Worker | null = null;
		let bestScore = -1;
		// Locality first, by bytes of inputs it built, then free share.
		const local = new Map<string, number>();
		for (const p of d.deps) {
			const b = this.#builtOn.get(p);
			if (b) local.set(b.worker, (local.get(b.worker) ?? 0) + b.bytes);
		}
		for (const w of this.#bySystem.get(d.system) ?? []) {
			if (!this.#takesWork(w) || w.running.size >= w.maxJobs) continue;
			if (!this.#offers(w, d.system, d.features)) continue;
			const score = (local.get(w.addr) ?? 0) + (1 - w.running.size / w.maxJobs) * 1e5;
			if (score > bestScore) {
				best = w;
				bestScore = score;
			}
		}
		if (best) this.#assign(d, best);
	}

	/** Fill a worker's free slots from the queues it serves. */
	#fill(w: Worker) {
		if (!this.#takesWork(w)) return;
		const qs: Queue[] = [];
		for (const q of this.#queues.values()) {
			if (q.members.size > 0 && this.#offers(w, q.system, q.features)) qs.push(q);
		}
		while (w.running.size < w.maxJobs) {
			let bestQ: Queue | null = null;
			let bestPrio = -Infinity;
			for (const q of qs) {
				if (!this.#top(q)) continue;
				const p = q.heap.peek()!.prio;
				if (p > bestPrio) {
					bestQ = q;
					bestPrio = p;
				}
			}
			if (!bestQ) return;
			this.#assign(bestQ.heap.pop()!.d, w);
		}
	}

	/** Valid head of a queue, dropping stale heap entries. */
	#top(q: Queue): Drv | null {
		for (;;) {
			const e = q.heap.peek();
			if (!e) return null;
			if (e.token === e.d.token && e.d.phase === 'queued' && this.#drvs.get(e.d.path) === e.d)
				return e.d;
			q.heap.pop();
		}
	}

	#leaveQueue(d: Drv) {
		this.#queues.get(d.qkey)?.members.delete(d);
	}

	/** Re-evaluate placeability per queue and tell followers about flips. */
	#placeability() {
		for (const q of this.#queues.values()) {
			if (q.members.size === 0) continue;
			const p = this.#placeable(q.system, q.features);
			if (p === q.placeable) continue;
			q.placeable = p;
			for (const d of q.members) {
				d.phase = p ? 'queued' : 'unplaceable';
				d.reason = p ? '' : this.#unplaceableReason(d);
				this.#emit({ case: 'drv', value: this.#drvMsg(d, DrvState_Cause.PLACEABILITY) });
			}
			if (p) for (const d of [...q.members]) this.#tryAssign(d);
		}
	}

	// ---------------------------------------------------------------- builds

	#assign(d: Drv, w: Worker) {
		this.#leaveQueue(d);
		d.token++;
		d.phase = 'assigned';
		d.worker = w;
		d.assignId = ++this.#assignIds;
		d.assignedMs = this.now;
		d.reason = '';
		w.running.add(d);
		this.#nAssigned++;
		this.#counters.assigned++;
		const msg = this.#drvMsg(d, DrvState_Cause.ASSIGNED);
		for (const s of msg.inputSources)
			if (s.workerAddr !== w.addr) this.#counters.fetchedBytesEstimate += Number(s.narBytes);
		this.#emit({ case: 'drv', value: msg });
		this.#gather(w, msg);

		const token = d.token;
		// The builder starts it a moment after the assignment: by hash, not from #rng.
		d.plannedMs = 0;
		d.log = null;
		d.reportedStart = false;
		d.reportedPhase = '';
		d.startedMs =
			this.now +
			(200 + (hash32(this.options.seed, d.path, d.assignId, 'start') % 2800)) / this.options.speed;
		const r = this.#rng.next();
		if (r < 0.01) {
			// It never starts.
			d.startedMs = Infinity;
			// The client never came to build it: the worker gives the Expect back.
			this.#later(60_000, () => {
				if (d.token === token) this.#requeue(d, 'never claimed');
			});
			return;
		}
		if (r < 0.015) {
			this.#later(this.#rng.int(2_000, 20_000), () => {
				if (d.token === token) this.#requeue(d, this.#rng.pick(GIVE_BACK_REASONS));
			});
			return;
		}
		const ms = Math.min(
			this.#meanBuildMs * 20,
			Math.max(300, this.#rng.logNormal(this.#meanBuildMs / 1.65, 1))
		);
		d.plannedMs = ms;
		this.#later(ms, () => this.#finish(d, token));
	}

	#unassign(d: Drv) {
		if (d.worker) {
			d.worker.running.delete(d);
			this.#nAssigned--;
		}
		d.worker = null;
	}

	/** Back to the queue, or dropped when no client waits on it. `assign`: try to assign it now. */
	#requeue(d: Drv, reason: string, assign = true) {
		if (d.phase !== 'assigned' || this.#drvs.get(d.path) !== d) return;
		const w = d.worker!;
		this.#unassign(d);
		if (d.waiters.length === 0) {
			this.#gone(d, DrvGone_Outcome.DROPPED, w.addr);
			this.#fill(w);
			return;
		}
		this.#counters.requeued++;
		this.#enqueue(d);
		d.reason = reason;
		this.#emit({ case: 'drv', value: this.#drvMsg(d, DrvState_Cause.REQUEUED) });
		if (assign) this.#tryAssign(d);
		this.#fill(w);
	}

	#finish(d: Drv, token: number) {
		if (d.token !== token || d.phase !== 'assigned' || this.#drvs.get(d.path) !== d) return;
		const w = d.worker!;
		// 1% is cancelled. The defaults give 94% built and 5% failed.
		const p = w.failing ? 0.8 : this.options.fail;
		const r = this.#rng.next();
		const outcome =
			r < 0.99 - p
				? DrvGone_Outcome.BUILT
				: r < 0.99
					? DrvGone_Outcome.FAILED
					: DrvGone_Outcome.CANCELLED;
		this.#unassign(d);
		const waiters = d.waiters;
		// With upstream substituters, 2% of builds find their output upstream.
		const substituted =
			outcome === DrvGone_Outcome.BUILT && w.substituters.length > 0 && this.#rng2.chance(0.02);
		const bytes = this.#gone(d, outcome, w.addr, substituted);
		if (substituted && bytes > 0) this.#took(w, UPSTREAM[0].url, bytes, true);
		if (bytes > 0) this.#useDisk(w, bytes);
		for (const n of waiters) this.#nodeDone(n, outcome === DrvGone_Outcome.BUILT);
		this.#fill(w);
	}

	/** Remove a tracked drv and emit DrvGone. Returns the bytes of its outputs. */
	#gone(d: Drv, outcome: DrvGone_Outcome, workerAddr: string, substituted = false): number {
		this.#drvs.delete(d.path);
		this.#leaveQueue(d);
		d.token++;
		const requestedBy: string[] = [];
		for (const n of d.waiters)
			if (requestedBy.length < 4 && !requestedBy.includes(n.job.identity))
				requestedBy.push(n.job.identity);
		d.waiters = [];
		const outputs: { path: string; narSize: bigint }[] = [];
		const c = this.#counters;
		if (outcome === DrvGone_Outcome.BUILT) {
			c.built++;
			const base = d.path.slice(0, -4);
			const n = this.#rng.chance(0.3) ? this.#rng.int(2, 3) : 1;
			let bytes = 0;
			for (let i = 0; i < n; i++) {
				const size = Math.round(this.#rng.logNormal(i === 0 ? 2e6 : 3e5, 1.4));
				bytes += size;
				outputs.push({
					path: `/nix/store/${base}${['', '-dev', '-doc'][i]}`,
					narSize: BigInt(size)
				});
			}
			c.publishedBytes += bytes;
			this.#builtOn.set(d.path, { worker: workerAddr, bytes });
			if (this.#builtOn.size > 65_536) this.#builtOn.clear();
		} else if (outcome === DrvGone_Outcome.FAILED) c.failed++;
		else if (outcome === DrvGone_Outcome.CANCELLED) c.cancelled++;
		else c.dropped++;
		const failure = outcome === DrvGone_Outcome.FAILED ? this.#failure(d, workerAddr) : undefined;
		const status =
			outcome === DrvGone_Outcome.BUILT
				? substituted
					? DrvGone_Status.SUBSTITUTED
					: DrvGone_Status.BUILT
				: (failure?.status ?? DrvGone_Status.UNSPECIFIED);
		if (workerAddr && d.assignId) {
			this.#record({
				path: d.path,
				system: d.system,
				worker: workerAddr,
				outcome,
				status,
				error: failure?.error ?? '',
				assignId: d.assignId,
				assignedMs: d.assignedMs,
				startedMs: this.options.progress && d.startedMs <= this.now ? d.startedMs : 0,
				finishedMs: this.now,
				plannedMs: d.plannedMs,
				requestedBy,
				failing:
					d.worker?.failing ?? this.#workers.find((w) => w.addr === workerAddr)?.failing ?? false
			});
		}
		this.#emit({
			case: 'drvGone',
			value: create(DrvGoneSchema, {
				drvPath: d.path,
				outcome,
				workerAddr,
				outputs: outputs.map((o) => create(OutputSchema, o)),
				status,
				error: failure?.error ?? ''
			})
		});
		return outputs.reduce((sum, o) => sum + Number(o.narSize), 0);
	}

	/**
	 * Nix's status and message for a failed build, colors included, as a
	 * builder reports them. Builders made failing by `failing` crash on
	 * every build, so the demo tells a broken builder from a broken job.
	 */
	#failure(d: Drv, workerAddr: string): { status: DrvGone_Status; error: string } {
		const rng = this.#rng2;
		const path = d.path;
		const failing = this.#workers.find((w) => w.addr === workerAddr)?.failing ?? false;
		let status = DrvGone_Status.PERMANENT_FAILURE;
		if (!failing) {
			let r = rng.next();
			for (const [s, p] of FAILURES) {
				status = s;
				if ((r -= p) < 0) break;
			}
		}
		// The same draws as before the logs existed, so a seed keeps its farm.
		if (!failing && status !== DrvGone_Status.TIMED_OUT) rng.pick(TAILS);
		const error = nixMessage(path, this.#logPlan(d), {
			outcome: DrvGone_Outcome.FAILED,
			status,
			failing
		});
		return { status, error };
	}

	#progressFields(d: Drv) {
		const r = this.#reported(d);
		if (!r) return {};
		return {
			buildPhase: r.phase,
			buildStartedMs: BigInt(Math.round(r.startedMs)),
			buildPhaseStartedMs: BigInt(Math.round(r.phaseStartedMs))
		};
	}

	#logPlan(d: Drv): LogPlan {
		return (d.log ??= planLog({
			seed: this.options.seed,
			drvPath: d.path,
			name: drvName(d.path),
			system: d.system,
			assignId: d.assignId,
			plannedMs: d.plannedMs,
			logsize: this.options.logsize
		}));
	}

	/** A running build's start and stdenv phase, as its builder reports them. */
	#reported(d: Drv): { startedMs: number; phase: string; phaseStartedMs: number } | null {
		if (!this.options.progress || d.phase !== 'assigned' || !(d.startedMs <= this.now)) return null;
		const sim = (this.now - d.startedMs) * this.options.speed;
		const p = d.plannedMs ? phaseAt(this.#logPlan(d), sim) : null;
		return {
			startedMs: d.startedMs,
			phase: p?.phase ?? '',
			phaseStartedMs: p ? d.startedMs + p.startedMs / this.options.speed : 0
		};
	}

	/** The builders' reports: one progress event per build that started or changed phase. */
	#progress() {
		for (const w of this.#workers) {
			for (const d of w.running) {
				const r = this.#reported(d);
				if (!r || (d.reportedStart && r.phase === d.reportedPhase)) continue;
				d.reportedStart = true;
				d.reportedPhase = r.phase;
				this.#emit({ case: 'drv', value: this.#drvMsg(d, DrvState_Cause.PROGRESS) });
			}
		}
	}

	#record(r: DoneRec) {
		// Whole ms, as the scheduler sends them, so paging by before_ms is exact.
		r.finishedMs = Math.round(r.finishedMs);
		r.assignedMs = Math.round(r.assignedMs);
		r.startedMs = Math.round(r.startedMs);
		this.#builds.push(r);
		if (r.outcome === DrvGone_Outcome.FAILED) this.#failures.push(r);
		if (this.#builds.length > RING_BUILDS + 500)
			this.#builds.splice(0, this.#builds.length - RING_BUILDS);
		if (this.#failures.length > RING_FAILURES + 100)
			this.#failures.splice(0, this.#failures.length - RING_FAILURES);
		for (const fn of this.#ended)
			fn(r.path, r.assignId, {
				outcome: r.outcome,
				status: r.status,
				failing: r.failing
			});
	}

	/**
	 * Builds "from before the page opened": `history` of them over the
	 * HISTORY_SPAN_MS before start, from hash, with the farm's builders and
	 * the derivations of its start pools. Draws nothing from #rng.
	 */
	#synthesizeBuilds(startMs: number) {
		const n = this.options.history;
		if (n === 0) return;
		const seed = this.options.seed;
		const span = HISTORY_SPAN_MS / this.options.speed;
		const oldest = this.#builds[0]?.finishedMs ?? startMs;
		const made: DoneRec[] = [];
		for (let i = 0; i < n; i++) {
			const h = hash32(seed, i, 'history');
			const w = this.#workers[h % this.#workers.length];
			if (!w) break;
			const pool = this.#popular.get(w.systems[0]) ?? [];
			const path = pool.length ? pool[(h >>> 8) % pool.length].path : this.#path('hello-2.12.1');
			// Before the farm's own first build, so the ring stays in finish order.
			const finishedMs = Math.round(Math.min(oldest, startMs) - 1000 - ((i + 0.5) / n) * span);
			const plannedMs = 2000 + (hash32(h, 'ms') % 600_000);
			const assignedMs = Math.round(finishedMs - plannedMs / this.options.speed - 1000);
			const f = (hash32(h, 'outcome') % 10_000) / 10_000;
			const outcome =
				f < (w.failing ? 0.8 : this.options.fail)
					? DrvGone_Outcome.FAILED
					: f > 0.99
						? DrvGone_Outcome.CANCELLED
						: DrvGone_Outcome.BUILT;
			const assignId = 1_000_000_000 + i;
			const rec: DoneRec = {
				path,
				system: w.systems[0],
				worker: w.addr,
				outcome,
				status:
					outcome === DrvGone_Outcome.BUILT
						? DrvGone_Status.BUILT
						: outcome === DrvGone_Outcome.FAILED
							? FAILURES[hash32(h, 'status') % FAILURES.length][0]
							: DrvGone_Status.UNSPECIFIED,
				error: '',
				assignId,
				assignedMs,
				startedMs: this.options.progress ? assignedMs + 800 : 0,
				finishedMs,
				plannedMs,
				requestedBy: [this.#ciRunners[h % this.#ciRunners.length]],
				failing: w.failing
			};
			if (outcome === DrvGone_Outcome.FAILED)
				rec.error = nixMessage(
					path,
					planLog({
						seed,
						drvPath: path,
						name: drvName(path),
						system: rec.system,
						assignId,
						plannedMs,
						logsize: this.options.logsize
					}),
					{ outcome, status: rec.status, failing: w.failing }
				);
			made.push(rec);
		}
		made.reverse();
		this.#builds = [...made, ...this.#builds];
		this.#failures = [
			...made.filter((r) => r.outcome === DrvGone_Outcome.FAILED),
			...this.#failures
		];
	}

	#drvMsg(d: Drv, cause: DrvState_Cause): DrvState {
		const ids: bigint[] = [];
		for (const n of d.waiters) {
			const id = BigInt(n.job.id);
			if (!ids.includes(id)) ids.push(id);
		}
		const assigned = d.phase === 'assigned' && d.worker;
		let sources: InputSource[] = [];
		let unknown = 0;
		// A progress report repeats the assignment's sources.
		if (assigned && cause === DrvState_Cause.PROGRESS && d.sources) {
			sources = d.sources.list;
			unknown = d.sources.unknown;
		} else if (assigned) {
			const by = new Map<string, { paths: number; bytes: number }>();
			let known = 0;
			for (const p of d.deps) {
				const b = this.#builtOn.get(p);
				if (!b) continue;
				known++;
				const e = by.get(b.worker) ?? { paths: 0, bytes: 0 };
				e.paths++;
				e.bytes += b.bytes;
				by.set(b.worker, e);
			}
			sources = [...by].map(([workerAddr, e]) =>
				create(InputSourceSchema, { workerAddr, paths: e.paths, narBytes: BigInt(e.bytes) })
			);
			unknown = d.inputs - known;
			d.sources = { list: sources, unknown };
		}
		return create(DrvStateSchema, {
			drvPath: d.path,
			phase:
				d.phase === 'assigned'
					? DrvState_Phase.ASSIGNED
					: d.phase === 'unplaceable'
						? DrvState_Phase.UNPLACEABLE
						: DrvState_Phase.QUEUED,
			cause,
			system: d.system,
			features: d.features,
			clientIds: ids,
			queuedMs: BigInt(Math.round(d.queuedMs)),
			cpHintMs: BigInt(d.cp),
			inputs: d.inputs,
			cacheChecked: d.cacheChecked,
			reason: d.reason,
			workerAddr: assigned ? d.worker!.addr : '',
			assignId: assigned ? BigInt(d.assignId) : 0n,
			assignedMs: assigned ? BigInt(Math.round(d.assignedMs)) : 0n,
			inputSources: sources,
			inputsUnknown: unknown,
			...this.#progressFields(d)
		});
	}

	// ------------------------------------------------------------ clients

	#path(name: string) {
		return `${this.#rng.hash()}-${name}.drv`;
	}

	#startJob(kind: 'ci' | 'user' | 'stuck' | 'hook'): Job {
		const rng = this.#rng;
		const job: Job = {
			id: this.#nextClient++,
			identity:
				kind === 'ci'
					? rng.pick(this.#ciRunners)
					: kind === 'hook'
						? rng.pick(HOOK_HOSTS)
						: rng.pick(USERS),
			connectedMs: this.now,
			nodes: [],
			ready: [],
			inFlight: 0,
			maxBuilds: kind === 'ci' ? 64 : kind === 'user' ? rng.pick([16, 32, 64]) : 8,
			keepGoing: kind === 'ci' ? rng.chance(0.7) : rng.chance(0.2),
			ended: false,
			hook: kind === 'hook',
			remaining: 0
		};
		this.#jobs.set(job.id, job);
		this.#emit({
			case: 'client',
			value: create(ClientStateSchema, {
				id: BigInt(job.id),
				identity: job.identity,
				connectedMs: BigInt(Math.round(this.now))
			})
		});
		const system = this.#pickSystem();
		if (kind === 'stuck') {
			// Wants that no builder can take: a missing feature or system.
			const cuda = rng.chance(0.6);
			this.#dag(job, rng.int(1, 4), cuda ? system : 'riscv64-linux', cuda ? ['cuda'] : []);
		} else if (kind === 'hook') {
			this.#dag(job, 1, system, null);
		} else {
			this.#dag(job, kind === 'ci' ? rng.int(60, 320) : rng.int(5, 60), system, null);
		}
		job.remaining = job.nodes.length;
		// The client takes a moment to upload before it sends its Wants.
		this.#after(rng.int(20, 400), () => this.#pump(job));
		return job;
	}

	/** Weighted by slots, so every builder pool gets work. */
	#pickSystem() {
		const total = this.#workers.reduce((s, w) => s + w.maxJobs, 0);
		let r = this.#rng.next() * total;
		for (const w of this.#workers) {
			r -= w.maxJobs;
			if (r < 0) return w.systems[0];
		}
		return this.options.systems[0];
	}

	/** A layered DAG: each node depends on one to three nodes one layer down. */
	#dag(job: Job, size: number, system: string, features: string[] | null) {
		const rng = this.#rng;
		const depth = size === 1 ? 1 : Math.min(size, rng.int(2, 6));
		const layers: Node[][] = [];
		let left = size;
		for (let k = 0; k < depth; k++) {
			const width =
				k === depth - 1 ? left : Math.max(1, Math.round((left * 1.6) / (depth - k + 0.6)));
			left -= width;
			const layer: Node[] = [];
			for (let i = 0; i < width; i++) {
				let path: string;
				const pool = this.#popular.get(system);
				const popular =
					pool && features === null && (k === 0 || job.hook) && rng.chance(job.hook ? 0.6 : 0.35);
				if (popular) {
					const slot = rng.int(0, pool.length - 1);
					if (rng.chance(0.02)) pool[slot] = { path: this.#path(rng.pick(NAMES)) };
					path = pool[slot].path;
				} else {
					// The same draws whatever the options, so a seed gives the same farm.
					const project = rng.pick(PROJECTS);
					const part = rng.pick(PARTS);
					const n = rng.int(1, 999);
					// With nixoslog, a NixOS test is named after the real test whose log it shows.
					const log = part === 'vm-test' ? this.options.nixoslog : null;
					path = this.#path(log ? `vm-test-run-${log}-${n}` : `${project}-${part}-${n}`);
				}
				let feats = features ?? [];
				if (features === null && !popular) feats = this.#needs(system);
				const node: Node = {
					path,
					system,
					features: feats,
					deps: [],
					dependents: [],
					cp: 0,
					inputs: rng.int(1, 6),
					pending: 0,
					state: 'blocked',
					preCached: !popular && rng.chance(0.12),
					job
				};
				if (k > 0) {
					const below = layers[k - 1];
					const n = Math.min(below.length, rng.int(1, 3));
					for (let j = 0; j < n; j++) {
						const dep = rng.pick(below);
						if (node.deps.includes(dep)) continue;
						node.deps.push(dep);
						dep.dependents.push(node);
					}
					node.inputs += node.deps.length;
					node.pending = node.deps.length;
				}
				layer.push(node);
			}
			layers.push(layer);
			if (left <= 0) break;
		}
		// The client's hint: 1 s per drv on the longest chain of dependants.
		for (let k = layers.length - 1; k >= 0; k--) {
			for (const n of layers[k]) {
				let max = 0;
				for (const d of n.dependents) if (d.cp > max) max = d.cp;
				n.cp = job.hook ? 0 : 1000 + max;
			}
		}
		for (const layer of layers) {
			for (const n of layer) {
				job.nodes.push(n);
				if (n.pending === 0) {
					n.state = 'ready';
					job.ready.push(n);
				}
			}
		}
		job.ready.sort((a, b) => a.cp - b.cp);
	}

	/**
	 * The features a new derivation needs, among those some builder of the
	 * system offers: about 88% none, 7% big-parallel, 4% kvm and nixos-test
	 * for NixOS tests, a few kvm alone, and rarely benchmark.
	 */
	#needs(system: string): string[] {
		const f = this.#rng.next();
		const offered = this.#featuresOf.get(system);
		const can = (need: string[]) => need.every((x) => offered?.has(x));
		const need =
			f < 0.07
				? ['big-parallel']
				: f < 0.11
					? ['kvm', 'nixos-test']
					: f < 0.118
						? ['kvm']
						: f < 0.12
							? ['benchmark']
							: [];
		return can(need) ? need : [];
	}

	#pump(job: Job) {
		if (job.ended) return;
		while (job.inFlight < job.maxBuilds && job.ready.length > 0) this.#want(job.ready.pop()!);
		this.#maybeEnd(job);
	}

	#want(n: Node) {
		const job = n.job;
		n.state = 'wanted';
		job.inFlight++;
		const d = this.#drvs.get(n.path);
		if (d) {
			d.waiters.push(n);
			this.#emit({ case: 'drv', value: this.#drvMsg(d, DrvState_Cause.FOLLOWERS) });
			return;
		}
		const checked = this.options.cache && this.#rng.chance(0.97);
		if (checked && (n.preCached || this.#builtOn.has(n.path))) {
			this.#counters.cacheHits++;
			this.#emit({
				case: 'cached',
				value: create(DrvCachedSchema, {
					drvPath: n.path,
					system: n.system,
					clientId: BigInt(job.id)
				})
			});
			this.#after(this.#rng.int(5, 60), () => this.#nodeDone(n, true));
			return;
		}
		if (checked) this.#counters.cacheMisses++;
		this.#counters.wanted++;
		const nd: Drv = {
			path: n.path,
			system: n.system,
			features: n.features,
			qkey: `${n.system}|${featureKey(n.features)}`,
			waiters: [n],
			phase: 'queued',
			queuedMs: this.now,
			cp: n.cp,
			inputs: n.inputs,
			deps: n.deps.map((x) => x.path),
			cacheChecked: checked,
			reason: '',
			worker: null,
			assignId: 0,
			assignedMs: 0,
			plannedMs: 0,
			startedMs: 0,
			log: null,
			reportedStart: false,
			reportedPhase: '',
			sources: null,
			token: 0
		};
		this.#drvs.set(nd.path, nd);
		this.#enqueue(nd);
		if (nd.phase === 'unplaceable') {
			nd.reason = this.#unplaceableReason(nd);
			// The client gives up after its restart grace of 120 s.
			this.#later(120_000, () => {
				if (n.state === 'wanted' && this.#drvs.get(n.path)?.phase === 'unplaceable')
					this.#endJob(job);
			});
		}
		this.#emit({ case: 'drv', value: this.#drvMsg(nd, DrvState_Cause.WANTED) });
		this.#tryAssign(nd);
	}

	#nodeDone(n: Node, ok: boolean) {
		const job = n.job;
		if (job.ended || n.state !== 'wanted') return;
		job.inFlight--;
		job.remaining--;
		if (ok) {
			n.state = 'done';
			for (const d of n.dependents) {
				if (--d.pending === 0 && d.state === 'blocked') {
					d.state = 'ready';
					job.ready.push(d);
				}
			}
			job.ready.sort((a, b) => a.cp - b.cp);
		} else {
			n.state = 'failed';
			if (!job.keepGoing) {
				this.#after(this.#rng.int(100, 2000), () => this.#endJob(job));
				return;
			}
		}
		this.#pump(job);
	}

	#maybeEnd(job: Job) {
		if (job.ended || job.inFlight > 0 || job.ready.length > 0) return;
		this.#after(this.#rng.int(50, 800), () => this.#endJob(job));
	}

	/** The client goes away: drop what only it wanted, then ClientGone. */
	#endJob(job: Job) {
		if (job.ended) return;
		job.ended = true;
		for (const n of job.nodes) {
			if (n.state !== 'wanted') continue;
			n.state = 'failed';
			const d = this.#drvs.get(n.path);
			if (!d) continue;
			d.waiters = d.waiters.filter((x) => x !== n);
			if (d.waiters.length > 0) {
				this.#emit({ case: 'drv', value: this.#drvMsg(d, DrvState_Cause.FOLLOWERS) });
			} else if (d.phase !== 'assigned') {
				this.#gone(d, DrvGone_Outcome.DROPPED, '');
			} else {
				// An orphan: revoked after a grace period unless someone wants it again.
				const token = d.token;
				this.#later(10_000, () => {
					if (d.token !== token || d.waiters.length > 0 || d.phase !== 'assigned') return;
					const w = d.worker!;
					this.#unassign(d);
					this.#gone(d, DrvGone_Outcome.DROPPED, w.addr);
					this.#fill(w);
				});
			}
		}
		this.#jobs.delete(job.id);
		this.#emit({ case: 'clientGone', value: create(ClientGoneSchema, { id: BigInt(job.id) }) });
	}

	#scheduleHook() {
		// Hook-mode builds: one short-lived client per derivation.
		const perSec = Math.max(0.2, this.options.builders / 20) * this.options.speed;
		this.#after(this.#rng.exp(1000 / perSec), () => {
			this.#startJob('hook');
			this.#scheduleHook();
		});
	}

	// Start jobs while fewer derivations are in flight than the target.
	// Counts the first Wants of jobs that have not sent them yet.
	#control() {
		let expected = this.#drvs.size;
		for (const j of this.#jobs.values())
			if (j.inFlight === 0 && !j.ended) expected += Math.min(j.maxBuilds, j.ready.length);
		const target = this.options.inFlight;
		for (let i = 0; i < 8 && expected < target; i++) {
			const r = this.#rng.next();
			const kind = r < 0.04 ? 'stuck' : r < 0.6 ? 'ci' : 'user';
			const j = this.#startJob(kind);
			expected += Math.min(j.maxBuilds, j.ready.length);
		}
	}

	// ---------------------------------------------------------------- stats

	// Mirrors sched::Core::stats(): drvs keyed by what they require, workers
	// by what they offer.
	#stats() {
		if (this.#muted) return;
		// The scheduler sends what builders reported, at most once a second per
		// builder, before the Stats. Builders report at most every REPORT_MS.
		for (const w of this.#workers) {
			if (!w.dirty || !w.up || this.now - w.lastReportMs < REPORT_MS) continue;
			w.dirty = false;
			w.lastReportMs = this.now;
			w.reportedFree = w.diskFree;
			this.#report(w);
			this.#emit({ case: 'worker', value: this.#workerMsg(w) });
		}
		const by = new Map<
			string,
			{ s: string; f: string; q: number; u: number; r: number; sl: number; fr: number }
		>();
		const at = (s: string, f: string) => {
			const k = `${s}|${f}`;
			let e = by.get(k);
			if (!e) by.set(k, (e = { s, f, q: 0, u: 0, r: 0, sl: 0, fr: 0 }));
			return e;
		};
		for (const w of this.#workers) {
			if (w.systems.length === 0) continue;
			const e = at(w.systems[0], featureKey(w.features));
			e.r += w.running.size;
			if (!this.#takesWork(w)) continue;
			e.sl += w.maxJobs;
			e.fr += Math.max(0, w.maxJobs - w.running.size);
		}
		for (const q of this.#queues.values()) {
			if (q.members.size === 0) continue;
			const e = at(q.system, featureKey(q.features));
			e.q += q.members.size;
			if (!q.placeable) e.u += q.members.size;
		}
		for (const s of this.options.systems) at(s, '');
		this.#emit({
			case: 'stats',
			value: create(StatsSchema, {
				totals: this.#countersMsg(this.#counters, this.#subTotals),
				systems: [...by.values()].map((e) =>
					create(SystemStatsSchema, {
						system: e.s,
						features: e.f,
						queued: e.q,
						unplaceable: e.u,
						running: e.r,
						slots: e.sl,
						free: e.fr
					})
				)
			})
		});
	}

	/** A builder's report reaches the scheduler: its traffic goes into the farm's totals. */
	#report(w: Worker) {
		for (const [url, t] of w.subs) {
			const was = w.reportedSubs.get(url) ?? { nar: 0, download: 0, paths: 0, failures: 0 };
			let sum = this.#subTotals.get(url);
			if (!sum) this.#subTotals.set(url, (sum = { nar: 0, download: 0, paths: 0, failures: 0 }));
			sum.nar += t.nar - was.nar;
			sum.download += t.download - was.download;
			sum.paths += t.paths - was.paths;
			sum.failures += t.failures - was.failures;
			w.reportedSubs.set(url, { ...t });
		}
	}

	#sampleHistory() {
		this.#history.push({ t: this.now, c: { ...this.#counters }, subs: this.#subsSnapshot() });
		if (this.#history.length > 60) this.#history.shift();
	}

	// Pretend the farm ran at the warm-up rates since servingSinceMs, and
	// make up a minute-by-minute history for the last hour.
	#synthesizeHistory(startMs: number, warmupMs: number) {
		const c = this.#counters;
		const ran = startMs - this.servingSinceMs;
		const scale = (ran - warmupMs) / warmupMs;
		const rates = { ...c };
		for (const k of COUNTER_KEYS) {
			rates[k] = c[k] / warmupMs;
			c[k] = Math.round(c[k] * (1 + scale));
		}
		// Builders reported their warm-up traffic, scaled like the counters, so
		// the first live report adds only what is new.
		const grow = (t: Traffic) => {
			t.nar = Math.round(t.nar * (1 + scale));
			t.download = Math.round(t.download * (1 + scale));
			t.paths = Math.round(t.paths * (1 + scale));
			t.failures = Math.round(t.failures * (1 + scale));
		};
		for (const w of this.#workers) {
			this.#report(w);
			w.dirty = false;
			for (const t of w.subs.values()) grow(t);
			for (const t of w.reportedSubs.values()) grow(t);
		}
		const subRates = new Map<string, Traffic>();
		for (const [url, t] of this.#subTotals) {
			subRates.set(url, {
				nar: t.nar / warmupMs,
				download: t.download / warmupMs,
				paths: t.paths / warmupMs,
				failures: t.failures / warmupMs
			});
			grow(t);
		}
		const hist: CounterSample[] = [];
		let t = startMs - (startMs % 60_000);
		const cur = { ...c };
		const curSubs = new Map([...this.#subTotals].map(([u, x]) => [u, { ...x }]));
		for (let i = 0; i < 60 && t - 60_000 > this.servingSinceMs; i++) {
			const f = Math.max(0.2, 1 + 0.15 * this.#rng.normal());
			for (const k of COUNTER_KEYS)
				cur[k] = Math.max(0, Math.round(cur[k] - rates[k] * 60_000 * f));
			for (const [url, x] of curSubs) {
				const r = subRates.get(url)!;
				x.nar = Math.max(0, Math.round(x.nar - r.nar * 60_000 * f));
				x.download = Math.max(0, Math.round(x.download - r.download * 60_000 * f));
				x.paths = Math.max(0, Math.round(x.paths - r.paths * 60_000 * f));
				x.failures = Math.max(0, Math.round(x.failures - r.failures * 60_000 * f));
			}
			t -= 60_000;
			hist.push({
				t,
				c: { ...cur },
				subs: new Map([...curSubs].map(([u, x]) => [u, { ...x }]))
			});
		}
		this.#history = hist.reverse();
	}
}

/**
 * Nix's message for a failed build, colors included, worded as Nix 2.36
 * words each status. Only a builder that exited with an error gets the
 * log's last 25 lines, log-lines' default.
 */
function nixMessage(path: string, plan: LogPlan, end: LogEnding): string {
	const drv = `/nix/store/${path}`;
	const out = drv.slice(0, -4);
	const red = (x: string) => `\x1b[31;1m${x}\x1b[0m`;
	// Nix colors what it formats into a message.
	const arg = (x: string) => `\x1b[35;1m${x}\x1b[0m`;
	// Nix indents every line after the first under "error: ".
	const error = (msg: string) => `${red('error:')} ${msg.replaceAll('\n', '\n       ')}`;
	switch (end.status) {
		case DrvGone_Status.TIMED_OUT:
			return error(`timed out after ${arg('3600')} seconds`);
		case DrvGone_Status.LOG_LIMIT_EXCEEDED:
			return error(
				`${arg(`building derivation '${drv}'`)} killed after writing more than ${arg('67108864')} bytes of log output`
			);
		case DrvGone_Status.NOT_DETERMINISTIC:
			return error(
				`derivation '${arg(drv)}' may not be deterministic: output ${arg(`"${out}"`)} differs`
			);
		case DrvGone_Status.OUTPUT_REJECTED: {
			const gcc = `/nix/store/${[...path.slice(0, 32)].reverse().join('')}-gcc-14.3.0`;
			return error(
				`output '${arg(out)}' is not allowed to refer to the following paths:${arg(`\n  ${gcc}`)}`
			);
		}
	}
	// make exits with 2. A fetcher, a failed fixup check and the NixOS test driver exit with 1.
	const code =
		!end.failing &&
		(plan.profile === 'nixos-test' ||
			end.status === DrvGone_Status.TRANSIENT_FAILURE ||
			end.status === DrvGone_Status.MISC_FAILURE)
			? 1
			: 2;
	const lines = tail(plan, end, 25);
	return error(
		[
			`Cannot build '${arg(drv)}'.`,
			`Reason: ${red(`builder failed with exit code ${code}`)}.`,
			'Output paths:',
			`  ${out}`,
			`Last ${lines.length} log lines:`,
			...lines.map((l) => `> ${l}`),
			'For full logs, run:',
			`  \x1b[1mnix log ${drv}\x1b[0m`
		].join('\n')
	);
}

// ------------------------------------------------------------------ source

/** Delay before the simulated stream opens. */
const CONNECT_DELAY_MS = 250;
/** How often events are delivered. */
const TICK_MS = 100;
/** Wait after a seq gap before reconnecting, shown as "retrying". */
const RETRY_DELAY_MS = 1000;

/** Feed a MockFarm into a sink like a live stream would. */
export function startMockSource(options: MockOptions, sink: SourceSink): Source {
	const farm = new MockFarm(options, Date.now());
	let streaming = false;
	let stopped = false;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let last = Date.now();

	const connect = (attempt: number) => {
		streaming = false;
		sink.status({ kind: 'connecting', attempt });
		connectTimer = setTimeout(() => {
			if (stopped) return;
			const now = Date.now();
			farm.advance(now, true);
			last = now;
			sink.beginStream();
			sink.status({ kind: 'syncing' });
			const r = sink.events(farm.snapshot());
			if (!r.ok) {
				connect(attempt + 1);
				return;
			}
			streaming = true;
			sink.status({ kind: 'live', sinceMs: now });
		}, CONNECT_DELAY_MS);
	};

	// A gap shows as a short "retrying" so the demo makes recovery visible. The
	// live source reconnects at once instead; the reducer handles both alike.
	const retry = (error: string) => {
		streaming = false;
		sink.status({
			kind: 'retrying',
			attempt: 1,
			retryAtMs: Date.now() + RETRY_DELAY_MS,
			error: `The stream skipped events (${error}).`
		});
		connectTimer = setTimeout(() => {
			if (!stopped) connect(1);
		}, RETRY_DELAY_MS);
	};

	const tick = setInterval(() => {
		if (!streaming || stopped) return;
		const now = Date.now();
		// After a long pause, as in a hidden tab, take a fresh snapshot rather than
		// replaying minutes of events at once.
		if (now - last > 30_000) {
			connect(1);
			return;
		}
		last = now;
		const batch = farm.advance(now);
		if (batch.length === 0) return;
		const r = sink.events(batch);
		if (!r.ok) retry(r.error);
	}, TICK_MS);

	const gapTimer =
		options.gapEvery > 0 ? setInterval(() => farm.injectGap(), options.gapEvery * 1000) : undefined;

	// The log viewer of a build: ticks while it watches, its start and its end.
	type Watch = { path: string; assignId: number; fn: (e: DemoLogEvent) => void; started: boolean };
	const watches = new Set<Watch>();
	let logTimer: ReturnType<typeof setInterval> | undefined;
	const offEnded = farm.onEnded((path, assignId, ending) => {
		for (const w of [...watches])
			if (w.path === path && (!w.assignId || w.assignId === assignId))
				w.fn({ kind: 'ended', ending, nowMs: farm.now });
	});
	const logTick = () => {
		for (const w of watches) {
			if (!w.started) {
				const p = farm.logPlan(w.path, w.assignId);
				if (p.startedMs !== null && !p.ending) {
					w.started = true;
					w.fn({ kind: 'started', startedMs: p.startedMs });
				}
			}
			w.fn({ kind: 'tick', nowMs: farm.now });
		}
	};
	const logs: LogBackend = options.logs
		? {
				kind: 'demo',
				plan: (path, assignId) => farm.logPlan(path, assignId),
				subscribe(path, assignId, fn) {
					const w: Watch = {
						path,
						assignId,
						fn,
						started: farm.logPlan(path, assignId).startedMs !== null
					};
					watches.add(w);
					logTimer ??= setInterval(logTick, 250);
					return () => {
						watches.delete(w);
						if (watches.size === 0) {
							clearInterval(logTimer);
							logTimer = undefined;
						}
					};
				}
			}
		: { kind: 'none' };

	connect(1);

	return {
		logs,
		async *recentBuilds(req) {
			// As if over the network: the answer comes after this turn.
			await new Promise((resolve) => setTimeout(resolve, 0));
			for (const b of farm.recentBuilds(req)) yield b;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(tick);
			clearInterval(gapTimer);
			clearInterval(logTimer);
			offEnded();
			clearTimeout(connectTimer);
			sink.status({ kind: 'stopped' });
		}
	};
}
