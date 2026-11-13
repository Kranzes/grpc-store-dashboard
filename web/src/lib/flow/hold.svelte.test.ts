import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { FarmStore } from '#lib/model/types.ts';
import { holdStill } from './hold.ts';

/** A store with one published map and one method, like ReducerFarmStore. */
class Fake {
	#workers = $state.raw<ReadonlyMap<string, number>>(new Map([['a', 1]]));
	get workers() {
		return this.#workers;
	}
	publish(next: ReadonlyMap<string, number>) {
		this.#workers = next;
	}
	count() {
		return this.#workers.size;
	}
}

describe('holdStill', () => {
	it('keeps what it read, and does not rerun readers on a publish', () => {
		const live = new Fake();
		const held = holdStill(live as unknown as FarmStore) as unknown as Fake;
		const seen: (number | undefined)[] = [];
		const stop = $effect.root(() => {
			$effect(() => {
				seen.push(held.workers.get('a'));
			});
		});
		flushSync();
		live.publish(new Map([['a', 2]]));
		flushSync();
		expect(seen).toEqual([1]);
		expect(held.workers.get('a')).toBe(1);
		expect(live.workers.get('a')).toBe(2);
		stop();
	});

	it('answers methods from the live store', () => {
		const live = new Fake();
		const held = holdStill(live as unknown as FarmStore) as unknown as Fake;
		void held.workers;
		live.publish(
			new Map([
				['a', 1],
				['b', 2]
			])
		);
		expect(held.count()).toBe(2);
		expect(held.workers.size).toBe(1);
	});
});
