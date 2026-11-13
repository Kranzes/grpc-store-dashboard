import { describe, expect, it } from 'vitest';
import { DrvGone_Outcome as Outcome, DrvGone_Status as Status } from '#lib/gen/events_pb.ts';
import { stripAnsi } from '#lib/logs/errors.ts';
import { drvPath } from '#lib/model/fixtures.ts';
import {
	baseLine,
	bytes,
	finalLog,
	linesAt,
	phaseAt,
	planLog,
	runningLog,
	tail,
	type LogLines,
	type LogPlan
} from './mock-log.ts';

const plan = (name: string, over: Partial<Parameters<typeof planLog>[0]> = {}) =>
	planLog({ seed: 1, drvPath: drvPath(name), name, system: 'x86_64-linux', assignId: 7, ...over });
const all = (log: LogLines) => Array.from({ length: log.count }, (_, i) => log.line(i));
const built = { outcome: Outcome.BUILT, status: Status.BUILT };
const failed = (status = Status.PERMANENT_FAILURE) => ({ outcome: Outcome.FAILED, status });
const phases = (lines: readonly string[]) =>
	lines.flatMap((l) => {
		const m = /^Running phase: (\S+)$/.exec(l);
		return m ? [m[1]] : [];
	});

/** Plans of many names and hashes, for properties every log keeps. */
function many(n: number): LogPlan[] {
	const names = [
		'hello-2.12.1',
		'cmake-3.31.6',
		'systemd-257.3',
		'rustc-1.86.0',
		'go-1.24.2',
		'python3.12-numpy-2.2.4',
		'ghc-9.8.4',
		'perl5.40.0-JSON-4.10',
		'api-vm-test-12',
		'web-image-3',
		'api-server-12'
	];
	return Array.from({ length: n }, (_, i) =>
		plan(names[i % names.length], { assignId: i, logsize: 0.3 })
	);
}

describe('mock-log', () => {
	it('line i is the same however it is reached', () => {
		const p = plan('qtbase-6.8.2', { logsize: 3 });
		expect(p.total).toBeGreaterThan(1000);
		const n = Math.min(10_000, p.total);
		const seq = Array.from({ length: n }, (_, i) => baseLine(p, i));
		// Random order, and a second plan from the same inputs.
		const again = plan('qtbase-6.8.2', { logsize: 3 });
		for (let k = 0; k < 2000; k++) {
			const i = (k * 7919) % n;
			expect(baseLine(again, i)).toBe(seq[i]);
		}
		expect(baseLine(p, n - 1)).toBe(seq[n - 1]);
		// Another assignment of the same derivation is another log.
		expect(all(finalLog(plan('qtbase-6.8.2', { logsize: 3, assignId: 8 }), built))).not.toEqual(
			all(finalLog(p, built))
		);
	});

	it("phases come in stdenv's order with both marker lines", () => {
		const order = [
			'unpackPhase',
			'patchPhase',
			'configurePhase',
			'buildPhase',
			'checkPhase',
			'installPhase',
			'fixupPhase',
			'installCheckPhase'
		];
		for (const p of many(40)) {
			if (p.profile === 'nixos-test') continue;
			const lines = all(finalLog(p, built));
			const seen = phases(lines);
			expect(seen.length).toBeGreaterThanOrEqual(5);
			const idx = seen.map((x) => order.indexOf(x));
			expect(idx).toEqual([...idx].sort((a, b) => a - b));
			for (let i = 0; i < lines.length; i++) {
				const m = /^Running phase: (\S+)$/.exec(lines[i]);
				if (m) expect(lines[i + 1]).toBe(`@nix { "action": "setPhase", "phase": "${m[1]}" }`);
			}
		}
	});

	it('the kernel log is about 50 MB', () => {
		const p = plan('linux-6.12.21');
		const log = finalLog(p, built);
		expect(log.count).toBeGreaterThan(700_000);
		let size = 0;
		for (let i = 0; i < log.count; i += 1000)
			size += bytes(log, i, Math.min(i + 1000, log.count)).length;
		expect(size).toBeGreaterThan(45e6);
		expect(size).toBeLessThan(56e6);
	});

	it('running builds show no install or fixup lines', () => {
		for (const p of many(20)) {
			for (const at of [0, p.plannedMs * 0.3, p.plannedMs * 0.99, p.plannedMs * 5]) {
				const lines = all(runningLog(p, at));
				expect(phases(lines)).not.toContain('installPhase');
				expect(phases(lines)).not.toContain('fixupPhase');
				expect(lines.some((l) => l.startsWith('(finished: run the VM test script'))).toBe(false);
			}
			// It grows as time goes on.
			expect(linesAt(p, p.plannedMs)).toBeGreaterThan(linesAt(p, p.plannedMs * 0.1));
		}
		const p = plan('hello-2.12.1');
		expect(phaseAt(p, 0)?.phase).toBe('unpackPhase');
		expect(phaseAt(p, p.plannedMs * 0.5)?.phase).toBe('buildPhase');
	});

	describe('each status ends the log as Nix ends it', () => {
		const p = plan('hello-2.12.1', { assignId: 3 });
		const end = (e: Parameters<typeof finalLog>[1]) => all(finalLog(p, e)).map(stripAnsi);
		const b = end(built);
		const lastLong = phases(b).includes('checkPhase') ? 'checkPhase' : 'buildPhase';
		it.each<[string, Parameters<typeof finalLog>[1], (lines: string[]) => void]>([
			['built', built, (l) => expect(phases(l)).toContain('installPhase')],
			[
				'a build failure',
				failed(),
				(l) => {
					expect(phases(l)).not.toContain('installPhase');
					expect(l.at(-1)).toMatch(/^make(\[3\])?: \*\*\* .* Error [12]$/);
					expect(l.some((x) => /^src\/foo\.c:12:5: error:|^FAIL: tests\//.test(x))).toBe(true);
					// The failed phase prints no footer.
					expect(l.some((x) => x.startsWith(`${lastLong} completed in`))).toBe(false);
				}
			],
			[
				'a timeout',
				failed(Status.TIMED_OUT),
				(l) => expect(l.at(-1)).toBe(stripAnsi(baseLine(p, l.length - 1)))
			],
			['rejected output', failed(Status.OUTPUT_REJECTED), (l) => expect(l).toEqual(b)],
			[
				'a transient failure',
				failed(Status.TRANSIENT_FAILURE),
				(l) => {
					expect(l.at(-2)).toMatch(/^curl: \(6\)/);
					expect(l.at(-1)).toMatch(/^ERROR: /);
				}
			],
			[
				'a misc failure',
				failed(Status.MISC_FAILURE),
				(l) => expect(l.at(-1)).toMatch(/^ERROR: noBrokenSymlinks: /)
			],
			[
				'a broken builder',
				{ ...failed(), failing: true },
				(l) => {
					expect(l.at(-2)).toBe('Illegal instruction (core dumped)');
					// 132: killed by SIGILL.
					expect(l.at(-1)).toMatch(/^make: \*\*\* .* Error 132$/);
				}
			],
			[
				'a cancelled build',
				{ outcome: Outcome.CANCELLED, status: Status.UNSPECIFIED },
				(l) => expect(phases(l)).not.toContain('installPhase')
			]
		])('%s', (_name, e, check) => check(end(e)));
	});

	it('no line has a control character other than ESC, tab and \\r', () => {
		// eslint-disable-next-line no-control-regex -- control characters are what it looks for
		const bad = /[\x00-\x08\x0a-\x0c\x0e-\x1a\x1c-\x1f\x7f]/;
		for (const p of many(30))
			for (const e of [built, failed(), failed(Status.MISC_FAILURE)])
				for (const l of all(finalLog(p, e))) expect(bad.test(l), JSON.stringify(l)).toBe(false);
	});

	it("phase footers use stdenv's hours, minutes and seconds", () => {
		const long = plan('hello-2.12.1', { plannedMs: 3 * 3600_000 });
		const lines = all(finalLog(long, built));
		const footers = lines.filter((l) => / completed in /.test(l));
		expect(footers.length).toBeGreaterThan(0);
		for (const f of footers)
			expect(f).toMatch(/^\w+Phase completed in (?:\d+ hours )?(?:\d+ minutes )?\d+ seconds$/);
		expect(footers.some((f) => /hours/.test(f))).toBe(true);
		// Phases under 30 s print none.
		const short = all(finalLog(plan('hello-2.12.1', { plannedMs: 20_000 }), built));
		expect(short.some((l) => / completed in /.test(l))).toBe(false);
	});

	it('a NixOS test has no phase lines and its subtests pair up', () => {
		for (let i = 0; i < 20; i++) {
			const p = plan(`api-vm-test-${i}`, { logsize: 0.5 });
			expect(p.profile).toBe('nixos-test');
			expect(phaseAt(p, p.plannedMs / 2)).toBeNull();
			const lines = all(finalLog(p, built)).map(stripAnsi);
			expect(lines.some((l) => /^Running phase:|^@nix /.test(l))).toBe(false);
			const open: string[] = [];
			for (const l of lines) {
				const s = /^subtest: (.+)$/.exec(l);
				if (s) open.push(s[1]);
				const f = /^\(finished: subtest: (.+), in \d+\.\d\d seconds\)$/.exec(l);
				if (f) expect(open.pop()).toBe(f[1]);
			}
			expect(open).toEqual([]);
			expect(lines.some((l) => l.startsWith('(finished: run the VM test script'))).toBe(true);
		}
	});

	it("a NixOS test's driver blocks come in the order the real driver prints them", () => {
		const raw = all(finalLog(plan('api-vm-test-3'), built));
		// The driver's own lines: bold green, the whole line.
		const blocks = raw.flatMap((l) => {
			// eslint-disable-next-line no-control-regex -- escapes are what it matches
			const m = /^\x1b\[1m\x1b\[32m([^\x1b]+)\x1b\[0m$/.exec(l);
			return m ? [m[1]] : [];
		});
		expect(blocks.slice(0, 3)).toEqual([
			'start all VLans',
			'run the VM test script',
			'start all VMs'
		]);
		expect(blocks.slice(3, -1).every((b) => b.startsWith('subtest: '))).toBe(true);
		expect(blocks.at(-1)).toBe('cleanup');
		const text = raw.map(stripAnsi);
		expect(text[0]).toBe('Machine state will be reset. To keep it, pass --keep-machine-state');
		// The test script ends before the cleanup starts.
		const end = text.findIndex((l) => l.startsWith('(finished: run the VM test script, '));
		expect(end).toBeLessThan(text.indexOf('cleanup'));
		expect(end).toBeGreaterThan(text.findLastIndex((l) => l.startsWith('subtest: ')));
		// A machine's own steps are green after its name, never the whole line.
		expect(raw.some((l) => l.startsWith('machine: \x1b[1m\x1b[32mwaiting for unit '))).toBe(true);
	});

	it("a failed NixOS test leaves its failing subtest open, then the driver's !!! lines and cleanup, all in Nix's excerpt", () => {
		for (let i = 0; i < 20; i++) {
			const p = plan(`web-vm-test-${i}`, { logsize: 0.5 });
			const lines = all(finalLog(p, failed())).map(stripAnsi);
			const open: string[] = [];
			for (const l of lines) {
				const s = /^subtest: (.+)$/.exec(l);
				if (s) open.push(s[1]);
				const f = /^\(finished: subtest: (.+), in /.exec(l);
				if (f) expect(open.pop()).toBe(f[1]);
			}
			expect([...open].reverse()).toEqual(p.failingSubtests);
			expect(lines.some((l) => l.startsWith('(finished: run the VM test script'))).toBe(false);
			// The driver closes the cleanup block it opened, and the log ends there.
			expect(lines.at(-1)).toMatch(/^\(finished: cleanup, in /);
			const bang = lines.slice(
				lines.findIndex((l) => l.startsWith('!!! ')),
				lines.indexOf('cleanup')
			);
			expect(bang[0]).toMatch(
				new RegExp(`^!!! Test "${p.failingSubtests[0]}" failed with error: `)
			);
			expect(bang[1]).toBe('!!! Traceback (most recent call last):');
			expect(bang).toContain('!!! ');
			expect(bang.at(-1)).toMatch(/^!!! RequestedAssertionFailed: /);
			expect(bang.every((l) => l.startsWith('!!! '))).toBe(true);
			// Nix quotes the last 25 lines by default, and the failing test's name and the cleanup fit in them.
			const excerpt = tail(p, failed(), 25).map(stripAnsi);
			expect(excerpt).toContain(bang[0]);
			expect(excerpt).toContain('cleanup');
		}
	});
});
