import { describe, expect, it } from 'vitest';
import { drvPath } from '#lib/model/fixtures.ts';
import type { BuildRow } from '#lib/model/types.ts';
import { keyOf, listItems } from './items.ts';

const NOW = 1_800_000_000_000;

function row(name: string, state: BuildRow['state']): BuildRow {
	return {
		drvPath: drvPath(name),
		name,
		system: 'x86_64-linux',
		worker: '10.0.0.10:50051',
		assignId: 1,
		state,
		status: null,
		errorLine: null,
		assignedMs: NOW - 120_000,
		startedMs: null,
		reportsStarts: false,
		finishedMs: state === 'assigned' ? null : NOW - 60_000,
		finishedServerMs: state === 'assigned' ? null : NOW - 60_000,
		phase: null,
		phaseStartedMs: null,
		requestedBy: [],
		from: 'live'
	};
}

const keys = (rows: readonly BuildRow[]) => rows.map(keyOf);
const labels = (items: ReturnType<typeof listItems>) =>
	items.map((it) => (it.kind === 'head' ? it.label : it.row.name));
const unique = (items: ReturnType<typeof listItems>) =>
	new Set(items.map((it) => it.key)).size === items.length;

describe('listItems', () => {
	it('heads each section under Failures first', () => {
		const live = [row('f1', 'failed'), row('a1', 'assigned'), row('b1', 'built')];
		const items = listItems(live, keys(live), 'failures', null, null);
		expect(labels(items)).toEqual(['Failed', 'f1', 'Assigned', 'a1', 'Finished', 'b1']);
		expect(items[0].key).toBe('head:Failed');
	});

	it('keys a section that comes back after the selected build apart', () => {
		const live = [row('f1', 'failed'), row('b1', 'built')];
		const selected = row('x', 'built');
		const items = listItems(live, keys(live), 'failures', keyOf(selected), selected);
		expect(labels(items)).toEqual(['Finished', 'x', 'Failed', 'f1', 'Finished', 'b1']);
		expect(unique(items)).toBe(true);
	});

	it('keys a section that comes back in a held order apart', () => {
		// Held as f1, a1, a2, a3, b1; then a2 finished.
		const held = [row('f1', 'failed'), row('a1', 'assigned'), row('a2', 'assigned')];
		held.push(row('a3', 'assigned'), row('b1', 'built'));
		const live = held.map((r) => (r.name === 'a2' ? { ...r, state: 'built' as const } : r));
		const items = listItems(live, keys(held), 'failures', null, null);
		expect(labels(items)).toEqual([
			'Failed',
			'f1',
			'Assigned',
			'a1',
			'Finished',
			'a2',
			'Assigned',
			'a3',
			'Finished',
			'b1'
		]);
		expect(unique(items)).toBe(true);
	});

	it('shows only rows the live view still has, without heads in other sorts', () => {
		const live = [row('b1', 'built'), row('b2', 'built')];
		const order = [...keys(live), keyOf(row('gone', 'built'))].reverse();
		expect(labels(listItems(live, order, 'newest', null, null))).toEqual(['b2', 'b1']);
	});
});
