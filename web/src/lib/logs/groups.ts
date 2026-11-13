// Groups that fold like the steps of a GitHub Actions log: stdenv phases,
// and the NixOS test driver's blocks and subtests, built as lines arrive.
//
// - A phase runs from its "Running phase: X" line to the line before the
//   next phase's, or the end. "@nix { … setPhase … }" opens one too when the
//   line before was not that phase's "Running phase" line.
// - The test driver starts each block of its own work with one bold green
//   line, the block's name, and ends it with "(finished: NAME, in X.XX
//   seconds)": "start all VLans", "run the VM test script", which holds the
//   VMs' start, the test script's own lines and every subtest, then
//   "cleanup". A subtest is the block "subtest: NAME", found by its text
//   after stripping ANSI, so it is found without colors too. Blocks nest,
//   and nest under the phase that prints them. A machine's own steps, such
//   as "machine: waiting for unit …", stay plain lines.
// - VM console lines such as "machine # ..." right after a block's finish
//   line join that block. The driver logs the console as it arrives, so a
//   block's console output can land after it finished. The first other
//   line ends the run.
// - A block that fails prints no finish line. The driver's cleanup runs
//   after the test script whether it passed or failed, so "cleanup" closes
//   every block still open, and the innermost of them is the failed group.
// - Lines before the first group, and other lines after a closed top-level
//   group, stay at the top level.

import { errorRules, makeRule, mayMatch, warningRules } from './errors.ts';

export type GroupKind = 'phase' | 'block' | 'subtest';

export type Group = {
	id: number;
	kind: GroupKind;
	/** A subtest's name comes without "subtest: ". */
	name: string;
	/** The slot of its header line, its first. */
	headerSlot: number;
	/** Its last slot so far. */
	lastSlot: number;
	depth: number;
	parent: number | null;
	/** From stdenv's footer or the driver's finish line; null when the log printed none. */
	durationS: number | null;
	/** Lines, warnings and errors, nested groups included. */
	lines: number;
	warnings: number;
	errors: number;
	closed: boolean;
};

const PHASE = /^Running phase: (\S+)$/;
const SET_PHASE = /^@nix \{.*"action": *"setPhase"/;
const SET_PHASE_NAME = /"phase": *"([^"]+)"/;
const FOOTER = /^(\S+) completed in (?:(\d+) hours )?(?:(\d+) minutes )?(\d+) seconds$/;
/** The NixOS test driver's subtest line, and the line that ends one of its blocks. */
export const SUBTEST = /^subtest: (.+)$/;
export const FINISHED = /^\(finished: (.+), in (\d+\.\d+) seconds\)$/;
/** A driver block's header: the whole line bold green, as the driver prints it. */
// eslint-disable-next-line no-control-regex -- escapes are what it matches
const BLOCK = /^\x1b\[1m\x1b\[32m([^\x1b]+)\x1b\[0m$/;
/** The driver's last block, which it runs whether the test script passed or failed. */
const CLEANUP = 'cleanup';
/** A VM's serial console line, as the NixOS test driver prints it. */
const CONSOLE = /^[\w.-]+ # /;

/** The log's error count stops here. */
export const ERRORS_CAP = 1000;

/** Count a line, and its error or warning. */
function tally(
	c: { lines: number; errors: number; warnings: number },
	err: boolean,
	warn: boolean
) {
	c.lines++;
	if (err) c.errors++;
	if (warn) c.warnings++;
}

/**
 * Where the first-error search in a failed chain starts: its outermost
 * phase or subtest, the failed unit of work, or else its innermost driver
 * block, since "run the VM test script" holds the whole test.
 */
function searchStart(chain: readonly Group[]): Group {
	return chain.find((g) => g.kind !== 'block') ?? chain[chain.length - 1];
}

export class GroupTree {
	readonly groups: Group[] = [];
	/** Open groups, outermost first. */
	readonly #open: Group[] = [];
	/** The Running phase line just before, which a setPhase line belongs to. */
	#lastPhaseLine: { slot: number; name: string } | null = null;
	/** The block that just finished, while console lines follow it. */
	#trailing: Group | null = null;
	/** The innermost block the driver's cleanup closed without its finish line. */
	#failed: Group | null = null;
	/** Bumped on every change, so the main thread gets the tree again. */
	version = 0;
	/** The last slot seen. */
	lastSlot = -1;
	/** Error and warning lines, by slot, in order; errors capped. */
	readonly errorSlots: number[] = [];
	errorsCapped = false;
	/** make's fallback lines, for the first error when nothing else matched. */
	readonly makeSlots: number[] = [];

	/** One complete line, in order: `text` without ANSI, `raw` as it arrived. */
	add(slot: number, text: string, raw = text) {
		this.lastSlot = slot;
		const trailing = this.#trailing;
		this.#trailing = null;
		const c0 = text.charCodeAt(0);
		// Cheap first checks, since most lines start with none of these.
		if (c0 === 82 /* R */) {
			const m = PHASE.exec(text);
			if (m) {
				this.#openPhase(slot, m[1]);
				this.#lastPhaseLine = { slot, name: m[1] };
				this.#count(slot, text);
				return;
			}
		} else if (c0 === 64 /* @ */ && SET_PHASE.test(text)) {
			const name = SET_PHASE_NAME.exec(text)?.[1] ?? '';
			const prev = this.#lastPhaseLine;
			if (!(prev && prev.slot === slot - 1 && prev.name === name) && name)
				this.#openPhase(slot, name);
			this.#count(slot, text);
			return;
		} else if (c0 === 115 /* s */) {
			const m = SUBTEST.exec(text);
			if (m) {
				this.#openBlock(slot, 'subtest', m[1]);
				this.#count(slot, text);
				return;
			}
		} else if (c0 === 40 /* ( */) {
			const m = FINISHED.exec(text);
			if (m && this.#finish(slot, text, m[1], Number(m[2]))) return;
		}
		if (raw.charCodeAt(0) === 27 /* ESC */) {
			const name = BLOCK.exec(raw)?.[1];
			if (name !== undefined) {
				this.#openBlock(slot, 'block', name);
				this.#count(slot, text);
				return;
			}
		}
		const top = this.#open.at(-1);
		// stdenv's footer starts with the open phase's name, which most lines fail at once.
		if (top?.kind === 'phase' && text.startsWith(top.name) && text.includes(' completed in ')) {
			const m = FOOTER.exec(text);
			if (m && m[1] === top.name)
				top.durationS = Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4]);
		}
		if (trailing && CONSOLE.test(text)) {
			this.#trailing = trailing;
			this.#count(slot, text, trailing);
			return;
		}
		this.#count(slot, text);
	}

	/** The gap row, where every open group ends with the head. */
	gap(slot: number) {
		this.lastSlot = slot;
		this.#trailing = null;
		this.#closeFrom(0);
		this.#lastPhaseLine = null;
		this.version++;
	}

	/** Count a line in every open group, and in `trailing`, a finished block it joins. */
	#count(slot: number, text: string, trailing?: Group) {
		const may = mayMatch(text);
		const err = may && errorRules(text);
		const warn = may && !err && warningRules(text);
		if (err) {
			if (this.errorSlots.length < ERRORS_CAP) this.errorSlots.push(slot);
			else this.errorsCapped = true;
		} else if (may && makeRule(text)) this.makeSlots.push(slot);
		if (trailing) {
			trailing.lastSlot = slot;
			tally(trailing, err, warn);
			this.version++;
		}
		if (this.#open.length === 0) return;
		for (const g of this.#open) {
			g.lastSlot = slot;
			tally(g, err, warn);
		}
		// Header counts change often; the main thread gets them at most 10 times a second.
		this.version++;
	}

	#new(kind: GroupKind, name: string, slot: number, parent: Group | null): Group {
		const g: Group = {
			id: this.groups.length,
			kind,
			name,
			headerSlot: slot,
			lastSlot: slot,
			depth: parent ? parent.depth + 1 : 0,
			parent: parent?.id ?? null,
			durationS: null,
			lines: 0,
			warnings: 0,
			errors: 0,
			closed: false
		};
		this.groups.push(g);
		this.version++;
		return g;
	}

	#openPhase(slot: number, name: string) {
		// A phase closes everything open, blocks in the phase before included.
		this.#closeFrom(0);
		this.#open.push(this.#new('phase', name, slot, null));
	}

	#openBlock(slot: number, kind: 'block' | 'subtest', name: string) {
		if (kind === 'block' && name === CLEANUP) this.#cutShort();
		this.#open.push(this.#new(kind, name, slot, this.#open.at(-1) ?? null));
	}

	/** Close the open groups from depth `k` in, and take them off the open stack. */
	#closeFrom(k: number) {
		const open = this.#open;
		for (let j = k; j < open.length; j++) open[j].closed = true;
		open.length = Math.min(open.length, k);
	}

	/**
	 * The driver's cleanup starts, so the test script ended. The blocks
	 * still open failed, since none printed its finish line. They close on
	 * the line before, and the phase that holds them stays open.
	 */
	#cutShort() {
		const open = this.#open;
		let k = open.length;
		while (k > 0 && open[k - 1].kind !== 'phase') k--;
		if (k === open.length) return;
		this.#failed = open[open.length - 1];
		this.#closeFrom(k);
		this.version++;
	}

	/**
	 * A finish line closes the innermost open block of its name, and those
	 * inside it. `message` is the block's name, "subtest: NAME" for a subtest.
	 */
	#finish(slot: number, text: string, message: string, secs: number): boolean {
		const sub = SUBTEST.exec(message)?.[1];
		const kind = sub === undefined ? 'block' : 'subtest';
		const name = sub ?? message;
		let k = this.#open.length - 1;
		while (k >= 0 && !(this.#open[k].kind === kind && this.#open[k].name === name)) k--;
		if (k < 0) return false;
		// Those inside it end on the line before; the finish line is its own last.
		this.#closeFrom(k + 1);
		this.#count(slot, text);
		const g = this.#open[k];
		g.durationS = secs;
		this.#closeFrom(k);
		this.#trailing = g;
		this.version++;
		return true;
	}

	/** Open groups, outermost first. */
	get open(): readonly Group[] {
		return this.#open;
	}

	/**
	 * The failed group once a failed build ends: the innermost block the
	 * driver's cleanup closed without its finish line, else the innermost
	 * open group, or null when the last line is at the top level.
	 */
	failedGroup(): Group | null {
		return this.#failed ?? this.#open.at(-1) ?? null;
	}

	/** A group and its parents, outermost first. */
	#up(g: Group): Group[] {
		const out: Group[] = [];
		for (let p: Group | null = g; p; p = p.parent === null ? null : this.groups[p.parent])
			out.unshift(p);
		return out;
	}

	/** The groups that hold a slot, outermost first. */
	chain(slot: number): Group[] {
		let best: Group | null = null;
		for (const g of this.groups)
			if (slot >= g.headerSlot && slot <= g.lastSlot && (!best || g.depth > best.depth)) {
				// The deepest that holds it; its parents follow.
				best = g;
			}
		return best ? this.#up(best) : [];
	}

	/**
	 * Where the first-error search starts: in the failed group's chain, or
	 * else the chain that holds the last line, as searchStart says; after
	 * the last top-level group when the last line is at the top level; the
	 * top in a log without groups.
	 */
	errorSearchFrom(): number {
		if (this.groups.length === 0) return 0;
		const failed = this.failedGroup();
		const chain = failed ? this.#up(failed) : this.chain(this.lastSlot);
		if (chain.length) return searchStart(chain).headerSlot;
		let end = -1;
		for (const g of this.groups) if (g.depth === 0) end = Math.max(end, g.lastSlot);
		return end + 1;
	}

	/** The first error line from errorSearchFrom, by the rules, else make's line, or null. */
	firstError(): number | null {
		const from = this.errorSearchFrom();
		for (const s of this.errorSlots) if (s >= from) return s;
		for (const s of this.makeSlots) if (s >= from) return s;
		return null;
	}
}
