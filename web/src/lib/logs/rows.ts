// Visual rows over the lines that show. With wrap a line takes
// max(1, ceil(cells / cols)) rows; a folded group's lines after its header
// take none; a line over 10,000 cells draws its first 10,000 and a "Show
// more" row. Line numbers stay physical. Rows map to slots and back, the
// gap's slot included.

import type { Group } from './groups.ts';

/** Cells of a line that are drawn; the rest is behind "Show more". */
export const MAX_CELLS = 10_000;

/** The first slot a folded group hides: the line after its header. */
const hiddenFrom = (g: Group) => g.headerSlot + 1;

export type RowsSource = Readonly<{
	/** Slots so far. */
	slots: () => number;
	/** Cells of a slot's line; -1 for the gap. */
	width: (slot: number) => number;
	/** The groups, by id. */
	groups: () => readonly Group[];
}>;

export class Rows {
	cols = 80;
	wrap = true;
	/** Open state per group id. Groups not in it are open. */
	readonly folded = new Set<number>();
	/** Per slot: how many folded groups hide it. */
	#hide = new Uint16Array(1024);
	/** Per slot: shown while "Only matching lines" is on. null when it is off. */
	#only: Uint8Array | null = null;
	/** Prefix sums: sums[s] = rows before slot s. */
	#sums = new Float64Array(1025);
	#slots = 0;
	/** Slots whose #hide extend() has set, apart from fold changes since. */
	#hideTo = 0;
	/** For a slot, the group whose header line it is. */
	#headers = new Map<number, Group>();

	constructor(readonly src: RowsSource) {}

	get total(): number {
		return this.#sums[this.#slots];
	}

	headerAt(slot: number): Group | undefined {
		return this.#headers.get(slot);
	}

	/** Groups changed: new headers. Recomputes what moved. */
	syncGroups() {
		let from = Infinity;
		for (const g of this.src.groups()) {
			if (this.#headers.get(g.headerSlot) !== g) {
				this.#headers.set(g.headerSlot, g);
				from = Math.min(from, g.headerSlot);
			}
		}
		if (from === Infinity) return;
		// Slots before the first new header keep their rows, but the last one computed may have grown.
		this.recompute(Math.min(from, Math.max(0, this.#slots - 1)));
	}

	/** Rows of a slot. */
	rowsOf(slot: number): number {
		if (this.#only) {
			if (!this.#only[slot]) return 0;
		} else if (this.#hide[slot] > 0) return 0;
		const w = this.src.width(slot);
		if (w < 0) return 1;
		if (this.#headers.has(slot)) return 1;
		const cells = Math.min(w, MAX_CELLS);
		const body = this.wrap ? Math.max(1, Math.ceil(cells / Math.max(1, this.cols))) : 1;
		return body + (w > MAX_CELLS ? 1 : 0);
	}

	#ensure(n: number) {
		if (this.#hide.length < n) {
			const h = new Uint16Array(Math.max(n, this.#hide.length * 2));
			h.set(this.#hide);
			this.#hide = h;
		}
		if (this.#sums.length < n + 2) {
			const s = new Float64Array(Math.max(n + 2, this.#sums.length * 2));
			s.set(this.#sums.subarray(0, this.#slots + 1));
			this.#sums = s;
		}
	}

	/** Recompute the sums from slot k on. */
	recompute(k: number) {
		const n = this.src.slots();
		this.#ensure(n);
		this.#slots = n;
		k = Math.max(0, Math.min(k, n));
		const sums = this.#sums;
		for (let i = k; i < n; i++) sums[i + 1] = sums[i] + this.rowsOf(i);
	}

	/** New slots arrived, or the last line grew, so extend from the last known slot. */
	extend() {
		const slots = this.src.slots();
		this.#ensure(slots);
		// New lines inside a folded group are hidden too. Check the last slot
		// seen again, since it may have been a partial line no group held yet.
		const from = Math.max(0, this.#hideTo - 1);
		const groups = this.src.groups();
		for (let s = from; s < slots; s++) {
			let h = 0;
			for (const id of this.folded) {
				const g = groups[id];
				if (g && s >= hiddenFrom(g) && s <= g.lastSlot) h++;
			}
			this.#hide[s] = h;
		}
		this.#hideTo = slots;
		this.recompute(Math.min(from, Math.max(0, this.#slots - 1)));
	}

	setLayout(cols: number, wrap: boolean) {
		if (cols === this.cols && wrap === this.wrap) return;
		this.cols = Math.max(1, cols);
		this.wrap = wrap;
		this.recompute(0);
	}

	/** Fold or open groups. Recomputes from the first of them on. */
	fold(ids: readonly number[], open: boolean) {
		const groups = this.src.groups();
		let from = Infinity;
		for (const id of ids) {
			const g = groups[id];
			if (!g || this.folded.has(id) === !open) continue;
			if (open) this.folded.delete(id);
			else this.folded.add(id);
			for (let s = hiddenFrom(g); s <= g.lastSlot; s++) this.#hide[s] += open ? -1 : 1;
			from = Math.min(from, g.headerSlot);
		}
		if (from !== Infinity) this.recompute(from);
	}

	/** Every group open or every group folded. */
	foldAll(open: boolean) {
		const groups = this.src.groups();
		this.folded.clear();
		this.#hide.fill(0);
		if (!open)
			for (const g of groups) {
				this.folded.add(g.id);
				for (let s = hiddenFrom(g); s <= g.lastSlot; s++) this.#hide[s]++;
			}
		this.recompute(0);
	}

	/** "Only matching lines": show these slots, and each group's header above its first match. null is off. */
	only(slots: Iterable<number> | null) {
		if (slots === null) {
			this.#only = null;
			this.recompute(0);
			return;
		}
		const n = this.src.slots();
		const mask = new Uint8Array(n);
		for (const s of slots) mask[s] = 1;
		// before[i]: matching slots before slot i, so a group's header shows when its range has one.
		const before = new Uint32Array(n + 1);
		for (let i = 0; i < n; i++) before[i + 1] = before[i] + mask[i];
		for (const g of this.src.groups()) {
			const a = Math.min(g.headerSlot, n);
			const b = Math.min(g.lastSlot + 1, n);
			if (before[b] > before[a]) mask[g.headerSlot] = 1;
		}
		this.#only = mask;
		this.recompute(0);
	}

	/** The first row of a slot. */
	rowOfSlot(slot: number): number {
		return this.#sums[Math.max(0, Math.min(slot, this.#slots))];
	}

	/** The slot that draws row r, and which of its rows r is. */
	slotOfRow(r: number): { slot: number; part: number } {
		const sums = this.#sums;
		let lo = 0;
		let hi = this.#slots - 1;
		if (hi < 0) return { slot: 0, part: 0 };
		r = Math.max(0, Math.min(r, this.total - 1));
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (sums[mid] <= r) lo = mid;
			else hi = mid - 1;
		}
		// Skip slots with no rows.
		while (lo < this.#slots - 1 && sums[lo + 1] === sums[lo]) lo++;
		return { slot: lo, part: r - sums[lo] };
	}
}
