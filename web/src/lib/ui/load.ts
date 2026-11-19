// A builder's or a pool's host CPU and memory, in the words of the card, the
// pool node and the panels.

import { shareOf, type PoolView, type WorkerView } from '#lib/model/types.ts';
import { formatBytes, formatCount, formatCpus, formatPercent } from './format.ts';

type Load = Pick<WorkerView, 'cpuBusy' | 'cpuIowait' | 'cpuCores' | 'memUsed' | 'memTotal'>;

/** Busy CPUs, CPUs in I/O wait and RAM in use as shares, 0 to 1, null where not reported. */
export function loadShares(l: Load): { cpu: number | null; io: number | null; mem: number | null } {
	return {
		cpu: shareOf(l.cpuBusy, l.cpuCores),
		io: shareOf(l.cpuIowait, l.cpuCores),
		mem: shareOf(l.memUsed, l.memTotal)
	};
}

/** "CPU 34% · RAM 61%", or null when neither is reported. */
export function loadText(l: Load): string | null {
	const { cpu, mem } = loadShares(l);
	if (cpu === null && mem === null) return null;
	const parts = [];
	if (cpu !== null) parts.push(`CPU ${formatPercent(cpu)}`);
	if (mem !== null) parts.push(`RAM ${formatPercent(mem)}`);
	return parts.join(' · ');
}

/** The figures behind loadText, and that every process counts in them. */
export function loadTitle(l: Load): string {
	const parts = [];
	if (l.cpuBusy !== null && l.cpuCores !== null) {
		const io = l.cpuIowait ? ` and ${formatCpus(l.cpuIowait)} waiting on I/O` : '';
		parts.push(
			`${formatCpus(l.cpuBusy)} of ${formatCount(l.cpuCores)} CPUs busy${io} over the last minute`
		);
	}
	if (l.memUsed !== null && l.memTotal !== null)
		parts.push(`${formatBytes(l.memUsed)} of ${formatBytes(l.memTotal)} RAM in use`);
	return `${parts.join(', ')}. Every process on the builder counts, not only its builds.`;
}

/** How many connected builders of a pool report, while some do not. null when all or none do. */
export function poolLoadCoverage(p: PoolView): { reporting: number; connected: number } | null {
	const connected = p.up + p.draining;
	return p.loadBuilders > 0 && p.loadBuilders < connected
		? { reporting: p.loadBuilders, connected }
		: null;
}
