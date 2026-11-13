<script lang="ts">
	import type { AppPhase } from '#lib/model/types.ts';
	import Icon from './Icon.svelte';
	import Mark from './Mark.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	// What the page shows before a session: while dashboard.json loads, when
	// no farm serves this copy, and when dashboard.json could not be read.
	type Props = {
		phase: Extract<AppPhase, { kind: 'loading' | 'no-farm' | 'error' }>;
		ondemo: () => void;
		/** Read dashboard.json again. */
		onretry: () => void;
	};
	let { phase, ondemo, onretry }: Props = $props();

	// A spinner only when loading takes a while, so a fast farm shows no flash.
	let slow = $state(false);
	$effect(() => {
		if (phase.kind !== 'loading') return;
		slow = false;
		const t = setTimeout(() => (slow = true), 300);
		return () => clearTimeout(t);
	});
</script>

<div class="page">
	<div class="top">
		<span class="brand"><Mark size={20} /> nix-grpc-store dashboard</span>
		<ThemeToggle />
	</div>

	<main class="center">
		{#if phase.kind === 'loading'}
			{#if slow}
				<div class="loading" role="status">
					<span class="spinner" aria-hidden="true"></span>
					<span class="visually-hidden">Loading the farm</span>
				</div>
			{/if}
		{:else}
			<section class="card" aria-labelledby="landing-title">
				<h1 id="landing-title">Watch your build farm, live</h1>
				<p class="lede">
					See builds arrive, get scheduled onto builders and flow through the cache.
				</p>

				{#if phase.kind === 'error'}
					<div class="error" role="alert">
						<Icon name="alert" size={18} />
						<div>
							<strong>{phase.error.title}</strong>
							<p>{phase.error.detail}</p>
						</div>
					</div>
					<div class="retry">
						<button type="button" class="btn-primary" onclick={onretry}>Try again</button>
					</div>
				{:else}
					<p class="note">
						This copy of the dashboard has no farm behind it. A farm serves it from its own Envoy (<code
							>docs/operators.md</code
						>).
					</p>
				{/if}

				<div class="divider"><span>or</span></div>

				<div class="demo">
					<button type="button" class="secondary" onclick={ondemo}>Try the demo</button>
					<p>A simulated farm running in this tab. Nothing is sent anywhere.</p>
				</div>
			</section>
		{/if}
	</main>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		background:
			radial-gradient(
				ellipse 80% 50% at 50% -10%,
				color-mix(in srgb, var(--accent) 9%, transparent),
				transparent
			),
			var(--bg);
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-6);
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--fg-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.center {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-6);
		padding: var(--space-8) var(--space-4) var(--space-9);
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 200px;
	}

	.loading .spinner {
		width: 28px;
		height: 28px;
		border-width: 2.5px;
		animation-duration: 0.9s;
	}

	.card {
		width: min(520px, 100%);
		padding: var(--space-7);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		background: var(--bg);
		box-shadow: var(--shadow-lg);
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: var(--leading-tight);
	}

	.lede {
		margin-top: var(--space-3);
		color: var(--fg-muted);
		font-size: var(--text-md);
	}

	.note {
		margin-top: var(--space-5);
		color: var(--fg);
		font-size: var(--text-sm);
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		height: 40px;
		padding: 0 18px;
		border-radius: var(--radius);
		font-size: var(--text-md);
		font-weight: 600;
		white-space: nowrap;
		transition:
			background var(--dur-fast),
			border-color var(--dur-fast);
	}

	.secondary {
		border: 1px solid var(--border);
		background: var(--bg-panel);
		color: var(--fg);
	}

	.secondary:hover:not(:disabled) {
		border-color: var(--border-strong);
		background: var(--bg-raised);
	}

	.error {
		display: flex;
		gap: var(--space-3);
		margin-top: var(--space-5);
		padding: var(--space-3) var(--space-4);
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius);
		background: var(--danger-soft);
		color: var(--fg);
		font-size: var(--text-sm);
	}

	/* Only the icon is red, because --danger-fg text on --danger-soft is 4.16:1 in Latte. */
	.error :global(.icon) {
		margin-top: 1px;
		color: var(--danger-fg);
	}

	.error strong {
		display: block;
		font-weight: 650;
	}

	.error p {
		margin-top: 2px;
		color: var(--fg);
		overflow-wrap: anywhere;
	}

	.retry {
		margin-top: var(--space-4);
	}

	.divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: var(--space-6) 0 var(--space-5);
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-subtle);
	}

	.demo {
		display: flex;
		align-items: center;
		gap: var(--space-4);
	}

	.demo p {
		color: var(--fg-muted);
		font-size: var(--text-sm);
	}

	code {
		padding: 1px 4px;
		border-radius: var(--radius-sm);
		background: var(--bg-raised);
		color: var(--fg);
		font-size: 0.86em;
	}

	@media (prefers-reduced-motion: reduce) {
		.loading .spinner {
			animation-duration: 3s;
		}
	}
</style>
