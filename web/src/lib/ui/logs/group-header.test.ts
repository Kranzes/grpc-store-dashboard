import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Group } from '#lib/logs/groups.ts';
import GroupHeader from './GroupHeader.svelte';

const NOW = 1_000_000;

function group(name: string): Group {
	return {
		id: 1,
		kind: 'phase',
		name,
		headerSlot: 10,
		lastSlot: 40,
		depth: 0,
		parent: null,
		durationS: null,
		lines: 31,
		warnings: 0,
		errors: 0,
		closed: false
	};
}

function header(name: string, phase: { name: string; startedMs: number } | null): string {
	return render(GroupHeader, {
		props: {
			group: group(name),
			folded: false,
			failed: false,
			current: true,
			phase,
			nowMs: NOW,
			onclick: () => {}
		}
	}).body;
}

describe('the current phase header', () => {
	it('says elapsed when the builder reported that phase', () => {
		const body = header('buildPhase', { name: 'buildPhase', startedMs: NOW - 12_000 });
		expect(body).toContain('12s elapsed');
	});

	it('shows the dot only while the report lags the log', () => {
		const body = header('buildPhase', { name: 'configurePhase', startedMs: NOW - 3_000 });
		expect(body).not.toContain('elapsed');
		expect(body).toMatch(/class="dot[ "]/);
	});
});
