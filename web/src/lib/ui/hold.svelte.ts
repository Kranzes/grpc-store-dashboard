// Hold a live list still while someone points at it or moves through it with
// the keyboard, since live updates would shift rows under them. A pointer
// counts once it moves or scrolls, not when the panel opens under it.
// Create it during component init and spread `handlers` on the list's container.

import { untrack } from 'svelte';

export class Hold<T> {
	#held = $state.raw<{ items: T } | null>(null);
	#pointer = false;
	#focus = false;
	readonly #live: () => T;

	/**
	 * `scope` names what the user chose to see, such as a search, when the
	 * live items are already filtered by it. After it changes, the next live
	 * items replace the held ones, so the user's own change shows at once.
	 */
	constructor(live: () => T, scope?: () => string) {
		this.#live = live;
		if (!scope) return;
		// The live items can come later than the scope, as with a throttled query.
		let shown = untrack(scope);
		$effect.pre(() => {
			const items = live();
			untrack(() => {
				if (scope() === shown) return;
				shown = scope();
				if (this.#held) this.#held = { items };
			});
		});
	}

	/** The held items, or the live ones. */
	get current(): T {
		return this.#held ? this.#held.items : this.#live();
	}

	get held(): boolean {
		return this.#held !== null;
	}

	readonly handlers = {
		onpointermove: () => {
			this.#pointer = true;
			this.#hold();
		},
		onwheel: () => {
			this.#pointer = true;
			this.#hold();
		},
		onpointerleave: () => {
			this.#pointer = false;
			this.#release();
		},
		onfocusin: () => {
			this.#focus = true;
			this.#hold();
		},
		onfocusout: (e: FocusEvent) => {
			if ((e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return;
			this.#focus = false;
			this.#release();
		}
	};

	#hold() {
		this.#held ??= { items: this.#live() };
	}

	#release() {
		if (!this.#pointer && !this.#focus) this.#held = null;
	}
}
