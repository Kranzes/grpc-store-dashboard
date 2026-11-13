<script lang="ts">
	import type { ConnectionStatus } from '#lib/model/types.ts';
	import { clock, retrySeconds } from './clock.svelte.ts';
	import { formatClock, formatSpan, spokenSpan } from './format.ts';
	import Spoken from './Spoken.svelte';

	type Props = {
		status: ConnectionStatus;
		/** When the user paused the dashboard, or null while it is live. */
		pausedSince?: number | null;
		/** Clicking the pill while paused resumes. */
		onresume?: () => void;
	};
	let { status, pausedSince = null, onresume }: Props = $props();

	const tone = $derived(
		status.kind === 'live'
			? 'ok'
			: status.kind === 'syncing' || status.kind === 'connecting'
				? 'busy'
				: status.kind === 'retrying'
					? 'warn'
					: status.kind === 'stopped'
						? 'off'
						: 'error'
	);

	const seconds = $derived(retrySeconds(status));

	const text = $derived.by(() => {
		switch (status.kind) {
			case 'connecting':
				return status.attempt > 1 ? `Connecting, attempt ${status.attempt}` : 'Connecting';
			case 'syncing':
				return 'Syncing';
			case 'live':
				return 'Live';
			case 'retrying':
				return seconds > 0 ? `Reconnecting in ${seconds}s` : 'Reconnecting';
			case 'signed-out':
				return 'Signed out';
			case 'denied':
				return 'No access';
			case 'stopped':
				return 'Disconnected';
		}
	});

	const hint = $derived.by(() => {
		switch (status.kind) {
			case 'live':
				return `Streaming since ${formatClock(status.sinceMs)}`;
			case 'syncing':
				return 'Receiving the current state of the farm';
			case 'retrying':
				return `Attempt ${status.attempt}. ${status.error}`;
			case 'signed-out':
				return 'Reload the page to sign in again';
			case 'denied':
				return status.error;
			default:
				return undefined;
		}
	});

	// Announce changes of kind only, not every countdown tick.
	const announce = $derived(status.kind === 'retrying' ? 'Lost, reconnecting' : text);

	const paused = $derived(pausedSince !== null);
	// Announced once when the pause begins and once when it ends, never the
	// seconds. Nothing on load.
	let resumed = $state(false);
	$effect.pre(() => {
		if (paused) resumed = true;
	});
	const pauseNews = $derived(paused ? 'Paused' : resumed ? 'Live again' : '');
</script>

<span class="status">
	{#if pausedSince !== null}
		<button
			type="button"
			class="pill paused"
			aria-label="Paused. Resume"
			title="Paused at {formatClock(pausedSince)}. Click or press P to resume."
			onclick={onresume}
		>
			<span class="pause-mark" aria-hidden="true"></span>
			<span class="num trim">Paused · {formatSpan(clock.wall - pausedSince)}</span>
		</button>
	{:else}
		<span class="pill {tone}" title={hint}>
			<span class="dot" aria-hidden="true"></span>
			<span class="num trim"
				>{#if status.kind === 'retrying' && seconds > 0}<Spoken
						{text}
						words="Reconnecting in {spokenSpan(seconds * 1000)}"
					/>{:else}{text}{/if}</span
			>
		</span>
	{/if}
	<span class="visually-hidden" aria-live="polite">Connection: {announce}</span>
	<span class="visually-hidden" aria-live="polite">{pauseNews}</span>
</span>

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 26px;
		padding: 0 10px 0 9px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-full);
		background: var(--bg-panel);
		color: var(--fg);
		font-size: var(--text-xs);
		font-weight: 550;
		white-space: nowrap;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--fg-faint);
	}

	.ok .dot {
		background: var(--conn-ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--conn-ok) 22%, transparent);
	}

	.busy .dot {
		background: var(--accent);
		animation: pulse 1.4s ease-in-out infinite;
	}

	.warn {
		border-color: color-mix(in srgb, var(--conn-warn) 45%, var(--border-subtle));
		background: var(--warn-soft);
	}

	.warn .dot {
		background: var(--conn-warn);
		animation: pulse 1.4s ease-in-out infinite;
	}

	.error {
		border-color: color-mix(in srgb, var(--conn-error) 40%, var(--border-subtle));
		background: var(--danger-soft);
	}

	.error .dot {
		background: var(--conn-error);
	}

	button.pill {
		cursor: pointer;
	}

	.paused {
		border-color: color-mix(in srgb, var(--conn-paused) 45%, var(--border-subtle));
		background: var(--paused-soft);
	}

	.paused:hover {
		border-color: var(--paused-fg);
	}

	/* A steady pause sign where the dot sits: two bars, no pulse. */
	.pause-mark {
		width: 8px;
		height: 9px;
		border-inline: 3px solid var(--paused-fg);
	}

	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot {
			animation: none !important;
		}
	}
</style>
