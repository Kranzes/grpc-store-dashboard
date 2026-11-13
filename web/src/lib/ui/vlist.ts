// Which rows a VirtualList renders, and which one holds the tab stop.

export type ListWindow = Readonly<{
	/** Row indices to render, ascending. */
	rows: readonly number[];
	/** The one row with tabindex 0, or null when the list is empty. */
	tabRow: number | null;
}>;

/**
 * Rows in view plus `overscan` on each side. The active row is always
 * rendered, even when scrolled far away, so the list keeps exactly one tab
 * stop and a focused row is not removed from the page under the user.
 */
export function listWindow(
	o: Readonly<{
		count: number;
		scrollTop: number;
		height: number;
		rowHeight: number;
		overscan: number;
		active: number;
	}>
): ListWindow {
	if (o.count <= 0) return { rows: [], tabRow: null };
	const start = Math.max(0, Math.floor(o.scrollTop / o.rowHeight) - o.overscan);
	const end = Math.min(
		o.count,
		Math.ceil((o.scrollTop + Math.max(o.height, o.rowHeight)) / o.rowHeight) + o.overscan
	);
	const tabRow = Math.max(0, Math.min(o.active, o.count - 1));
	const rows: number[] = [];
	if (tabRow < start) rows.push(tabRow);
	for (let i = start; i < end; i++) rows.push(i);
	if (tabRow >= end) rows.push(tabRow);
	return { rows, tabRow };
}
