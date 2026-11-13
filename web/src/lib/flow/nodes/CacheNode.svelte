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
	const ratio = $derived(c?.hitRatio ?? null);
	// The ratio comes from the header totals, so it covers the same window.
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
		<span class="label">Hit ratio</span>
		<span class="value num big">{formatPercent(ratio)}</span>
		<span class="meter" aria-hidden="true"
			><span style:transform="scaleX({ratio ?? 0})"></span></span
		>
		<WindowCaption minutes={totals.windowMinutes} since={totals.since} />
	</span>

	<span class="grid">
		<span class="stat">
			<span class="label">Hits</span>
			<span class="value num small">{formatPerMinute((c?.hitsPerSec ?? 0) * 60)}/min</span>
		</span>
		<span class="stat">
			<span class="label">Misses</span>
			<span class="value num small">{formatPerMinute((c?.missesPerSec ?? 0) * 60)}/min</span>
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
			title="Estimated from which builder last built each input. It can count inputs a builder already has, and it misses inputs nobody here built."
		>
			<span class="label"><i class="line-key flow-fetch"></i>Fetch (estimated)</span>
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

	.small {
		font-size: var(--text-sm);
	}
</style>
