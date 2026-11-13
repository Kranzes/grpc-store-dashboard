import { toBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DrvGone_Outcome,
	DrvGone_Status,
	DrvState_Cause,
	DrvState_Phase,
	WatchEventSchema,
	WorkerState_DrainReason,
	type DrvState,
	type Stats,
	type WatchEvent
} from '#lib/gen/events_pb.ts';
import { T0, reducerSink } from '#lib/model/fixtures.ts';
import { FarmReducer } from '#lib/model/reducer.ts';
import type { ConnectionStatus } from '#lib/model/types.ts';
import {
	DEFAULT_SYSTEMS,
	MockFarm,
	machineMix,
	mockOptions,
	parseMockOptions,
	startMockSource
} from './mock.ts';
import { finalLog, planLog } from './mock-log.ts';

/** What Nix 2.36 says for a failure that is not the builder exiting with an error. */
const NIX_SAYS = new Map<DrvGone_Status, string>([
	[DrvGone_Status.TIMED_OUT, 'timed out after'],
	[DrvGone_Status.LOG_LIMIT_EXCEEDED, 'killed after writing more than'],
	[DrvGone_Status.NOT_DETERMINISTIC, 'may not be deterministic: output'],
	[DrvGone_Status.OUTPUT_REJECTED, 'is not allowed to refer to the following paths:']
]);
describe('parseMockOptions', () => {
	it('has defaults that scale with the builder count', () => {
		expect(parseMockOptions(new URLSearchParams())).toEqual({
			builders: 12,
			systems: [...DEFAULT_SYSTEMS],
			shares: [2, 1],
			inFlight: 768,
			rate: 54,
			speed: 1,
			seed: 1,
			gapEvery: 0,
			cache: true,
			churn: 0,
			fail: 0.05,
			failing: 0,
			uptime: 0,
			lowdisk: 0,
			upstream: 3,
			logs: true,
			logsize: 1,
			nixoslog: null,
			history: 300,
			progress: true
		});
		expect(parseMockOptions(new URLSearchParams('builders=50'))).toMatchObject({
			builders: 50,
			inFlight: 3200,
			rate: 225
		});
	});

	it('reads every option', () => {
		const o = parseMockOptions(
			new URLSearchParams(
				'builders=8&systems=x86_64-linux, riscv64-linux&inflight=100&rate=30&speed=2.5&seed=42&gaps=30&cache=0&churn=6&fail=0.2&failing=3&uptime=5&lowdisk=2&upstream=1' +
					'&logs=0&logsize=6&nixoslog=openssh&history=0&progress=0'
			)
		);
		expect(o).toEqual({
			builders: 8,
			systems: ['x86_64-linux', 'riscv64-linux'],
			shares: [2, 1],
			inFlight: 100,
			rate: 30,
			speed: 2.5,
			seed: 42,
			gapEvery: 30,
			cache: false,
			churn: 6,
			fail: 0.2,
			failing: 3,
			uptime: 5,
			lowdisk: 2,
			upstream: 1,
			logs: false,
			logsize: 6,
			nixoslog: 'openssh',
			history: 0,
			progress: false
		});
	});

	it('starts the scheduler uptime minutes before the page, so its history is short', () => {
		const T = 1_800_000_000_000;
		const young = new MockFarm(mockOptions({ uptime: 5 }), T);
		expect(young.servingSinceMs).toBe(T - 5 * 60_000);
		// By default it served for hours.
		expect(new MockFarm(mockOptions(), T).servingSinceMs).toBeLessThan(T - 3 * 3600_000);
	});

	it('falls back or clamps on bad values', () => {
		const o = parseMockOptions(
			new URLSearchParams('builders=lots&systems=bad system!&inflight=-5&speed=0&seed=x&rate=1e9')
		);
		expect(o).toMatchObject({
			builders: 12,
			systems: [...DEFAULT_SYSTEMS],
			inFlight: 0,
			speed: 0.05,
			seed: 1,
			rate: 10_000
		});
		expect(parseMockOptions(new URLSearchParams('builders=5000')).builders).toBe(1000);
		expect(parseMockOptions(new URLSearchParams('churn=-3')).churn).toBe(0);
		expect(parseMockOptions(new URLSearchParams('upstream=9')).upstream).toBe(3);
		expect(parseMockOptions(new URLSearchParams('upstream=-1&lowdisk=2000'))).toMatchObject({
			upstream: 0,
			lowdisk: 1000
		});
		expect(parseMockOptions(new URLSearchParams('fail=2&failing=2.6'))).toMatchObject({
			fail: 1,
			failing: 3
		});
		expect(parseMockOptions(new URLSearchParams('fail=-1&failing=-4'))).toMatchObject({
			fail: 0,
			failing: 0
		});
		expect(parseMockOptions(new URLSearchParams('nixoslog=hello')).nixoslog).toBeNull();
	});

	it('reads builder counts per system', () => {
		const q = (s: string) => parseMockOptions(new URLSearchParams(s));
		// Every system counted: the counts are the builders.
		expect(q('systems=x86_64-linux:20,aarch64-linux:6')).toMatchObject({
			builders: 26,
			systems: ['x86_64-linux', 'aarch64-linux'],
			shares: [20, 6],
			inFlight: 26 * 64
		});
		// With builders as well, the counts are shares of it.
		expect(q('systems=x86_64-linux:3,aarch64-linux:1&builders=100')).toMatchObject({
			builders: 100,
			shares: [3, 1]
		});
		// A system without a count keeps its default share.
		expect(q('systems=x86_64-linux,aarch64-linux:2')).toMatchObject({
			builders: 12,
			shares: [2, 2]
		});
		// Bad entries drop out: a zero count, a bad name, a bad count.
		expect(
			q('systems=x86_64-linux:0,aarch64-linux:3,bad name:2,riscv64-linux:x,aarch64-darwin:-1')
		).toMatchObject({ builders: 3, systems: ['aarch64-linux'], shares: [3] });
		expect(q('systems=a:600,b:600').builders).toBe(1000);
		// Counts combine with the failure options.
		expect(q('systems=x86_64-linux:20,aarch64-linux:6&fail=0&failing=2')).toMatchObject({
			builders: 26,
			shares: [20, 6],
			fail: 0,
			failing: 2
		});
	});
});

/** Cloud instances register by their private address, owned machines by name. */
const CLOUD = /^10\.\d+\.\d+\.\d+:50051$/;
const isCloud = (addr: string) => CLOUD.test(addr);

function fingerprint(events: WatchEvent[]): string {
	let h = 2166136261;
	for (const e of events)
		for (const b of toBinary(WatchEventSchema, e)) h = Math.imul(h ^ b, 16777619);
	return `${events.length}:${(h >>> 0).toString(16)}`;
}

function run(
	seed: number,
	stepMs: number,
	untilMs: number,
	options: Parameters<typeof mockOptions>[0] = { builders: 6 }
): WatchEvent[] {
	const farm = new MockFarm(mockOptions({ ...options, seed }), T0);
	const out = [...farm.snapshot()];
	for (let t = T0 + stepMs; t <= T0 + untilMs; t += stepMs) out.push(...farm.advance(t));
	return out;
}

describe('MockFarm', () => {
	// Six runs of 2 to 5 simulated minutes, three with 60 builders, and the progress reports
	// add about 40% more events: about 4 s, more under load.
	it('is deterministic for a seed, whatever the tick length', { timeout: 60_000 }, () => {
		const a = fingerprint(run(5, 250, 120_000));
		expect(fingerprint(run(5, 1000, 120_000))).toBe(a);
		expect(fingerprint(run(6, 250, 120_000))).not.toBe(a);
		// Churn and spot interruptions too.
		const churn = { builders: 60, churn: 30 };
		const b = fingerprint(run(5, 250, 300_000, churn));
		expect(fingerprint(run(5, 1000, 300_000, churn))).toBe(b);
		expect(fingerprint(run(6, 1000, 300_000, churn))).not.toBe(b);
	});

	it('gives each system its share of the builders', () => {
		const bySystem = (o: Parameters<typeof mockOptions>[0]) =>
			new MockFarm(mockOptions(o), T0).inspect().bySystem;
		const systems = ['x86_64-linux', 'aarch64-linux', 'aarch64-darwin'];
		expect(bySystem({ builders: 30, systems, shares: [20, 6, 4] })).toEqual({
			'x86_64-linux': 20,
			'aarch64-linux': 6,
			'aarch64-darwin': 4
		});
		// The default: 2 shares for the first system, 1 for each other.
		expect(bySystem({ builders: 12 })).toEqual({ 'x86_64-linux': 8, 'aarch64-linux': 4 });
		expect(bySystem({ builders: 30, systems })).toEqual({
			'x86_64-linux': 15,
			'aarch64-linux': 8,
			'aarch64-darwin': 7
		});
	});

	it('is a hybrid farm: cloud VMs and instances with KVM, on demand and spot, and own metal', () => {
		const mix = (o: Parameters<typeof mockOptions>[0]) =>
			new MockFarm(mockOptions(o), T0).inspect().byMachine;
		// The default demo farm.
		expect(mix({})).toEqual({
			'x86_64-linux vm': 2,
			'x86_64-linux vm-spot': 2,
			'x86_64-linux kvm': 1,
			'x86_64-linux kvm-spot': 1,
			'x86_64-linux quiet': 1,
			'x86_64-linux metal': 1,
			'aarch64-linux vm': 1,
			'aarch64-linux vm-spot': 2,
			'aarch64-linux kvm': 1
		});
		// Other systems are owned machines.
		expect(machineMix('riscv64-linux', 2)).toEqual(['own', 'own']);
	});

	it('starts with every builder connected: maintenance waits for the first snapshot', () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const farm = new MockFarm(mockOptions({ builders: 30, seed }), T0);
			const up = farm.snapshot().filter((e) => e.event.case === 'worker' && e.event.value.up);
			expect(up, `seed ${seed}`).toHaveLength(30);
		}
	});

	it(
		'keeps the default demo healthy: no queue unplaceable but the stuck jobs',
		{ timeout: 60_000 },
		() => {
			const farm = new MockFarm(mockOptions(), T0);
			const stuck = (d: { system: string; features: string[] }) =>
				d.system === 'riscv64-linux' || d.features.includes('cuda');
			const bad = new Set<string>();
			const note = (e: WatchEvent) => {
				if (e.event.case !== 'drv' || e.event.value.phase !== DrvState_Phase.UNPLACEABLE) return;
				if (!stuck(e.event.value)) bad.add(`${e.event.value.system} ${e.event.value.features}`);
			};
			const snap = farm.snapshot();
			expect(snap.filter((e) => e.event.case === 'worker' && e.event.value.up)).toHaveLength(
				farm.options.builders
			);
			snap.forEach(note);
			for (let t = T0 + 1000; t <= T0 + 60 * 60_000; t += 1000) farm.advance(t).forEach(note);
			expect([...bad]).toEqual([]);
			expect(farm.inspect().interruptions).toEqual([]);
		}
	);

	it(
		'holds back only Graviton metal from maintenance while nothing covers it',
		{ timeout: 60_000 },
		() => {
			// aarch64-linux: a VM on demand, one on spot and the only Graviton metal.
			// aarch64-darwin: one Mac, alone in its system.
			const systems = ['aarch64-linux', 'aarch64-darwin'];
			const away = { mac: 0, metal: 0 };
			for (const seed of [1, 2, 3, 4, 5]) {
				const farm = new MockFarm(
					mockOptions({ builders: 4, systems, shares: [3, 1], speed: 4, seed }),
					T0
				);
				const kinds = farm.inspect().machines;
				const addr = (k: string) => Object.keys(kinds).filter((a) => kinds[a] === k);
				const [metal] = addr('aarch64-linux kvm');
				const [mac] = addr('aarch64-darwin own');
				expect([addr('aarch64-linux kvm'), addr('aarch64-darwin own')]).toEqual([[metal], [mac]]);
				const left = new Set<string>();
				// Two hours at speed 4: about five maintenance windows per builder.
				for (let t = T0 + 1000; t <= T0 + 30 * 60_000; t += 1000)
					for (const e of farm.advance(t))
						if (e.event.case === 'worker' && (!e.event.value.up || e.event.value.draining))
							left.add(e.event.value.addr);
				if (left.has(mac)) away.mac++;
				if (left.has(metal)) away.metal++;
			}
			expect(away.mac).toBeGreaterThanOrEqual(3);
			expect(away.metal).toBe(0);
		}
	);

	it('names owned machines and gives each kind its features', () => {
		const systems = ['x86_64-linux', 'aarch64-linux', 'aarch64-darwin'];
		const farm = new MockFarm(mockOptions({ builders: 30, systems, shares: [20, 6, 4] }), T0);
		const kinds = farm.inspect().machines;
		// Nix's default features, and the address each kind registers by.
		const nix = 'benchmark, big-parallel, nixos-test';
		const withKvm = 'benchmark, big-parallel, kvm, nixos-test';
		const x86 = 'x86_64-linux i686-linux';
		const expected: Record<string, [RegExp, string]> = {
			'x86_64-linux vm': [CLOUD, `${x86} · ${nix}`],
			'x86_64-linux vm-spot': [CLOUD, `${x86} · ${nix}`],
			'x86_64-linux kvm': [CLOUD, `${x86} · ${withKvm}`],
			'x86_64-linux kvm-spot': [CLOUD, `${x86} · ${withKvm}`],
			'x86_64-linux quiet': [/^metal-x86-quiet:50051$/, `${x86} · benchmark, kvm, nixos-test`],
			'x86_64-linux metal': [/^metal-x86-\d\d:50051$/, `${x86} · big-parallel, kvm, nixos-test`],
			'aarch64-linux vm': [CLOUD, `aarch64-linux · ${nix}`],
			'aarch64-linux vm-spot': [CLOUD, `aarch64-linux · ${nix}`],
			'aarch64-linux kvm': [CLOUD, `aarch64-linux · ${withKvm}`],
			'aarch64-darwin own': [/^mac-\d\d:50051$/, `aarch64-darwin · ${nix}`]
		};
		const offers: Record<string, string[]> = {};
		for (const e of farm.snapshot()) {
			if (e.event.case !== 'worker') continue;
			const w = e.event.value;
			const kind = kinds[w.addr];
			expect(w.addr, kind).toMatch(expected[kind]?.[0] ?? /^$/);
			const offer = `${w.systems.join(' ')} · ${w.features.join(', ') || '-'}`;
			offers[kind] = [...new Set([...(offers[kind] ?? []), offer])];
		}
		expect(offers).toEqual(
			Object.fromEntries(Object.entries(expected).map(([kind, [, offer]]) => [kind, [offer]]))
		);
	});

	it('needs features about as often as nixpkgs does', () => {
		const farm = new MockFarm(mockOptions({ builders: 12, seed: 4 }), T0);
		const needs = new Map<string, number>();
		let wanted = 0;
		for (let t = T0 + 1000; t <= T0 + 20 * 60_000; t += 1000) {
			for (const e of farm.advance(t)) {
				if (e.event.case !== 'drv' || e.event.value.cause !== DrvState_Cause.WANTED) continue;
				const k = e.event.value.features.join(',');
				if (k === 'cuda') continue;
				wanted++;
				needs.set(k, (needs.get(k) ?? 0) + 1);
			}
		}
		const share = (k: string) => (needs.get(k) ?? 0) / wanted;
		expect(wanted).toBeGreaterThan(5000);
		expect([...needs.keys()].sort()).toEqual([
			'',
			'benchmark',
			'big-parallel',
			'kvm',
			'kvm,nixos-test'
		]);
		expect(share('')).toBeCloseTo(0.88, 1);
		expect(share('big-parallel')).toBeCloseTo(0.07, 1);
		expect(share('kvm,nixos-test')).toBeGreaterThan(0.03);
		expect(share('kvm,nixos-test')).toBeLessThan(0.05);
		expect(share('kvm')).toBeLessThan(0.015);
		expect(share('benchmark')).toBeLessThan(share('kvm'));
	});

	it(
		'NixOS tests on aarch64 turn unplaceable while the autoscaler has no Graviton metal, and back',
		{ timeout: 60_000 },
		() => {
			// 9 builders: three on aarch64-linux, of which one, Graviton metal, offers kvm.
			expect(machineMix('aarch64-linux', 3)).toEqual(['vm', 'vm-spot', 'kvm']);
			const farm = new MockFarm(mockOptions({ builders: 9, churn: 30, seed: 2 }), T0);
			const r = new FarmReducer();
			r.beginStream();
			expect(r.apply(farm.snapshot(), T0).ok).toBe(true);
			const flips: string[] = [];
			const problems: string[] = [];
			for (let t = T0 + 1000; t <= T0 + 20 * 60_000; t += 1000) {
				const batch = farm.advance(t);
				const f = farm.inspect();
				const metal = f.working['aarch64-linux kvm'] ?? 0;
				for (const e of batch) {
					if (e.event.case !== 'drv' || e.event.value.cause !== DrvState_Cause.PLACEABILITY)
						continue;
					const d = e.event.value;
					if (d.system !== 'aarch64-linux' || !d.features.includes('kvm')) continue;
					const phase = d.phase === DrvState_Phase.UNPLACEABLE ? 'unplaceable' : 'queued';
					const k = `${d.features.join(',')} ${phase}`;
					if (flips.at(-1) !== k) flips.push(k);
					if (phase === 'unplaceable' && !d.reason.includes(`{${d.features.join(',')}}`))
						problems.push(d.reason);
					// Unplaceable exactly while no Graviton metal takes work.
					if ((phase === 'unplaceable') !== (metal === 0))
						problems.push(`${k} with ${metal} Graviton metal at ${t - T0}`);
				}
				const res = r.apply(batch, t);
				if (!res.ok) problems.push(res.error);
				const c = r.counts();
				if (c.queued !== f.queued || c.unplaceable !== f.unplaceable)
					problems.push(
						`${c.queued}/${c.unplaceable} vs ${f.queued}/${f.unplaceable} at ${t - T0}`
					);
			}
			expect(problems.slice(0, 5)).toEqual([]);
			expect(flips).toContain('kvm,nixos-test unplaceable');
			expect(flips).toContain('kvm,nixos-test queued');
		}
	);

	it('fail and failing set the failure share', { timeout: 60_000 }, () => {
		// Built and failed per builder over 10 simulated minutes.
		const outcomes = (options: Parameters<typeof mockOptions>[0]) => {
			const farm = new MockFarm(mockOptions({ builders: 6, speed: 4, ...options }), T0);
			const by = new Map<string, { built: number; failed: number }>();
			for (let t = T0 + 1000; t <= T0 + 10 * 60_000; t += 1000) {
				for (const e of farm.advance(t)) {
					if (e.event.case !== 'drvGone') continue;
					const g = e.event.value;
					if (g.outcome !== DrvGone_Outcome.BUILT && g.outcome !== DrvGone_Outcome.FAILED) continue;
					let n = by.get(g.workerAddr);
					if (!n) by.set(g.workerAddr, (n = { built: 0, failed: 0 }));
					if (g.outcome === DrvGone_Outcome.BUILT) n.built++;
					else n.failed++;
				}
			}
			return by;
		};
		const share = (n: { built: number; failed: number }) => n.failed / (n.built + n.failed);

		// The first builder the farm creates, 10.0.0.10, fails 80%; the rest never fail.
		const one = outcomes({ fail: 0, failing: 1 });
		expect(one.size).toBe(6);
		for (const [addr, n] of one) {
			expect(n.built + n.failed, addr).toBeGreaterThan(100);
			if (addr === '10.0.0.10:50051') expect(share(n)).toBeCloseTo(0.8, 1);
			else expect(n.failed, addr).toBe(0);
		}

		// Half of everything fails on every builder.
		let built = 0;
		let failed = 0;
		for (const n of outcomes({ fail: 0.5 }).values()) {
			built += n.built;
			failed += n.failed;
		}
		expect(share({ built, failed })).toBeCloseTo(0.5, 1);
	});

	it(
		'every FAILED has a status other than unspecified, and failing builders report build-failed with the illegal instruction line',
		{ timeout: 60_000 },
		() => {
			const farm = new MockFarm(mockOptions({ builders: 6, speed: 4, failing: 1 }), T0);
			const statuses = new Set<DrvGone_Status>();
			let failed = 0;
			let failing = 0;
			for (let t = T0 + 1000; t <= T0 + 10 * 60_000; t += 1000) {
				for (const e of farm.advance(t)) {
					if (e.event.case !== 'drvGone') continue;
					const g = e.event.value;
					if (g.outcome === DrvGone_Outcome.BUILT) {
						expect([DrvGone_Status.BUILT, DrvGone_Status.SUBSTITUTED]).toContain(g.status);
						expect(g.error).toBe('');
						continue;
					}
					if (g.outcome !== DrvGone_Outcome.FAILED) {
						expect(g.status).toBe(DrvGone_Status.UNSPECIFIED);
						expect(g.error).toBe('');
						continue;
					}
					failed++;
					expect(g.status).not.toBe(DrvGone_Status.UNSPECIFIED);
					statuses.add(g.status);
					// Nix 2.36's words for each status, with its colors.
					const words = NIX_SAYS.get(g.status);
					if (words) {
						expect(g.error).toContain(words);
						expect(g.error).not.toContain('log lines:');
					} else {
						expect(g.error).toContain(`Cannot build '\x1b[35;1m/nix/store/${g.drvPath}\x1b[0m'.`);
						expect(g.error).toMatch(/Reason: .*builder failed with exit code [12]/);
						expect(g.error).toMatch(/Last \d+ log lines:\n {7}> /);
						expect(g.error).toContain('For full logs, run:');
					}
					if (g.workerAddr === '10.0.0.10:50051') {
						failing++;
						expect(g.status).toBe(DrvGone_Status.PERMANENT_FAILURE);
						expect(g.error).toContain('Illegal instruction (core dumped)');
					} else {
						expect(g.error).not.toContain('Illegal instruction');
					}
				}
			}
			expect(failing).toBeGreaterThan(100);
			expect(failed).toBeGreaterThan(failing);
			expect(statuses.has(DrvGone_Status.PERMANENT_FAILURE)).toBe(true);
		}
	);

	it('lowdisk starts the last builders low on disk, and a GC brings them back', () => {
		const farm = new MockFarm(mockOptions({ builders: 6, lowdisk: 2 }), T0);
		const snap = farm.snapshot().flatMap((e) => (e.event.case === 'worker' ? [e.event.value] : []));
		const low = snap.slice(-2);
		for (const w of low) {
			expect(w).toMatchObject({ draining: true, drainReason: WorkerState_DrainReason.LOW_DISK });
			expect(w.diskFreeBytes, w.addr).toBeLessThan(w.minFreeBytes ?? 0n);
		}
		for (const w of snap.slice(0, -2)) expect(w.draining).toBe(false);
		// After 5 minutes they take work again, with room on disk.
		const back = new Map<string, bigint>();
		for (let t = T0 + 1000; t <= T0 + 301_000; t += 1000)
			for (const e of farm.advance(t))
				if (e.event.case === 'worker' && !e.event.value.draining && e.event.value.up)
					back.set(e.event.value.addr, e.event.value.diskFreeBytes ?? 0n);
		for (const w of low)
			expect(back.get(w.addr) ?? 0n, w.addr).toBeGreaterThan(w.minFreeBytes ?? 0n);
	});

	it("maintenance sometimes stops a builder's nix-daemon, and the builder comes back", () => {
		// Few builds, so the run is mostly maintenance.
		const farm = new MockFarm(
			mockOptions({ builders: 12, speed: 20, inFlight: 12, rate: 0.5 }),
			T0
		);
		const hung = new Set<string>();
		const back = new Set<string>();
		for (let t = T0 + 1000; t <= T0 + 10 * 60_000; t += 1000)
			for (const e of farm.advance(t)) {
				if (e.event.case !== 'worker') continue;
				const w = e.event.value;
				if (w.draining && w.drainReason === WorkerState_DrainReason.LOCAL_DAEMON) hung.add(w.addr);
				else if (hung.has(w.addr) && w.up && !w.draining) back.add(w.addr);
			}
		expect(hung.size).toBeGreaterThan(0);
		expect([...hung].some((a) => back.has(a))).toBe(true);
	});

	it('upstream=0 lists no substituters, and every other value keeps the outcomes', () => {
		const run10 = (upstream: number) => {
			const farm = new MockFarm(mockOptions({ builders: 6, seed: 1, upstream }), T0);
			const out = [...farm.snapshot()];
			for (let t = T0 + 1000; t <= T0 + 10 * 60_000; t += 1000) out.push(...farm.advance(t));
			return out;
		};
		const outcomes = (events: WatchEvent[]) =>
			events.flatMap((e) =>
				e.event.case === 'drvGone' ? [`${e.event.value.drvPath} ${e.event.value.outcome}`] : []
			);
		const none = run10(0);
		for (const e of none)
			if (e.event.case === 'worker') expect(e.event.value.substituters).toEqual([]);
		const three = run10(3);
		expect(outcomes(none).length).toBeGreaterThan(500);
		expect(outcomes(three)).toEqual(outcomes(none));
		// The demo's machine classes: the farm cache, cache.nixos.org, nix-community on Linux.
		const lists = new Set(
			three.flatMap((e) =>
				e.event.case === 'worker' ? [e.event.value.substituters.map((x) => x.url).join(' ')] : []
			)
		);
		expect(lists).toContain(
			'https://cache.farm.example https://cache.nixos.org https://nix-community.cachix.org'
		);
	});

	it('Counters follow the WorkerStates', { timeout: 60_000 }, () => {
		const farm = new MockFarm(mockOptions({ builders: 12, seed: 2 }), T0);
		const last = new Map<string, Map<string, bigint>>();
		const sumOf = (subs: readonly { url: string; narBytes: bigint; paths: bigint }[]) =>
			new Map(subs.map((x) => [x.url, x.narBytes]));
		const take = (e: WatchEvent, grew: Map<string, bigint>) => {
			if (e.event.case !== 'worker') return;
			const w = e.event.value;
			const prev = last.get(w.addr) ?? new Map<string, bigint>();
			for (const x of w.substituters)
				grew.set(x.url, (grew.get(x.url) ?? 0n) + x.narBytes - (prev.get(x.url) ?? 0n));
			last.set(w.addr, sumOf(w.substituters));
		};
		for (const e of farm.snapshot()) take(e, new Map());
		let counters: Map<string, bigint> | null = null;
		let grew = new Map<string, bigint>();
		let checked = 0;
		for (let t = T0 + 500; t <= T0 + 10 * 60_000; t += 500) {
			for (const e of farm.advance(t)) {
				take(e, grew);
				if (e.event.case !== 'stats') continue;
				const now = sumOf(e.event.value.totals!.substituters);
				if (counters) {
					for (const url of new Set([...now.keys(), ...counters.keys()]))
						expect((now.get(url) ?? 0n) - (counters.get(url) ?? 0n), url).toBe(grew.get(url) ?? 0n);
					checked++;
				}
				counters = now;
				grew = new Map();
			}
		}
		expect(checked).toBeGreaterThan(500);
		expect(counters!.get('https://cache.nixos.org')).toBeGreaterThan(0n);
	});

	it('adds and retires cloud builders like an autoscaler with churn', { timeout: 60_000 }, () => {
		const farm = new MockFarm(mockOptions({ builders: 60, churn: 30, seed: 5 }), T0);
		const r = new FarmReducer();
		r.beginStream();
		expect(r.apply(farm.snapshot(), T0).ok).toBe(true);
		const first = new Set(r.views(T0, 15).topology.workers);
		const owned = [...first].filter((a) => !isCloud(a));
		expect(owned.length).toBeGreaterThan(0);
		// The cloud part at full size. The warm-up churned already.
		const size = farm.inspect().cloudSize;
		expect(size).toBeGreaterThan(0);
		const ownedKinds = () =>
			Object.entries(farm.inspect().byMachine).filter(([k]) => / (metal|quiet)$/.test(k));
		const ownedBefore = ownedKinds();
		const added = new Set<string>();
		let low = Infinity;
		let high = 0;
		const end = T0 + 10 * 60_000;
		for (let t = T0 + 1000; t <= end; t += 1000) {
			const batch = farm.advance(t);
			for (const e of batch)
				if (e.event.case === 'worker' && !first.has(e.event.value.addr))
					added.add(e.event.value.addr);
			const res = r.apply(batch, t);
			expect(res.ok, res.ok ? '' : res.error).toBe(true);
			const { cloudUp } = farm.inspect();
			low = Math.min(low, cloudUp);
			high = Math.max(high, cloudUp);
		}
		const v = r.views(end, 15);
		expect(v.scheduler.workersUp).toBe(farm.inspect().workersUp);
		// New cloud hosts joined; retired ones left and stay away.
		expect(added.size).toBeGreaterThan(20);
		expect([...added].filter((a) => !isCloud(a))).toEqual([]);
		const pools = [...v.pools.values()];
		const sum = (k: 'joined' | 'left') => pools.reduce((a, p) => a + p[k], 0);
		expect(sum('joined')).toBeGreaterThan(10);
		expect(sum('left')).toBeGreaterThan(10);
		const retired = [...first].filter((a) => !v.workers.get(a)?.up);
		expect(retired.filter(isCloud).length).toBeGreaterThan(5);
		// Owned machines stay, though maintenance may have one offline for a while.
		for (const a of owned) expect(v.workers.has(a), a).toBe(true);
		expect(ownedKinds()).toEqual(ownedBefore);
		// The cloud part swings between 70% and 100% of its size.
		expect(low).toBeGreaterThanOrEqual(Math.floor(0.7 * size) - 2);
		expect(low).toBeLessThanOrEqual(Math.ceil(0.75 * size));
		expect(high).toBeGreaterThanOrEqual(Math.floor(0.95 * size));
		expect(high).toBeLessThanOrEqual(size + 2);
	});

	it(
		'churns every cloud kind, cloud metal included, and never own metal or Macs',
		{ timeout: 60_000 },
		() => {
			const systems = ['x86_64-linux', 'aarch64-linux', 'aarch64-darwin'];
			const farm = new MockFarm(
				mockOptions({ builders: 60, systems, shares: [30, 20, 10], churn: 30, seed: 7 }),
				T0
			);
			const kinds = { ...farm.inspect().machines };
			const owned = Object.entries(kinds).filter(([a]) => !isCloud(a));
			// Only Macs and own metal register by name.
			expect(new Set(owned.map(([, k]) => k))).toEqual(
				new Set(['aarch64-darwin own', 'x86_64-linux metal', 'x86_64-linux quiet'])
			);
			const joined = new Set<string>();
			const left = new Set<string>();
			for (let t = T0 + 1000; t <= T0 + 20 * 60_000; t += 1000) {
				const batch = farm.advance(t);
				const now = farm.inspect().machines;
				for (const [a, k] of Object.entries(now)) {
					if (!(a in kinds)) joined.add(k);
					kinds[a] = k;
				}
				for (const e of batch)
					if (e.event.case === 'worker' && !e.event.value.up && !(e.event.value.addr in now))
						left.add(kinds[e.event.value.addr]);
			}
			const cloud = [
				'aarch64-linux kvm',
				'aarch64-linux vm',
				'aarch64-linux vm-spot',
				'x86_64-linux kvm',
				'x86_64-linux kvm-spot',
				'x86_64-linux vm',
				'x86_64-linux vm-spot'
			];
			expect([...joined].sort()).toEqual(cloud);
			expect([...left].sort()).toEqual(cloud);
			// Owned machines are all still there.
			const now = farm.inspect().machines;
			for (const [a, k] of owned) expect(now[a], a).toBe(k);
		}
	);

	it(
		'interrupts spot builders: two minutes of draining, then they go and their builds requeue',
		{ timeout: 120_000 },
		() => {
			// Builds of a minute on average, so some outlast the warning.
			const farm = new MockFarm(
				mockOptions({ builders: 60, churn: 30, rate: 60, seed: 5, upstream: 0 }),
				T0
			);
			const r = new FarmReducer();
			r.beginStream();
			const snap = farm.snapshot();
			expect(r.apply(snap, T0).ok).toBe(true);
			const before = farm.inspect().interruptions.length;
			const requeuedBefore = farm.inspect().counters.requeued;
			const problems: string[] = [];
			// Which builder each assigned drv runs on, from the stream.
			const on = new Map<string, string>();
			const warned = new Map<string, number>();
			let lost = 0;
			let requeued = 0;
			let left = 0;
			// Within one batch, per builder: the builds it lost, requeued or dropped.
			// Like the scheduler, the farm sends them before the builder's down event.
			type Lost = { requeued: number; dropped: number };
			const follow = (e: WatchEvent, lostAt: Map<string, Lost>) => {
				const ev = e.event;
				const note = (path: string, k: keyof Lost) => {
					const addr = on.get(path);
					if (addr === undefined || !warned.has(addr)) return;
					let n = lostAt.get(addr);
					if (!n) lostAt.set(addr, (n = { requeued: 0, dropped: 0 }));
					n[k]++;
				};
				if (ev.case === 'drv') {
					const d = ev.value;
					if (d.cause === DrvState_Cause.REQUEUED && d.reason === 'the worker disconnected')
						note(d.drvPath, 'requeued');
					if (d.phase === DrvState_Phase.ASSIGNED) on.set(d.drvPath, d.workerAddr);
					else on.delete(d.drvPath);
					const at = warned.get(d.workerAddr);
					if (d.cause === DrvState_Cause.ASSIGNED && at !== undefined && Number(e.timeMs) > at)
						problems.push(`assigned to warned ${d.workerAddr}`);
				} else if (ev.case === 'drvGone') {
					if (ev.value.outcome === DrvGone_Outcome.DROPPED) note(ev.value.drvPath, 'dropped');
					on.delete(ev.value.drvPath);
				}
			};
			for (const e of snap) follow(e, new Map());
			for (let t = T0 + 1000; t <= T0 + 30 * 60_000; t += 1000) {
				const batch = farm.advance(t);
				const f = farm.inspect();
				for (const i of f.interruptions.slice(before))
					if (!warned.has(i.addr)) warned.set(i.addr, Math.round(i.warnedMs));
				const lostAt = new Map<string, Lost>();
				for (const e of batch) {
					// Any builder that goes, interrupted or not, has lost its builds already.
					if (e.event.case === 'worker' && !e.event.value.up)
						for (const [path, addr] of on)
							if (addr === e.event.value.addr)
								problems.push(`${path} still on ${addr} when it left`);
					if (e.event.case === 'worker' && warned.has(e.event.value.addr)) {
						const w = e.event.value;
						const after = Number(e.timeMs) - warned.get(w.addr)!;
						// Reports may follow while it drains; it never takes work again.
						if (w.up && !w.draining)
							problems.push(`${w.addr} up, not draining, ${after} ms after its warning`);
						if (w.up && after === 0 && w.drainReason !== WorkerState_DrainReason.STOPPING)
							problems.push(`${w.addr} drains without saying it stops`);
						if (!w.up) {
							if (after !== 120_000) problems.push(`${w.addr} left ${after} ms after its warning`);
							left++;
							// Everything that still ran there is lost.
							const n = lostAt.get(w.addr);
							lostAt.delete(w.addr);
							requeued += n?.requeued ?? 0;
							lost += (n?.requeued ?? 0) + (n?.dropped ?? 0);
						}
					}
					follow(e, lostAt);
				}
				for (const [addr, n] of lostAt)
					if (n.requeued) problems.push(`requeued from ${addr}, which did not leave`);
				const res = r.apply(batch, t);
				if (!res.ok) problems.push(res.error);
				// The reducer agrees with the farm every second.
				const c = r.counts();
				const up = r.views(t, 15).scheduler.workersUp;
				if (
					c.queued !== f.queued ||
					c.unplaceable !== f.unplaceable ||
					c.assigned !== f.assigned ||
					up !== f.workersUp
				)
					problems.push(
						`${c.queued}/${c.unplaceable}/${c.assigned}/${up} vs ` +
							`${f.queued}/${f.unplaceable}/${f.assigned}/${f.workersUp} at ${t - T0}`
					);
			}
			expect(problems.slice(0, 5)).toEqual([]);
			const f = farm.inspect();
			const ints = f.interruptions.slice(before);
			// About 25 spot builders, each interrupted once in 50 minutes: one every 2 minutes.
			expect(ints.length).toBeGreaterThan(8);
			expect(ints.length).toBeLessThan(30);
			for (const i of ints) expect(i.machine).toMatch(/-spot$/);
			expect(left).toBeGreaterThan(5);
			expect(lost).toBeGreaterThan(10);
			expect(requeued).toBeGreaterThan(lost / 2);
			expect(f.counters.requeued - requeuedBefore).toBeGreaterThanOrEqual(requeued);
			// The autoscaler made up for them: the cloud stays near its target.
			expect(f.cloudUp).toBeGreaterThan(0.6 * f.cloudSize);
		}
	);

	it(
		'a spot builder offline for maintenance when its interruption comes sends no more events',
		{ timeout: 60_000 },
		() => {
			const end = T0 + 4 * 60_000;
			// The first spot builder that is offline when its interruption comes,
			// and the events it sends after that.
			const run = (seed: number) => {
				const farm = new MockFarm(
					mockOptions({ builders: 60, churn: 30, speed: 4, rate: 30, seed, upstream: 0 }),
					T0
				);
				const r = new FarmReducer();
				r.beginStream();
				expect(r.apply(farm.snapshot(), T0).ok).toBe(true);
				const before = farm.inspect().interruptions.length;
				const up = new Map<string, boolean>();
				for (const a of r.views(T0, 15).topology.workers) up.set(a, true);
				let gone: { addr: string; at: number } | null = null;
				const after: string[] = [];
				for (let t = T0 + 1000; t <= end; t += 1000) {
					const batch = farm.advance(t);
					const ints = farm.inspect().interruptions.slice(before);
					if (!gone) {
						const i = ints.find((x) => up.get(x.addr) === false);
						if (i) gone = { addr: i.addr, at: t };
					}
					for (const e of batch) {
						if (e.event.case !== 'worker') continue;
						up.set(e.event.value.addr, e.event.value.up);
						if (gone && e.event.value.addr === gone.addr) after.push(`${t - T0}`);
					}
					expect(r.apply(batch, t).ok).toBe(true);
				}
				return { farm, r, gone, after };
			};
			// A seed where it happens in the first 2 minutes, so the builder's
			// maintenance would have ended before the run does.
			let found: ReturnType<typeof run> | undefined;
			for (let seed = 1; seed <= 10 && !found; seed++) {
				const x = run(seed);
				if (x.gone && x.gone.at - T0 < 2 * 60_000) found = x;
			}
			expect(found, 'an early interruption of an offline builder').toBeDefined();
			const { farm, r, gone, after } = found!;
			const addr = gone!.addr;
			expect(farm.inspect().interruptions.find((x) => x.addr === addr)?.machine).toMatch(/-spot$/);
			// No warning and no last event, since it already left the scheduler. It
			// never comes back, though its maintenance would have ended by now.
			expect(after).toEqual([]);
			expect(farm.inspect().machines[addr]).toBeUndefined();
			expect(r.views(end, 15).workers.get(addr)?.up).toBe(false);
		}
	);

	it('churns nothing on a farm of owned machines', () => {
		const farm = new MockFarm(
			mockOptions({ builders: 4, systems: ['aarch64-darwin'], churn: 60, speed: 4 }),
			T0
		);
		const addrs = new Set<string>();
		for (let t = T0 + 1000; t <= T0 + 5 * 60_000; t += 1000)
			for (const e of farm.advance(t)) if (e.event.case === 'worker') addrs.add(e.event.value.addr);
		expect([...addrs].filter((a) => !/^mac-0[1-4]:50051$/.test(a))).toEqual([]);
		expect(farm.inspect()).toMatchObject({ cloudSize: 0, cloudUp: 0 });
	});

	it('obeys the stream rules for a simulated hour at scale', { timeout: 180_000 }, () => {
		const HOUR = 3600_000;
		const farm = new MockFarm(mockOptions({ builders: 50, seed: 3 }), T0);
		const r = new FarmReducer();
		const seen = new Map<string, number>();
		const note = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
		const workers = new Map<string, { up: boolean; draining: boolean }>();
		const problems: string[] = [];
		let events = 0;
		let trackedSum = 0;
		let trackedMax = 0;
		let checks = 0;

		const classify = (e: WatchEvent) => {
			const ev = e.event;
			note(ev.case ?? 'none');
			switch (ev.case) {
				case 'drv': {
					const d = ev.value;
					note(`drv:${DrvState_Cause[d.cause]}`);
					if (d.phase === DrvState_Phase.UNPLACEABLE)
						note(`unplaceable:${d.features.join(',') || d.system}`);
					if (d.cause === DrvState_Cause.REQUEUED) note(`requeue:${d.reason.split(':')[0]}`);
					if (d.phase === DrvState_Phase.ASSIGNED) {
						for (const s of d.inputSources)
							note(s.workerAddr === d.workerAddr ? 'input:local' : 'input:other');
						if (d.inputsUnknown > 0) note('input:unknown');
					}
					if (d.clientIds.length > 1) note('followers>1');
					break;
				}
				case 'drvGone':
					note(`gone:${DrvGone_Outcome[ev.value.outcome]}`);
					break;
				case 'worker': {
					const w = ev.value;
					if (w.draining) note(`drain:${WorkerState_DrainReason[w.drainReason]}`);
					if (w.draining && w.drainReason === WorkerState_DrainReason.UNSPECIFIED)
						problems.push(`${w.addr} drains without a reason`);
					if (
						w.diskFreeBytes === undefined ||
						w.diskFreeBytes < 0n ||
						w.diskTotalBytes === undefined
					)
						problems.push(`${w.addr} disk ${w.diskFreeBytes}/${w.diskTotalBytes}`);
					else if (w.diskFreeBytes > w.diskTotalBytes)
						problems.push(`${w.addr} more free than total disk`);
					const prev = workers.get(w.addr);
					if (prev && !prev.up && w.up) note('worker:return');
					if (w.up && w.draining && !prev?.draining) note('worker:drain');
					if (w.up && !w.draining && prev?.up && prev.draining) note('worker:undrain');
					if (!w.up) note('worker:offline');
					workers.set(w.addr, { up: w.up, draining: w.draining });
					break;
				}
				case 'client': {
					const id = ev.value.identity;
					note(
						id.startsWith('ci-runner-')
							? 'client:ci'
							: id.startsWith('oidc:')
								? 'client:oidc'
								: 'client:host'
					);
					break;
				}
			}
		};

		// Apply up to each Stats, then compare it with what the stream built.
		const feed = (batch: WatchEvent[], now: number) => {
			let from = 0;
			for (let i = 0; i < batch.length; i++) {
				classify(batch[i]);
				const ev = batch[i].event;
				if (ev.case !== 'stats' && i !== batch.length - 1) continue;
				const res = r.apply(batch.slice(from, i + 1), now);
				if (!res.ok) problems.push(`apply: ${res.error}`);
				from = i + 1;
				if (ev.case === 'stats') compareStats(ev.value);
			}
		};
		let lastSubs = new Map<string, bigint>();
		const compareStats = (s: Stats) => {
			// Counters never go down within a term.
			const subs = new Map(s.totals!.substituters.map((x) => [x.url, x.narBytes]));
			for (const [url, n] of lastSubs)
				if ((subs.get(url) ?? 0n) < n) problems.push(`Counters for ${url} went down`);
			lastSubs = subs;
			let q = 0;
			let u = 0;
			let running = 0;
			for (const x of s.systems) {
				q += x.queued;
				u += x.unplaceable;
				running += x.running;
			}
			const c = r.counts();
			if (q !== c.queued || u !== c.unplaceable || running !== c.assigned)
				problems.push(
					`stats ${q}/${u}/${running} vs stream ${c.queued}/${c.unplaceable}/${c.assigned}`
				);
		};
		const check = (t: number) => {
			checks++;
			const v = r.views(t, 15);
			const f = farm.inspect();
			const c = r.counts();
			const same = (what: string, a: number, b: number) => {
				if (a !== b) problems.push(`${what}: reducer ${a}, farm ${b} at ${t - T0}`);
			};
			same('tracked', c.drvs, f.tracked);
			same('queued', c.queued, f.queued);
			same('unplaceable', c.unplaceable, f.unplaceable);
			same('assigned', c.assigned, f.assigned);
			same('clients', c.clients, f.clients);
			same('workersUp', v.scheduler.workersUp, f.workersUp);
			trackedSum += c.drvs;
			trackedMax = Math.max(trackedMax, c.drvs);
			const s = v.scheduler;
			for (const [k, n] of Object.entries(s))
				if (typeof n === 'number' && n < 0) problems.push(`scheduler.${k} = ${n}`);
			if (s.free > s.slots) problems.push(`free ${s.free} > slots ${s.slots}`);
			for (const w of v.workers.values()) {
				if (w.running < 0 || w.queuedCanTake < 0) problems.push(`worker ${w.addr} negative`);
				if (w.up && w.running > w.maxJobs) problems.push(`worker ${w.addr} over capacity`);
				if (!w.up && w.running !== 0)
					problems.push(`worker ${w.addr} down but running ${w.running}`);
			}
			for (const g of v.clientGroups.values())
				if (g.clients < 0 || g.waiting < 0 || g.wantsPerSec < 0)
					problems.push(`group ${g.id} negative`);
			for (const [id, e] of v.edges) if (!(e.rate >= 0)) problems.push(`edge ${id} rate ${e.rate}`);
			for (const [k, n] of Object.entries(v.totals))
				if (typeof n === 'number' && n < 0) problems.push(`totals.${k} = ${n}`);
			if (v.topology.clientGroups.length > 10) problems.push('too many client groups');
		};

		r.beginStream();
		const snap = farm.snapshot();
		for (const e of snap) note(`snapshot:${e.event.case}`);
		feed(snap, T0);
		const started = performance.now();
		for (let t = T0 + 500; t <= T0 + HOUR; t += 500) {
			const batch = farm.advance(t);
			events += batch.length;
			feed(batch, t);
			if ((t - T0) % 30_000 === 0) check(t);
			if (t === T0 + HOUR / 2) {
				// A reconnect half-way: a fresh snapshot must agree too.
				r.beginStream();
				feed(farm.snapshot(), t);
				check(t);
			}
		}
		const elapsed = performance.now() - started;

		expect(problems.slice(0, 10)).toEqual([]);
		const perSec = events / 3600;
		console.info(
			`mock hour at 50 builders: ${events} events (${perSec.toFixed(0)}/s), ` +
				`in flight avg ${(trackedSum / checks).toFixed(0)} max ${trackedMax}, ${elapsed.toFixed(0)} ms`
		);
		expect(perSec).toBeGreaterThanOrEqual(200);
		expect(trackedMax).toBeGreaterThanOrEqual(3000);
		expect(trackedSum / checks).toBeGreaterThan(3000);

		for (const k of [
			'snapshot:reset',
			'snapshot:worker',
			'snapshot:client',
			'snapshot:drv',
			'snapshot:snapshotDone',
			'stats',
			'client',
			'clientGone',
			'cached',
			'drv:SNAPSHOT',
			'drv:WANTED',
			'drv:FOLLOWERS',
			'drv:ASSIGNED',
			'drv:REQUEUED',
			'gone:BUILT',
			'gone:FAILED',
			'gone:CANCELLED',
			'gone:DROPPED',
			'input:local',
			'input:other',
			'input:unknown',
			'followers>1',
			'worker:drain',
			'worker:undrain',
			'drain:LOW_DISK',
			'drain:STOPPING',
			'worker:offline',
			'worker:return',
			'requeue:the worker disconnected',
			'requeue:never claimed',
			'requeue:given back',
			'unplaceable:cuda',
			'unplaceable:riscv64-linux',
			'client:ci',
			'client:oidc',
			'client:host'
		])
			expect(seen.get(k) ?? 0, k).toBeGreaterThan(0);
	});
});

describe('startMockSource', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('connects, goes live, recovers from injected gaps and stops', () => {
		vi.useFakeTimers({ now: T0 });
		const r = new FarmReducer();
		const statuses: ConnectionStatus['kind'][] = [];
		let applied = 0;
		let gaps = 0;
		const src = startMockSource(
			mockOptions({ builders: 4, gapEvery: 5 }),
			reducerSink(r, {
				applied: (batch, res) => {
					if (res.ok) applied += batch.length;
					else gaps++;
				},
				status: (s) => {
					if (statuses.at(-1) !== s.kind) statuses.push(s.kind);
				}
			})
		);
		expect(statuses).toEqual(['connecting']);
		vi.advanceTimersByTime(300);
		expect(statuses).toEqual(['connecting', 'syncing', 'live']);
		expect(r.phase).toBe('live');
		vi.advanceTimersByTime(4000);
		expect(gaps).toBe(0);
		vi.advanceTimersByTime(2000);
		expect(gaps).toBe(1);
		vi.advanceTimersByTime(1500);
		expect(statuses.slice(3)).toEqual(['retrying', 'connecting', 'syncing', 'live']);
		expect(r.phase).toBe('live');
		expect(applied).toBeGreaterThan(100);
		src.stop();
		expect(statuses.at(-1)).toBe('stopped');
		const before = applied;
		vi.advanceTimersByTime(5000);
		expect(applied).toBe(before);
	});

	it('takes a fresh snapshot after a long pause instead of replaying it', () => {
		vi.useFakeTimers({ now: T0 });
		const r = new FarmReducer();
		const firstEvents: (string | undefined)[] = [];
		const statuses: ConnectionStatus['kind'][] = [];
		const src = startMockSource(
			mockOptions({ builders: 4 }),
			reducerSink(r, {
				applied: (batch) => firstEvents.push(batch[0]?.event.case),
				status: (s) => statuses.push(s.kind)
			})
		);
		vi.advanceTimersByTime(1000);
		expect(statuses).toEqual(['connecting', 'syncing', 'live']);
		// The tab was asleep: the clock jumps without timers running.
		vi.setSystemTime(T0 + 10 * 60_000);
		const n = firstEvents.length;
		vi.advanceTimersByTime(1000);
		// It connects again, and the first batch after the pause is a snapshot.
		expect(statuses.slice(3)).toEqual(['connecting', 'syncing', 'live']);
		expect(firstEvents[n]).toBe('reset');
		expect(r.phase).toBe('live');
		src.stop();
	});
});

describe('logs in the demo', () => {
	/** Events without what logs and progress add: seq, error text and the progress fields. */
	function farmShape(events: WatchEvent[]): string {
		const out: string[] = [];
		for (const e of events) {
			const ev = e.event;
			if (ev.case === 'drv') {
				if (ev.value.cause === DrvState_Cause.PROGRESS) continue;
				out.push(
					`drv ${ev.value.drvPath} ${ev.value.cause} ${ev.value.phase} ${ev.value.workerAddr} ${ev.value.assignId}`
				);
			} else if (ev.case === 'drvGone') {
				out.push(
					`gone ${ev.value.drvPath} ${ev.value.outcome} ${ev.value.status} ${ev.value.workerAddr}`
				);
			} else if (ev.case === 'worker')
				out.push(`worker ${ev.value.addr} ${ev.value.up} ${ev.value.draining}`);
			else if (ev.case === 'cached') out.push(`cached ${ev.value.drvPath}`);
		}
		return out.join('\n');
	}

	it('a seed draws the same farm with logs, logsize and history', () => {
		const base = farmShape(run(5, 500, 120_000, { builders: 6, progress: false }));
		for (const o of [
			{ logs: false },
			{ logsize: 6 },
			{ history: 0 },
			{ history: 2000 },
			// Progress only adds events.
			{ progress: true }
		])
			expect(
				farmShape(run(5, 500, 120_000, { builders: 6, progress: false, ...o })),
				JSON.stringify(o)
			).toBe(base);
	});

	it('progress events change only phase, phase start and start', () => {
		const farm = new MockFarm(mockOptions({ builders: 6, speed: 4 }), T0);
		const last = new Map<string, DrvState>();
		for (const e of farm.snapshot())
			if (e.event.case === 'drv') last.set(e.event.value.drvPath, e.event.value);
		let progress = 0;
		let phases = 0;
		for (let t = T0 + 500; t <= T0 + 120_000; t += 500) {
			for (const e of farm.advance(t)) {
				if (e.event.case !== 'drv') continue;
				const d = e.event.value;
				if (d.cause === DrvState_Cause.PROGRESS) {
					progress++;
					if (d.buildPhase) phases++;
					const before = last.get(d.drvPath)!;
					const strip = (x: DrvState) => ({
						...x,
						cause: 0,
						buildPhase: '',
						buildStartedMs: 0n,
						buildPhaseStartedMs: 0n,
						// Followers leave with ClientGone, which carries no DrvState.
						clientIds: [],
						$typeName: x.$typeName
					});
					expect(strip(d)).toEqual(strip(before));
					expect(d.buildStartedMs).toBeGreaterThan(0n);
					expect(d.buildStartedMs).toBeGreaterThanOrEqual(d.assignedMs);
					if (d.buildPhase) expect(d.buildPhaseStartedMs).toBeGreaterThanOrEqual(d.buildStartedMs);
				}
				last.set(d.drvPath, d);
			}
		}
		expect(progress).toBeGreaterThan(50);
		expect(phases).toBeGreaterThan(20);
	});

	it('a NixOS test reports a start and no phase', () => {
		const farm = new MockFarm(mockOptions({ builders: 12, speed: 4 }), T0);
		let tests = 0;
		for (let t = T0 + 500; t <= T0 + 300_000 && tests < 3; t += 500)
			for (const e of farm.advance(t)) {
				if (e.event.case !== 'drv' || e.event.value.cause !== DrvState_Cause.PROGRESS) continue;
				const d = e.event.value;
				if (!/-vm-test-\d+\.drv$/.test(d.drvPath)) continue;
				tests++;
				expect(d.buildStartedMs).toBeGreaterThan(0n);
				expect(d.buildPhase).toBe('');
				expect(d.buildPhaseStartedMs).toBe(0n);
			}
		expect(tests).toBeGreaterThan(0);
	});

	it("the failure excerpt's last lines are the log's last lines", () => {
		const farm = new MockFarm(mockOptions({ builders: 6, speed: 4, fail: 0.3 }), T0);
		let checked = 0;
		for (let t = T0 + 500; t <= T0 + 120_000 && checked < 20; t += 500)
			for (const e of farm.advance(t)) {
				if (e.event.case !== 'drvGone' || e.event.value.outcome !== DrvGone_Outcome.FAILED)
					continue;
				const g = e.event.value;
				const quoted = g.error
					.split('\n')
					.filter((l) => l.startsWith('       > '))
					.map((l) => l.slice('       > '.length));
				// Nix quotes the log only when the builder exited with an error.
				expect(quoted.length > 0).toBe(!NIX_SAYS.has(g.status));
				if (!quoted.length) continue;
				const p = farm.logPlan(g.drvPath, 0);
				expect(p.ending?.outcome).toBe(DrvGone_Outcome.FAILED);
				const log = finalLog(planLog({ ...p, plannedMs: p.plannedMs || undefined }), p.ending!);
				const lines = Array.from({ length: log.count }, (_, i) => log.line(i));
				expect(quoted).toEqual(lines.slice(-quoted.length));
				checked++;
			}
		expect(checked).toBeGreaterThanOrEqual(20);
	});
});

describe('MockFarm.recentBuilds', () => {
	// events.proto: at most 256 builds per batch, and at most 256 with their error text.
	const BATCH = 256;
	const HISTORY = 300;
	type Req = Parameters<MockFarm['recentBuilds']>[0];
	const ask = (farm: MockFarm, req: Partial<Req> = {}) =>
		farm.recentBuilds({ beforeMs: 0, limit: 1000, failedOnly: false, withError: false, ...req });
	const rows = (farm: MockFarm, req: Partial<Req> = {}) => ask(farm, req).flatMap((b) => b.builds);
	/** A farm a minute after the page opened. */
	const farmOf = (history: number) => {
		const farm = new MockFarm(mockOptions({ builders: 6, history }), T0);
		farm.advance(T0 + 60_000);
		return farm;
	};

	it('holds the history the option asks for, newest first', () => {
		const farm = farmOf(HISTORY);
		const all = rows(farm);
		expect(all.length).toBeGreaterThan(HISTORY);
		const times = all.map((b) => Number(b.finishedMs));
		expect(times).toEqual([...times].sort((a, b) => b - a));
		expect(all.every((b) => b.error === '' && b.workerAddr !== '' && b.assignId > 0n)).toBe(true);
		// Page through the ring, which holds the history from before the page opened.
		let before = 0;
		let older60 = 0;
		for (let page = 0; page < 50; page++) {
			const batches = ask(farm, { beforeMs: before });
			const got = batches.flatMap((b) => b.builds);
			older60 += got.filter((b) => Number(b.finishedMs) < T0 - 60_000).length;
			if (batches.at(-1)!.complete || got.length === 0) break;
			before = Number(got.at(-1)!.finishedMs);
		}
		expect(older60).toBeGreaterThanOrEqual(HISTORY);
		// history=0: only what the farm built since it started.
		const none = new MockFarm(mockOptions({ builders: 6, history: 0 }), T0);
		expect(rows(none).every((b) => Number(b.finishedMs) >= T0 - 70_000)).toBe(true);
	});

	it('pages by before_ms, in batches of at most 256', () => {
		const farm = farmOf(HISTORY);
		const batches = ask(farm);
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.every((b) => b.builds.length <= BATCH)).toBe(true);
		const times = batches.flatMap((b) => b.builds).map((b) => Number(b.finishedMs));
		const older = rows(farm, { beforeMs: times[9], limit: 5 });
		expect(older.map((b) => Number(b.finishedMs))).toEqual(
			times.filter((t) => t < times[9]).slice(0, 5)
		);
	});

	it('sends failures with their text, at most 256', () => {
		const failed = rows(farmOf(HISTORY), { failedOnly: true, withError: true });
		expect(failed.length).toBeGreaterThan(0);
		expect(failed.length).toBeLessThanOrEqual(BATCH);
		expect(
			failed.every((b) => b.outcome === DrvGone_Outcome.FAILED && b.error.includes('error:'))
		).toBe(true);
	});

	it('finds one derivation by path', () => {
		const farm = farmOf(HISTORY);
		const path = rows(farm)[3].drvPath;
		const one = ask(farm, { limit: 0, drvPaths: [path] });
		expect(one[0].builds.map((b) => b.drvPath)).toEqual([path]);
	});
});
