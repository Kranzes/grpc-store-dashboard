<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import type { FlowNode } from '../types.ts';

	let { type }: NodeProps<FlowNode> = $props();

	const text: Record<string, [string, string]> = {
		'empty-clients': ['No build clients', 'Nobody is asking the scheduler for builds right now.'],
		'empty-builders': [
			'No builders connected',
			'Queued work waits until a builder connects to the scheduler.'
		],
		'empty-cache': [
			'No cache configured',
			'This scheduler has no binary cache, so there are no cache hits, publishes or fetches.'
		]
	};
	const [title, body] = $derived(text[type] ?? ['', '']);
</script>

<div class="farm-placeholder" role="note">
	<strong>{title}</strong>
	<span>{body}</span>
</div>
