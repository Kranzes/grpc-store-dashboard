// A hook for browser tests into the line canvas, which has no elements to
// inspect. Set globalThis.__lineProbe = true before the page loads and the
// canvas puts a LineProbe at window.__lines. Without the flag nothing is
// installed, and the canvas behaves the same either way: the probe only
// reads, and counts draws.

import type { Colors, LineReport } from './lineLayer.ts';

export type LineProbe = {
	/** Every drawn line in paint order, bottom first, with its dots in flow px. */
	report(): LineReport[];
	/** Paint order, bottom first. */
	order(): string[];
	/** Draws so far, and ms spent in them. */
	draws(): { count: number; ms: number };
	/** Travel time: the canvas clock without pauses, ms. */
	travel(): number;
	/** The point `s` flow px along a line, in page px. A negative `s` counts from its end. */
	client(id: string, s: number): { x: number; y: number } | null;
	/** The same point in flow px. */
	flow(id: string, s: number): { x: number; y: number } | null;
	/** Length of a line's track, flow px. */
	length(id: string): number | null;
	/** The colors the lines draw with, resolved from the theme. */
	colors(): Colors | null;
};

export const PROBE_FLAG = '__lineProbe';

export function probeOn(): boolean {
	return (globalThis as Record<string, unknown>)[PROBE_FLAG] === true;
}
