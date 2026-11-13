<script lang="ts">
	import { basePath } from '#lib/farm/farm.ts';
	import { page } from '$app/state';
	import type { FarmStore } from '#lib/model/types.ts';
	import { failPercent } from '#lib/flow/labels.ts';
	import { farmFailShare } from '#lib/flow/outliers.ts';
	import { WINDOW_MINUTES, formatCount, windowShort, windowSpoken } from './format.ts';
	import Segmented from './Segmented.svelte';
	import WindowCaption from './WindowCaption.svelte';
	import { logsHref } from './nav.ts';

	type Props = {
		/** What the totals show: the live store, or that store held still while paused. */
		store: FarmStore;
		/**
		 * The live store, for the time window picker, so a click shows the choice
		 * at once, while paused too. The totals catch up on resume.
		 */
		live: FarmStore;
	};
	let { store, live }: Props = $props();

	const t = $derived(store.totals);
	// Before the first snapshot the zeros would be made up.
	const known = $derived(store.meta !== null);
	const n = (v: number) => (known ? formatCount(v) : '–');
	/** The failures of the header window, in the Logs tab. */
	const failuresHref = $derived(
		logsHref(basePath(), page.url, { status: ['failed'], since: t.windowMinutes })
	);
	/** The failed share of finished builds, since a count alone cannot say whether the farm is healthy. */
	const share = $derived(known ? failPercent(farmFailShare(t)) : null);
</script>

<div class="totals" role="group" aria-label="Totals">
	<dl class="now">
		<div title="Waiting for a builder slot, including unplaceable ones">
			<dt>Queued</dt>
			<dd class="num">{n(t.queued)}</dd>
		</div>
		<div title="Assigned to a builder. Includes uploading and fetching inputs.">
			<dt>Assigned</dt>
			<dd class="num">{n(t.running)}</dd>
		</div>
	</dl>
	<span class="divider" aria-hidden="true"></span>
	<dl class="window">
		<div>
			<dt><span class="swatch built" aria-hidden="true"></span>Built</dt>
			<dd class="num">{n(t.built)}</dd>
		</div>
		<div>
			<dt><span class="swatch failed" aria-hidden="true"></span>Failed</dt>
			<dd class="num" class:bad={t.failed > 0}>
				{#if known}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- built from basePath() -->
					<a
						href={failuresHref}
						title="Show these failures in the build list"
						aria-label="{n(t.failed)} failed in the last {windowSpoken(
							t.windowMinutes
						)}, show the list">{n(t.failed)}</a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{:else}
					{n(t.failed)}
				{/if}{#if share}<span
						class="share"
						title="Share of finished builds, built or failed, that failed">{` · ${share}`}</span
					>{/if}
			</dd>
		</div>
		<div title="Cache hits, so no build ran">
			<dt><span class="swatch cached" aria-hidden="true"></span>Cached</dt>
			<dd class="num">{n(t.cached)}</dd>
		</div>
	</dl>
	<div class="picker">
		<Segmented
			label="Time window"
			value={live.totals.windowMinutes}
			onchange={(m: number) => live.setWindowMinutes(m)}
			options={WINDOW_MINUTES.map((m) => ({
				value: m,
				label: windowSpoken(m),
				text: windowShort(m)
			}))}
		/>
		<!-- The selected segment names a full window, so only a window that fills gets a caption. -->
		{#if t.since}
			<span class="caption"><WindowCaption minutes={t.windowMinutes} since={t.since} /></span>
		{/if}
	</div>
</div>

<style>
	.totals {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-width: 0;
	}

	dl {
		display: flex;
		gap: var(--space-4);
		margin: 0;
	}

	dl > div {
		display: flex;
		flex-direction: column;
		min-width: 52px;
	}

	@media (max-width: 1279px) {
		.totals,
		dl {
			gap: var(--space-3);
		}

		dl > div {
			min-width: 44px;
		}

		dd {
			font-size: var(--text-md);
		}
	}

	dt {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--fg-muted);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		white-space: nowrap;
	}

	/* Room for the widest formatted count, such as "1,234" or "12.3k", so nothing shifts. */
	dd {
		min-width: 5.2ch;
		margin: 0;
		white-space: nowrap;
		font-size: var(--text-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
		line-height: 1.2;
	}

	.bad {
		color: var(--danger-fg);
	}

	dd a {
		color: inherit;
		text-decoration: none;
	}

	dd a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.share {
		color: var(--fg-muted);
		font-size: var(--text-xs);
		font-weight: 600;
		letter-spacing: 0;
	}

	.swatch {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.swatch.built {
		background: var(--state-built);
	}

	.swatch.failed {
		background: var(--state-failed);
	}

	.swatch.cached {
		background: var(--state-cached);
	}

	.divider {
		align-self: stretch;
		width: 1px;
		margin: 4px 0;
		background: var(--border-subtle);
	}

	.picker :global(button) {
		min-width: 30px;
	}

	.picker {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.caption {
		font-size: 10px;
		line-height: 1;
	}

	.caption :global(.when) {
		font-size: inherit;
	}
</style>
