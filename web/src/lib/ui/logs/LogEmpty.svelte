<script lang="ts" module>
	import type { LogProblem } from '#lib/logs/client.svelte.ts';
	import type { DrvPhase } from '#lib/model/types.ts';

	/** The sentence for a build with no log, or a log that stopped. */
	export function problemSentence(p: LogProblem, builder: string, oldBuild: boolean): string {
		switch (p.kind) {
			case 'none':
				return `${builder || 'This farm'} serves no build logs.`;
			case 'not-found':
				return oldBuild
					? `${builder} keeps no log of this build. Cloud builders can come back at the same address without their logs.`
					: `${builder} keeps no log of this build.`;
			case 'left':
				return `${builder} left the farm, and its logs went with it.`;
			case 'rebuilding':
				return `${builder} is building this again, and that build replaced this log.`;
			case 'damaged':
				return `The log file on ${builder} is damaged.`;
			case 'ended-early':
				return 'The log ends early: the build was stopped.';
			case 'denied':
				return 'This farm does not let you read build logs.';
			case 'busy':
				return `${builder} is busy serving logs.`;
			case 'lost':
				return `Lost the connection to ${builder}.`;
			case 'unreadable':
				return `${builder} cannot read this log from the farm's log store or binary cache right now.`;
			case 'no-follow':
				return `${builder} cannot show logs of builds in progress. The log appears when the build ends.`;
			case 'no-route':
				return 'This farm does not serve build logs yet.';
		}
	}

	/** Why a derivation from a link has no log, by its phase, or null when it has one. */
	export function phaseSentence(phase: DrvPhase | null, dependencyFailed: boolean): string | null {
		if (dependencyFailed) return 'This build never ran: one of its inputs failed.';
		if (phase === 'queued' || phase === 'unplaceable') return 'Not assigned to a builder yet.';
		if (phase === 'cached') return 'Nothing was built: the output came from a cache.';
		return null;
	}
</script>

<script lang="ts">
	import Icon from '../Icon.svelte';

	type Props = { sentence: string; children?: import('svelte').Snippet };
	let { sentence, children }: Props = $props();
</script>

<div class="empty" role="status">
	<Icon name="log" size={22} />
	<p>{sentence}</p>
	{@render children?.()}
</div>

<style>
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-8) var(--space-6);
		color: var(--fg-muted);
		text-align: center;
	}

	p {
		max-width: 52ch;
		margin: 0;
		color: var(--fg);
		font-size: var(--text-sm);
	}
</style>
