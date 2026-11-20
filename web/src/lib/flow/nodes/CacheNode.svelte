<script lang="ts">
	import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/svelte';
	import { formatByteRate, formatPercent, formatPerMinute, hostOf } from '#lib/ui/format.ts';
	import WindowCaption from '#lib/ui/WindowCaption.svelte';
	import { getFlowContext, nodeButton } from '../context.ts';
	import type { FlowNode } from '../types.ts';

	let { id, data }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();

	// The ports move when the builder lane's buses do. Svelte Flow measures
	// handles only when a node resizes, so tell it.
	const updateNodeInternals = useUpdateNodeInternals();
	$effect(() => {
		void data.ports?.publish;
		void data.ports?.fetch;
		updateNodeInternals(id);
	});

	const c = $derived(ctx.store.cache);
	const host = $derived(c?.url ? hostOf(c.url) : 'Binary cache');
	// Null while no client reports its graph: then only the line below it shows.
	const cached = $derived(c?.cachedRatio ?? null);
	// Measured while a builder lists the cache as a substituter.
	const estimated = $derived(c?.fetchEstimated ?? true);
	// The shares and the rates come from the header totals: one window for the card.
	const totals = $derived(ctx.store.totals);
</script>

<Handle
	type="target"
	position={Position.Left}
	id="publish"
	class="farm-handle"
	style="top: {data.ports?.publish ?? 0}px"
/>
<Handle
	type="source"
	position={Position.Left}
	id="fetch"
	class="farm-handle"
	style="top: {data.ports?.fetch ?? 0}px"
/>
<Handle type="target" position={Position.Top} id="top" class="farm-handle" />
<button type="button" class="farm-node hub cache" {...nodeButton(ctx, id)}>
	<span class="row">
		<span class="title">Binary cache</span>
	</span>
	<span class="sub mono" title={c?.url}>{host}</span>

	<!-- One share, so a thin meter under its number, like the scheduler's Slots bar. -->
	<span class="stat ratio">
		{#if cached !== null}
			<span
				class="headline"
				title="Of the derivations clients needed, the share already in the cache. Clients do not request those."
			>
				<span class="label">Cached</span>
				<span class="share"
					><span class="value num big">{formatPercent(cached)}</span>
					<span class="of">of requested derivations</span></span
				>
				<span class="meter" aria-hidden="true"
					><span style:transform="scaleX({cached})"></span></span
				>
			</span>
		{/if}
		<WindowCaption minutes={totals.windowMinutes} since={totals.since} />
	</span>

	<span
		class="found"
		title="Requests the cache had by the time the scheduler got them. Clients request only what they found missing, so these are mostly races won between clients."
	>
		<span class="label">Found cached when scheduled</span>
		<span class="num">{formatPercent(c?.hitRatio ?? null)}</span>
	</span>

	<span class="grid">
		<span class="stat">
			<span class="label">Hits</span>
			<span class="value num small">{formatPerMinute(c?.hitsPerMin ?? 0)}/min</span>
		</span>
		<span class="stat">
			<span class="label">Misses</span>
			<span class="value num small">{formatPerMinute(c?.missesPerMin ?? 0)}/min</span>
		</span>
	</span>
	<span class="caption">Scheduler lookups only</span>

	<span class="grid io">
		<span class="stat">
			<span class="label"><i class="line-key flow-publish"></i>Publish</span>
			<span class="value num small">{formatByteRate(c?.publishedBytesPerSec ?? 0)}</span>
		</span>
		<span
			class="stat"
			title={estimated
				? 'No builder lists this cache as a substituter, so this counts inputs another builder here built. It is estimated from which builder last built each input, and it can count inputs a builder already has.'
				: 'What builders report taking from this cache, in NAR bytes before compression.'}
		>
			<span class="label"
				><i class="line-key flow-fetch"></i>{estimated
					? 'Fetch from peers (estimated)'
					: 'Fetch'}</span
			>
			<span class="value num small">{formatByteRate(c?.fetchedBytesPerSec ?? 0)}</span>
		</span>
	</span>
</button>

<style>
	.cache {
		gap: 6px;
	}

	.title {
		font-size: var(--text-md);
	}

	.ratio {
		padding: 6px 0 2px;
	}

	.headline {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.share {
		display: flex;
		align-items: baseline;
		gap: 6px;
		white-space: nowrap;
	}

	.of {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	.found {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-size: var(--text-xs);
	}

	.found .label {
		color: var(--fg-muted);
	}

	/* Latte teal is 2.43:1 on the track; mixed with text it reaches 3.14:1. */
	.meter {
		--fill: light-dark(
			color-mix(in oklab, var(--state-cached) 65%, var(--fg)),
			var(--state-cached)
		);
		margin: 4px 0 3px;
	}

	.big {
		font-size: var(--text-2xl);
		font-weight: 650;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}

	.io {
		padding-top: 6px;
		border-top: 1px solid var(--border-subtle);
	}

	/* A label on two lines keeps both values on one baseline. */
	.io .stat {
		justify-content: space-between;
	}

	.small {
		font-size: var(--text-sm);
	}
</style>
