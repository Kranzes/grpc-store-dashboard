// The log's text in the worker: decoded bytes in 1 MiB pages, where each
// line starts, its width in cells, and the SGR style every 1,024 lines.
//
// A log of at most 64 MiB is kept whole, as one part. A larger one is two
// parts: the head, its first 16 MiB up to the last newline, and the tail,
// placed by the line number the server counted, with one gap row between
// them. From an old server that sends the whole log in one call, the head
// is its first 16 MiB and the tail a ring of its last 48 MiB, still counting
// every line. Either way line numbers stay exact.
//
// Lines are addressed by slot: the head's lines, then the gap when there
// is one, then the tail's. A slot's line number is its part's first line
// plus its index there.

import { PLAIN, plainText, stateAfter, type SgrState } from './ansi.ts';
import { HEAD_MAX, MiB, TAIL_MAX } from './limits.ts';
import { cellWidth, completePrefix, decodeLine, resolveCR } from './text.ts';

export const PAGE = MiB;
/** Widths at or above this mean "longer". */
export const WIDTH_LONG = 65_535;
const CHECKPOINT = 1024;

/** A line as the worker sees it once it is complete. */
export type LineEvent = Readonly<{
	slot: number;
	/** 1-based line number. */
	line: number;
	/** Without ANSI, \r resolved. */
	text: string;
	/** As it arrived, escapes and \r included. */
	raw: string;
}>;

class Grow<T extends Float64Array | Uint16Array | Uint8Array> {
	a: T;
	n = 0;
	constructor(readonly make: (n: number) => T) {
		this.a = make(1024);
	}
	push(v: number) {
		if (this.n === this.a.length) {
			const b = this.make(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.n++] = v;
	}
	/** Drop the first k. */
	shift(k: number) {
		this.a.copyWithin(0, k, this.n);
		this.n -= k;
	}
}

/** One run of consecutive lines with their bytes. */
export class Part {
	/** Byte pages; page p holds bytes [base + p * PAGE, …). */
	pages: Uint8Array[] = [];
	/** Absolute offset of pages[0] within this part's stream. */
	base = 0;
	/** Bytes appended to this part so far. */
	bytes = 0;
	/** Line starts, absolute offsets. */
	readonly starts = new Grow((n) => new Float64Array(n));
	readonly widths = new Grow((n) => new Uint16Array(n));
	/** Bit 0: has an escape. Bit 1: is an @nix line. */
	readonly flags = new Grow((n) => new Uint8Array(n));
	/** SGR state at the start of every CHECKPOINT-th line, keyed by absolute index / CHECKPOINT. */
	readonly checkpoints = new Map<number, SgrState>([[0, PLAIN]]);
	/** Lines dropped from the front of a ring, so absolute index = index + dropped. */
	dropped = 0;
	/** The style at the start of the first kept line. */
	firstState: SgrState = PLAIN;
	/** State at the end of the last complete line. */
	state: SgrState = PLAIN;
	/** 0-based line number of this part's first kept line. */
	firstLine: number;
	/** Where the line being written starts, absolute. */
	open = 0;

	constructor(firstLine: number, offset = 0) {
		this.firstLine = firstLine;
		this.base = offset;
		this.bytes = offset;
		this.open = offset;
	}

	get count(): number {
		return this.starts.n;
	}

	/** Whether a line is still being written at the end. */
	get partial(): boolean {
		return this.open < this.bytes;
	}

	append(chunk: Uint8Array) {
		let off = 0;
		while (off < chunk.length) {
			const inPage = (this.bytes - this.base) % PAGE;
			if (inPage === 0) this.pages.push(new Uint8Array(PAGE));
			const page = this.pages[this.pages.length - 1];
			const n = Math.min(PAGE - inPage, chunk.length - off);
			page.set(chunk.subarray(off, off + n), inPage);
			off += n;
			this.bytes += n;
		}
	}

	/** Bytes [from, to), as absolute offsets. */
	slice(from: number, to: number): Uint8Array {
		from = Math.max(from, this.base);
		to = Math.min(to, this.bytes);
		if (to <= from) return new Uint8Array(0);
		const p0 = Math.floor((from - this.base) / PAGE);
		const p1 = Math.floor((to - 1 - this.base) / PAGE);
		if (p0 === p1) {
			const o = (from - this.base) % PAGE;
			return this.pages[p0].subarray(o, o + (to - from));
		}
		const out = new Uint8Array(to - from);
		let w = 0;
		for (let p = p0; p <= p1; p++) {
			const pageStart = this.base + p * PAGE;
			const a = Math.max(from, pageStart) - pageStart;
			const b = Math.min(to, pageStart + PAGE) - pageStart;
			out.set(this.pages[p].subarray(a, b), w);
			w += b - a;
		}
		return out;
	}

	/** The byte range of line i, without its newline. The last one may still be open. */
	range(i: number): [number, number] {
		return [this.starts.a[i], this.lineEnd(i)];
	}

	/** Where the last line ends: before its newline, once it has one. */
	lastEnd = 0;
	lineEnd(i: number): number {
		return i === this.count - 1 ? this.lastEnd : this.starts.a[i + 1] - 1;
	}

	raw(i: number): string {
		const [a, b] = this.range(i);
		return decodeLine(this.slice(a, b));
	}

	/** The style at the start of line i, from the checkpoint before it and the lines in between. */
	stateAt(i: number): SgrState {
		const a = i + this.dropped;
		const k = Math.floor(a / CHECKPOINT);
		let from = k * CHECKPOINT - this.dropped;
		let st = this.checkpoints.get(k);
		if (from < 0 || st === undefined) {
			from = 0;
			st = this.firstState;
		}
		for (let j = from; j < i; j++) if (this.flags.a[j] & 1) st = stateAfter(this.raw(j), st);
		return st;
	}

	/**
	 * Drop whole pages from the front until at most `keep` bytes remain, and
	 * every line that starts in a dropped page. This keeps the ring of an old
	 * server's tail.
	 */
	dropTo(keep: number) {
		let pages = 0;
		while (this.bytes - (this.base + pages * PAGE) - PAGE >= keep && this.pages.length - pages > 1)
			pages++;
		if (pages === 0) return;
		const base = this.base + pages * PAGE;
		let drop = 0;
		while (drop < this.count && this.starts.a[drop] < base) drop++;
		// A line still open past the cut stays.
		if (drop === this.count && this.partial) drop--;
		// The style where the first kept line starts, while the bytes are still here.
		const st = this.stateAt(drop);
		this.pages.splice(0, pages);
		this.base = base;
		this.starts.shift(drop);
		this.widths.shift(drop);
		this.flags.shift(drop);
		this.dropped += drop;
		this.firstLine += drop;
		this.firstState = st;
		for (const k of this.checkpoints.keys())
			if (k * CHECKPOINT < this.dropped) this.checkpoints.delete(k);
	}
}

export type StoreListener = (e: LineEvent) => void;

/**
 * The log of one build: its parts, the gap and the line events. `onLine`
 * sees every complete line in order, with its slot.
 */
export class LogStore {
	parts: Part[] = [new Part(0)];
	/** Lines not shown, between the head and the tail, 1-based and inclusive. null for none. */
	gap: { firstHidden: number; lastHidden: number } | null = null;
	/** Bytes decoded so far, every call and part counted. */
	decoded = 0;
	/**
	 * The whole log comes in one call, as from an old server or the demo, so
	 * past 16 MiB the rest goes to a ring of the last 48 MiB.
	 */
	ring = false;
	/** The ring dropped lines since this was last cleared, so tail slots moved. */
	ringMoved = false;
	/** Where the tail started when the ring first dropped lines since then: its slot and line. */
	ringFrom = { slot: 0, line: 0 };
	onLine: StoreListener | null = null;
	/** A line was still being written, and grows. */
	onPartial: (() => void) | null = null;

	get head(): Part {
		return this.parts[0];
	}
	get tail(): Part {
		return this.parts[this.parts.length - 1];
	}

	/** Slot of the tail's first line: after the head, and after the gap row when there is one. */
	get tailSlot(): number {
		return this.head.count + (this.gap ? 1 : 0);
	}

	/** Slots: the head's lines, the gap, the tail's. */
	get slots(): number {
		return this.parts.length === 1 ? this.head.count : this.tailSlot + this.tail.count;
	}

	/** The part and index of a slot, or the gap. */
	at(slot: number): { part: Part; i: number } | 'gap' {
		const h = this.head.count;
		if (this.parts.length === 1 || slot < h) return { part: this.head, i: slot };
		if (this.gap && slot === h) return 'gap';
		return { part: this.tail, i: slot - this.tailSlot };
	}

	/** 1-based line number of a slot, or null for the gap. */
	lineOf(slot: number): number | null {
		const a = this.at(slot);
		return a === 'gap' ? null : a.part.firstLine + a.i + 1;
	}

	/** The slot of a 1-based line number, 'gap' when it is in the part not shown, null past the end. */
	slotOf(line: number): number | 'gap' | null {
		const h = this.head;
		if (line < 1) return null;
		if (line <= h.firstLine + h.count) return line - h.firstLine - 1;
		if (this.parts.length === 1) return null;
		const t = this.tail;
		if (line > t.firstLine && line <= t.firstLine + t.count)
			return this.tailSlot + (line - t.firstLine - 1);
		if (this.gap && line >= this.gap.firstHidden && line <= this.gap.lastHidden) return 'gap';
		return null;
	}

	/** The last line number the log has, 0 when empty. */
	get lastLine(): number {
		const t = this.tail;
		return t.firstLine + t.count;
	}

	/** The raw text of a slot's line, escapes included. */
	raw(slot: number): string {
		const a = this.at(slot);
		return a === 'gap' ? '' : a.part.raw(a.i);
	}

	stateAt(slot: number): SgrState {
		const a = this.at(slot);
		return a === 'gap' ? PLAIN : a.part.stateAt(a.i);
	}

	/**
	 * A second call starts the tail at byte `offset`, which is line
	 * `firstLine` + 1 (decision 6). The head ends at its last newline; when
	 * the tail starts right after it there is no gap.
	 */
	startTail(offset: number, firstLine: number) {
		this.#closeHead();
		this.parts = [this.head, new Part(firstLine, offset)];
		this.#setGap();
	}

	/**
	 * The head arrives after the tail, as when a failed build shows its end
	 * first. It goes in front, closed at its last newline, and the gap shrinks
	 * to the lines between them. Tail slots move by the head's lines.
	 */
	putHead(head: Part, decoded: number) {
		this.parts[0] = head;
		this.decoded += decoded;
		this.#closeHead();
		this.#setGap();
	}

	/** The lines between the head's end and the tail's first, null when the tail follows the head. */
	#setGap() {
		const headEnd = this.head.firstLine + this.head.count;
		const t = this.tail;
		this.gap = t.firstLine > headEnd ? { firstHidden: headEnd + 1, lastHidden: t.firstLine } : null;
	}

	/** The bytes of the head's complete lines: where a tail call that leaves no gap starts. */
	get headComplete(): number {
		return this.head.open;
	}

	/** The head stops at its last newline, so it drops an open line there. */
	#closeHead() {
		const h = this.head;
		if (h.partial && h.count > 0) {
			h.starts.n--;
			h.widths.n--;
			h.flags.n--;
		}
		h.bytes = h.open;
		h.lastEnd = h.open - 1;
	}

	/** Decoded bytes, in order. */
	push(chunk: Uint8Array) {
		this.decoded += chunk.length;
		let off = 0;
		while (off < chunk.length) {
			// The head of a one-call log ends at its first line end at or past 16 MiB,
			// in this piece or an earlier one.
			const h = this.head;
			if (this.ring && this.parts.length === 1 && h.bytes - h.base >= HEAD_MAX && !h.partial)
				this.parts = [h, new Part(h.count, h.bytes)];
			const part = this.tail;
			const n = Math.min(chunk.length - off, PAGE);
			const piece = chunk.subarray(off, off + n);
			const stopAt = this.ring && this.parts.length === 1 ? HEAD_MAX : Infinity;
			off += this.#ingest(part, piece, stopAt);
			if (
				this.ring &&
				this.parts.length === 2 &&
				this.tail.bytes - this.tail.base > TAIL_MAX + PAGE
			) {
				const t = this.tail;
				const from = { slot: this.tailSlot, line: t.firstLine };
				t.dropTo(TAIL_MAX);
				if (t.firstLine > from.line) {
					if (!this.ringMoved) this.ringFrom = from;
					this.#setGap();
					this.ringMoved = true;
				}
			}
		}
	}

	/** Bytes of `chunk` taken into `part`: all of them, or up to a line end once it holds `stopAt` bytes. */
	#ingest(part: Part, chunk: Uint8Array, stopAt: number): number {
		if (chunk.length === 0) return 0;
		const before = part.bytes;
		let take = chunk.length;
		if (stopAt !== Infinity) {
			for (let k = Math.max(0, stopAt - (before - part.base) - 1); k < chunk.length; k++)
				if (chunk[k] === 10) {
					take = Math.min(take, k + 1);
					break;
				}
		}
		const piece = chunk.subarray(0, take);
		part.append(piece);
		// With no line open, the first byte starts one.
		if (part.open === before) this.#begin(part, before);
		for (let k = 0; k < piece.length; k++) {
			if (piece[k] !== 10) continue;
			const end = before + k;
			this.#complete(part, part.open, end);
			part.open = end + 1;
			if (part.open < part.bytes) this.#begin(part, part.open);
		}
		if (part.partial) {
			part.lastEnd = part.bytes;
			this.#measure(part, part.count - 1, part.slice(part.open, part.bytes), true);
			this.onPartial?.();
		}
		return take;
	}

	#begin(part: Part, start: number) {
		part.starts.push(start);
		part.widths.push(0);
		part.flags.push(0);
	}

	#complete(part: Part, start: number, end: number) {
		const i = part.count - 1;
		part.lastEnd = end;
		this.#measure(part, i, part.slice(start, end), false);
		if (part.flags.a[i] & 1) part.state = stateAfter(this.#lastRaw, part.state);
		const next = i + 1 + part.dropped;
		if (next % CHECKPOINT === 0) part.checkpoints.set(next / CHECKPOINT, part.state);
		const slot = part === this.head ? i : this.tailSlot + i;
		this.onLine?.({ slot, line: part.firstLine + i + 1, text: this.#lastText, raw: this.#lastRaw });
	}

	#lastRaw = '';
	#lastText = '';

	#measure(part: Part, i: number, bytes: Uint8Array, open: boolean) {
		// Fast path: plain ASCII without escape, \r or tab is its own width.
		let plain = true;
		for (let k = 0; k < bytes.length; k++) {
			const b = bytes[k];
			if (b >= 0x80 || b < 0x20 || b === 0x7f) {
				plain = false;
				break;
			}
		}
		let text: string;
		let raw: string;
		if (plain) {
			raw = text = decodeLine(bytes);
			part.widths.a[i] = Math.min(WIDTH_LONG, bytes.length);
		} else {
			raw = decodeLine(open ? bytes.subarray(0, completePrefix(bytes)) : bytes);
			text = plainText(resolveCR(raw));
			part.widths.a[i] = Math.min(WIDTH_LONG, cellWidth(text));
			if (raw.includes('\x1b')) part.flags.a[i] |= 1;
		}
		if (raw.startsWith('@nix ')) part.flags.a[i] |= 2;
		this.#lastRaw = raw;
		this.#lastText = text;
	}

	/** Every line again, in order, for a rebuild after the ring moved. */
	forEachLine(fn: StoreListener) {
		const n = this.slots;
		for (let s = 0; s < n; s++) {
			const a = this.at(s);
			if (a === 'gap') continue;
			if (a.i === a.part.count - 1 && a.part.partial) continue;
			const raw = a.part.raw(a.i);
			fn({ slot: s, line: a.part.firstLine + a.i + 1, text: plainText(resolveCR(raw)), raw });
		}
	}

	/** Every kept byte, in order: the raw log as it arrived, the gap left out. */
	rawPages(): Uint8Array[] {
		const out: Uint8Array[] = [];
		for (const p of this.parts) {
			const first = p.starts.n > 0 ? p.starts.a[0] : p.base;
			out.push(p.slice(first, p.bytes));
		}
		return out;
	}
}
