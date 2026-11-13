// A shared "now" for relative times and countdowns. The timer runs only
// while something reactive reads it.

import { createSubscriber } from 'svelte/reactivity';
import type { ConnectionStatus } from '#lib/model/types.ts';

class Clock {
	#subscribe = createSubscriber((update) => {
		const t = setInterval(update, 500);
		return () => clearInterval(t);
	});
	#frozen = $state<number | null>(null);

	/** Now, for times the dashboard shows as data. It stands still while paused. */
	get now(): number {
		if (this.#frozen !== null) return this.#frozen;
		this.#subscribe();
		return Date.now();
	}

	/** Now, ticking even while paused, for countdowns and the pause's own length. */
	get wall(): number {
		this.#subscribe();
		return Date.now();
	}

	/** Hold `now` at a time, or let it run again with null. */
	freeze(at: number | null) {
		this.#frozen = at;
	}
}

export const clock = new Clock();

/** Whole seconds until the next attempt while retrying, else 0. The header and the map show this. */
export function retrySeconds(status: ConnectionStatus): number {
	return status.kind === 'retrying'
		? Math.max(0, Math.ceil((status.retryAtMs - clock.wall) / 1000))
		: 0;
}
