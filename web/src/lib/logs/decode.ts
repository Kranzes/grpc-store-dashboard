// The zstd stream of one GetBuildLog call, decoded chunk by chunk with
// fzstd. Each decoded piece goes straight on, so no whole-log buffer
// exists. A broken stream keeps what decoded before it.

import { Decompress } from 'fzstd';

export class ZstdStream {
	readonly #d: Decompress;
	#failed: string | null = null;
	/** Decoded bytes so far. */
	bytes = 0;

	constructor(onData: (bytes: Uint8Array) => void) {
		this.#d = new Decompress((chunk) => {
			if (chunk.length === 0) return;
			this.bytes += chunk.length;
			onData(chunk);
		});
	}

	/** Why the stream broke, or null. */
	get failed(): string | null {
		return this.#failed;
	}

	/** One message's data. Returns false once the stream broke. */
	push(data: Uint8Array, final = false): boolean {
		if (this.#failed !== null) return false;
		try {
			this.#d.push(data, final);
			return true;
		} catch (e) {
			this.#failed = e instanceof Error ? e.message : String(e);
			return false;
		}
	}
}
