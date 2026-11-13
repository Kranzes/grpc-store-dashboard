<script module lang="ts">
	import type { DrvPhase } from '#lib/model/types.ts';

	const PHASE_LABEL: Record<DrvPhase, string> = {
		queued: 'Queued',
		unplaceable: 'Unplaceable',
		assigned: 'Assigned',
		built: 'Built',
		failed: 'Failed',
		cancelled: 'Cancelled',
		dropped: 'Dropped',
		cached: 'Cached'
	};
</script>

<script lang="ts">
	type Props = { phase: DrvPhase; compact?: boolean };
	let { phase, compact = false }: Props = $props();
</script>

<span class="chip {phase}" class:compact>
	<span class="dot" aria-hidden="true"></span><span class:trim={!compact}>{PHASE_LABEL[phase]}</span
	>
</span>

<style>
	.chip {
		--c: var(--state-queued);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 22px;
		padding: 0 8px;
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--c) 16%, transparent);
		color: var(--fg);
		font-size: var(--text-2xs);
		font-weight: 600;
		white-space: nowrap;
	}

	.compact {
		height: auto;
		padding: 0;
		background: none;
		color: var(--fg-muted);
		font-weight: 550;
	}

	.dot {
		width: 7px;
		height: 7px;
		flex: none;
		border-radius: 50%;
		background: var(--c);
	}

	.unplaceable {
		--c: var(--state-unplaceable);
	}

	.assigned {
		--c: var(--state-assigned);
	}

	.built {
		--c: var(--state-built);
	}

	.failed {
		--c: var(--state-failed);
	}

	.cancelled,
	.dropped {
		--c: var(--state-cancelled);
	}

	.cached {
		--c: var(--state-cached);
	}
</style>
