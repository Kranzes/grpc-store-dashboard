import { describe, expect, it } from 'vitest';
import { DrvGone_Outcome, DrvGone_Status } from '#lib/gen/events_pb.ts';
import { plainText } from '#lib/logs/ansi.ts';
import { GroupTree } from '#lib/logs/groups.ts';
import { drvPath } from '#lib/model/fixtures.ts';
import { NIXOS_LOGS } from './mock.ts';
import { finalLog, linesAt, planLog } from './mock-log.ts';
import { nixosLogLines, nixosLogPlan } from './nixos-logs.ts';

const base = planLog({
	seed: 1,
	drvPath: drvPath('api-vm-test-3'),
	name: 'api-vm-test-3',
	system: 'x86_64-linux',
	assignId: 1,
	plannedMs: 60_000
});
const failed = { outcome: DrvGone_Outcome.FAILED, status: DrvGone_Status.PERMANENT_FAILURE };

function tree(log: { count: number; line: (i: number) => string }): GroupTree {
	const t = new GroupTree();
	for (let i = 0; i < log.count; i++) t.add(i, plainText(log.line(i)), log.line(i));
	return t;
}

describe('nixosLogPlan', () => {
	it.each([
		['openbao', 'Read a secret from cubbyhole'],
		['nat', null],
		['openssh', 'keygen without sshd']
	] as const)('%s: the real log, and a failure cut into it', async (name, failing) => {
		expect(NIXOS_LOGS).toContain(name);
		const lines = await nixosLogLines(name);
		const p = nixosLogPlan(base, lines);
		// A test that passed shows the whole real log.
		expect(
			finalLog(p, { outcome: DrvGone_Outcome.BUILT, status: DrvGone_Status.BUILT }).count
		).toBe(lines.length);
		// A running build shows the test script in time, and the cleanup only once it ends.
		expect(linesAt(p, 30_000)).toBeLessThan(p.runningMax);
		expect(plainText(lines[p.runningMax])).toMatch(/^\(finished: run the VM test script, /);
		const t = tree(finalLog(p, failed));
		const chain = t.chain(t.failedGroup()!.headerSlot).map((g) => g.name);
		expect(chain).toEqual(['run the VM test script', ...(failing ? [failing] : [])]);
		expect(p.failingSubtests).toEqual(failing ? [failing] : []);
		expect(t.groups.at(-1)).toMatchObject({ name: 'cleanup', depth: 0 });
	});
});
