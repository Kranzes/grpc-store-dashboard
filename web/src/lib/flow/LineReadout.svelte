<script lang="ts">
	import type { LineKind } from './kinds.ts';
	import type { ReadoutText } from './labels.ts';
	import type { LineTitle } from './lines.ts';
	import { beside } from '#lib/ui/place.ts';

	type Props = {
		/** The kind of the lines under the pointer, whose color keys the name. */
		kind: LineKind;
		title: LineTitle;
		numbers: ReadoutText;
		/** The pointer, in px from the map's top left. */
		x: number;
		y: number;
		/** The map's size, to keep the readout inside it. */
		width: number;
		height: number;
	};
	let { kind, title, numbers, x, y, width, height }: Props = $props();

	let w = $state(0);
	let h = $state(0);
	// Right of and below the pointer, flipped to stay inside the map.
	const left = $derived(beside(x, w, width, 12));
	const top = $derived(beside(y, h, height, 16, 12));
</script>

<!--
	The panels carry the same numbers; this only follows the pointer. The
	numbers lead and the name follows, muted, after a stroke of the line's
	color, as in the panels' Lines rows.
-->
<div
	class="line-readout"
	aria-hidden="true"
	bind:clientWidth={w}
	bind:clientHeight={h}
	style:transform="translate({left}px, {top}px)"
>
	<span class="numbers num"
		>{numbers.rate}{#if numbers.fail}&nbsp;· <span class="fail-bar"></span>{numbers.fail}{/if}</span
	>
	<span class="title"
		><i class="line-key flow-{kind}"></i>{#each title.parts as p, i (i)}{#if p.mono}<span
					class="mono">{p.text}</span
				>{:else}{p.text}{/if}{/each}</span
	>
</div>

<style>
	.line-readout {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 6;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-width: 360px;
		padding: 6px 9px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-node);
		box-shadow: var(--shadow-md);
		color: var(--fg);
		font-size: 12px;
		line-height: 1.35;
		pointer-events: none;
	}

	.numbers {
		font-weight: 600;
	}

	.title {
		color: var(--fg-muted);
	}
</style>
