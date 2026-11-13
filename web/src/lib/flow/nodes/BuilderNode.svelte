<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { builderState, hasUpstream, loadOf, poolOf } from '#lib/model/types.ts';
	import { drainBadge, drainTitle } from '#lib/ui/drain.ts';
	import { formatBytes, formatShort, spokenShort } from '#lib/ui/format.ts';
	import { builderFeatures } from '../cells.ts';
	import { getFlowContext, nodeButton } from '../context.ts';
	import { BUILDER_PORT_OFFSET, SUBSTITUTE_PORT_OFFSET } from '../layout.ts';
	import { lineId } from '../kinds.ts';
	import FailBadge from './FailBadge.svelte';
	import { clock } from '#lib/ui/clock.svelte.ts';
	import type { FlowNode } from '../types.ts';

	let { id, data }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();
	const upstream = $derived(hasUpstream(ctx.store.topology));

	const w = $derived(ctx.store.workers.get(data.ref));
	const state = $derived(builderState(w));
	const fill = $derived(loadOf(w));
	/** How long it has been offline, ms. Only offline cards read the clock. */
	const gone = $derived(w?.goneAt != null ? Math.max(0, clock.now - w.goneAt) : null);
	const native = $derived(w?.systems[0] ?? '');
	/** Systems besides the native one, which the heading names. */
	const extra = $derived(w ? w.systems.length - 1 : 0);
	// Each array keeps its identity while unchanged, so the list below is
	// worked out again only when a feature list changes.
	const ownFeatures = $derived(w?.features);
	const poolFeatures = $derived(ctx.store.pools.get(poolOf(native))?.features);
	// The rarest first, so a cut line keeps what tells this builder apart.
	const features = $derived(
		ownFeatures ? builderFeatures(ownFeatures, poolFeatures).join(', ') : ''
	);
	// Free disk while it is why the builder drains. Offline cards show none.
	const lowDisk = $derived(
		state === 'draining' && w?.drainReason === 'low-disk' && w.diskFree !== null
			? `${formatBytes(w.diskFree)} free`
			: null
	);
</script>

<Handle type="target" position={Position.Left} id="in" class="farm-handle" />
<Handle
	type="source"
	position={Position.Right}
	id="publish"
	class="farm-handle"
	style="top: calc(50% - {BUILDER_PORT_OFFSET}px)"
/>
<Handle
	type="target"
	position={Position.Right}
	id="fetch"
	class="farm-handle"
	style="top: calc(50% + {BUILDER_PORT_OFFSET}px)"
/>
<!-- Only on a farm with upstream substituters, where some card gets a substitute line. -->
{#if upstream}
	<Handle
		type="target"
		position={Position.Right}
		id="substitute"
		class="farm-handle"
		style="top: calc(50% + {SUBSTITUTE_PORT_OFFSET}px)"
	/>
{/if}
<button type="button" class="farm-node builder {state}" {...nodeButton(ctx, id)}>
	<span class="row">
		<span class="status-dot {state}" aria-hidden="true"></span>
		<span class="title mono" title={data.ref}>{data.ref}</span>
		{#if state === 'draining' && w}
			<span class="badge" title={drainTitle(w)}>{drainBadge(w)}</span>
		{:else if state === 'offline'}
			<!-- Since when: a reboot a moment ago, or a builder about to drop off the map.
			     "Offline · 4m" would cut the address, so the age is in the tooltip and the name. -->
			<span class="badge" title={gone !== null ? `Offline for ${formatShort(gone)}` : undefined}
				>Offline{#if gone !== null}<span class="visually-hidden">
						for {spokenShort(gone)}</span
					>{/if}</span
			>
		{/if}
		<!-- Beside Draining, Low disk, Stopping or Offline, only the share fits with the address. -->
		<FailBadge line={lineId('assign', data.ref)} short={state !== 'up'} />
	</span>
	<!-- The group's heading names the native system, so the line starts with the features. -->
	<span class="sub" title="{w?.systems.join(', ')}{features ? ` · ${features}` : ''}">
		{features || (extra > 0 ? '' : 'No extra features')}{#if extra > 0}<span class="extra"
				>{`${features ? ' · ' : ''}+${extra} ${extra === 1 ? 'system' : 'systems'}`}</span
			>{/if}
	</span>
	<span class="meter" aria-hidden="true">
		<span style:transform="scaleX({fill})"></span>
	</span>
	<span class="row foot" title="Assigned to a builder. Includes uploading and fetching inputs.">
		<span class="num slots">{w?.running ?? 0}/{w?.maxJobs ?? 0}</span>
		<span class="muted">assigned</span>
		{#if lowDisk}
			<span class="spacer"></span>
			<span class="num disk">{lowDisk}</span>
		{/if}
	</span>
</button>

<style>
	.builder {
		gap: 5px;
		padding: 9px 12px 10px;
	}

	.title {
		font-size: var(--text-xs);
		letter-spacing: -0.01em;
	}

	.extra {
		color: var(--fg-muted);
	}

	.foot {
		font-size: var(--text-2xs);
	}

	.slots {
		font-weight: 600;
		min-width: 3.4em;
	}

	.muted {
		color: var(--fg-muted);
	}

	/* Thinner than the scheduler's and the pools' bars: on a saturated farm every card is full. */
	.meter {
		height: 3px;
	}

	/* 4.76:1 on --bg-node in Latte. */
	.disk {
		color: var(--warn-fg);
		font-weight: 600;
	}

	.draining .meter {
		--fill: var(--state-unplaceable);
	}

	.builder.offline {
		border-style: dashed;
		background: var(--canvas-bg);
		box-shadow: none;
	}

	/* The border, dot and badge say "offline"; fading the text would fail AA. */
	.offline .meter {
		opacity: calc(0.6 * var(--chrome, 1));
	}
</style>
