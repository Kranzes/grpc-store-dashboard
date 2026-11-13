import { describe, expect, it } from 'vitest';
import {
	formatAgo,
	formatBytes,
	formatClockMinutes,
	formatCount,
	formatPercent,
	formatPerMinute,
	formatShort,
	formatSpan,
	hostOf,
	spokenAgo,
	spokenShort,
	spokenSpan,
	WINDOW_MINUTES,
	windowCaption,
	windowShort,
	windowSpoken
} from './format.ts';

describe('format', () => {
	it('counts', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(1234)).toBe('1,234');
		expect(formatCount(12_345)).toBe('12.3k');
		expect(formatCount(123_456)).toBe('123k');
		expect(formatCount(1_234_567)).toBe('1.23M');
	});

	it('rates', () => {
		expect(formatPerMinute(0)).toBe('0');
		expect(formatPerMinute(0.2)).toBe('<1');
		expect(formatPerMinute(0.5)).toBe('1');
		expect(formatPerMinute(24.4)).toBe('24');
		expect(formatPerMinute(1240)).toBe('1,240');
		expect(formatPerMinute(12_345)).toBe('12.3k');
	});

	it('bytes in binary units', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KiB');
		expect(formatBytes(50 * 1024 * 1024)).toBe('50 MiB');
		expect(formatBytes(1004 * 1024 * 1024)).toBe('1 GiB');
	});

	it('spans in the picker style, two units at most', () => {
		expect(formatSpan(0)).toBe('0s');
		expect(formatSpan(12_400)).toBe('12s');
		expect(formatSpan(200_000)).toBe('3m 20s');
		expect(formatSpan(180_000)).toBe('3m');
		expect(formatSpan(3 * 3600_000 + 6 * 60_000 + 59_000)).toBe('3h 6m');
		expect(formatSpan(2 * 86_400_000 + 4 * 3600_000)).toBe('2d 4h');
		expect(formatSpan(-1)).toBe('–');
		expect(spokenSpan(1000)).toBe('1 second');
		expect(spokenSpan(200_000)).toBe('3 minutes 20 seconds');
		expect(spokenSpan(3600_000)).toBe('1 hour');
	});

	it('relative times in the picker style, the coarsest unit only, and in words', () => {
		expect(formatAgo(1000, 1500)).toBe('just now');
		expect(formatAgo(0, 12_000)).toBe('12s ago');
		expect(formatAgo(0, 185_000)).toBe('3m ago');
		expect(formatAgo(0, 3 * 3600_000 + 6 * 60_000)).toBe('3h ago');
		expect(formatAgo(0, 2 * 86_400_000)).toBe('2d ago');
		expect(formatAgo(4_000, 0)).toBe('in 4s');
		expect(spokenAgo(0, 185_000)).toBe('3 minutes ago');
		expect(spokenAgo(0, 1000)).toBe('just now');
		expect(spokenAgo(4_000, 0)).toBe('in 4 seconds');
		expect(spokenAgo(0, 3600_000)).toBe('1 hour ago');
		expect(formatShort(59_400)).toBe('59s');
		expect(formatShort(60_000)).toBe('1m');
		expect(spokenShort(200_000)).toBe('3 minutes');
		expect(spokenShort(1000)).toBe('1 second');
	});

	it('percent', () => {
		expect(formatPercent(null)).toBe('–');
		expect(formatPercent(0.876)).toBe('88%');
	});

	it('captions a full window "Last 15m", in words for screen readers', () => {
		expect(windowCaption(15, null, 0)).toEqual({
			text: 'Last 15m',
			spoken: 'Last 15 minutes',
			phrase: 'in the last 15 minutes',
			title: null
		});
		expect(windowCaption(60, null, 0).text).toBe('Last 1h');
		expect(windowCaption(1, null, 0).spoken).toBe('Last 1 minute');
	});

	it('captions a window that fills "Since 23:41", and says what started the counts', () => {
		const at = Date.UTC(2026, 10, 8, 23, 41, 10);
		const clock = formatClockMinutes(at);
		const now = at + 4 * 60_000 + 20_000;
		const page = windowCaption(15, { fromMs: at, cause: 'page' }, now);
		expect(page).toEqual({
			text: `Since ${clock}`,
			spoken: `Since ${clock}`,
			phrase: `since ${clock}`,
			title: `Counting since this page opened at ${clock}: 4m of the 15m window`
		});
		expect(windowCaption(60, { fromMs: at, cause: 'restart' }, now).title).toBe(
			`Counting since the scheduler restarted at ${clock}: 4m of the 1h window`
		);
		expect(windowCaption(60, { fromMs: at, cause: 'history' }, at + 30_000).title).toBe(
			`Counting since ${clock}, as far back as the scheduler's history goes: 30s of the 1h window`
		);
		// Never more than the window, and never "so far".
		expect(windowCaption(5, { fromMs: at, cause: 'page' }, at + 3600_000).title).toContain(
			': 5m of the 5m window'
		);
		expect(JSON.stringify(page)).not.toMatch(/so far/i);
	});

	it('offers 5m, 15m, 30m and 1h, no more than the hour line histories keep', () => {
		expect(WINDOW_MINUTES.map(windowShort)).toEqual(['5m', '15m', '30m', '1h']);
		expect(WINDOW_MINUTES.map(windowSpoken)).toEqual([
			'5 minutes',
			'15 minutes',
			'30 minutes',
			'1 hour'
		]);
		expect(windowSpoken(120)).toBe('2 hours');
		expect(windowShort(90)).toBe('90m');
	});

	it('names the host of a URL', () => {
		expect(hostOf('https://cache.example.com:8443/nix')).toBe('cache.example.com:8443');
		expect(hostOf('not a url')).toBe('not a url');
	});
});
