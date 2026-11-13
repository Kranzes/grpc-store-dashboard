import { describe, expect, it } from 'vitest';
import type { SystemQueueView } from '#lib/model/types.ts';
import { groupBacklog, type Offer } from './backlog.ts';

const row = (
	system: string,
	features: string,
	queued: number,
	unplaceable = 0
): SystemQueueView => ({
	system,
	features,
	queued,
	unplaceable,
	running: 0,
	slots: 0,
	free: 0
});

const X = 'x86_64-linux';
const builder = (...features: string[]): Offer => ({ systems: [X], features });

describe('groupBacklog', () => {
	const rows = [
		row(X, '', 3000),
		row(X, 'big-parallel', 500),
		row(X, 'kvm,nixos-test', 200),
		row(X, 'benchmark', 7),
		row('aarch64-linux', '', 900)
	];

	it('a uniform group counts what each of its builders could take, once', () => {
		const group = Array.from({ length: 10 }, () => builder('big-parallel'));
		expect(groupBacklog(rows, group)).toBe(3500);
	});

	it('mixed features add up to the union, not a sum and not the largest card', () => {
		// Neither set holds the other: one card takes 3,507, the other 3,700.
		const group = [builder('benchmark', 'big-parallel'), builder('kvm', 'nixos-test')];
		expect(groupBacklog(rows, group)).toBe(3000 + 500 + 200 + 7);
		// A row needs one builder with every feature, not features spread over two.
		expect(groupBacklog([row(X, 'big-parallel,kvm', 40)], group)).toBe(0);
	});

	it('a group of one is that builder', () => {
		expect(groupBacklog(rows, [builder('kvm', 'nixos-test')])).toBe(3200);
	});

	it('an empty queue, or no builders, is 0', () => {
		expect(groupBacklog([], [builder()])).toBe(0);
		expect(groupBacklog(rows, [])).toBe(0);
	});

	it('leaves out unplaceable derivations, and counts systems a builder also offers', () => {
		expect(groupBacklog([row(X, '', 10, 4)], [builder()])).toBe(6);
		const both: Offer = { systems: [X, 'i686-linux'], features: [] };
		expect(groupBacklog([row('i686-linux', '', 5), row(X, '', 1)], [both])).toBe(6);
	});
});
