import { readFileSync } from 'node:fs';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';
import { finalLog, planLog } from '#lib/source/mock-log.ts';
import { DrvGone_Outcome, DrvGone_Status } from '#lib/gen/events_pb.ts';
import { drvPath } from '#lib/model/fixtures.ts';
import { plainText } from './ansi.ts';
import { LogEngine } from './engine.ts';
import { GroupTree, type Group } from './groups.ts';
import hello from './fixtures/hello.log?raw';
import openbao from './fixtures/openbao.log?raw';
import nat from './fixtures/nat-firewall.log?raw';

/** A tree from lines as the worker sees them: without escapes, and as they arrived. */
function tree(lines: readonly string[]): GroupTree {
	const t = new GroupTree();
	lines.forEach((l, i) => t.add(i, plainText(l), l));
	return t;
}
const names = (gs: readonly Group[]) => gs.map((g) => g.name);
const linesOf = (log: string) => log.split('\n').slice(0, -1);
const helloLines = linesOf(hello);
const E = '\x1b';
/** A line of the NixOS test driver's own: bold green, the whole line. */
const block = (name: string) => `${E}[1m${E}[32m${name}${E}[0m`;

function testLog(i: number, failed: boolean) {
	const name = `api-vm-test-${i}`;
	const p = planLog({ seed: 1, drvPath: drvPath(name), name, system: 'x86_64-linux', assignId: 1 });
	const log = finalLog(p, {
		outcome: failed ? DrvGone_Outcome.FAILED : DrvGone_Outcome.BUILT,
		status: failed ? DrvGone_Status.PERMANENT_FAILURE : DrvGone_Status.BUILT
	});
	return { p, lines: Array.from({ length: log.count }, (_, k) => log.line(k)) };
}

describe('groups', () => {
	it('phases from Running phase lines', () => {
		const t = tree(helloLines);
		expect(names(t.groups)).toEqual([
			'unpackPhase',
			'patchPhase',
			'updateAutotoolsGnuConfigScriptsPhase',
			'configurePhase',
			'buildPhase',
			'checkPhase',
			'installPhase',
			'fixupPhase',
			'installCheckPhase'
		]);
		const configure = t.groups.find((g) => g.name === 'configurePhase')!;
		// Lines 10 to 289, 0-based slots 9 to 288.
		expect([configure.headerSlot, configure.lastSlot, configure.lines]).toEqual([9, 288, 280]);
	});

	it('lines before the first group stay at the top level, with no header', () => {
		const t = tree(helloLines);
		expect(t.chain(0)).toEqual([]);
		expect(t.groups[0]).toMatchObject({ name: 'unpackPhase', headerSlot: 1 });
	});

	it('setPhase alone as the fallback', () => {
		const t = tree(['x', '@nix { "action": "setPhase", "phase": "buildPhase" }', 'make']);
		expect(names(t.groups)).toEqual(['buildPhase']);
		expect(t.chain(0)).toEqual([]);
	});

	it('a Running phase line followed by its setPhase makes one group', () => {
		const t = tree([
			'Running phase: buildPhase',
			'@nix { "action": "setPhase", "phase": "buildPhase" }',
			'make'
		]);
		expect(names(t.groups)).toEqual(['buildPhase']);
		expect(t.groups[0].lines).toBe(3);
	});

	it('a log with no phase and no driver block has no groups', () => {
		expect(tree(['a', 'b', 'c']).groups).toEqual([]);
	});

	it('durations from completed lines only, with hours, minutes and seconds', () => {
		const t = tree([
			'Running phase: configurePhase',
			'checking',
			'configurePhase completed in 1 minutes 12 seconds',
			'Running phase: buildPhase',
			'buildPhase completed in 2 hours 3 minutes 4 seconds',
			'Running phase: checkPhase',
			'ok'
		]);
		expect(t.groups.map((g) => g.durationS)).toEqual([72, 7384, null]);
	});

	it("a footer for another phase's name is a plain line", () => {
		const t = tree(['Running phase: buildPhase', 'checkPhase completed in 41 seconds']);
		expect(t.groups[0].durationS).toBeNull();
	});

	it("the driver's blocks open on their bold green line and close on their finish line", () => {
		const t = tree([
			'Machine state will be reset. To keep it, pass --keep-machine-state',
			block('start all VLans'),
			'(finished: start all VLans, in 0.00 seconds)',
			'Test will time out and terminate in 3600.0 seconds',
			block('run the VM test script'),
			block('start all VMs'),
			'machine: starting vm',
			'(finished: start all VMs, in 0.21 seconds)',
			block('subtest: login'),
			'x',
			'(finished: subtest: login, in 1.25 seconds)',
			'(finished: run the VM test script, in 3.00 seconds)',
			'test script finished in 3.02s',
			block('cleanup'),
			'kill QemuMachine (pid 46)',
			'(finished: cleanup, in 0.20 seconds)'
		]);
		expect(
			t.groups.map((g) => [g.kind, g.name, g.depth, g.headerSlot, g.lastSlot, g.durationS])
		).toEqual([
			['block', 'start all VLans', 0, 1, 2, 0],
			['block', 'run the VM test script', 0, 4, 11, 3],
			['block', 'start all VMs', 1, 5, 7, 0.21],
			['subtest', 'login', 1, 8, 10, 1.25],
			['block', 'cleanup', 0, 13, 15, 0.2]
		]);
		expect(t.groups.every((g) => g.closed)).toBe(true);
		// The driver's lines between its blocks stay at the top level.
		for (const slot of [0, 3, 12]) expect(t.chain(slot)).toEqual([]);
		expect(t.failedGroup()).toBeNull();
	});

	it('a block is the whole line in bold green, and nothing else', () => {
		const t = tree([
			`${E}[1m${E}[32mstart${E}[0m and more`,
			`${E}[1mbold${E}[0m`,
			`${E}[32mgreen${E}[0m`,
			'start all VLans',
			'(finished: start all VLans, in 0.00 seconds)'
		]);
		expect(t.groups).toEqual([]);
	});

	it('subtests match after stripping ANSI, or without colors', () => {
		const t = tree([
			block('subtest: login'),
			'x',
			'(finished: subtest: login, in 1.25 seconds)',
			'subtest: plain',
			'(finished: subtest: plain, in 0.50 seconds)'
		]);
		expect(t.groups).toMatchObject([
			{ kind: 'subtest', name: 'login', durationS: 1.25 },
			{ kind: 'subtest', name: 'plain', durationS: 0.5 }
		]);
	});

	it("a machine's own steps and serial lines open nothing", () => {
		const t = tree([
			`machine: ${block('waiting for unit openbao.service')}`,
			'machine: subtest: x',
			'machine # subtest: y',
			`${E}[2mmachine # ${block('cleanup')}${E}[0m`,
			'machine: (finished: subtest: x, in 1.00 seconds)',
			'machine: (finished: waiting for unit openbao.service, in 11.92 seconds)'
		]);
		expect(t.groups).toEqual([]);
	});

	it('a finish line closes only a block of its kind and name', () => {
		const t = tree([
			block('run the VM test script'),
			block('subtest: cleanup'),
			'(finished: cleanup, in 1.00 seconds)',
			'(finished: subtest: run the VM test script, in 1.00 seconds)'
		]);
		expect(t.open.map((g) => g.name)).toEqual(['run the VM test script', 'cleanup']);
	});

	it('subtests nest', () => {
		const t = tree([
			'subtest: outer',
			'subtest: inner',
			'a',
			'(finished: subtest: inner, in 1.00 seconds)',
			'b',
			'(finished: subtest: outer, in 2.00 seconds)'
		]);
		expect(
			t.groups.map((g) => [g.name, g.depth, g.parent, g.lines, g.headerSlot, g.lastSlot])
		).toEqual([
			['outer', 0, null, 6, 0, 5],
			['inner', 1, 0, 3, 1, 3]
		]);
	});

	it('blocks nest under a phase', () => {
		const t = tree([
			'Running phase: checkPhase',
			block('run the VM test script'),
			'subtest: a',
			'x',
			'(finished: subtest: a, in 1.00 seconds)'
		]);
		expect(t.groups.map((g) => [g.name, g.depth, g.parent])).toEqual([
			['checkPhase', 0, null],
			['run the VM test script', 1, 0],
			['a', 2, 1]
		]);
	});

	it('a new phase closes open blocks', () => {
		const t = tree([
			'Running phase: checkPhase',
			'subtest: a',
			'x',
			'Running phase: installPhase',
			'y'
		]);
		expect(t.groups.find((g) => g.name === 'a')).toMatchObject({
			closed: true,
			lastSlot: 2,
			durationS: null
		});
	});

	it('a finish closes the innermost block of its name and those inside it', () => {
		const t = tree([
			'subtest: a',
			'subtest: b',
			'x',
			'(finished: subtest: a, in 3.00 seconds)',
			'top'
		]);
		expect(t.groups.map((g) => [g.name, g.closed, g.lastSlot])).toEqual([
			['a', true, 3],
			['b', true, 2]
		]);
		expect(t.open).toEqual([]);
	});

	it('a finish with no open block of its name is a plain line', () => {
		const t = tree(['subtest: a', '(finished: subtest: b, in 1.00 seconds)', 'x']);
		expect(t.groups[0]).toMatchObject({ name: 'a', closed: false, lines: 3 });
	});

	it("a NixOS test's subtests nest in the test script, between the driver's blocks", () => {
		const { lines } = testLog(3, false);
		const t = tree(lines);
		expect(t.groups.filter((g) => g.kind === 'phase')).toEqual([]);
		expect(names(t.groups.filter((g) => g.depth === 0))).toEqual([
			'start all VLans',
			'run the VM test script',
			'cleanup'
		]);
		const run = t.groups.find((g) => g.name === 'run the VM test script')!;
		const inside = t.groups.filter((g) => g.parent === run.id);
		expect(inside[0].name).toBe('start all VMs');
		expect(inside.filter((g) => g.kind === 'subtest').length).toBeGreaterThanOrEqual(2);
		expect(t.groups.some((g) => /^machine/.test(g.name))).toBe(false);
		expect(t.chain(0)).toEqual([]);
	});

	it('lines between top-level blocks stay at the top level', () => {
		const t = tree([
			'subtest: a',
			'(finished: subtest: a, in 1.00 seconds)',
			'between',
			'subtest: b',
			'x'
		]);
		expect(t.chain(2)).toEqual([]);
		expect(t.groups[1].headerSlot).toBe(3);
	});

	it("console lines right after a block's finish join it, until another line", () => {
		const t = tree([
			'subtest: a',
			'machine: must succeed: true',
			'(finished: subtest: a, in 1.00 seconds)',
			`${E}[2mmachine # [  12.000000] systemd[1]: Started Journal Service.${E}[0m`,
			'server-2 # [  12.100000] kernel: eth1: renamed from eth0',
			'machine: waiting for unit postgresql.service',
			'machine # [  13.000000] systemd[1]: Starting nginx.service...',
			'subtest: b',
			'x'
		]);
		const a = t.groups[0];
		expect(a).toMatchObject({ name: 'a', closed: true, durationS: 1, lastSlot: 4, lines: 5 });
		expect(t.chain(4).map((g) => g.name)).toEqual(['a']);
		// The driver line ends the run; console lines after it stay at the top level.
		expect(t.chain(5)).toEqual([]);
		expect(t.chain(6)).toEqual([]);
		expect(t.groups[1]).toMatchObject({ name: 'b', headerSlot: 7 });
	});

	it("console lines after the driver's own blocks join them too", () => {
		const t = tree([
			block('run the VM test script'),
			block('start all VMs'),
			'machine: QEMU running (pid 46)',
			'(finished: start all VMs, in 0.21 seconds)',
			`${E}[2mmachine # Starting virtiofs daemons...${E}[0m`,
			block('subtest: a')
		]);
		expect(t.chain(4).map((g) => g.name)).toEqual(['run the VM test script', 'start all VMs']);
		expect(t.groups[1].lastSlot).toBe(4);
	});

	it('console lines after a nested finish join the inner subtest and count in the outer', () => {
		const t = tree([
			'subtest: outer',
			'subtest: inner',
			'(finished: subtest: inner, in 1.00 seconds)',
			'machine # [   1.000000] kernel: hello',
			'y',
			'(finished: subtest: outer, in 2.00 seconds)'
		]);
		const [outer, inner] = t.groups;
		expect(inner).toMatchObject({ lastSlot: 3, lines: 3 });
		expect(outer).toMatchObject({ lastSlot: 5, lines: 6 });
		expect(t.chain(4).map((g) => g.name)).toEqual(['outer']);
	});

	it('the gap row ends a run of console lines', () => {
		const t = tree(['subtest: a', '(finished: subtest: a, in 1.00 seconds)']);
		t.gap(2);
		t.add(3, 'machine # [   1.000000] kernel: hello');
		expect(t.groups[0].lastSlot).toBe(1);
		expect(t.chain(3)).toEqual([]);
	});

	it('an error after the last subtest and its console lines stays at the top level', () => {
		const t = tree([
			'subtest: a',
			'(finished: subtest: a, in 1.00 seconds)',
			'machine # [   1.000000] kernel: hello',
			'!!! boom'
		]);
		expect(t.groups[0].lastSlot).toBe(2);
		expect(t.failedGroup()).toBeNull();
		expect(t.chain(3)).toEqual([]);
	});

	it('the failed group is the innermost group holding the last line', () => {
		expect(tree(helloLines.slice(0, 1000)).failedGroup()?.name).toBe('buildPhase');
		const t = tree(['subtest: a', 'subtest: b', '!!! Test "b" failed with error: "x"']);
		expect(t.failedGroup()?.name).toBe('b');
	});

	it("the driver's cleanup closes the blocks a failure left open, and they stay the failed chain", () => {
		const t = tree([
			block('run the VM test script'),
			block('subtest: a'),
			'(finished: subtest: a, in 1.00 seconds)',
			block('subtest: b'),
			'machine: must succeed: false',
			`${E}[31m!!! ${E}[0mTest "b" failed with error: "command \`false\` failed (exit code 1)"`,
			`${E}[31m!!! ${E}[0mTraceback (most recent call last):`,
			`${E}[31m!!! ${E}[0mRequestedAssertionFailed: command \`false\` failed (exit code 1)`,
			block('cleanup'),
			'kill QemuMachine (pid 46)',
			`${E}[2mmachine # qemu-system-x86_64: terminating on signal 15${E}[0m`,
			'(finished: cleanup, in 0.20 seconds)',
			`${E}[2mmachine # [  30.000000] reboot: Power down${E}[0m`
		]);
		expect(t.groups.map((g) => [g.name, g.depth, g.closed, g.lastSlot, g.durationS])).toEqual([
			['run the VM test script', 0, true, 7, null],
			['a', 1, true, 2, 1],
			['b', 1, true, 7, null],
			['cleanup', 0, true, 12, 0.2]
		]);
		expect(t.open).toEqual([]);
		expect(t.failedGroup()?.name).toBe('b');
		// The search for the first error starts at the failed subtest, so it finds its !!! line.
		expect(t.errorSearchFrom()).toBe(3);
		expect(t.firstError()).toBe(5);
	});

	it('a failure outside any subtest leaves the test script as the failed group', () => {
		const t = tree([
			block('run the VM test script'),
			'subtest: a',
			'(finished: subtest: a, in 1.00 seconds)',
			'router: must succeed: curl http://server/',
			`${E}[31m!!! ${E}[0mTraceback (most recent call last):`,
			block('cleanup'),
			'(finished: cleanup, in 0.20 seconds)'
		]);
		expect(t.failedGroup()?.name).toBe('run the VM test script');
		expect(t.errorSearchFrom()).toBe(0);
		expect(t.firstError()).toBe(4);
	});

	it('the cleanup leaves a phase that holds the driver open', () => {
		const t = tree([
			'Running phase: checkPhase',
			block('run the VM test script'),
			'subtest: a',
			'!!! Test "a" failed with error: "x"',
			block('cleanup'),
			'(finished: cleanup, in 0.20 seconds)'
		]);
		expect(t.open.map((g) => g.name)).toEqual(['checkPhase']);
		expect(t.failedGroup()?.name).toBe('a');
		expect(t.groups.find((g) => g.name === 'cleanup')).toMatchObject({ depth: 1, parent: 0 });
		// A phase is the failed unit of work, so the search starts there.
		expect(t.errorSearchFrom()).toBe(0);
	});

	it("a failed demo test's chain is the test script and its failing subtests", () => {
		const { lines, p } = testLog(5, true);
		const t = tree(lines);
		const failed = t.failedGroup()!;
		expect(failed.name).toBe(p.failingSubtests[0]);
		expect(failed.durationS).toBeNull();
		expect(names(t.chain(failed.headerSlot))).toEqual([
			'run the VM test script',
			...[...p.failingSubtests].reverse()
		]);
		// The driver's cleanup came after the failure.
		expect(t.groups.at(-1)).toMatchObject({ name: 'cleanup', depth: 0, closed: true });
		expect(lines[t.firstError()!]).toContain(`Test "${p.failingSubtests[0]}" failed`);
	});

	it('no group is failed when the last line is at the top level', () => {
		expect(
			tree(['subtest: a', '(finished: subtest: a, in 1.00 seconds)', '!!! boom']).failedGroup()
		).toBeNull();
	});

	it('!!! lines count as errors in their group and every parent', () => {
		const t = tree([
			'subtest: a',
			'subtest: b',
			`${E}[31m!!! ${E}[0mTest "b" failed with error: "x"`,
			`${E}[31m!!! ${E}[0m`
		]);
		// The empty "!!!" line counts too, so the traceback's mark runs unbroken.
		expect(t.groups.map((g) => g.errors)).toEqual([2, 2]);
	});

	it('line, warning and error counts include nested groups', () => {
		const t = tree([
			'Running phase: buildPhase',
			'a.c:1:1: warning: x',
			'subtest: s',
			'b.c:2:2: error: y',
			'(finished: subtest: s, in 1.00 seconds)'
		]);
		expect(t.groups.map((g) => [g.lines, g.warnings, g.errors])).toEqual([
			[5, 1, 1],
			[3, 0, 1]
		]);
	});

	it("the gap row closes open groups, and the tail's first lines stay top level", () => {
		const e = new LogEngine();
		e.push(new TextEncoder().encode('Running phase: buildPhase\nmake\nmake\n'));
		e.startTail(10_000, 500);
		e.push(new TextEncoder().encode('tail line\nRunning phase: installPhase\nx\n'));
		e.settle();
		const t = e.tree;
		expect(t.groups.map((g) => [g.name, g.closed])).toEqual([
			['buildPhase', true],
			['installPhase', false]
		]);
		// The tail's first line: slot 4, after the head's 3 and the gap.
		expect(t.chain(4)).toEqual([]);
		expect(e.store.lineOf(4)).toBe(501);
	});

	it('lines appended during follow extend the open group without a rescan', () => {
		const t = new GroupTree();
		t.add(0, 'Running phase: buildPhase');
		const g = t.groups[0];
		for (let i = 1; i < 100; i++) t.add(i, `cc ${i}`);
		expect(t.groups[0]).toBe(g);
		expect(g.lastSlot).toBe(99);
		expect(g.lines).toBe(100);
	});

	it('the search for the first error starts at the outermost group that holds the last line', () => {
		const t = tree([
			'Running phase: configurePhase',
			'conf.c:1:1: error: in configure, before the failed phase',
			'Running phase: buildPhase',
			'subtest: s',
			'make: *** [Makefile:1: all] Error 2',
			'b.c:2:2: error: the one'
		]);
		expect(t.errorSearchFrom()).toBe(2);
		expect(t.firstError()).toBe(5);
		// At the top level after the last group: from the line after it.
		const top = tree([
			'subtest: a',
			'x.c:1:1: error: inside',
			'(finished: subtest: a, in 1.00 seconds)',
			'y.c:1:1: error: after'
		]);
		expect(top.errorSearchFrom()).toBe(3);
		expect(top.firstError()).toBe(3);
		expect(tree(['a.c:1:1: error: x']).firstError()).toBe(0);
	});
});

describe('groups of real NixOS test logs', () => {
	const openssh = new TextDecoder().decode(
		decompress(readFileSync(new URL('./fixtures/openssh.log.zst', import.meta.url)))
	);
	const logs = {
		/** nixosTests.openbao: one VM and 16 subtests. */
		openbao: linesOf(openbao),
		/** nixosTests.nat.firewall: three VMs and no subtests. */
		nat: linesOf(nat),
		/** nixosTests.openssh: about a dozen VMs and 13 subtests, one name twice. */
		openssh: linesOf(openssh)
	};
	const DRIVER = ['start all VLans', 'run the VM test script', 'cleanup'];
	/** Each subtest's name and duration, in order, as the log's finish lines say. */
	const subtests = (t: GroupTree) =>
		t.groups.filter((g) => g.kind === 'subtest').map((g) => [g.name, g.durationS]);

	it.each(Object.entries(logs))("%s: the driver's blocks at the top level", (_, lines) => {
		const t = tree(lines);
		expect(names(t.groups.filter((g) => g.depth === 0))).toEqual(DRIVER);
		expect(t.groups.every((g) => g.closed && g.kind !== 'phase')).toBe(true);
		expect(t.groups.some((g) => g.name === 'Setup')).toBe(false);
		// The first line, before any block, and the lines between them stay at the top level.
		expect(t.chain(0)).toEqual([]);
		const text = lines.map((l) => plainText(l));
		for (const l of [
			'Test will time out and terminate in 3600.0 seconds',
			'test script finished in'
		])
			expect(t.chain(text.findIndex((x) => x.startsWith(l)))).toEqual([]);
		// Machines' own steps never open one.
		expect(t.groups.every((g) => g.depth === 0 || g.parent === t.groups[1].id)).toBe(true);
		expect(t.failedGroup()).toBeNull();
		expect(t.errorSlots).toEqual([]);
	});

	it('openbao: its subtests nest under "run the VM test script", with their durations', () => {
		const t = tree(logs.openbao);
		const [vlans, run, vms] = t.groups;
		expect([vlans.durationS, run.durationS, vms.name, vms.depth]).toEqual([
			0,
			27.67,
			'start all VMs',
			1
		]);
		expect(run).toMatchObject({ headerSlot: 4, lastSlot: 1289 });
		const subs = subtests(t);
		expect(subs).toHaveLength(16);
		expect(subs[0]).toEqual(['Wait for OpenBao to start up', 12]);
		expect(subs[6]).toEqual(['Unseal OpenBao', 2.16]);
		expect(subs.at(-1)).toEqual(['Read a secret from cubbyhole', 0.15]);
		expect(t.groups.filter((g) => g.kind === 'subtest').every((g) => g.depth === 1)).toBe(true);
		// The console's lines right after the VMs started join "start all VMs".
		expect(t.chain(28).map((g) => g.name)).toEqual(['run the VM test script', 'start all VMs']);
		expect(t.groups.at(-1)).toMatchObject({ name: 'cleanup', durationS: 0.2, lastSlot: 1297 });
	});

	it('nat: a test without subtests still folds by its blocks', () => {
		const t = tree(logs.nat);
		expect(t.groups.map((g) => [g.name, g.depth, g.durationS])).toEqual([
			['start all VLans', 0, 0.01],
			['run the VM test script', 0, 42.49],
			['cleanup', 0, 0.47]
		]);
		// The test script holds nearly the whole log, three VMs' boot included.
		expect(t.groups[1].lines).toBeGreaterThan(3000);
	});

	it('openssh: 13 subtests, the same name twice, each with its own duration', () => {
		const t = tree(logs.openssh);
		const subs = subtests(t);
		expect(subs).toHaveLength(13);
		expect(subs.filter(([n]) => n === 'no-openssl')).toEqual([
			['no-openssl', 0.91],
			['no-openssl', 0.88]
		]);
		expect(subs[5]).toEqual(['allowed-users', 31.49]);
		expect(t.groups[1].durationS).toBe(102.36);
	});

	it('the engine finds the same blocks in the bytes', () => {
		const e = new LogEngine();
		e.push(new TextEncoder().encode(openbao));
		e.settle();
		expect(e.groups().map((g) => [g.kind, g.name, g.headerSlot, g.lastSlot])).toEqual(
			tree(logs.openbao).groups.map((g) => [g.kind, g.name, g.headerSlot, g.lastSlot])
		);
	});

	it('a failure cut into a real log opens the test script and the failed subtest', () => {
		// "Unseal OpenBao" fails halfway, as the driver prints it, then cleans up.
		const lines = [
			...logs.openbao.slice(0, 1150),
			`${E}[31m!!! ${E}[0mTest "Unseal OpenBao" failed with error: "command \`bao operator unseal\` failed (exit code 2)"`,
			`${E}[31m!!! ${E}[0mTraceback (most recent call last):`,
			`${E}[31m!!! ${E}[0m  File "<string>", line 52, in <module>`,
			`${E}[31m!!! ${E}[0m`,
			`${E}[31m!!! ${E}[0mRequestedAssertionFailed: command \`bao operator unseal\` failed (exit code 2)`,
			...logs.openbao.slice(logs.openbao.indexOf(block('cleanup')))
		];
		const t = tree(lines);
		const failed = t.failedGroup()!;
		expect(names(t.chain(failed.headerSlot))).toEqual(['run the VM test script', 'Unseal OpenBao']);
		expect(failed).toMatchObject({ closed: true, durationS: null, lastSlot: 1154 });
		expect(names(t.groups.filter((g) => g.depth === 0))).toEqual(DRIVER);
		expect(plainText(lines[t.firstError()!])).toMatch(/^!!! Test "Unseal OpenBao" failed/);
	});
});
