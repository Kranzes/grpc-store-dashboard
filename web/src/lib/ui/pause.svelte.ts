// With Pause the user freezes what the dashboard shows: the map, the header
// totals and an open panel. The stream keeps arriving underneath, and
// resuming shows the live state at once. It lasts for the session only, like
// every other view setting.
//
// A pan, a zoom or a pointer held down on the map holds everything still the
// same way while it lasts, without the pill saying Paused. The hold ends by
// itself on release, and a pill that flashed on every pan would be noise.

export class Pause {
	#since = $state<number | null>(null);
	#heldSince = $state<number | null>(null);

	/** When the pause began, in browser time, or null while live. */
	get since(): number | null {
		return this.#since;
	}

	get paused(): boolean {
		return this.#since !== null;
	}

	/** When the map's pan, zoom or press began holding everything still, or null. */
	get heldSince(): number | null {
		return this.#heldSince;
	}

	/** The dashboard shows a still picture: paused, or held by the map. */
	get still(): boolean {
		return this.#since !== null || this.#heldSince !== null;
	}

	/** Hold everything still while the map moves or a pointer is down on it. */
	hold(on: boolean, now = Date.now()) {
		this.#heldSince = on ? (this.#heldSince ?? now) : null;
	}

	pause(now = Date.now()) {
		this.#since ??= now;
	}

	resume() {
		this.#since = null;
	}

	toggle(now = Date.now()) {
		if (this.#since === null) this.pause(now);
		else this.resume();
	}
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat'> & {
	readonly target: EventTarget | null;
	readonly defaultPrevented: boolean;
};

/**
 * Whether a key press can be a one-key shortcut: no Ctrl, Meta or Alt, not
 * held down, not handled already, and not while typing in a field. Shift is
 * allowed, for Caps Lock, "P" and "+".
 */
function isPlainKey(e: KeyLike): boolean {
	if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
	const t = e.target as HTMLElement | null;
	if (!t || typeof t.closest !== 'function') return true;
	return !t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** Whether a key press is the pause shortcut: P on its own. */
export function isPauseKey(e: KeyLike): boolean {
	return (e.key === 'p' || e.key === 'P') && isPlainKey(e);
}

/** The map's view keys: + or = zooms in, - zooms out, 0 fits the farm. */
export function mapViewKey(e: KeyLike): 'in' | 'out' | 'fit' | null {
	const action =
		e.key === '+' || e.key === '=' ? 'in' : e.key === '-' ? 'out' : e.key === '0' ? 'fit' : null;
	return action && isPlainKey(e) ? action : null;
}
