// Small one-line boxes, such as badges, rate labels and the status pill, trim
// their text to the capitals and the baseline with `text-box: trim-both cap
// alphabetic`, so equal padding above and below looks equal. A browser
// without text-box gets a line box one cap tall instead, where the font's
// own ascent and descent decide where the capitals sit. This measures how
// far that is from the top, per font, so base.css can nudge them back.

type FontMetrics = Readonly<{
	/** Height of a capital H. */
	cap: number;
	/** The font's ascent and descent, which CSS lays a line out with. */
	ascent: number;
	descent: number;
	size: number;
}>;

/**
 * How far below the top of a line box 1cap tall the capitals start, in em.
 * The line box centres the font's content area, its ascent plus descent, so
 * the baseline sits (cap + ascent - descent) / 2 from its top.
 */
export function capShift(m: FontMetrics): number {
	return (m.ascent - m.descent - m.cap) / 2 / m.size;
}

const TRIM = 'trim-both cap alphabetic';

/**
 * Set --trim-shift-sans and --trim-shift-mono on the root element when the
 * browser lacks text-box. Does nothing where it has it.
 */
export function installTrimFallback(doc: Document = document): void {
	if (typeof CSS === 'undefined' || CSS.supports('text-box', TRIM)) return;
	const ctx = doc.createElement('canvas').getContext('2d');
	if (!ctx) return;
	const root = doc.documentElement;
	const style = getComputedStyle(root);
	for (const font of ['sans', 'mono'] as const) {
		const family = style.getPropertyValue(`--font-${font}`).trim();
		if (!family) continue;
		const size = 100;
		ctx.font = `600 ${size}px ${family}`;
		const m = ctx.measureText('H');
		const shift = capShift({
			cap: m.actualBoundingBoxAscent,
			ascent: m.fontBoundingBoxAscent,
			descent: m.fontBoundingBoxDescent,
			size
		});
		if (Number.isFinite(shift))
			root.style.setProperty(`--trim-shift-${font}`, `${shift.toFixed(4)}em`);
	}
}
