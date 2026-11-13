<script lang="ts" generics="T">
	import { tick, untrack, type Snippet } from 'svelte';
	import { listWindow } from './vlist.ts';

	// Renders only the rows in view, so lists of thousands stay smooth. Rows
	// have a fixed height. One tab stop: arrow keys, Home and End move focus.
	// The active row stays rendered while scrolled away, so the tab stop and
	// the focused element survive scrolling.
	type Props = {
		items: readonly T[];
		key: (item: T) => string;
		label: string;
		rowHeight?: number;
		/** Rows rendered above and below the viewport. */
		overscan?: number;
		/** Render one row. Put `tabindex` on its single focusable element. */
		row: Snippet<[item: T, tabindex: number, index: number]>;
		/** Scroll offset in px. Bind it to come back to the same place later. */
		scrollTop?: number;
		/** Rows that arrow keys pass over and that never take the tab stop, such as headers. */
		skip?: (index: number) => boolean;
		/**
		 * Keep the first visible row where it is when rows arrive above it.
		 * Called with how many arrived above, so the caller can say so.
		 */
		onabove?: (n: number) => void;
		/** The list scrolled near its end: `rows` left below the view. */
		onnearend?: (rows: number) => void;
	};
	let {
		items,
		key,
		label,
		rowHeight = 52,
		overscan = 6,
		row,
		scrollTop = $bindable(0),
		skip,
		onabove,
		onnearend
	}: Props = $props();

	let el: HTMLDivElement | undefined = $state();
	let height = $state(0);

	// Start at the offset the caller kept.
	$effect(() => {
		if (!el) return;
		const top = untrack(() => scrollTop);
		if (top > 0) el.scrollTop = top;
		scrollTop = el.scrollTop;
	});
	let active = $state(0);

	// The anchor rule: the first visible row's key keeps its offset when rows
	// arrive above it.
	let anchorKey: string | null = null;
	let anchorOffset = 0;
	$effect.pre(() => {
		const list = items;
		untrack(() => {
			if (!onabove || !el || anchorKey === null) return;
			const i = list.findIndex((x) => key(x) === anchorKey);
			if (i < 0) return;
			const top = i * rowHeight - anchorOffset;
			const moved = Math.round((top - el.scrollTop) / rowHeight);
			if (moved > 0 && el.scrollTop > 0) {
				el.scrollTop = top;
				scrollTop = top;
				onabove(moved);
			}
		});
	});
	$effect(() => {
		void items;
		void scrollTop;
		untrack(() => {
			const first = Math.floor(scrollTop / rowHeight);
			const it = items[first];
			anchorKey = it ? key(it) : null;
			anchorOffset = first * rowHeight - scrollTop;
			const below = items.length - Math.ceil((scrollTop + height) / rowHeight);
			onnearend?.(below);
		});
	});

	/** The tab stop never sits on a skipped row. */
	const tabStop = $derived.by(() => {
		let i = Math.min(active, items.length - 1);
		while (i >= 0 && i < items.length - 1 && skip?.(i)) i++;
		return Math.max(0, i);
	});
	const win = $derived(
		listWindow({ count: items.length, scrollTop, height, rowHeight, overscan, active: tabStop })
	);
	const current = $derived(win.tabRow ?? 0);

	async function move(to: number, dir = 1) {
		if (!el || items.length === 0) return;
		let i = Math.max(0, Math.min(items.length - 1, to));
		// Pass over skipped rows, in the direction of the move.
		while (skip?.(i) && i + dir >= 0 && i + dir < items.length) i += dir;
		if (skip?.(i)) {
			i -= dir;
			while (skip?.(i) && i - dir >= 0 && i - dir < items.length) i -= dir;
		}
		active = i;
		const top = i * rowHeight;
		if (top < el.scrollTop) el.scrollTop = top;
		else if (top + rowHeight > el.scrollTop + el.clientHeight)
			el.scrollTop = top + rowHeight - el.clientHeight;
		scrollTop = el.scrollTop;
		await tick();
		el.querySelector<HTMLElement>(`[data-index="${i}"] [tabindex]`)?.focus();
	}

	/** Move the tab stop to row `i`, scroll it into view and focus it. */
	export function focusAt(i: number): Promise<void> {
		return move(i);
	}

	function onkeydown(e: KeyboardEvent) {
		const page = Math.max(1, Math.floor((el?.clientHeight ?? 0) / rowHeight) - 1);
		const to =
			e.key === 'ArrowDown'
				? current + 1
				: e.key === 'ArrowUp'
					? current - 1
					: e.key === 'PageDown'
						? current + page
						: e.key === 'PageUp'
							? current - page
							: e.key === 'Home'
								? 0
								: e.key === 'End'
									? items.length - 1
									: null;
		if (to === null) return;
		e.preventDefault();
		const dir = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'End' ? -1 : 1;
		move(to, dir);
	}

	function onfocusin(e: FocusEvent) {
		const at = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
		if (at) active = Number(at.dataset.index);
	}
</script>

<!-- Key and focus events bubble up from the row buttons; the list only routes them. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="vlist"
	bind:this={el}
	bind:clientHeight={height}
	onscroll={() => (scrollTop = el?.scrollTop ?? 0)}
	{onkeydown}
	{onfocusin}
	role="list"
	aria-label={label}
>
	<div class="spacer" style:height="{items.length * rowHeight}px">
		{#each win.rows as index (key(items[index]))}
			{@const item = items[index]}
			<div
				class="vrow"
				role="listitem"
				data-index={index}
				aria-setsize={items.length}
				aria-posinset={index + 1}
				style:height="{rowHeight}px"
				style:transform="translateY({index * rowHeight}px)"
			>
				{@render row(item, index === win.tabRow ? 0 : -1, index)}
			</div>
		{/each}
	</div>
</div>

<style>
	.vlist {
		position: relative;
		overflow-y: auto;
		overscroll-behavior: contain;
		contain: layout paint;
	}

	.spacer {
		position: relative;
		width: 100%;
	}

	.vrow {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
	}
</style>
