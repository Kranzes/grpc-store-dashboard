<script lang="ts">
	import type { NodeLine } from '#lib/flow/lines.ts';
	import type { EdgeView, FarmStore } from '#lib/model/types.ts';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import { clock } from '../clock.svelte.ts';
	import { windowCaption } from '../format.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import WindowCaption from '../WindowCaption.svelte';
	import { lineRow } from './line.ts';

	// A node panel's Lines section: one row per line or bundle at the node,
	// each opening the line panel.
	type Props = {
		store: FarmStore;
		rows: readonly NodeLine[];
		/** A line the store has no line for, such as a client group folded into other clients. */
		fallback?: (edgeId: string) => EdgeView | undefined;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, rows, fallback, onopenlines }: Props = $props();

	const edges = new Throttled(
		() => store.edges,
		() => store.edges
	);
	const shown = $derived(
		rows.map((r) => ({
			row: r,
			...lineRow(r.flow, r.edgeIds, (id) => edges.current.get(id) ?? fallback?.(id))
		}))
	);
	// Line counts start when the page went live, not where the header totals start.
	const since = $derived(store.linesSince);
	const minutes = $derived(store.totals.windowMinutes);
	const spokenWindow = $derived(windowCaption(minutes, since, since ? clock.now : 0).phrase);
	// Only the failure shares cover the window; rates are now.
	const windowed = $derived(shown.some((s) => s.fail));
</script>

{#if shown.length > 0}
	<section class="p-section">
		<div class="p-head">
			<h3>Lines</h3>
			{#if windowed}<WindowCaption {minutes} {since} />{/if}
		</div>
		<ul class="rows">
			{#each shown as s (s.row.flow)}
				<li>
					<button
						type="button"
						class="row"
						aria-label={[s.row.name, s.spoken, s.fail && `${s.fail} failed ${spokenWindow}`]
							.filter(Boolean)
							.join(', ')}
						onclick={() => onopenlines(s.row.flow, s.row.edgeIds)}
					>
						<span class="swatch flow-{s.row.flow}" aria-hidden="true"></span>
						<span class="name">{s.row.label}</span>
						<span class="value num"
							>{s.rate}{#if s.fail}&nbsp;· <span class="fail-bar" aria-hidden="true"></span>{s.fail} failed{/if}</span
						>
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.rows {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg-node);
		list-style: none;
		overflow: hidden;
	}

	li + li {
		border-top: 1px solid var(--border-subtle);
	}

	.row {
		display: grid;
		grid-template-columns: 16px 1fr;
		align-items: center;
		gap: 2px 10px;
		width: 100%;
		padding: 7px 12px;
		border: 0;
		background: transparent;
		font-size: var(--text-xs);
		text-align: left;
	}

	/* Text stays --fg, because --danger-fg on the hover fill is below AA in Latte. */
	.row:hover {
		background: var(--bg-hover);
	}

	.row:focus-visible {
		outline-offset: -2px;
	}

	.swatch {
		width: 16px;
		height: 3px;
		border-radius: 2px;
		background: var(--flow-c);
	}

	.name {
		font-weight: 550;
	}

	.value {
		grid-column: 2;
		color: var(--fg);
		font-size: var(--text-2xs);
	}
</style>
