<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { OTHER_CLIENTS } from '#lib/model/types.ts';
	import { formatCount, formatPerMinute } from '#lib/ui/format.ts';
	import { getFlowContext, nodeButton } from '../context.ts';
	import { lineId } from '../kinds.ts';
	import FailBadge from './FailBadge.svelte';
	import type { FlowNode } from '../types.ts';

	let { id, data }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();

	const g = $derived(ctx.store.clientGroups.get(data.ref));
	const label = $derived(g?.label ?? (data.ref === OTHER_CLIENTS ? 'other clients' : data.ref));
	const other = $derived(data.ref === OTHER_CLIENTS);
</script>

<Handle type="source" position={Position.Right} id="out" class="farm-handle" />
<button type="button" class="farm-node clients" class:other {...nodeButton(ctx, id)}>
	<span class="row">
		<span class="title" class:mono={!other} title={label}>{label}</span>
		<FailBadge line={lineId('request', data.ref)} />
	</span>
	<span class="row nums">
		<span class="num"><strong>{formatCount(g?.clients ?? 0)}</strong> streams</span>
		<span class="sep" aria-hidden="true">·</span>
		<span class="num"><strong>{formatCount(g?.waiting ?? 0)}</strong> waiting</span>
	</span>
	<span
		class="row rate"
		title="Build requests from these clients, per minute: derivations they ask for, including cache hits and ones another client already asked for"
	>
		<span class="num"
			><strong>{formatPerMinute((g?.wantsPerSec ?? 0) * 60)}</strong> requests/min</span
		>
	</span>
</button>

<style>
	.clients {
		gap: 4px;
		justify-content: center;
	}

	.title {
		font-size: var(--text-xs);
	}

	.other .title {
		color: var(--fg-muted);
		font-style: italic;
		font-weight: 500;
	}

	.nums,
	.rate {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	strong {
		color: var(--fg);
		font-weight: 600;
	}

	.sep {
		color: var(--fg-faint);
	}
</style>
