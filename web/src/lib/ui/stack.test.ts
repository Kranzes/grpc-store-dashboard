import { describe, expect, it } from 'vitest';
import { parseLineId } from '#lib/flow/kinds.ts';
import {
	back,
	focusOf,
	openLinesOnMap,
	openNode,
	openerOf,
	push,
	sameView,
	selectedOf,
	viewKey,
	type EndsOf,
	type PanelStack,
	type PanelView
} from './stack.ts';

// Ends as the map draws them, for the ids these tests use.
const ends: EndsOf = (id) => {
	const [kind, ...rest] = id.split(':');
	const end = rest.join(':');
	const other = end.startsWith('pool:') ? end : `worker:${end}`;
	switch (kind) {
		case 'assign':
			return ['scheduler', other];
		case 'publish':
			return [other, 'cache'];
		case 'fetch':
			return ['cache', other];
		case 'want':
			return [`clients:${end}`, 'scheduler'];
		default:
			return ['scheduler', 'cache'];
	}
};

const node = (nodeId: string): PanelView => ({ kind: 'node', nodeId });
const line = (...edgeIds: string[]): PanelView => ({
	kind: 'lines',
	flow: parseLineId(edgeIds[0])!.kind,
	edgeIds
});
const drv = (drvPath: string, via?: string): PanelView => ({ kind: 'derivation', drvPath, via });

describe('panel stack', () => {
	it('focus is the topmost view that is not a derivation', () => {
		expect(focusOf([])).toBeNull();
		expect(focusOf([node('worker:a')])).toEqual(node('worker:a'));
		expect(focusOf([node('worker:a'), drv('/d')])).toEqual(node('worker:a'));
		const s: PanelStack = [node('worker:a'), line('assign:a'), drv('/d', 'assign:a')];
		expect(focusOf(s)).toEqual(line('assign:a'));
		expect(selectedOf(focusOf(s))).toBeNull();
		expect(selectedOf(focusOf([node('worker:a'), drv('/d')]))).toBe('worker:a');
	});

	it('a node click opens its panel, and a second click closes it or steps back to it', () => {
		const s = openNode([], 'worker:a');
		expect(s).toEqual([node('worker:a')]);
		expect(openNode(s, 'worker:a')).toEqual([]);
		expect(openNode(s, 'scheduler')).toEqual([node('scheduler')]);
		expect(openNode([...s, drv('/d')], 'worker:a')).toEqual([node('worker:a')]);
		// Over a line panel, a node click starts over.
		expect(openNode([line('assign:a', 'assign:b')], 'worker:a')).toEqual([node('worker:a')]);
	});

	it('a builder picked from a pool opens over the pool', () => {
		expect(openNode([], 'worker:a', 'pool:x86_64-linux')).toEqual([
			node('pool:x86_64-linux'),
			node('worker:a')
		]);
		const inPool = openNode([node('pool:x86_64-linux')], 'worker:a', 'pool:x86_64-linux');
		expect(inPool).toEqual([node('pool:x86_64-linux'), node('worker:a')]);
		expect(back(inPool)).toEqual([node('pool:x86_64-linux')]);
		expect(openNode(inPool, 'worker:a', 'pool:x86_64-linux')).toEqual([]);
	});

	it('a click on the map opens a line over the node panel at one of its ends', () => {
		const s = openLinesOnMap([node('worker:a')], 'assign', ['assign:a'], ends);
		expect(s).toEqual([node('worker:a'), line('assign:a')]);
		expect(back(s)).toEqual([node('worker:a')]);
		// A derivation over the node panel goes; the node panel stays below.
		expect(openLinesOnMap([node('worker:a'), drv('/d')], 'assign', ['assign:a'], ends)).toEqual([
			node('worker:a'),
			line('assign:a')
		]);
		// The scheduler is at an end of every assignment line of a bundle.
		expect(openLinesOnMap([node('scheduler')], 'assign', ['assign:a', 'assign:b'], ends)).toEqual([
			node('scheduler'),
			line('assign:a', 'assign:b')
		]);
	});

	it('a click on the map starts over when no open node is at an end of every line', () => {
		expect(openLinesOnMap([], 'assign', ['assign:a'], ends)).toEqual([line('assign:a')]);
		expect(openLinesOnMap([node('worker:a')], 'assign', ['assign:a', 'assign:b'], ends)).toEqual([
			line('assign:a', 'assign:b')
		]);
		expect(openLinesOnMap([node('worker:b')], 'publish', ['publish:a'], ends)).toEqual([
			line('publish:a')
		]);
		expect(openLinesOnMap([line('assign:a')], 'assign', ['assign:b'], ends)).toEqual([
			line('assign:b')
		]);
	});

	it('clicking the focused line again closes, or steps back from its derivation', () => {
		const s = openLinesOnMap([], 'assign', ['assign:a', 'assign:b'], ends);
		// The same bundle, hit in another order.
		expect(openLinesOnMap(s, 'assign', ['assign:b', 'assign:a'], ends)).toEqual([]);
		const withDrv = push(s, drv('/d', 'assign:a'));
		expect(openLinesOnMap(withDrv, 'assign', ['assign:a', 'assign:b'], ends)).toEqual(s);
		// Over a node panel too, a second click closes the panel.
		const over = [node('worker:a'), line('assign:a')];
		expect(openLinesOnMap(over, 'assign', ['assign:a'], ends)).toEqual([]);
	});

	it('Lines rows, breakdown rows and list rows push, and back pops one view', () => {
		let s: PanelStack = [node('scheduler')];
		s = push(s, line('assign:a', 'assign:b'));
		s = push(s, line('assign:a'));
		s = push(s, drv('/d', 'assign:a'));
		expect(s).toHaveLength(4);
		expect(push(s, drv('/d', 'assign:a'))).toBe(s);
		s = back(s);
		expect(s.at(-1)).toEqual(line('assign:a'));
		s = back(s);
		expect(s.at(-1)).toEqual(line('assign:a', 'assign:b'));
		expect(back(back(s))).toEqual([]);
	});

	it("the opener is the first view's node", () => {
		expect(openerOf([], ends)).toBeNull();
		expect(openerOf([node('pool:x86_64-linux'), node('worker:a')], ends)).toBe('pool:x86_64-linux');
		expect(openerOf([node('worker:a'), line('assign:a')], ends)).toBe('worker:a');
		// A line from the map: its builder, pool or client end.
		expect(openerOf([line('assign:a')], ends)).toBe('worker:a');
		expect(openerOf([line('assign:pool:x86_64-linux')], ends)).toBe('pool:x86_64-linux');
		expect(openerOf([line('publish:a')], ends)).toBe('worker:a');
		expect(openerOf([line('fetch:a')], ends)).toBe('worker:a');
		expect(openerOf([line('want:ci')], ends)).toBe('clients:ci');
		// A bundle: the node its lines share. The cache hits line: the scheduler.
		expect(openerOf([line('assign:a', 'assign:b')], ends)).toBe('scheduler');
		expect(openerOf([line('publish:a', 'publish:b')], ends)).toBe('cache');
		expect(openerOf([line('fetch:a', 'fetch:b')], ends)).toBe('cache');
		expect(openerOf([line('want:ci', 'want:dev')], ends)).toBe('scheduler');
		expect(openerOf([line('cached:scheduler')], ends)).toBe('scheduler');
	});

	it('views compare by content, and keys tell them apart', () => {
		expect(sameView(line('assign:a', 'assign:b'), line('assign:b', 'assign:a'))).toBe(true);
		expect(sameView(line('assign:a'), line('assign:a', 'assign:b'))).toBe(false);
		expect(sameView(drv('/d', 'assign:a'), drv('/d', 'assign:b'))).toBe(false);
		expect(sameView(node('worker:a'), line('assign:a'))).toBe(false);
		const keys = [node('a'), line('assign:a'), drv('/d'), drv('/d', 'assign:a')].map(viewKey);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
