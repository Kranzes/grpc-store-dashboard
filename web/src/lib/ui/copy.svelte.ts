// Which thing a copy button put on the clipboard, so it says "Copied" for 1.5 s.

export class Copier<T extends string> {
	#what = $state<T | null>(null);

	/** What was copied last, until the feedback ends. */
	get what(): T | null {
		return this.#what;
	}

	async copy(what: T, text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this.#what = what;
			setTimeout(() => (this.#what = null), 1500);
		} catch {
			// The browser can block the clipboard; the text stays selectable.
		}
	}
}
