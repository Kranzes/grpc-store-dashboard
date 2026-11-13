<script lang="ts">
	import type { NodeLine } from '#lib/flow/lines.ts';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import { lineId } from '#lib/flow/kinds.ts';
	import type { FarmStore, SubstituterView } from '#lib/model/types.ts';
	import { formatByteRate, formatBytes, formatCount, hostOf, plural } from '../format.ts';
	import { Hold } from '../hold.svelte.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import VirtualList from '../VirtualList.svelte';
	import WindowCaption from '../WindowCaption.svelte';
	import LineRows from './LineRows.svelte';

	type Props = {
		store: FarmStore;
		/** The Lines row: substitutions to builders, as a bundle of drawn lines. */
		rows: readonly NodeLine[];
		onopenbuilder: (addr: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, rows, onopenbuilder, onopenlines }: Props = $props();

	const u = $derived(store.upstream);
	const minutes = $derived(store.totals.windowMinutes);

	/** "on 12 builders · 9.8 MiB/s · 6.3 GiB, 2,140 paths" */
	function summary(s: SubstituterView): string {
		return [
			`on ${plural(s.builders, 'builder', 'builders')}`,
			formatByteRate(s.narBytesPerSec),
			`${formatBytes(s.narBytes)}, ${plural(s.paths, 'path', 'paths')}`
		].join(' · ');
	}

	/** "2.2 GiB on the wire · 3 failed substitutions", or null with neither. */
	function wire(s: SubstituterView): string | null {
		const parts: string[] = [];
		if (s.downloadBytes > 0) parts.push(`${formatBytes(s.downloadBytes)} on the wire`);
		if (s.failures > 0)
			parts.push(plural(s.failures, 'failed substitution', 'failed substitutions'));
		return parts.length ? parts.join(' · ') : null;
	}

	// Every builder with a substitute line, pooled ones included, busiest
	// first, at most twice a second and held still while pointed at.
	const live = new Throttled(
		() => store.frame,
		() =>
			store.topology.upstreamWorkers
				.map((addr) => ({
					addr,
					rate: store.edges.get(lineId('substitute', addr))?.rate ?? 0,
					w: store.workers.get(addr)
				}))
				.sort((a, b) => b.rate - a.rate || (a.addr < b.addr ? -1 : 1))
	);
	const hold = new Hold(() => live.current);
	const builders = $derived(hold.current);
</script>

{#snippet sub(s: SubstituterView)}
	{@const w = wire(s)}
	<li>
		<span class="url mono">{s.url}</span>
		<span class="detail num">{summary(s)}</span>
		{#if w}<span class="detail num">{w}</span>{/if}
	</li>
{/snippet}

{#if !u}
	<p class="p-caption">No builder lists a substituter.</p>
{:else}
	<section class="p-section">
		<p class="p-caption">Where builders get inputs that neither they nor the farm's cache have.</p>
		<WindowCaption {minutes} since={u.since} />
		<dl class="p-facts">
			<div>
				<dt>Now</dt>
				<dd class="small">{formatByteRate(u.narBytesPerSec)}</dd>
			</div>
			<div>
				<dt>Substituted</dt>
				<dd class="small">{formatBytes(u.narBytes)}</dd>
			</div>
			<div>
				<dt title="Builders taking bytes from a substituter now">Substituting</dt>
				<dd class="small">
					{formatCount(u.downloading)}<span class="p-of">{` of ${formatCount(u.builders)}`}</span>
				</dd>
			</div>
		</dl>
		{#if u.unreported > 0}
			<p class="p-caption">
				{u.unreported === 1
					? '1 builder does not report its substituters.'
					: `${formatCount(u.unreported)} builders do not report their substituters.`}
			</p>
		{/if}
	</section>

	<LineRows {store} {rows} {onopenlines} />

	<section class="p-section">
		<div class="p-head">
			<h3>Substituters</h3>
			<WindowCaption {minutes} since={u.since} />
		</div>
		<ul class="subs">
			{#each u.substituters as s (s.url)}{@render sub(s)}{/each}
		</ul>
	</section>

	{#if u.farmCache}
		<section class="p-section">
			<h3>Farm cache</h3>
			<ul class="subs">{@render sub(u.farmCache)}</ul>
			<p class="p-caption">
				Builders measure these bytes. The fetch lines and the binary cache card estimate the same
				traffic.
			</p>
		</section>
	{/if}

	<section class="p-section">
		<p class="p-caption">
			Sizes are NAR sizes before compression. "On the wire" counts the bytes builders received, for
			http and https substituters only. A failed substitution stopped before the whole NAR arrived,
			and Nix then tried the next substituter.
		</p>
		{#if !store.meta?.cacheSubstituterUrl}
			<p class="p-caption">
				This farm does not say which substituter is its own cache, so the list may include it.
			</p>
		{/if}
	</section>
{/if}

<section class="p-section grow">
	<h3>Builders, busiest first</h3>
	<div class="p-list" role="group" aria-label="Builders" {...hold.handlers}>
		<p class="p-list-cap num">
			<span>{plural(builders.length, 'builder', 'builders')}</span>
			{#if hold.held}<span class="p-list-paused">Held</span>{/if}
		</p>
		{#if builders.length === 0}
			<p class="p-list-empty">No builder lists a substituter.</p>
		{:else}
			<VirtualList
				items={builders}
				key={(b) => b.addr}
				label="Builders with substituters"
				rowHeight={40}
			>
				{#snippet row(b, tabindex)}
					{@const first = b.w?.substituters[0]}
					<button type="button" class="p-row item" {tabindex} onclick={() => onopenbuilder(b.addr)}>
						<span class="addr mono" title={b.addr}>{b.addr}</span>
						<span class="top mono" title={b.w?.substituters.join(', ')}
							>{first ? hostOf(first) : ''}{#if (b.w?.substituters.length ?? 0) > 1}<span
									class="more">{` +${(b.w?.substituters.length ?? 1) - 1}`}</span
								>{/if}</span
						>
						<span class="num rate">{formatByteRate(b.rate)}</span>
					</button>
				{/snippet}
			</VirtualList>
		{/if}
	</div>
</section>

<style>
	.subs {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.subs li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.url {
		font-size: var(--text-xs);
		font-weight: 550;
		overflow-wrap: anywhere;
	}

	.detail {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	.item {
		align-items: center;
		gap: 8px;
		font-size: var(--text-xs);
	}

	.addr {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		font-weight: 550;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.top {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.more {
		color: var(--fg-muted);
	}

	.rate {
		flex: none;
		min-width: 6.5em;
		font-weight: 600;
		text-align: right;
	}
</style>
