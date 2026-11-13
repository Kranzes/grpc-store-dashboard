<script lang="ts">
	import { basePath } from '#lib/farm/farm.ts';
	import { page } from '$app/state';
	import { logsHref, overviewHref } from './nav.ts';

	// The two tabs. Links, not ARIA tabs: each has its own URL, so
	// middle-click, Back and "Open in new tab" work.
	const base = $derived(basePath());
	const logs = $derived(page.url.pathname.startsWith(`${base}logs/`));
	const tabs = $derived([
		{ label: 'Overview', href: overviewHref(base, page.url), current: !logs },
		{ label: 'Logs', href: logsHref(base, page.url), current: logs }
	]);
</script>

<nav class="tabs" aria-label="Views">
	{#each tabs as t (t.label)}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built from basePath() -->
		<a href={t.href} aria-current={t.current ? 'page' : undefined} data-tab={t.label.toLowerCase()}
			>{t.label}</a
		>
	{/each}
</nav>

<style>
	.tabs {
		display: inline-flex;
		flex: none;
		align-items: stretch;
		padding: 2px;
		gap: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg-panel);
	}

	a {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 10px;
		border-radius: 6px;
		color: var(--fg-muted);
		font-size: var(--text-xs);
		font-weight: 550;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background var(--dur-fast),
			color var(--dur-fast);
	}

	a:hover {
		color: var(--fg);
	}

	a[aria-current='page'] {
		background: var(--bg-node);
		box-shadow: var(--shadow-sm);
		color: var(--fg);
	}

	a:focus-visible {
		outline-offset: 0;
	}
</style>
