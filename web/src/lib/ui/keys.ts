// Arrow keys in a row of items that wraps around, as in a radio group or a toolbar.

/**
 * Where a key moves focus among `n` items from item `i`: Right and Down to
 * the next, Left and Up to the one before, wrapping around, and with `ends`,
 * Home and End to the first and the last. -1 for any other key.
 */
export function rovingIndex(key: string, i: number, n: number, ends = false): number {
	if (key === 'ArrowRight' || key === 'ArrowDown') return (i + 1) % n;
	if (key === 'ArrowLeft' || key === 'ArrowUp') return (i - 1 + n) % n;
	if (ends && key === 'Home') return 0;
	if (ends && key === 'End') return n - 1;
	return -1;
}
