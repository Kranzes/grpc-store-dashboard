// Everything the log worker does, without the worker: decoded bytes in,
// rows, groups, errors, search and text out. worker.ts wires it to messages,
// and tests drive it directly.

import { Looks, parseLine, plainText, type Look } from './ansi.ts';
import { ZstdStream } from './decode.ts';
import { GroupTree, type Group } from './groups.ts';
import type { CallInfo, ErrorsInfo, Moved, Progress, RenderedRow, SearchInfo } from './protocol.ts';
import { MAX_CELLS, Rows } from './rows.ts';
import { Search } from './search.ts';
import { LogStore } from './store.ts';
import { displayRuns, displayText, graphemes, isSimple, resolveCR } from './text.ts';

const URL_RE = /https?:\/\/[^\s<>"'`\\]+/g;

type Seg = { text: string; look: Look; mark: 0 | 1 | 2; href: string };

/** How a call's bytes go in, as `beginCall` says. */
type CallOptions = Readonly<{ tailFirst?: boolean; of?: number; whole?: boolean }>;

const BIDI_LOOK: Look = { c: 'abidi', s: '' };

export class LogEngine {
	store = new LogStore();
	tree = new GroupTree();
	looks = new Looks();
	rows: Rows;
	search: Search;
	/** The current hit, or -1 for none. */
	current = -1;
	onlyMatching = false;
	#errSet = new Set<number>();
	#calls = new Map<number, ZstdStream>();
	broken: string | null = null;
	/** Lines a running build holds; the tail is still open while true. */
	#dirtyRows = false;

	constructor() {
		this.rows = this.#makeRows();
		this.search = new Search({
			slots: () => this.store.slots,
			text: (slot) => this.#shown(slot),
			hasGap: () => this.store.gap !== null,
			open: () => this.store.tail.partial
		});
		this.#wire();
	}

	#makeRows(cols = 80, wrap = true): Rows {
		const rows = new Rows({
			slots: () => this.store.slots,
			width: (slot) => {
				const a = this.store.at(slot);
				return a === 'gap' ? -1 : a.part.widths.a[a.i];
			},
			groups: () => this.tree.groups
		});
		rows.setLayout(cols, wrap);
		return rows;
	}

	#wire() {
		this.store.onLine = (e) => {
			this.tree.add(e.slot, e.text, e.raw);
			this.#dirtyRows = true;
		};
		this.store.onPartial = () => {
			this.#dirtyRows = true;
		};
	}

	/** Start over, because a later call reads another source from 0. */
	restart() {
		this.#reset();
		this.looks = new Looks();
		this.#calls.clear();
		this.#sinks.clear();
		this.#tails.clear();
		this.#ended.clear();
		this.#headCall = null;
		this.#held = null;
		this.broken = null;
	}

	// ------------------------------------------------------------- input

	/**
	 * A call starts: the head or the whole log, the tail placed at its info's
	 * line, or more of a part after a break. A tail that arrives while the
	 * head still streams waits until the head ends. With `tailFirst`, for a
	 * failed build whose view opens at its end, the tail goes in at once and
	 * the head waits aside until it ends, then goes in front in `endCall`. A
	 * 'more' call that goes on from call `of` takes its place, so its bytes go
	 * where that call's went. A `whole` head sends the whole log, as a follow
	 * call does.
	 */
	beginCall(
		call: number,
		part: 'head' | 'tail' | 'more',
		info: CallInfo | null,
		{ tailFirst = false, of, whole = false }: CallOptions = {}
	) {
		// A server that sends no info sends the whole log in this one call too.
		if (part === 'head' && (whole || !info)) this.store.ring = true;
		if (part === 'head') this.#headCall = call;
		let sink: (bytes: Uint8Array) => void;
		const before = of === undefined ? undefined : this.#sinks.get(of);
		if (part === 'more' && before) {
			sink = before;
			if (of === this.#headCall) this.#headCall = call;
		} else if (part === 'tail' && info && tailFirst && this.#headCall !== null) {
			// The head so far moves aside; the tail's lines are the log until it ends.
			const held = new LogStore();
			for (const b of this.store.rawPages()) held.push(b);
			this.#held = held;
			this.#reset();
			this.startTail(info.offset, info.firstLine);
			sink = (b) => this.push(b);
		} else if (part === 'tail' && info) {
			const pending: Uint8Array[] = [];
			const place = () => {
				this.startTail(info.offset, info.firstLine);
				for (const b of pending.splice(0)) this.push(b);
			};
			sink = (b) => {
				if (this.#headCall !== null) pending.push(b.slice());
				else this.push(b);
			};
			this.#tails.set(call, place);
			if (this.#headCall === null) {
				this.#tails.delete(call);
				place();
			}
		} else if (part === 'head') {
			// The head of a log whose tail came first waits aside.
			sink = (b) => (this.#held ?? this.store).push(b);
		} else {
			sink = (b) => this.push(b);
		}
		this.#sinks.set(call, sink);
		this.#calls.set(call, new ZstdStream(sink));
	}

	/** The head of a log whose tail landed first, until the head ends. */
	#held: LogStore | null = null;

	/** Empty rows, groups and errors, for a log that starts over in place. */
	#reset() {
		this.store = new LogStore();
		this.tree = new GroupTree();
		this.#errSet = new Set();
		this.current = -1;
		this.rows = this.#makeRows(this.rows.cols, this.rows.wrap);
		this.search.start(this.search.state.query);
		this.#wire();
	}

	#headCall: number | null = null;
	/** Where each call's bytes go, for a call that goes on from it. */
	readonly #sinks = new Map<number, (bytes: Uint8Array) => void>();
	/** Tails waiting for the head to end. */
	readonly #tails = new Map<number, () => void>();
	/** Bytes each call that ended decoded. */
	readonly #ended = new Map<number, number>();

	/** Bytes a call decoded, for a resume at the right offset. */
	decodedBy(call: number): number {
		return this.#calls.get(call)?.bytes ?? this.#ended.get(call) ?? 0;
	}

	/** The tail of a log starts at a byte and line the server counted. */
	startTail(offset: number, firstLine: number) {
		this.store.startTail(offset, firstLine);
		this.#dirtyRows = true;
		if (this.store.gap) this.tree.gap(this.store.head.count);
	}

	/** The head's complete lines in bytes: where a tail without a gap starts. */
	get headComplete(): number {
		return this.store.headComplete;
	}

	zstd(call: number, data: Uint8Array) {
		const s = this.#calls.get(call);
		if (!s) return;
		if (!s.push(data)) this.broken = s.failed;
	}

	/**
	 * A call ended. `complete`: its part is complete, so a waiting tail can
	 * follow it, or a held head go in front of the tail. Then rows above the
	 * view grew, and the answer says by how many and how group ids moved.
	 */
	endCall(call: number, complete = true): Moved | null {
		const s = this.#calls.get(call);
		if (!s) return null;
		if (complete && !s.push(new Uint8Array(0), true)) this.broken = s.failed;
		this.#ended.set(call, s.bytes);
		this.#calls.delete(call);
		if (call !== this.#headCall || !complete) return null;
		this.#headCall = null;
		for (const [id, place] of this.#tails) {
			this.#tails.delete(id);
			place();
		}
		return this.#held ? this.#putHead() : null;
	}

	/** The held head goes in front of the tail; its groups come folded, the tail's keep their state. */
	#putHead(): Moved {
		const held = this.#held!;
		this.#held = null;
		this.settle();
		const tailSlot = () => this.store.tailSlot;
		const before = this.rows.rowOfSlot(tailSlot());
		const lines = this.#headerLines();
		this.store.putHead(held.head, held.decoded);
		const remap = this.#rebuild(lines, true);
		return {
			shift: this.rows.rowOfSlot(tailSlot()) - before,
			remap,
			folded: [...this.rows.folded],
			total: this.rows.total
		};
	}

	/** Decoded bytes, in order. */
	push(bytes: Uint8Array) {
		this.store.push(bytes);
	}

	/**
	 * Apply what arrived since the last call: rows, and the search over new
	 * lines. When the ring dropped lines, groups and rows go again, and the
	 * answer says how group ids moved.
	 */
	settle(): Moved | null {
		const s = this.store;
		const remap = s.ringMoved ? this.#rebuild(this.#headerLines(s.ringFrom)) : null;
		if (this.#dirtyRows) {
			this.#dirtyRows = false;
			this.rows.syncGroups();
			this.rows.extend();
		}
		return remap && { shift: 0, remap, folded: [...this.rows.folded], total: this.rows.total };
	}

	/**
	 * Slots moved, because the ring dropped lines or a head went in front of
	 * the tail. Make groups, errors and rows again from the kept lines.
	 * `oldLines`: the header line of each group before, since a group keeps
	 * its fold by its header line. `foldNew`: groups that are new fold.
	 * Answers each old group id's new id, null when it went.
	 */
	#rebuild(oldLines: readonly number[], foldNew = false): (number | null)[] {
		this.store.ringMoved = false;
		const wasFolded = new Set(this.rows.folded);
		const tree = new GroupTree();
		const gapSlot = this.store.gap ? this.store.head.count : -1;
		let gapped = false;
		this.store.forEachLine((e) => {
			if (!gapped && gapSlot >= 0 && e.slot > gapSlot) {
				tree.gap(gapSlot);
				gapped = true;
			}
			tree.add(e.slot, e.text, e.raw);
		});
		if (!gapped && gapSlot >= 0) tree.gap(gapSlot);
		const byLine = new Map<number, number>();
		for (const g of tree.groups) byLine.set(this.#headerLine(g), g.id);
		const remap = oldLines.map((l) => byLine.get(l) ?? null);
		const kept = new Set(remap.filter((id) => id !== null));
		this.tree = tree;
		this.#errSet = new Set();
		this.rows = this.#makeRows(this.rows.cols, this.rows.wrap);
		this.rows.syncGroups();
		const fold: number[] = [];
		remap.forEach((id, old) => {
			if (id !== null && wasFolded.has(old)) fold.push(id);
		});
		if (foldNew) for (const g of tree.groups) if (!kept.has(g.id)) fold.push(g.id);
		this.rows.fold(fold, false);
		this.search.start(this.search.state.query);
		this.#dirtyRows = true;
		return remap;
	}

	/**
	 * Each group's header line. `tail`: where the tail started before the
	 * ring dropped lines, so that the old tail slots still give their lines.
	 */
	#headerLines(tail?: { slot: number; line: number }): number[] {
		const h = this.store.head.count;
		return this.tree.groups.map((g) =>
			tail && g.headerSlot >= h ? tail.line + (g.headerSlot - tail.slot) + 1 : this.#headerLine(g)
		);
	}

	#headerLine(g: Group): number {
		return this.store.lineOf(g.headerSlot) ?? -1;
	}

	// ------------------------------------------------------------ output

	progress(): Progress {
		const s = this.store;
		return {
			lines: s.lastLine,
			bytes: s.decoded + (this.#held?.decoded ?? 0),
			slots: s.slots,
			rows: this.rows.total,
			open: s.tail.partial,
			broken: this.broken,
			gap: s.gap ? { from: s.gap.firstHidden, to: s.gap.lastHidden } : null,
			idle: this.#calls.size === 0
		};
	}

	groups(): readonly Group[] {
		return this.tree.groups;
	}

	errors(): ErrorsInfo {
		const t = this.tree;
		const first = t.firstError();
		const last = this.store.lastLine;
		return {
			lines: t.errorSlots.map((s) => this.store.lineOf(s) ?? 0),
			capped: t.errorsCapped,
			first: first === null ? null : this.store.lineOf(first),
			lastLines: Math.max(1, last - 24)
		};
	}

	searchInfo(): SearchInfo {
		const st = this.search.state;
		return {
			count: st.hits.length,
			capped: st.capped,
			complete: st.complete,
			gapSkipped: st.gapSkipped,
			current: this.current
		};
	}

	/** The text a slot shows: no escapes, \r resolved, tabs expanded. null for the gap. */
	#shown(slot: number): string | null {
		const a = this.store.at(slot);
		if (a === 'gap') return null;
		const raw = a.part.raw(a.i);
		return displayText(plainText(resolveCR(raw)));
	}

	#isError(slot: number): boolean {
		if (this.#errSet.size !== this.tree.errorSlots.length)
			this.#errSet = new Set(this.tree.errorSlots);
		return this.#errSet.has(slot);
	}

	// ------------------------------------------------------------ rows

	setLayout(cols: number, wrap: boolean) {
		this.rows.setLayout(cols, wrap);
	}

	render(from: number, to: number): RenderedRow[] {
		const out: RenderedRow[] = [];
		const total = this.rows.total;
		const end = Math.min(to, total);
		let r = Math.max(0, from);
		while (r < end) {
			const { slot, part } = this.rows.slotOfRow(r);
			const n = this.rows.rowsOf(slot);
			const rows = this.#renderSlot(slot, r - part, n);
			for (const row of rows) if (row.row >= r && row.row < end) out.push(row);
			r = r - part + Math.max(1, n);
		}
		return out;
	}

	#renderSlot(slot: number, firstRow: number, n: number): RenderedRow[] {
		const at = this.store.at(slot);
		if (at === 'gap') {
			const g = this.store.gap!;
			const h = this.store.head;
			const t = this.store.tail;
			return [
				{
					row: firstRow,
					kind: 'gap',
					slot,
					line: null,
					part: 0,
					gap: { from: g.firstHidden, to: g.lastHidden, bytes: Math.max(0, t.base - h.bytes) }
				}
			];
		}
		const line = at.part.firstLine + at.i + 1;
		const header = this.rows.headerAt(slot);
		const raw = at.part.raw(at.i);
		const nix = (at.part.flags.a[at.i] & 2) !== 0;
		const error = this.#isError(slot);
		if (header) {
			return [
				{
					row: firstRow,
					kind: 'header',
					slot,
					line,
					part: 0,
					group: header.id,
					segs: [[displayText(plainText(resolveCR(raw))), '', '', '']],
					error
				}
			];
		}
		const segs = this.#segments(slot, raw);
		const width = at.part.widths.a[at.i];
		const cols = this.rows.wrap ? this.rows.cols : MAX_CELLS;
		const long = width > MAX_CELLS;
		const bodyRows = long ? n - 1 : n;
		const out: RenderedRow[] = [];
		const parts = cut(segs, cols, Math.min(width, MAX_CELLS), bodyRows);
		for (let p = 0; p < bodyRows; p++)
			out.push({
				row: firstRow + p,
				kind: 'line',
				slot,
				line: p === 0 ? line : null,
				part: p,
				segs: (parts[p] ?? []).map((s) => [s.text, markClass(s), s.look.s, s.href] as const),
				error: error && p === 0,
				nix
			});
		if (long) {
			const [a, b] = at.part.range(at.i);
			out.push({
				row: firstRow + bodyRows,
				kind: 'more',
				slot,
				line: null,
				part: bodyRows,
				more: {
					cells: width - MAX_CELLS,
					bytes: Math.round((b - a) * (1 - MAX_CELLS / Math.max(width, MAX_CELLS)))
				}
			});
		}
		return out;
	}

	/** A line's styled segments, with search marks and links, as it shows. */
	#segments(slot: number, raw: string): Seg[] {
		const { segments } = parseLine(resolveCR(raw), this.store.stateAt(slot), this.looks);
		// Tabs, bidi markers and dropped controls, segment by segment.
		const segs: Seg[] = [];
		let col = 0;
		for (const s of segments)
			col = displayRuns(s.text, col, (text, bidi) =>
				segs.push({ text, look: bidi ? BIDI_LOOK : s.look, mark: 0, href: '' })
			);
		const text = segs.map((s) => s.text).join('');
		// Links: plain http and https URLs.
		const links: [number, number, string][] = [];
		for (const m of text.matchAll(URL_RE)) {
			const url = m[0].replace(/[).,;:!?\]]+$/, '');
			links.push([m.index, m.index + url.length, url]);
		}
		const marks: [number, number, 1 | 2][] = [];
		if (this.search.state.query) {
			const hits = this.search.state.hits;
			for (let i = this.search.indexAt(slot); i < hits.length && hits[i].slot === slot; i++)
				marks.push([hits[i].from, hits[i].to, i === this.current ? 2 : 1]);
		}
		if (!links.length && !marks.length) return segs;
		return splitAt(segs, links, marks);
	}

	// ----------------------------------------------------------- folds

	fold(ids: number[], open: boolean, anchor: number | null): number | null {
		this.rows.fold(ids, open);
		return anchor === null ? null : this.rows.rowOfSlot(anchor);
	}

	foldAll(open: boolean, anchor: number | null): number | null {
		this.rows.foldAll(open);
		return anchor === null ? null : this.rows.rowOfSlot(anchor);
	}

	/** Open the groups that hold a slot. */
	#openFor(slot: number) {
		const ids = this.tree
			.chain(slot)
			.map((g) => g.id)
			.filter((id) => this.rows.folded.has(id));
		if (ids.length) this.rows.fold(ids, true);
	}

	/** Open the groups that hold a line and give its row; 'gap' when it is in the part not shown. */
	reveal(line: number): number | 'gap' | null {
		const slot = this.store.slotOf(line);
		if (slot === null) return null;
		if (slot === 'gap') return 'gap';
		this.#openFor(slot);
		return this.rows.rowOfSlot(slot);
	}

	// ---------------------------------------------------------- search

	setSearch(text: string, caseSensitive: boolean, onlyMatching: boolean) {
		const q = text ? { text, caseSensitive } : null;
		const same =
			this.search.state.query?.text === q?.text &&
			this.search.state.query?.caseSensitive === q?.caseSensitive;
		if (!same) {
			this.search.start(q);
			this.current = -1;
		}
		this.onlyMatching = onlyMatching && q !== null;
		if (!this.onlyMatching) this.rows.only(null);
	}

	/** Search on for up to `budgetMs`; true while more is left. */
	searchStep(budgetMs = 8): boolean {
		const more = this.search.step(budgetMs);
		if (this.onlyMatching) this.rows.only(this.search.slots());
		return more;
	}

	/** Move to hit `index`, opening its groups. */
	gotoHit(index: number): { row: number | null; line: number | null } {
		const hits = this.search.state.hits;
		if (index < 0 || index >= hits.length) {
			this.current = -1;
			return { row: null, line: null };
		}
		this.current = index;
		const h = hits[index];
		if (!this.onlyMatching) this.#openFor(h.slot);
		return { row: this.rows.rowOfSlot(h.slot), line: this.store.lineOf(h.slot) };
	}

	// ------------------------------------------------------------ text

	/** Lines from..to, 1-based, as plain text, folded lines included and the gap left out. */
	range(from: number, to: number): string {
		const out: string[] = [];
		for (let l = from; l <= to; l++) {
			const slot = this.store.slotOf(l);
			if (typeof slot !== 'number') continue;
			out.push(this.#shown(slot) ?? '');
		}
		return out.join('\n');
	}

	/** One long line, whole. */
	lineText(slot: number): string {
		return this.#shown(slot) ?? '';
	}

	/** The raw log as it arrived, or its text without escapes, \r resolved and @nix lines kept. */
	blob(kind: 'raw' | 'text'): Blob {
		const type = 'text/plain;charset=utf-8';
		if (kind === 'raw') return new Blob(this.store.rawPages() as BlobPart[], { type });
		const parts: string[] = [];
		const n = this.store.slots;
		for (let s = 0; s < n; s++) {
			const a = this.store.at(s);
			if (a === 'gap') {
				const g = this.store.gap!;
				parts.push(`[lines ${g.firstHidden} to ${g.lastHidden} not shown]\n`);
				continue;
			}
			parts.push(plainText(resolveCR(a.part.raw(a.i))), '\n');
		}
		return new Blob(parts, { type });
	}
}

function markClass(s: Seg): string {
	const m = s.mark === 2 ? 'hit cur' : s.mark === 1 ? 'hit' : '';
	return m ? (s.look.c ? `${s.look.c} ${m}` : m) : s.look.c;
}

/** Split segments at link and mark boundaries, in text offsets. */
function splitAt(
	segs: Seg[],
	links: [number, number, string][],
	marks: [number, number, 1 | 2][]
): Seg[] {
	const set = new Set<number>();
	for (const [a, b] of links) set.add(a).add(b);
	for (const [a, b] of marks) set.add(a).add(b);
	const cuts = [...set].sort((x, y) => x - y);
	// Links and marks are in order and never overlap, so each index only moves on.
	let ci = 0;
	let li = 0;
	let mi = 0;
	const out: Seg[] = [];
	let pos = 0;
	for (const s of segs) {
		const end = pos + s.text.length;
		while (ci < cuts.length && cuts[ci] <= pos) ci++;
		let a = pos;
		for (;;) {
			const c = ci < cuts.length && cuts[ci] < end ? cuts[ci++] : end;
			while (li < links.length && links[li][1] <= a) li++;
			while (mi < marks.length && marks[mi][1] <= a) mi++;
			const link = li < links.length && links[li][0] <= a && c <= links[li][1] ? links[li] : null;
			const mark = mi < marks.length && marks[mi][0] <= a && c <= marks[mi][1] ? marks[mi] : null;
			out.push({
				text: s.text.slice(a - pos, c - pos),
				look: s.look,
				mark: mark ? mark[2] : 0,
				href: link ? link[2] : ''
			});
			a = c;
			if (c === end) break;
		}
		pos = end;
	}
	return out;
}

/** Segments into rows of `cols` cells, at most `rows` of them, and no more than `max` cells. */
function cut(segs: Seg[], cols: number, max: number, rows: number): Seg[][] {
	const out: Seg[][] = [[]];
	let cells = 0;
	let row = 0;
	const simple = segs.every((s) => isSimple(s.text));
	for (const s of segs) {
		if (cells >= max) break;
		if (simple) {
			let i = 0;
			while (i < s.text.length && cells < max) {
				const room = Math.min((row + 1) * cols - cells, max - cells);
				const take = Math.min(room, s.text.length - i);
				out[row].push({ ...s, text: s.text.slice(i, i + take) });
				i += take;
				cells += take;
				if (cells === (row + 1) * cols && row + 1 < rows) out[++row] = [];
			}
			continue;
		}
		let buf = '';
		for (const { g, cells: w } of graphemes(s.text)) {
			if (cells + w > max) break;
			if (cells + w > (row + 1) * cols && row + 1 < rows) {
				if (buf) out[row].push({ ...s, text: buf });
				buf = '';
				out[++row] = [];
				cells = row * cols;
			}
			buf += g;
			cells += w;
		}
		if (buf) out[row].push({ ...s, text: buf });
	}
	return out;
}
