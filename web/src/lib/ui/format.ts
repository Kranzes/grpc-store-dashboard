// Number and time formatting for live values. Outputs are short so they fit
// fixed-width slots; callers add .num for tabular numerals.

import type { Coverage } from '#lib/model/types.ts';

const intl = new Intl.NumberFormat('en-US');

/** 1234 as "1,234", 12345 as "12.3k", 1234567 as "1.23M". */
export function formatCount(n: number): string {
	if (!Number.isFinite(n)) return '–';
	const a = Math.abs(n);
	if (a < 10_000) return intl.format(Math.round(n));
	if (a < 1_000_000) return `${trim(n / 1000, a < 100_000 ? 1 : 0)}k`;
	return `${trim(n / 1_000_000, a < 10_000_000 ? 2 : 1)}M`;
}

/** Every digit, so 710513 is "710,513". For line numbers and counts that must stay exact. */
export function formatExact(n: number): string {
	return Number.isFinite(n) ? intl.format(Math.round(n)) : '–';
}

/** "1 builder", "3 builders". */
export function plural(
	n: number,
	one: string,
	many: string,
	fmt: (n: number) => string = formatCount
): string {
	return `${fmt(n)} ${n === 1 ? one : many}`;
}

/** Events per minute, whole: "0", "<1", "24", "1,240", "12.3k". Not a fraction of a build. */
export function formatPerMinute(perMin: number): string {
	if (!Number.isFinite(perMin) || perMin <= 0) return '0';
	if (perMin < 0.5) return '<1';
	return formatCount(perMin);
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Binary units, as Nix reports NAR sizes: "512 B", "3.4 MiB". Never four digits. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	let v = bytes;
	let u = 0;
	while (v >= 1000 && u < UNITS.length - 1) {
		v /= 1024;
		u++;
	}
	return `${u === 0 ? Math.round(v) : trim(v, v < 10 ? 1 : 0)} ${UNITS[u]}`;
}

export function formatByteRate(bytesPerSec: number): string {
	return `${formatBytes(bytesPerSec)}/s`;
}

/** In the picker's style, two units at most: "12s", "3m 20s", "3h 6m", "2d 4h". */
export function formatSpan(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '–';
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const words = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** formatSpan as a screen reader says it: "12 seconds", "3 minutes 20 seconds". */
export function spokenSpan(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown';
	const s = Math.floor(ms / 1000);
	if (s < 60) return words(s, 'second');
	const m = Math.floor(s / 60);
	const two = (a: string, b: string, rest: number) => (rest ? `${a} ${b}` : a);
	if (m < 60) return two(words(m, 'minute'), words(s % 60, 'second'), s % 60);
	const h = Math.floor(m / 60);
	if (h < 24) return two(words(h, 'hour'), words(m % 60, 'minute'), m % 60);
	const d = Math.floor(h / 24);
	return two(words(d, 'day'), words(h % 24, 'hour'), h % 24);
}

/** Relative to `now`, coarsest unit only: "just now", "12s ago", "3m ago", "in 4s". */
export function formatAgo(thenMs: number, nowMs: number): string {
	const d = nowMs - thenMs;
	if (Math.abs(d) < 1500) return 'just now';
	if (d < 0) return `in ${formatShort(-d)}`;
	return `${formatShort(d)} ago`;
}

/** formatAgo as a screen reader says it: "12 seconds ago", "in 4 seconds". */
export function spokenAgo(thenMs: number, nowMs: number): string {
	const d = nowMs - thenMs;
	if (Math.abs(d) < 1500) return 'just now';
	if (d < 0) return `in ${spokenShort(-d)}`;
	return `${spokenShort(d)} ago`;
}

const COARSE = [
	[86_400, 'd', 'day'],
	[3600, 'h', 'hour'],
	[60, 'm', 'minute']
] as const;

/** Coarsest unit only, in the picker's style: "12s", "3m", "2h", "4d". */
export function formatShort(ms: number): string {
	const s = Math.round(ms / 1000);
	for (const [n, unit] of COARSE) if (s >= n) return `${Math.floor(s / n)}${unit}`;
	return `${Math.max(0, s)}s`;
}

// Made once, since toLocaleTimeString builds a formatter on every call, about 40 µs each.
const CLOCK = new Intl.DateTimeFormat(undefined, {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
});
const CLOCK_MINUTES = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** formatShort as a screen reader says it: "12 seconds", "3 minutes". */
export function spokenShort(ms: number): string {
	const s = Math.round(ms / 1000);
	for (const [n, , word] of COARSE) if (s >= n) return words(Math.floor(s / n), word);
	return words(Math.max(0, s), 'second');
}

export function formatClock(ms: number): string {
	return CLOCK.format(ms);
}

/** The locale's clock to the minute: "23:41", "11:41 PM". */
export function formatClockMinutes(ms: number): string {
	return CLOCK_MINUTES.format(ms);
}

/** The totals windows the header offers, in minutes. Line histories keep an hour. */
export const WINDOW_MINUTES = [5, 15, 30, 60] as const;

/** A totals window as the header's picker shows it: "5m", "30m", "1h". */
export function windowShort(minutes: number): string {
	return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** A totals window as a screen reader says it: "5 minutes", "1 hour". */
export function windowSpoken(minutes: number): string {
	if (minutes >= 60 && minutes % 60 === 0) return words(minutes / 60, 'hour');
	return words(minutes, 'minute');
}

/** What a window's counts cover, for one muted caption per card or panel section. */
export type WindowCaption = Readonly<{
	/** "Last 15m", or "Since 23:41" while the window fills. */
	text: string;
	/** As a screen reader says it: "Last 15 minutes", "Since 23:41". */
	spoken: string;
	/** In the middle of a sentence: "in the last 15 minutes", "since 23:41". */
	phrase: string;
	/** Why the window is not full yet. null when it is. */
	title: string | null;
}>;

const STARTED: Record<Coverage['cause'], (at: string) => string> = {
	page: (at) => `since this page opened at ${at}`,
	restart: (at) => `since the scheduler restarted at ${at}`,
	history: (at) => `since ${at}, as far back as the scheduler's history goes`
};

/**
 * The caption of a window of `minutes`: "Last 15m" when the counts cover all
 * of it, else "Since 23:41" and a tooltip that says what started them.
 */
export function windowCaption(
	minutes: number,
	since: Coverage | null,
	nowMs: number
): WindowCaption {
	if (!since) {
		return {
			text: `Last ${windowShort(minutes)}`,
			spoken: `Last ${windowSpoken(minutes)}`,
			phrase: `in the last ${windowSpoken(minutes)}`,
			title: null
		};
	}
	const at = formatClockMinutes(since.fromMs);
	const covered = Math.min(minutes * 60_000, Math.max(0, nowMs - since.fromMs));
	return {
		text: `Since ${at}`,
		spoken: `Since ${at}`,
		phrase: `since ${at}`,
		title: `Counting ${STARTED[since.cause](at)}: ${formatShort(covered)} of the ${windowShort(minutes)} window`
	};
}

/** "host:port" of a URL, or the string itself if it is not one. */
export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export function formatPercent(ratio: number | null): string {
	if (ratio === null || !Number.isFinite(ratio)) return '–';
	return `${Math.round(ratio * 100)}%`;
}

function trim(v: number, digits: number): string {
	return v.toFixed(digits).replace(/\.0+$/, '');
}
