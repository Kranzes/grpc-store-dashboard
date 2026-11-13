<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { hasUpstream, parseNodeId, workerNodeId } from '#lib/model/types.ts';
	import { poolDrains } from '#lib/ui/drain.ts';
	import { formatCount } from '#lib/ui/format.ts';
	import { cellsOf, featureSummary, type Cell } from '../cells.ts';
	import { failingBuilders, failingTitle, farmFailShare } from '../outliers.ts';
	import { getFlowContext, nodeButton, repeatClick } from '../context.ts';
	import {
		BUILDER_PORT_OFFSET,
		POOL_GRID,
		POOL_PITCH,
		POOL_PORT_Y,
		SUBSTITUTE_PORT_OFFSET,
		poolCellAt
	} from '../layout.ts';
	import type { FlowNode } from '../types.ts';

	let { id, data }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();
	const upstream = $derived(hasUpstream(ctx.store.topology));

	const p = $derived(ctx.store.pools.get(data.ref));
	const fill = $derived(p && p.slots > 0 ? Math.min(1, p.running / p.slots) : 0);
	// The dot sums up the pool: green while some builder takes work.
	const state = $derived(!p || p.up > 0 ? 'up' : p.draining > 0 ? 'draining' : 'offline');
	const features = $derived(p ? featureSummary(p.features, p.builders) : '');
	// Builders that fail far more than the farm. The cells show load only.
	const farm = $derived(farmFailShare(ctx.store.totals));
	const failing = $derived(failingBuilders(data.cells ?? [], ctx.store.edges, farm));
	const allFeatures = $derived(
		p?.features.map((f) => `${f.name}: ${formatCount(f.builders)}`).join(', ') ?? ''
	);

	// The grid updates in place: a cell keeps its object while its builder's
	// view is unchanged, so only changed cells touch the DOM.
	let lastCells: (Cell | null)[] = [];
	const cells = $derived.by(() => {
		lastCells = cellsOf(data.cells ?? [], ctx.store.workers, lastCells);
		return lastCells;
	});

	const gridH = $derived((data.rows ?? 1) * POOL_PITCH - POOL_GRID.gap);
	// The builder whose panel is open, ringed in the grid.
	const ring = $derived.by(() => {
		const sel = ctx.selected ? parseNodeId(ctx.selected) : null;
		return sel?.kind === 'builder' ? (data.cells ?? []).indexOf(sel.addr) : -1;
	});

	function oncellclick(e: MouseEvent) {
		const addr = (e.target as HTMLElement).closest<HTMLElement>('[data-addr]')?.dataset.addr;
		if (!addr) return;
		// A cell opens its builder; anywhere else on the node opens the pool.
		e.stopPropagation();
		if (!repeatClick(e)) ctx.select(workerNodeId(addr), id);
	}
</script>

<!-- Handles near the top, so lines stay put while the grid grows. -->
<Handle
	type="target"
	position={Position.Left}
	id="in"
	class="farm-handle"
	style="top: {POOL_PORT_Y}px"
/>
<Handle
	type="source"
	position={Position.Right}
	id="publish"
	class="farm-handle"
	style="top: {POOL_PORT_Y - BUILDER_PORT_OFFSET}px"
/>
<Handle
	type="target"
	position={Position.Right}
	id="fetch"
	class="farm-handle"
	style="top: {POOL_PORT_Y + BUILDER_PORT_OFFSET}px"
/>
<!-- Only on a farm with upstream substituters, where some card gets a substitute line. -->
{#if upstream}
	<Handle
		type="target"
		position={Position.Right}
		id="substitute"
		class="farm-handle"
		style="top: {POOL_PORT_Y + SUBSTITUTE_PORT_OFFSET}px"
	/>
{/if}
<!-- Sizes come from POOL_GRID, which the layout uses for the node's height. -->
<button
	type="button"
	class="farm-node pool"
	style:--cell="{POOL_GRID.cell}px"
	style:--gap="{POOL_GRID.gap}px"
	style:--pad="{POOL_GRID.pad}px"
	style:--frame="{POOL_GRID.border}px"
	style:--head="{POOL_GRID.head}px"
	{...nodeButton(ctx, id)}
>
	<span class="visually-hidden">{data.ref} builders, pool of {data.count}:</span>
	<span class="head">
		<span class="row">
			<span class="status-dot {state}" aria-hidden="true"></span>
			<span class="title num">{formatCount(p?.up ?? 0)} online</span>
			{#if p?.draining}<span class="muted num" title={poolDrains(p)}
					>· {formatCount(p.draining)} draining</span
				>{/if}
			{#if p?.offline}<span class="muted num">· {formatCount(p.offline)} offline</span>{/if}
			{#if failing > 0}
				<span
					class="badge fail num"
					title="{failingTitle(farm)} The panel of the pool's assignment line lists each share."
				>
					{formatCount(failing)} failing
				</span>
			{/if}
		</span>
		<span class="meter" aria-hidden="true">
			<span style:transform="scaleX({fill})"></span>
		</span>
		<span
			class="row foot"
			title="Assigned to a builder. Includes uploading and fetching inputs. Draining builders included."
		>
			<span class="num slots">{formatCount(p?.running ?? 0)}/{formatCount(p?.slots ?? 0)}</span>
			<span class="muted">assigned</span>
			<span class="spacer"></span>
			<span
				class="num muted"
				title="Queued derivations whose system and features some builder of this pool offers"
			>
				{formatCount(p?.queuedCanTake ?? 0)} queued
			</span>
		</span>
		<span class="sub" title={allFeatures}>{features}</span>
	</span>
	<!-- Cells are a mouse shortcut to a builder's panel. Keyboard and screen
	     reader users reach every builder through the pool's panel. -->
	<span
		class="cells"
		aria-hidden="true"
		style:grid-template-columns="repeat({POOL_GRID.columns}, var(--cell))"
		style:height="{gridH}px"
		onclick={oncellclick}
	>
		<!-- Unkeyed on purpose: a builder never moves to another cell, so
		     updating cells in place by position is right, and cheapest. -->
		<!-- eslint-disable-next-line svelte/require-each-key -->
		{#each cells as c}
			{#if c}
				<span class="pool-cell l{c.level} {c.state}" data-addr={c.addr} title={c.title}></span>
			{:else}
				<span class="free"></span>
			{/if}
		{/each}
		{#if ring >= 0}
			{@const at = poolCellAt(ring)}
			<span class="ring" style:left="{at.x - 2}px" style:top="{at.y - 2}px"></span>
		{/if}
	</span>
</button>

<style>
	.pool {
		--pad-y: 10px;
		gap: 0;
		padding: var(--pad-y) var(--pad);
		border-width: var(--frame);
	}

	/* The summary lines, then the grid at --head from the node's top. */
	.head {
		display: flex;
		flex: none;
		flex-direction: column;
		gap: 6px;
		height: calc(var(--head) - var(--pad-y) - var(--frame));
	}

	.title {
		font-size: var(--text-xs);
	}

	.foot {
		font-size: var(--text-2xs);
	}

	.slots {
		font-weight: 600;
	}

	.muted {
		color: var(--fg-muted);
	}

	.cells {
		position: relative;
		display: grid;
		opacity: var(--chrome, 1);
		flex: none;
		grid-auto-rows: var(--cell);
		gap: var(--gap);
		align-content: start;
	}

	/* Cells draw as .pool-cell in nodes.css. */
	.cells .pool-cell:hover {
		outline: 1px solid var(--fg);
		outline-offset: 1px;
	}

	.free {
		display: block;
	}

	.ring {
		position: absolute;
		width: calc(var(--cell) + 4px);
		height: calc(var(--cell) + 4px);
		border: 2px solid var(--accent);
		border-radius: 4px;
		pointer-events: none;
	}
</style>
