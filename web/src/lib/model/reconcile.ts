// Structural sharing for published views: keep the previous object wherever
// the new one has the same content, so `$derived` and keyed blocks see no
// change for parts that did not change.

type Plain = Record<string, unknown>;

function isPlain(x: unknown): x is Plain {
	if (x === null || typeof x !== 'object') return false;
	const p = Object.getPrototypeOf(x);
	return p === Object.prototype || p === null;
}

/**
 * `next`, with every part equal to the matching part of `prev` replaced by it.
 * Copies `next` only when some part of it is replaced, so `next` must not be
 * changed afterwards.
 */
export function reconcile<T>(prev: T, next: T): T {
	if (Object.is(prev, next)) return prev;
	if (Array.isArray(prev) && Array.isArray(next)) {
		let same = prev.length === next.length;
		let out: unknown[] | null = null;
		for (let i = 0; i < next.length; i++) {
			const v = next[i];
			const r = i < prev.length ? reconcile(prev[i], v) : v;
			if (r !== prev[i]) same = false;
			if (r !== v) (out ??= next.slice())[i] = r;
		}
		return (same ? prev : (out ?? next)) as T;
	}
	if (isPlain(prev) && isPlain(next)) {
		const keys = Object.keys(next);
		let same = true;
		let out: Plain | null = null;
		for (const k of keys) {
			const v = next[k];
			const r = k in prev ? reconcile(prev[k], v) : v;
			if (r !== prev[k]) same = false;
			if (r !== v) (out ??= { ...next })[k] = r;
		}
		if (same && Object.keys(prev).length !== keys.length) same = false;
		return (same ? prev : (out ?? next)) as T;
	}
	return next;
}

/**
 * An empty read-only map. Rune modules take it from here, because
 * svelte/prefer-svelte-reactivity flags a `new Map()` there.
 */
export function emptyMap<V>(): ReadonlyMap<string, V> {
	return new Map();
}

/** A map whose entries keep identity when equal; `prev` itself when nothing changed. */
export function reconcileMap<K, V>(prev: ReadonlyMap<K, V>, next: Map<K, V>): ReadonlyMap<K, V> {
	let same = prev.size === next.size;
	for (const [k, v] of next) {
		const p = prev.get(k);
		if (p === undefined) {
			same = false;
			continue;
		}
		const r = reconcile(p, v);
		if (r !== p) same = false;
		next.set(k, r);
	}
	return same ? prev : next;
}
