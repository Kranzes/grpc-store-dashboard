// Re-run a drill-down query when the store publishes, at most every `ms`.
// Create it during component init; it stops with the component.

import { untrack } from 'svelte';

export class Throttled<T> {
	#value = $state.raw<T>() as T;

	constructor(frame: () => unknown, query: () => T, ms = 500) {
		this.#value = untrack(query);
		let last = performance.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = () => {
			timer = undefined;
			last = performance.now();
			this.#value = untrack(query);
		};
		$effect(() => {
			frame();
			if (timer !== undefined) return;
			const wait = ms - (performance.now() - last);
			if (wait <= 0) run();
			else timer = setTimeout(run, wait);
		});
		$effect(() => () => clearTimeout(timer));
	}

	get current(): T {
		return this.#value;
	}
}
