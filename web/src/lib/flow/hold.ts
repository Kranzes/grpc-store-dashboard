// The map holds still while the view moves.
//
// A live number that changes mid-gesture repaints its node or line, and the
// browser then redraws that part of the moving picture at the new zoom. At 50
// builders shown as cards, the store's 30 publishes a second turned each zoom
// step into a redraw of most of the map. Held, a pan or zoom only moves
// pixels that are already drawn.

import { untrack } from 'svelte';
import type { FarmStore } from '#lib/model/types.ts';

/**
 * The store as it is now. Each field keeps the value it has the first time it
 * is read, and reading it subscribes to nothing. Methods still ask the live
 * store. The store replaces published maps and never changes them, so a kept
 * map stays as it was.
 */
export function holdStill(store: FarmStore): FarmStore {
	const kept = new Map<PropertyKey, unknown>();
	return new Proxy(store, {
		get(target, key) {
			if (!kept.has(key)) {
				const now = untrack(() => Reflect.get(target, key, target));
				kept.set(key, now);
			}
			const value = kept.get(key);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}
