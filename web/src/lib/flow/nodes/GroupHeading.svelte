<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { formatCount } from '#lib/ui/format.ts';
	import { poolMembers } from '#lib/ui/panels/pool.ts';
	import { groupBacklog, type Offer } from '../backlog.ts';
	import { getFlowContext } from '../context.ts';
	import { MAX_ROWS } from '../layout.ts';
	import type { FlowNode } from '../types.ts';

	let { data }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();

	const collapsed = $derived(ctx.pools.collapsed(data.ref));
	const count = $derived(data.count ?? 0);
	// A single column of cards has no room for the action; its chevron and the
	// pool panel still toggle it.
	const action = $derived(collapsed ? 'Show cards' : count > MAX_ROWS ? 'Collapse' : '');
	// One queued count for the group, where its cards would each repeat it. A
	// collapsed group's pool card shows its own.
	const members = $derived(poolMembers(ctx.store.topology, data.ref));
	const queued = $derived.by(() => {
		if (collapsed) return null;
		const offers: Offer[] = [];
		for (const a of members) {
			const w = ctx.store.workers.get(a);
			if (w) offers.push(w);
		}
		return groupBacklog(ctx.store.scheduler.systems, offers);
	});
</script>

<!-- A disclosure: expanded shows the group's builders as cards, collapsed as one pool. -->
<h3 class="group">
	<button
		type="button"
		class="toggle"
		aria-expanded={!collapsed}
		data-pool-toggle={data.ref}
		title={collapsed
			? `Show these ${formatCount(count)} builders as cards`
			: 'Collapse these builders into one pool'}
		onclick={() => ctx.pools.set(data.ref, !collapsed)}
	>
		<span class="chevron" class:open={!collapsed}><Icon name="chevron" size={14} /></span>
		<span class="mono">{data.ref}</span>
		<span class="count num">{formatCount(count)} {count === 1 ? 'builder' : 'builders'}</span>
		{#if queued !== null}
			<span
				class="count num queued"
				title="Queued derivations that at least one of these builders can take"
			>
				· {formatCount(queued)} queued</span
			>
		{/if}
		{#if action}<span class="action" aria-hidden="true">{action}</span>{/if}
	</button>
</h3>

<style>
	.group {
		display: flex;
		align-items: center;
		height: 100%;
		margin: 0;
		color: var(--fg);
		font-size: var(--text-xs);
		font-weight: 600;
		white-space: nowrap;
		/* Only the button takes clicks; the rest of the row is map. */
		pointer-events: none;
	}

	/* The whole heading row, and taller than it, so the toggle is easy to hit. */
	.toggle {
		display: flex;
		align-items: baseline;
		gap: 6px;
		width: calc(100% + 10px);
		height: 32px;
		margin: -4px -4px -4px -6px;
		padding: 0 4px 0 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		font-weight: 600;
		line-height: 32px;
		pointer-events: auto;
	}

	/* Like the nodes, no hover while the view moves, as in Flow.svelte. */
	:global(.farm-map.moving) .toggle {
		pointer-events: none;
	}

	/* No hover fill: --fg-muted on it would drop below AA on the map. */
	.toggle:hover .mono,
	.toggle:hover .action {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.toggle:hover .chevron {
		color: var(--fg);
	}

	.chevron {
		align-self: center;
		color: var(--fg-muted);
		transition: transform var(--dur-fast) var(--ease-out);
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	/* The group's name reads before its cards: as large as their titles, without .mono's shrink. */
	.mono {
		font-size: var(--text-sm);
	}

	.count {
		color: var(--fg-muted);
		font-size: var(--text-xs);
		font-weight: 500;
	}

	/* A one-column group's heading may run into the gap beside it, which is wider. */
	.queued {
		flex: none;
	}

	.action {
		margin-left: auto;
		color: var(--fg-muted);
		font-size: var(--text-xs);
		font-weight: 600;
	}
</style>
