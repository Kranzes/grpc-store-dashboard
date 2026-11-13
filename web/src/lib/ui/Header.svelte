<script lang="ts">
	import type { Farm, FarmSession, FarmStore } from '#lib/model/types.ts';
	import Icon from './Icon.svelte';
	import Mark from './Mark.svelte';
	import StatusPill from './StatusPill.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import Totals from './Totals.svelte';
	import ViewTabs from './ViewTabs.svelte';

	type Props = {
		farmName: string;
		/** The farm that serves this page. null in the demo. */
		farm: Farm | null;
		session: FarmSession;
		/** What the totals show: the session's store, or that store held still while paused. */
		shown: FarmStore;
		/** When the user paused the dashboard, or null while it is live. */
		pausedSince: number | null;
		onresume: () => void;
		onleavedemo: () => void;
	};
	let { farmName, farm, session, shown, pausedSince, onresume, onleavedemo }: Props = $props();

	// Leave the demo, or follow the auth proxy's sign-out link when the farm
	// names one. A network that watches without signing in has nothing to
	// leave, and neither has a page that is signed out. The denied card has
	// its own Sign out, so the header leaves it to the card.
	const signOutUrl = $derived.by(() => {
		if (session.mode === 'mock' || farm?.auth !== 'proxy' || !farm.signOutUrl) return null;
		const kind = session.store.status.kind;
		return kind === 'signed-out' || kind === 'denied' ? null : farm.signOutUrl;
	});
</script>

<header class="header">
	<div class="farm">
		<Mark />
		<div class="name">
			<h1
				title={session.mode === 'mock'
					? 'A simulated farm running in this browser tab'
					: location.host}
			>
				{farmName}
			</h1>
		</div>
		<StatusPill status={session.store.status} {pausedSince} {onresume} />
		<ViewTabs />
	</div>

	<Totals store={shown} live={session.store} />

	<div class="actions">
		<ThemeToggle />
		{#if session.mode === 'mock'}
			<button
				type="button"
				class="leave"
				onclick={onleavedemo}
				aria-label="Leave demo"
				title="Leave demo"
			>
				<Icon name="logout" size={15} />
				<span aria-hidden="true">Leave demo</span>
			</button>
		{:else if signOutUrl}
			<!-- eslint-disable svelte/no-navigation-without-resolve -- the farm's sign-out -->
			<a
				class="leave"
				href={signOutUrl}
				data-sveltekit-reload
				aria-label="Sign out"
				title="Sign out"
			>
				<Icon name="logout" size={15} />
				<span aria-hidden="true">Sign out</span>
			</a>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		{/if}
	</div>
</header>

<style>
	.header {
		display: flex;
		align-items: center;
		gap: var(--space-5);
		height: var(--header-h);
		padding: 0 var(--space-4);
		border-bottom: 1px solid var(--border);
		background: var(--bg);
	}

	/* Both sides grow alike so the totals stay centered; the farm name shrinks first. */
	.farm {
		display: flex;
		flex: 1 1 0;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	.name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	h1 {
		overflow: hidden;
		font-size: var(--text-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.actions {
		display: flex;
		flex: 1 1 0;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
	}

	.leave {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--fg-muted);
		font-size: var(--text-xs);
		font-weight: 550;
		text-decoration: none;
		white-space: nowrap;
	}

	.leave:hover {
		border-color: var(--border);
		background: var(--bg-panel);
		color: var(--fg);
	}

	/* The tabs take the room the farm name had. Below this the totals stop
	   being centered, and the leave button shows only its icon. */
	@media (max-width: 1439px) {
		/* Give the spare room to the farm name instead of centering the totals. */
		.actions {
			flex: none;
		}

		.leave span {
			display: none;
		}

		.leave {
			width: 30px;
			padding: 0;
			justify-content: center;
		}
	}

	@media (max-width: 1279px) {
		.header {
			gap: var(--space-3);
		}
	}
</style>
