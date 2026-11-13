import { describe, expect, it } from 'vitest';
import type { SystemQueueView } from '#lib/model/types.ts';
import { QUEUE_TRACK, needText, queueCard, stuckTitle } from './queue.ts';

const row = (system: string, queued: number, unplaceable = 0, features = ''): SystemQueueView => ({
	system,
	features,
	queued,
	unplaceable,
	running: 0,
	slots: 0,
	free: 0
});

describe('queue rows on the scheduler card', () => {
	it('folds every row with unplaceable work into one, and the largest queues fill the rest', () => {
		// As the reducer sorts them: unplaceable rows first, then the busiest.
		const systems = [
			row('aarch64-linux', 9, 9, 'kvm,nixos-test'),
			row('aarch64-linux', 3, 3, 'kvm'),
			row('riscv64-linux', 3, 3),
			row('x86_64-linux', 2, 2, 'cuda'),
			row('x86_64-linux', 404),
			row('aarch64-linux', 149),
			row('i686-linux', 12),
			row('x86_64-darwin', 0)
		];
		const card = queueCard(systems);
		expect(card.stuck?.rows).toHaveLength(4);
		expect(card.stuck?.unplaceable).toBe(17);
		// Four rows, but three systems, since aarch64-linux needs two sets of features.
		expect(card.stuck?.systems).toEqual(['aarch64-linux', 'riscv64-linux', 'x86_64-linux']);
		// The big queues no longer hide under "+N more".
		expect(card.bars.map((b) => b.row.system)).toEqual([
			'x86_64-linux',
			'aarch64-linux',
			'i686-linux'
		]);
		expect(card.more).toBe(1);
		expect(card.bars[0].fill).toBe(1);
		expect(card.bars[1].fill).toBeCloseTo(149 / 404);
	});

	it('gives every slot to queues when nothing is unplaceable', () => {
		const card = queueCard([row('a', 5), row('b', 50), row('c', 1), row('d', 0), row('e', 0)]);
		expect(card.stuck).toBeNull();
		expect(card.bars.map((b) => b.row.system)).toEqual(['b', 'a', 'c', 'd']);
		expect(card.more).toBe(1);
	});

	it('draws a queue of 1 beside a large one, and an empty queue as an empty track', () => {
		const card = queueCard([
			row('x86_64-linux', 272),
			row('riscv64-linux', 1),
			row('i686-linux', 0)
		]);
		const [big, small, none] = card.bars;
		expect(big.fill).toBe(1);
		// 1/272 of 64 px would be 0.24 px; it gets 2 px.
		expect(small.fill * QUEUE_TRACK).toBeCloseTo(2);
		expect(none.fill).toBe(0);
	});

	it('shows only the folded row when all work is stuck, and nothing without rows', () => {
		const card = queueCard([row('riscv64-linux', 3, 3)]);
		expect(card.stuck?.unplaceable).toBe(3);
		expect(card.stuck?.systems).toEqual(['riscv64-linux']);
		expect(card.bars).toEqual([]);
		expect(card.more).toBe(0);
		expect(queueCard([])).toEqual({ stuck: null, bars: [], more: 0 });
	});

	it('names what the folded rows need in the tooltip', () => {
		expect(needText(row('riscv64-linux', 3, 3))).toBe('riscv64-linux');
		expect(needText(row('aarch64-linux', 9, 9, 'kvm,nixos-test'))).toBe(
			'aarch64-linux, needs kvm, nixos-test'
		);
		expect(stuckTitle([row('riscv64-linux', 3, 3), row('x86_64-linux', 2, 2, 'cuda')])).toBe(
			'No connected builder offers what these need: riscv64-linux; x86_64-linux, needs cuda'
		);
	});
});
