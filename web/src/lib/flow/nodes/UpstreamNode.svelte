<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { UPSTREAM_CARD_ROWS } from '#lib/model/types.ts';
	import { formatByteRate, formatCount, hostOf } from '#lib/ui/format.ts';
	import { getFlowContext, nodeButton } from '../context.ts';
	import { UPSTREAM_PORT_Y } from '../layout.ts';
	import type { FlowNode } from '../types.ts';

	let { id }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();

	const u = $derived(ctx.store.upstream);
	const rows = $derived(u?.substituters.slice(0, UPSTREAM_CARD_ROWS) ?? []);
	const more = $derived(u ? Math.max(0, u.substituters.length - UPSTREAM_CARD_ROWS) : 0);
	const NAR_NOTE = 'NAR sizes before compression';
	const unreported = $derived(
		u && u.unreported > 0
			? u.unreported === 1
				? '1 more builder does not report its substituters.'
				: `${formatCount(u.unreported)} more builders do not report their substituters.`
			: undefined
	);
	/** A row's share of what all upstream substituters serve now. */
	const share = (rate: number) => (u && u.narBytesPerSec > 0 ? rate / u.narBytesPerSec : 0);
</script>

<Handle
	type="source"
	position={Position.Left}
	id="out"
	class="farm-handle"
	style="top: {UPSTREAM_PORT_Y}px"
/>
<button type="button" class="farm-node hub upstream" {...nodeButton(ctx, id)}>
	<span class="title">Substituters</span>
	<span class="sub num" title={unreported}>
		{formatCount(u?.substituters.length ?? 0)} on {formatCount(u?.builders ?? 0)}
		{u?.builders === 1 ? 'builder' : 'builders'}
	</span>
	<span class="stat" title={more > 0 ? NAR_NOTE : undefined}>
		<span class="label"><i class="line-key flow-substitute"></i>Substitutions</span>
		<span class="value num">{formatByteRate(u?.narBytesPerSec ?? 0)}</span>
	</span>
	<span class="rows">
		{#each rows as r (r.url)}
			<span class="row-item">
				<span class="line">
					<span class="host mono" title={r.url}>{hostOf(r.url)}</span>
					<span class="rate num">{formatByteRate(r.narBytesPerSec)}</span>
				</span>
				<span class="bar" aria-hidden="true"
					><span style:transform="scaleX({share(r.narBytesPerSec)})"></span></span
				>
			</span>
		{/each}
		{#if u?.farmCache}
			<span class="row-item farm">
				<span class="line">
					<span class="host mono" title={u.farmCache.url}>{hostOf(u.farmCache.url)}</span>
					<span class="rate">farm cache</span>
				</span>
				<span class="where">On the binary cache card</span>
			</span>
		{/if}
	</span>
	<span class="caption">{more > 0 ? `+${formatCount(more)} more in the panel` : NAR_NOTE}</span>
</button>

<style>
	/* The layout gives the card 118 px plus 30 px a row: upstreamHeight. */
	.upstream {
		gap: 0;
	}

	.title {
		height: 19px;
		font-size: var(--text-md);
	}

	.sub {
		height: 17px;
	}

	.stat {
		height: 38px;
		padding-top: 4px;
	}

	.value {
		font-size: var(--text-lg);
	}

	.rows {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--border-subtle);
	}

	.row-item {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
		height: 30px;
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.host {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		font-size: var(--text-2xs);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.rate {
		flex: none;
		font-size: var(--text-2xs);
		font-weight: 600;
	}

	.bar {
		position: relative;
		display: block;
		height: 3px;
		border-radius: 2px;
		background: var(--bg-raised);
		opacity: var(--chrome, 1);
		overflow: hidden;
	}

	.bar > span {
		position: absolute;
		inset: 0;
		display: block;
		transform-origin: left center;
		border-radius: inherit;
		background: var(--flow-c);
		transition: transform var(--dur-slow) var(--ease-out);
	}

	.rows {
		--flow-c: var(--flow-substitute);
	}

	/* The farm cache's traffic shows on its own card. */
	.farm .host,
	.farm .rate,
	.where {
		color: var(--fg-muted);
		font-weight: 500;
	}

	.where {
		font-size: 10px;
	}

	.caption {
		margin-top: auto;
		height: 14px;
	}
</style>
