<script lang="ts">
	import type { NodeLine } from '#lib/flow/lines.ts';
	import type { FarmStore } from '#lib/model/types.ts';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import { formatPercent, formatPerMinute } from '../format.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import WindowCaption from '../WindowCaption.svelte';
	import DerivationList from './DerivationList.svelte';
	import LineRows from './LineRows.svelte';

	type Props = {
		store: FarmStore;
		/** The Lines rows: publishes in, fetches out and cache hits, as bundles of drawn lines. */
		rows: readonly NodeLine[];
		onselectderivation: (path: string, via?: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, rows, onselectderivation, onopenlines }: Props = $props();

	const LIMIT = 500;
	const c = $derived(store.cache);
	const recent = new Throttled(
		() => store.frame,
		() => store.drvsForCache(LIMIT)
	);
</script>

{#if !c}
	<p class="p-caption">This scheduler has no binary cache configured.</p>
{:else}
	<section class="p-section">
		<dl class="p-rows">
			<dt>Cache</dt>
			<dd class="mono">{c.url}</dd>
		</dl>
		<WindowCaption minutes={store.totals.windowMinutes} since={store.totals.since} />
		<dl class="p-facts">
			<div>
				<dt>Hit ratio</dt>
				<dd>{formatPercent(c.hitRatio)}</dd>
			</div>
			<div>
				<dt>Hits per minute</dt>
				<dd>{formatPerMinute(c.hitsPerSec * 60)}</dd>
			</div>
			<div>
				<dt>Misses per minute</dt>
				<dd>{formatPerMinute(c.missesPerSec * 60)}</dd>
			</div>
		</dl>
		<p class="p-caption">
			Hits and misses count only the scheduler's own lookups. Clients skip outputs they already
			found in the cache, so the real hit ratio is higher.
		</p>
	</section>

	<LineRows {store} {rows} {onopenlines} />
{/if}

<section class="p-section grow">
	<h3>Recent hits, publishes and fetches</h3>
	<DerivationList
		items={recent.current}
		limit={LIMIT}
		label="Recent cache activity"
		context="cache"
		empty="No cache activity yet."
		onselect={(path) => onselectderivation(path)}
	/>
</section>
