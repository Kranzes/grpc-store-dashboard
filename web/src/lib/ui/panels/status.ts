// What Nix said about a build: a short label for list rows and facts, and a
// sentence for its tooltip. DerivationList, DerivationDetail and the builder
// panel share them.

import { ERRORS_KEPT, type BuildStatus, type DrvView, type WorkerView } from '#lib/model/types.ts';

export const STATUS_LABEL: Record<BuildStatus, string> = {
	built: 'Built',
	substituted: 'Substituted',
	'already-valid': 'Already valid',
	'build-failed': 'Build failed',
	'timed-out': 'Timed out',
	'log-limit': 'Log limit exceeded',
	'output-rejected': 'Output rejected',
	'input-rejected': 'Input rejected',
	'not-deterministic': 'Not deterministic',
	'dependency-failed': 'Dependency failed',
	transient: 'Transient failure',
	'cached-failure': 'Cached failure',
	'no-substituters': 'No substituters',
	misc: 'Other failure',
	'worker-error': 'Builder error'
};

// Say only what Nix knows. A build that exits with an error is "permanent"
// unless it had network access or the disk was nearly full, so a flaky test
// fails as a permanent failure too.
export const STATUS_SENTENCE: Record<BuildStatus, string> = {
	built: 'The builder built it.',
	substituted: 'The builder took the output from a substituter instead of building it.',
	'already-valid': 'The builder already had the output.',
	'build-failed': 'The build exited with an error.',
	'timed-out':
		'The build ran past its timeout, or printed nothing for longer than its max-silent-time.',
	'log-limit': 'The build wrote more log than max-build-log-size allows.',
	'output-rejected': 'An output failed a check, such as a fixed-output hash that did not match.',
	'input-rejected': 'Nix rejected one of its inputs.',
	'not-deterministic': 'A repeated build produced different outputs.',
	'dependency-failed': 'An input of this build failed.',
	transient:
		'Nix marks the failure as possibly temporary. It does so when a build with network access exits with an error, such as one whose source URL did not answer, or when the disk is nearly full.',
	'cached-failure': 'Nix remembered an earlier failure and did not try again.',
	'no-substituters': 'Nix needed a path that no substituter had.',
	misc: 'Nix gave no more specific reason.',
	'worker-error':
		'The builder or its nix-daemon failed before or while building, so Nix reported no result.'
};

/**
 * A status after a count above 1: "4 builds failed", "2 builder errors".
 * A count of 1 takes the lower-case label: "1 build failed".
 */
const STATUS_PLURAL: Record<BuildStatus, string> = {
	built: 'built',
	substituted: 'substituted',
	'already-valid': 'already valid',
	'build-failed': 'builds failed',
	'timed-out': 'timed out',
	'log-limit': 'log limits exceeded',
	'output-rejected': 'outputs rejected',
	'input-rejected': 'inputs rejected',
	'not-deterministic': 'not deterministic',
	'dependency-failed': 'dependencies failed',
	transient: 'transient failures',
	'cached-failure': 'cached failures',
	'no-substituters': 'no substituters',
	misc: 'other failures',
	'worker-error': 'builder errors'
};

/** The failure callout's title: "Build failed: timed out", "Build failed" or "Builder error". */
export function statusTitle(status: BuildStatus): string {
	if (status === 'worker-error') return STATUS_LABEL[status];
	if (status === 'build-failed') return 'Build failed';
	return `Build failed: ${STATUS_LABEL[status].toLowerCase()}`;
}

/**
 * Failed builds by status, most common first: "4 builds failed, 1 timed out".
 * Builds without a status are left out. '' when there are none.
 */
export function failureSummary(drvs: readonly DrvView[]): string {
	const counts = new Map<BuildStatus, number>();
	for (const d of drvs)
		if (d.phase === 'failed' && d.status) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
	return [...counts]
		.sort((a, b) => b[1] - a[1] || STATUS_LABEL[a[0]].localeCompare(STATUS_LABEL[b[0]]))
		.map(([s, n]) => `${n} ${n === 1 ? STATUS_LABEL[s].toLowerCase() : STATUS_PLURAL[s]}`)
		.join(', ');
}

/** Whether any builder reports a version; an older scheduler sends none. */
export function anyReportsVersion(workers: ReadonlyMap<string, WorkerView>): boolean {
	for (const w of workers.values()) if (w.version !== '') return true;
	return false;
}

/**
 * Why a failed build shows no log lines, or null when it shows them. Exactly
 * one applies. `version` is its builder's, null when the store no longer has
 * the builder. `anyVersion` says whether any builder reports a version, since
 * an older scheduler sends none, and then the farm is the one that does not say.
 */
export function logCaption(
	d: Pick<DrvView, 'status' | 'errorSent' | 'errorText'>,
	version: string | null,
	anyVersion: boolean
): string | null {
	if (d.errorText !== null) return null;
	if (d.status === null)
		return anyVersion && !version
			? 'This builder does not say why builds fail.'
			: 'This farm does not say why builds fail.';
	if (!d.errorSent) return 'The builder sent no log lines for this build.';
	return `The dashboard keeps the log lines of the newest ${ERRORS_KEPT} failed builds only.`;
}
