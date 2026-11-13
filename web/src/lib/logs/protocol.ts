// The messages between the viewer, on the main thread, and its log worker.

import type { DemoLogPlan } from '#lib/source/mock.ts';
import type { LogEnding } from '#lib/source/mock-log.ts';
import type { Group } from './groups.ts';

/** What a call's first message said, from servers that send it. */
export type CallInfo = Readonly<{
	/** The decoded byte this call starts at. */
	offset: number;
	/** Newlines before offset. */
	firstLine: number;
	/** Decoded size, 0 when unknown. */
	size: number;
}>;

export type ToWorker =
	/**
	 * A call starts: the whole log, its head, or its tail placed by `info`.
	 * `tailFirst`: the tail shows as it arrives, and the head goes in front when it ends.
	 * `of`: the call that broke, whose part this 'more' call goes on with.
	 * `whole`: this head sends the whole log, as a follow call does, so past
	 * 16 MiB the worker keeps its first 16 MiB and a ring of its last 48 MiB.
	 */
	| {
			t: 'call';
			call: number;
			part: 'head' | 'tail' | 'more';
			info: CallInfo | null;
			tailFirst?: boolean;
			of?: number;
			whole?: boolean;
	  }
	| { t: 'zstd'; call: number; data: Uint8Array }
	/** The call ended, complete or broken off. More of a broken call may follow in another call. */
	| { t: 'end'; call: number; complete: boolean }
	/** How many bytes a call decoded, and where the head's complete lines end. */
	| { t: 'decoded'; req: number; call: number }
	/** Drop everything, because a later call reads another source from 0. */
	| { t: 'restart' }
	/** The demo's log of a build, made in the worker. */
	| { t: 'demo'; plan: DemoLogPlan }
	| { t: 'demo-tick'; nowMs: number }
	| { t: 'demo-started'; startedMs: number }
	| { t: 'demo-ended'; ending: LogEnding; nowMs: number }
	| { t: 'layout'; cols: number; wrap: boolean }
	| { t: 'rows'; req: number; from: number; to: number }
	/** Fold or open groups; `anchor` is a slot whose row comes back. */
	| { t: 'fold'; req: number; ids: number[]; open: boolean; anchor: number | null }
	| { t: 'foldAll'; req: number; open: boolean; anchor: number | null }
	/** Open the groups that hold a line and answer its row. */
	| { t: 'reveal'; req: number; line: number }
	| { t: 'search'; text: string; caseSensitive: boolean; onlyMatching: boolean }
	/** Move to hit `index`, opening its groups; -1 clears the current hit. */
	| { t: 'hit'; req: number; index: number }
	/** Lines from..to, 1-based, folded ones included, as plain text. */
	| { t: 'range'; req: number; from: number; to: number }
	/** The raw log as it arrived, or the text without escapes. */
	| { t: 'blob'; req: number; kind: 'raw' | 'text' }
	/** The full text of one long line. */
	| { t: 'line'; req: number; slot: number };

/** One drawn row. Segments are [text, class names, inline style, link]. */
export type RenderedRow = Readonly<{
	row: number;
	kind: 'line' | 'header' | 'gap' | 'more';
	slot: number;
	/** 1-based line number, on a line's first row; null otherwise. */
	line: number | null;
	/** Which row of its line this is. */
	part: number;
	/** Header rows: the group. */
	group?: number;
	segs?: readonly (readonly [string, string, string, string])[];
	/** An error line, which the gutter marks with a bar. */
	error?: boolean;
	/** An @nix line, drawn dim. */
	nix?: boolean;
	/** "Show more": cells and an estimate of the bytes not drawn. */
	more?: { cells: number; bytes: number };
	/** The gap row: lines and bytes not shown. */
	gap?: { from: number; to: number; bytes: number };
}>;

export type Progress = Readonly<{
	/** Lines the log has, the last line's number. */
	lines: number;
	/** Bytes decoded over all calls. */
	bytes: number;
	slots: number;
	rows: number;
	/** The last line is still being written. */
	open: boolean;
	/** A decoder failed because the stream broke. */
	broken: string | null;
	gap: { from: number; to: number } | null;
	/** Nothing more is on its way: every call ended, or the demo sent all it has. */
	idle: boolean;
}>;

export type ErrorsInfo = Readonly<{
	/** Error lines, 1-based and capped. */
	lines: readonly number[];
	capped: boolean;
	/** The first error by the rules in errors.ts, or null. */
	first: number | null;
	/** The first line of the last 25, for "Last lines". */
	lastLines: number;
}>;

export type SearchInfo = Readonly<{
	count: number;
	capped: boolean;
	complete: boolean;
	gapSkipped: boolean;
	current: number;
}>;

/**
 * Group ids moved: the head of a log whose tail came first went in above,
 * or the ring dropped lines, with shift 0.
 */
export type Moved = Readonly<{
	/** Rows added before the tail's first line. */
	shift: number;
	/** Each old group id's new id, null when it went. */
	remap: readonly (number | null)[];
	folded: readonly number[];
	total: number;
}>;

/**
 * A group as the viewer gets it: with the line numbers of its first and last
 * slots, which differ from slot + 1 once the middle of a log is hidden or the
 * ring has dropped its start. null where the line is not known.
 */
export type GroupView = Group &
	Readonly<{
		line: number | null;
		lastLine: number | null;
	}>;

export type FromWorker =
	| { t: 'progress'; p: Progress }
	| ({ t: 'moved' } & Moved)
	| {
			t: 'groups';
			groups: readonly GroupView[];
			open: readonly number[];
			/** The failed group once a failed build ends, by GroupTree.failedGroup. */
			failed: number | null;
	  }
	| { t: 'errors'; e: ErrorsInfo }
	| { t: 'rows'; req: number; rows: readonly RenderedRow[]; total: number }
	| { t: 'folded'; req: number; total: number; anchorRow: number | null; folded: readonly number[] }
	| {
			t: 'revealed';
			req: number;
			row: number | null;
			gap: boolean;
			total: number;
			folded: readonly number[];
	  }
	| { t: 'search'; s: SearchInfo }
	| {
			t: 'hit';
			req: number;
			row: number | null;
			line: number | null;
			total: number;
			folded: readonly number[];
	  }
	| { t: 'range'; req: number; text: string }
	| { t: 'blob'; req: number; blob: Blob }
	| { t: 'line'; req: number; text: string }
	| { t: 'decoded'; req: number; bytes: number; headComplete: number };
