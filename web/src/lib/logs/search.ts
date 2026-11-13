// Find in the log. It searches the text as lines show it, with no escapes,
// \r resolved and tabs expanded. It ignores case unless asked, and runs in
// slices with a cancel token, so typing starts it over. Hits in folded
// groups count.

/** At most this many hits; the count then reads "10,000+". */
export const HITS_CAP = 10_000;

export type Hit = Readonly<{ slot: number; from: number; to: number }>;

export type SearchQuery = Readonly<{ text: string; caseSensitive: boolean }>;

export type SearchSource = Readonly<{
	slots: () => number;
	/** The shown text of a slot; null for the gap. */
	text: (slot: number) => string | null;
	/** Whether the log has a gap, so the search covers only the shown parts. */
	hasGap: () => boolean;
	/** Whether the last slot's line is still being written. */
	open: () => boolean;
}>;

export type SearchState = {
	query: SearchQuery | null;
	hits: Hit[];
	capped: boolean;
	/** Slots searched so far. */
	done: number;
	/** The whole log was searched, until more lines arrive. */
	complete: boolean;
	gapSkipped: boolean;
	/**
	 * A slot searched while its line was still being written, or -1 for none.
	 * It is searched again as it grows.
	 */
	open: number;
};

/** Hits of `q` in one line's text. */
export function findIn(text: string, q: SearchQuery, slot: number, out: Hit[], cap: number): void {
	if (!q.text) return;
	const hay = q.caseSensitive ? text : text.toLowerCase();
	const needle = q.caseSensitive ? q.text : q.text.toLowerCase();
	let at = hay.indexOf(needle);
	while (at >= 0 && out.length < cap) {
		out.push({ slot, from: at, to: at + needle.length });
		at = hay.indexOf(needle, at + Math.max(1, needle.length));
	}
}

/**
 * One search at a time. `step` searches up to `budgetMs` of lines and
 * returns whether it has more to do; a new query starts over.
 */
export class Search {
	state: SearchState = {
		query: null,
		hits: [],
		capped: false,
		done: 0,
		complete: true,
		gapSkipped: false,
		open: -1
	};
	generation = 0;

	constructor(readonly src: SearchSource) {}

	start(q: SearchQuery | null) {
		this.generation++;
		this.state = {
			query: q && q.text ? q : null,
			hits: [],
			capped: false,
			done: 0,
			complete: !(q && q.text),
			gapSkipped: false,
			open: -1
		};
	}

	/** Search on; true while more is left. A followed build's new lines are searched as they come. */
	step(budgetMs = 8): boolean {
		const st = this.state;
		const q = st.query;
		if (!q) return false;
		// The line searched while open has grown, so search it again from its start.
		if (st.open >= 0 && !st.capped) {
			while (st.hits.length && st.hits[st.hits.length - 1].slot >= st.open) st.hits.pop();
			st.done = Math.min(st.done, st.open);
			st.open = -1;
		}
		const n = this.src.slots();
		const t0 = performance.now();
		let k = 0;
		while (st.done < n && !st.capped) {
			const text = this.src.text(st.done);
			if (text === null) st.gapSkipped = true;
			else findIn(text, q, st.done, st.hits, HITS_CAP + 1);
			st.done++;
			if (st.hits.length > HITS_CAP) {
				st.hits.length = HITS_CAP;
				st.capped = true;
			}
			if (++k % 256 === 0 && performance.now() - t0 > budgetMs) break;
		}
		if (this.src.hasGap()) st.gapSkipped = true;
		st.open = !st.capped && n > 0 && st.done === n && this.src.open() ? n - 1 : -1;
		st.complete = st.done >= n || st.capped;
		return !st.complete;
	}

	/** Lines are left to search: new ones arrived, or the open one may have grown. */
	pending(): boolean {
		const st = this.state;
		return !!st.query && !st.capped && (st.done < this.src.slots() || st.open >= 0);
	}

	/** Slots with a hit, for "Only matching lines". */
	slots(): Set<number> {
		const out = new Set<number>();
		for (const h of this.state.hits) out.add(h.slot);
		return out;
	}

	/** The index of the first hit at or after a slot. */
	indexAt(slot: number): number {
		const hits = this.state.hits;
		let lo = 0;
		let hi = hits.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (hits[mid].slot < slot) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
}
