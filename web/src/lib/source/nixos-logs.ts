// Real NixOS test logs from cache.nixos.org, for the demo's nixoslog option.
// With it, every NixOS test build shows the log it names. The log worker
// imports this module only in dev and test builds, so a production build
// carries none of it. The logs are Hydra's builds of nixosTests.openbao (one VM, subtests),
// nixosTests.nat.firewall (three VMs, no subtests) and nixosTests.openssh
// (about a dozen VMs and 13 subtests, kept compressed).

import { decompress } from 'fzstd';
import { stripAnsi } from '#lib/logs/errors.ts';
import { FINISHED, SUBTEST } from '#lib/logs/groups.ts';
import type { NixosLog } from './mock.ts';
import type { LogPlan } from './mock-log.ts';

/** The log's lines, without their newlines. */
export async function nixosLogLines(name: NixosLog): Promise<string[]> {
	let text: string;
	if (name === 'openbao') text = (await import('../logs/fixtures/openbao.log?raw')).default;
	else if (name === 'nat') text = (await import('../logs/fixtures/nat-firewall.log?raw')).default;
	else {
		// A data: URL, so the bytes come with the module wherever it runs.
		const url = (await import('../logs/fixtures/openssh.log.zst?inline')).default;
		const zst = new Uint8Array(await (await fetch(url)).arrayBuffer());
		text = new TextDecoder().decode(decompress(zst));
	}
	return text.split('\n').slice(0, -1);
}

/**
 * A plan that shows a real log in place of the generated one, with the
 * generated plan's build and timing. A running build shows the lines up to
 * the test script's finish line in proportion to its time, and the driver's
 * cleanup when it ends. A failure cuts in halfway through the last subtest,
 * or halfway through the test script when it has none.
 */
export function nixosLogPlan(base: LogPlan, lines: readonly string[]): LogPlan {
	const text = lines.map(stripAnsi);
	const run = text.indexOf('run the VM test script');
	const ends = (l: string, block: string) => FINISHED.exec(l)?.[1] === block;
	const end = text.findIndex((l) => ends(l, 'run the VM test script'));
	if (run < 0 || end < 0) return base;
	const last = text.findLastIndex((l) => SUBTEST.test(l));
	const name = last < 0 ? '' : SUBTEST.exec(text[last])![1];
	const finish = last < 0 ? -1 : text.findIndex((l, i) => i > last && ends(l, `subtest: ${name}`));
	// Inside the last subtest, or inside the test script when it has none.
	const inSubtest = finish > last + 1;
	const [from, to] = inSubtest ? [last, finish] : [run, end];
	const failAt = from + 1 + Math.floor((to - from - 1) / 2);
	const gen = (from: number) => (k: number) => lines[from + k];
	return {
		...base,
		blocks: [
			{ start: 0, count: end, gen: gen(0), t0: 0, t1: base.plannedMs, ending: false },
			{
				start: end,
				count: lines.length - end,
				gen: gen(end),
				t0: base.plannedMs,
				t1: base.plannedMs,
				ending: true
			}
		],
		total: lines.length,
		runningMax: end,
		failAt,
		phases: [],
		failingSubtests: inSubtest ? [name] : []
	};
}
