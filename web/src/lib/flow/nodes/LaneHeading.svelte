<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import type { FlowNode } from '../types.ts';

	let { data }: NodeProps<FlowNode> = $props();
</script>

<h2 class="lane">{data.ref}</h2>

<style>
	.lane {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 100%;
		margin: 0;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		white-space: nowrap;
	}
</style>
