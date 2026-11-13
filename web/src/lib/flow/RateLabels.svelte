<script lang="ts">
	import { ViewportPortal, useViewport } from '@xyflow/svelte';
	import { untrack } from 'svelte';
	import type { EdgeView } from '#lib/model/types.ts';
	import { markScale } from './marks.ts';
	import {
		LABEL_MIN_ZOOM,
		PILL,
		labelOrder,
		labelOrigin,
		labelSizes,
		labelText,
		placeLabels,
		scaleBox,
		textMeasurer,
		visibleLabels,
		type Box,
		type LabelSlot,
		type Obstacles
	} from './labels.ts';

	type Props = {
		slots: readonly LabelSlot[];
		obstacles: Obstacles;
		/** Live numbers, refreshed once a second. */
		edges: ReadonlyMap<string, EdgeView>;
		/** The user pans or zooms. Labels mount or drop for the zoom only when that ends. */
		moving: boolean;
		/** Ids that stay bright while something is focused, or null without focus. */
		bright: ReadonlySet<string> | null;
		/** The focus class token of an id. */
		token: (id: string) => string;
		/** Boxes of the labels a viewer can see, in flow px, for the click test. */
		onplaced: (boxes: ReadonlyMap<string, Box>) => void;
	};
	let { slots, obstacles, edges, moving, bright, token, onplaced }: Props = $props();

	const viewport = useViewport();
	// One boolean, so the class flips only when the zoom crosses the limit,
	// and only once a gesture ends: a pinch or wheel across 0.6 mounts or
	// drops every label once, not on each crossing mid-gesture.
	const below = $derived(viewport.current.zoom < LABEL_MIN_ZOOM);
	let hidden = $state(untrack(() => below));
	$effect(() => {
		if (!moving) hidden = below;
	});
	// Above zoom 1.25 labels stop growing with the map, scaled about the side
	// that touches their line. Placement keeps their full size, so a smaller
	// label covers nothing it would not have covered. Like `hidden`, it
	// follows the zoom once a move ends.
	const target = $derived(markScale(viewport.current.zoom));
	let scale = $state(untrack(() => target));
	$effect(() => {
		if (!moving) scale = target;
	});
	const none = new Map<string, never>();

	let root: HTMLElement | undefined = $state();
	/** The pill's font, read once from the stylesheet. */
	const font = $derived.by(() => {
		if (!root) return null;
		const s = getComputedStyle(root);
		return `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
	});

	// While the zoom hides the labels, they read no numbers, measure and
	// place nothing, and no label element exists. Crossing the limit mounts
	// or drops the labels once, with the numbers of that moment.
	const texts = $derived(
		hidden ? none : new Map(slots.map((s) => [s.id, labelText(s.kind, edges.get(s.id))]))
	);
	const sizes = $derived(labelSizes(texts, font ? textMeasurer(font) : null));
	// A string, so placement re-runs only when a label's size changes, not
	// when its text changes at the same width.
	const sizeKey = $derived([...sizes].map(([id, s]) => `${id}:${s.w}x${s.h}`).join('\n'));
	const order = $derived(hidden ? [] : labelOrder(slots, bright));
	const placed = $derived.by(() => {
		if (hidden) return none;
		void sizeKey;
		return placeLabels(
			slots,
			untrack(() => sizes),
			obstacles,
			order
		);
	});
	const list = $derived([...placed].map(([id, box]) => ({ id, box })));
	const bySlot = $derived(new Map(slots.map((s) => [s.id, s])));

	// Hidden labels never take clicks meant for a line under them, and a
	// scaled one takes them only where it shows.
	$effect(() => {
		const visible = visibleLabels(placed, hidden, bright);
		if (scale !== 1)
			for (const [id, box] of visible) {
				const slot = bySlot.get(id);
				if (slot) visible.set(id, scaleBox(box, slot, scale));
			}
		onplaced(visible);
	});
	$effect(() => () => onplaced(visibleLabels(placed, true, null)));
</script>

<ViewportPortal target="front">
	<div
		class="rate-labels"
		class:hidden
		aria-hidden="true"
		bind:this={root}
		style:--pad-x="{PILL.padX}px"
		style:--pad-top="{PILL.padTop}px"
		style:--pad-bottom="{PILL.padBottom}px"
		style:--cap="{PILL.cap}px"
		style:--row-gap="{PILL.rowGap}px"
		style:--bar="{PILL.bar}px"
		style:--bar-height="{PILL.barHeight}px"
		style:--bar-gap="{PILL.barGap}px"
	>
		{#each list as l (l.id)}
			{@const t = texts.get(l.id)}
			{@const slot = bySlot.get(l.id)}
			{@const [ox, oy] = slot ? labelOrigin(slot) : [0, 0]}
			<div
				class="rate-label flow-{slot?.kind} {token(l.id)}"
				data-id={l.id}
				style:transform="translate({l.box.x}px, {l.box.y}px){scale !== 1 ? ` scale(${scale})` : ''}"
				style:transform-origin="{ox * 100}% {oy * 100}%"
				style:width="{l.box.w}px"
				style:height="{l.box.h}px"
			>
				{#if t?.rate}<span class="text">{t.rate}</span>{/if}
				{#if t?.fail}<span class="fail"><i></i><span class="text">{t.fail}</span></span>{/if}
			</div>
		{/each}
	</div>
</ViewportPortal>

<style>
	.rate-labels {
		position: absolute;
		top: 0;
		left: 0;
		font-size: 10px;
		font-weight: 600;
		pointer-events: none;
	}

	.rate-labels.hidden {
		display: none;
	}

	/* The lines keep a common left edge, and the block is centred in the box,
	   which is a fraction wider than the text after rounding. */
	.rate-label {
		position: absolute;
		top: 0;
		left: 0;
		display: grid;
		grid-template-columns: max-content;
		justify-content: center;
		justify-items: start;
		align-content: start;
		row-gap: var(--row-gap);
		box-sizing: border-box;
		padding: var(--pad-top) var(--pad-x) var(--pad-bottom);
		border: 1px solid color-mix(in srgb, var(--flow-c) 55%, var(--canvas-bg));
		border-radius: 4px;
		background: var(--canvas-bg);
		color: var(--fg);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* One line, from the capitals' top to the baseline: labels.ts sizes the box so. */
	.rate-label > span,
	.text {
		height: var(--cap);
	}

	/* The text sits in its own span: a flex container such as .fail is not trimmed. */
	.text {
		text-box: trim-both cap alphabetic;
	}

	/* A line one cap tall puts the capitals where the font's metrics say; trim.ts measures how far off. */
	@supports not (text-box: trim-both cap alphabetic) {
		.text {
			position: relative;
			top: calc(-1 * var(--trim-shift));
			line-height: 1cap;
		}
	}

	.fail {
		display: flex;
		align-items: center;
		gap: var(--bar-gap);
		color: var(--danger-fg);
	}

	/* A short level bar, as on the lines and in the legend; a thin upright one read as a capital I. */
	.fail i {
		flex: none;
		width: var(--bar);
		height: var(--bar-height);
		border-radius: 1px;
		background: var(--danger);
	}
</style>
