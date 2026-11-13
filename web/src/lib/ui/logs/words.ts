// The Logs tab's words for durations and counts, in the picker's style,
// with what screen readers hear.

import type { Group } from '#lib/logs/groups.ts';
import { ERRORS_CAP } from '#lib/logs/groups.ts';
import {
	formatExact,
	formatShort,
	formatSpan,
	plural,
	spokenShort,
	spokenSpan
} from '../format.ts';

export type Said = Readonly<{ text: string; words: string }>;

/** A running build's stdenv phase as its builder reported it; startedMs is browser ms. */
export type ReportedPhase = Readonly<{ name: string; startedMs: number }>;

/** Two units, as details and group headers say them: "3m 20s", "41s", "<1s". */
export function span(ms: number): Said {
	if (ms < 1000) return { text: '<1s', words: 'under a second' };
	return { text: formatSpan(ms), words: spokenSpan(ms) };
}

/** One unit, as lists say them: "41s", "6m". */
export function short(ms: number): Said {
	if (ms < 1000) return { text: '<1s', words: 'under a second' };
	// Round down to whole seconds, as span does, so a list row and "Took" agree.
	const whole = Math.floor(ms / 1000) * 1000;
	return { text: formatShort(whole), words: spokenShort(whole) };
}

export function lines(n: number): string {
	return plural(n, 'line', 'lines', formatExact);
}

export function errors(n: number): string {
	return n >= ERRORS_CAP
		? `${formatExact(ERRORS_CAP)}+ errors`
		: plural(n, 'error', 'errors', formatExact);
}

export function warnings(n: number): string {
	return plural(n, 'warning', 'warnings', formatExact);
}

/** A header's accessible name: "buildPhase, failed, 1,480 lines, 3 errors". */
export function groupWords(g: Group, failed: boolean, elapsed: Said | null): string {
	const parts = [g.kind === 'subtest' ? `subtest: ${g.name}` : g.name];
	if (failed) parts.push('failed');
	if (g.durationS !== null) parts.push(span(g.durationS * 1000).words);
	if (elapsed) parts.push(`${elapsed.words} elapsed`);
	parts.push(lines(g.lines));
	if (g.warnings) parts.push(warnings(g.warnings));
	if (g.errors) parts.push(errors(g.errors));
	return parts.join(', ');
}
