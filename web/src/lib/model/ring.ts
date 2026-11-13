/** The newest `cap` items pushed, in a fixed array. */
export class Ring<T> {
	#items: (T | undefined)[];
	#head = 0;

	constructor(readonly cap: number) {
		this.#items = new Array(cap);
	}

	/** Adds `x` and returns the item it replaced. With cap 0 it keeps nothing. */
	push(x: T): T | undefined {
		if (this.cap === 0) return undefined;
		const old = this.#items[this.#head];
		this.#items[this.#head] = x;
		this.#head = (this.#head + 1) % this.cap;
		return old;
	}

	/** The items, newest first. */
	*newest(): Generator<T> {
		for (let i = 1; i <= this.cap; i++) {
			const x = this.#items[(this.#head - i + this.cap) % this.cap];
			if (x === undefined) return;
			yield x;
		}
	}

	clear() {
		this.#items = new Array(this.cap);
		this.#head = 0;
	}
}
