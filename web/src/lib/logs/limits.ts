// The log sizes of decision 6, for the worker's store and the viewer's
// client. No imports, so the client keeps ansi.ts and text.ts off the main
// thread.

export const MiB = 1024 * 1024;
/** Up to this much a log is kept whole. */
export const WHOLE_MAX = 64 * MiB;
/** The head of a larger log. */
export const HEAD_MAX = 16 * MiB;
/** The tail of a larger log. */
export const TAIL_MAX = 48 * MiB;
