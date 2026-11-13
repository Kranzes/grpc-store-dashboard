import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { Hold } from './hold.svelte.ts';

/** A filtered live list, as the build list gets it, with the rows after the search. */
class List {
	q = $state('gcc');
	rows = $state.raw<readonly string[]>(['gcc-1', 'gcc-2']);
}

function held(list: List, scoped: boolean) {
	let hold!: Hold<readonly string[]>;
	const stop = $effect.root(() => {
		hold = scoped
			? new Hold(
					() => list.rows,
					() => list.q
				)
			: new Hold(() => list.rows);
	});
	flushSync();
	hold.handlers.onpointermove();
	return { hold, stop };
}

describe('Hold', () => {
	it('keeps the order while held, and shows the live one on release', () => {
		const list = new List();
		const { hold, stop } = held(list, false);
		list.rows = ['gcc-0', 'gcc-1', 'gcc-2'];
		flushSync();
		expect(hold.current).toEqual(['gcc-1', 'gcc-2']);
		hold.handlers.onpointerleave();
		expect(hold.current).toEqual(['gcc-0', 'gcc-1', 'gcc-2']);
		stop();
	});

	it('takes the first live items after its scope changed, then holds again', () => {
		const list = new List();
		const { hold, stop } = held(list, true);
		// The search changes while the pointer rests on the list.
		list.q = 'clang';
		flushSync();
		expect(hold.current).toEqual(['gcc-1', 'gcc-2']);
		list.rows = ['clang-1'];
		flushSync();
		expect(hold.current).toEqual(['clang-1']);
		expect(hold.held).toBe(true);
		list.rows = ['clang-0', 'clang-1'];
		flushSync();
		expect(hold.current).toEqual(['clang-1']);
		stop();
	});
});
