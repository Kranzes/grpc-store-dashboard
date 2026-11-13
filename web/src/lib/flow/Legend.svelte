<script module lang="ts">
	import type { LineKind } from './kinds.ts';

	/** A legend item: a kind of line, or the failure bars on assignment and request lines. */
	export type LegendItem = LineKind | 'failed';
</script>

<script lang="ts">
	import { Panel, useViewport } from '@xyflow/svelte';
	import { untrack } from 'svelte';
	import { LINE_KINDS } from './kinds.ts';
	import { LABEL_MIN_ZOOM } from './labels.ts';
	import { kindLabel } from './lines.ts';
	import { rovingIndex } from '#lib/ui/keys.ts';

	type Props = {
		/** Rates on lines, which the switch in the note row turns on and off. Session only. */
		showRates: boolean;
		/** The user pans or zooms. The note follows the zoom once that ends, as the labels do. */
		moving: boolean;
		/** The pointer rests on an item, which the map lights, or null once it left. */
		onhover?: (item: LegendItem | null) => void;
		/** Keyboard focus is on an item, which the map lights at once, or null once it left. */
		onfocusitem?: (item: LegendItem | null) => void;
		/** A pool is on the map, so the legend explains its cells, once for every pool. */
		pools?: boolean;
		/** The upstream card and its lines show. */
		upstream?: boolean;
	};
	let {
		showRates = $bindable(),
		moving,
		onhover,
		onfocusitem,
		pools = false,
		upstream = false
	}: Props = $props();

	const viewport = useViewport();
	const below = $derived(viewport.current.zoom < LABEL_MIN_ZOOM);
	let small = $state(untrack(() => below));
	$effect(() => {
		if (!moving) small = below;
	});

	const FAILED_HINT =
		'Red bars among the dots show the share of finished builds that failed in the selected window, on the lines into builders and out of client groups.';

	const HINT: Record<LineKind, string> = {
		request: 'Derivations clients ask the scheduler for, per minute',
		assign: 'Derivations assigned to builders, per minute',
		hit: 'Requests the scheduler found in the cache, per minute. No bytes travel on this line.',
		publish: 'Output bytes builders publish to the cache',
		fetch: 'Estimated input bytes builders fetch from the cache',
		substitute:
			'Input bytes builders take from substituters such as cache.nixos.org. Sizes are NAR sizes before compression.'
	};

	/** The busiest line of each unit is the widest, so widths compare only within one (traffic.ts). */
	const WIDTHS =
		'Line widths compare only within one unit: derivations per minute, or bytes per second.';
	/** The note says to zoom in, for the rate labels, instead of what widths mean. */
	const zoomIn = $derived(showRates && small);

	type Item = { kind: LegendItem; label: string; hint: string };
	const items = $derived<Item[]>([
		...LINE_KINDS.filter((k) => upstream || k !== 'substitute').map((kind) => ({
			kind,
			label: kindLabel(kind),
			hint: HINT[kind]
		})),
		{ kind: 'failed', label: 'Failed builds', hint: FAILED_HINT }
	]);

	/** The item under the pointer. */
	let hovered: LegendItem | null = null;
	function hover(item: LegendItem | null) {
		hovered = item;
		onhover?.(item);
	}

	// The items are one tab stop, and the arrow keys move between them.
	let stop = $state<LegendItem>('request');
	const tabStop = $derived(items.some((i) => i.kind === stop) ? stop : items[0].kind);
	/** The item keyboard focus is on. A click's focus lights nothing, so the pointer's rules hold. */
	let focused: LegendItem | null = null;
	function focusItem(el: HTMLElement | null, item: LegendItem | null) {
		if (el && item) stop = item;
		const next = el?.matches(':focus-visible') ? item : null;
		if (next === focused) return;
		focused = next;
		onfocusitem?.(next);
	}
	function onkeydown(e: KeyboardEvent & { currentTarget: HTMLElement }, i: number) {
		const to = rovingIndex(e.key, i, items.length, true);
		if (to < 0) return;
		e.preventDefault();
		(e.currentTarget.parentElement?.children[to] as HTMLElement | undefined)?.focus();
	}

	// An item that goes away under the pointer gets no pointerleave, and the
	// map would stay lit for it: Substitutions, when the upstream card goes.
	// The same holds for keyboard focus.
	$effect(() => {
		const kinds = items.map((i) => i.kind);
		if (hovered && !kinds.includes(hovered)) hover(null);
		if (focused && !kinds.includes(focused)) focusItem(null, null);
	});
</script>

<!--
	Rows: the line kinds, the pool cells while a pool is on the map, then the
	note. The box is as wide as the widest row, and rows wrap when the map is
	too narrow for them.
-->
<Panel position="bottom-left" class="legend-panel">
	<div class="legend">
		<!-- Focus lights an item's lines as a resting pointer does, and screen
		     readers hear its hint as the description. aria-description is
		     ARIA 1.3, which Svelte's types and checks do not know yet, hence
		     the spread. -->
		<ul class="items" aria-label="Line colors">
			{#each items as item, i (item.kind)}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<li
					tabindex={item.kind === tabStop ? 0 : -1}
					title={item.hint}
					{...{ 'aria-description': item.hint }}
					onpointerenter={() => hover(item.kind)}
					onpointerleave={() => hover(null)}
					onfocus={(e) => focusItem(e.currentTarget, item.kind)}
					onblur={() => focusItem(null, null)}
					onkeydown={(e) => onkeydown(e, i)}
				>
					<span
						class="swatch {item.kind === 'failed' ? 'flow-assign failed' : `flow-${item.kind}`}"
						aria-hidden="true"
					></span>
					{item.label}
				</li>
			{/each}
		</ul>
		{#if pools}
			<p class="cells">
				<span class="cells-name">Pool cells</span>
				<span>Idle</span>
				<span class="ramp" aria-hidden="true">
					<i class="pool-cell l0"></i><i class="pool-cell l1"></i><i class="pool-cell l2"></i><i
						class="pool-cell l3"
					></i>
				</span>
				<span>Full</span>
				<span class="key"><i class="pool-cell l2 draining" aria-hidden="true"></i>Draining</span>
				<span class="key"><i class="pool-cell offline" aria-hidden="true"></i>Offline</span>
			</p>
		{/if}
		<div class="note-row">
			<p
				class="note"
				title={zoomIn ? undefined : WIDTHS}
				{...{ 'aria-description': zoomIn ? undefined : WIDTHS }}
			>
				{zoomIn ? 'Zoom in to read rates on lines' : 'Thicker lines carry more traffic'}
			</p>
			<button
				type="button"
				class="rates"
				aria-pressed={showRates}
				aria-label="Rates on lines"
				title="Show each line's rate beside its end"
				onclick={() => (showRates = !showRates)}
			>
				<span class="track" aria-hidden="true"><span class="knob"></span></span>
				Rates
			</button>
		</div>
	</div>
</Panel>

<style>
	/* Room on the right for the zoom buttons and the chips beside them. */
	:global(.svelte-flow__panel.legend-panel) {
		max-width: calc(100% - 150px);
	}

	.legend {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: max-content;
		max-width: 100%;
		padding: 7px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--bg-node) 88%, transparent);
		backdrop-filter: blur(6px);
		box-shadow: var(--shadow-sm);
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	.items {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		display: flex;
		align-items: center;
		gap: 6px;
		border-radius: var(--radius-sm);
		white-space: nowrap;
	}

	.note-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.note {
		margin: 0;
		font-style: italic;
	}

	/* The switch stays on a narrow map; the note gives way. */
	@media (max-width: 1279px) {
		.note {
			display: none;
		}
	}

	/* A small switch: a track whose knob moves right and fills while rates show. */
	.rates {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 20px;
		margin: -2px 0 -2px auto;
		padding: 0 6px 0 2px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--fg);
		font-size: var(--text-2xs);
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.rates:hover {
		background: var(--bg-raised);
	}

	.rates:focus-visible {
		outline-offset: 0;
	}

	.track {
		position: relative;
		width: 22px;
		height: 12px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--bg-node);
		transition: background var(--dur-fast);
	}

	.knob {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--fg-muted);
		transition:
			transform var(--dur-fast) var(--ease-out),
			background var(--dur-fast);
	}

	.rates[aria-pressed='true'] .track {
		border-color: var(--accent-strong);
		background: var(--accent-soft);
	}

	.rates[aria-pressed='true'] .knob {
		background: var(--accent-strong);
		transform: translateX(10px);
	}

	.swatch {
		width: 16px;
		height: 3px;
		border-radius: 2px;
		background: var(--flow-c);
	}

	/* A red bar among the dots, as on a failing line. */
	.swatch.failed {
		position: relative;
	}

	.swatch.failed::after {
		position: absolute;
		top: -1px;
		left: 4px;
		width: 8px;
		height: 5px;
		background: var(--danger);
		content: '';
	}

	/* The pool key: cells drawn as PoolNode.svelte draws them. */
	.cells {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
		margin: 0;
	}

	.cells-name {
		margin-right: 4px;
		color: var(--fg);
	}

	.ramp,
	.key {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.key {
		gap: 4px;
		margin-left: 8px;
	}

	/* Cells draw as .pool-cell in nodes.css. */
	.pool-cell {
		flex: none;
	}

	/* Thin dashes, as the cache hits line draws. */
	.swatch.flow-hit {
		height: 2px;
		border-radius: 0;
		background: repeating-linear-gradient(90deg, var(--flow-c) 0 5px, transparent 5px 9px);
	}
</style>
