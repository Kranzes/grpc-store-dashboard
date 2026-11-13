<script lang="ts">
	import LogsLink from '../logs/LogsLink.svelte';
	import { untrack } from 'svelte';
	import type { NodeLine } from '#lib/flow/lines.ts';
	import type { PoolToggles } from '#lib/flow/pools.svelte.ts';
	import {
		POOL_CHURN_MINUTES,
		WORKER_LINGER_MS,
		builderState,
		loadOf,
		type FarmStore,
		type WorkerView
	} from '#lib/model/types.ts';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import { drainRow, poolDrains } from '../drain.ts';
	import { formatBytes, formatCount } from '../format.ts';
	import { Hold } from '../hold.svelte.ts';
	import Segmented from '../Segmented.svelte';
	import { Throttled } from '../throttle.svelte.ts';
	import VirtualList from '../VirtualList.svelte';
	import WindowCaption from '../WindowCaption.svelte';
	import LineRows from './LineRows.svelte';
	import { poolList, poolMembers, type PoolFilter, type PoolSort } from './pool.ts';

	type Props = {
		store: FarmStore;
		system: string;
		pools: PoolToggles;
		/** The Lines rows: the pool's three lines. */
		rows: readonly NodeLine[];
		onopenbuilder: (addr: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, system, pools, rows, onopenbuilder, onopenlines }: Props = $props();

	const LINGER_MIN = WORKER_LINGER_MS / 60_000;
	/** Above this many cards, the panel says the list reads better than the map. */
	const MANY_CARDS = 100;
	const p = $derived(store.pools.get(system));
	const fill = $derived(p && p.slots > 0 ? Math.min(1, p.running / p.slots) : 0);
	const collapsed = $derived(pools.collapsed(system));

	// Search, sort, filter and scroll as the user left them for this pool, so
	// coming back from a builder finds the list unchanged. The panel is keyed
	// by its node, so `system` never changes here.
	const kept = untrack(() => pools.list(system));
	let query = $state(kept.query);
	let sort = $state<PoolSort>(kept.sort);
	let filter = $state<PoolFilter>(kept.filter);
	let scrollTop = $state(kept.scrollTop);
	$effect(() => pools.saveList(system, { query, sort, filter, scrollTop }));

	// Live views at most twice a second, held still while the user browses.
	// Search, sort and filter apply on top at once, held or not.
	const members = $derived(poolMembers(store.topology, system));
	const live = new Throttled(
		() => store.frame,
		() => members.map((a) => store.workers.get(a)).filter((w): w is WorkerView => !!w)
	);
	const hold = new Hold(() => live.current);
	const all = $derived(hold.current);
	const shown = $derived(poolList(all, { query, sort, filter }));

	let list: { focusAt(i: number): Promise<void> } | undefined = $state();

	/** Focus the row of `addr`, as on the way back from its panel. False when it is not listed. */
	export async function focusBuilder(addr: string): Promise<boolean> {
		const i = shown.findIndex((w) => w.addr === addr);
		if (i < 0 || !list) return false;
		await list.focusAt(i);
		return true;
	}

	const filters = $derived([
		{ value: 'all' as const, label: 'All' },
		{
			value: 'draining' as const,
			label: `Draining, ${formatCount(p?.draining ?? 0)} builders`,
			text: `Draining ${formatCount(p?.draining ?? 0)}`
		},
		{
			value: 'offline' as const,
			label: `Offline, ${formatCount(p?.offline ?? 0)} builders`,
			text: `Offline ${formatCount(p?.offline ?? 0)}`
		}
	]);
</script>

{#if !p}
	<p class="p-caption">No builders of this system are connected or shown any more.</p>
{:else}
	<section class="p-section">
		<dl class="p-facts facts">
			<div>
				<dt>Builders</dt>
				<dd>{formatCount(p.builders)}</dd>
			</div>
			<div>
				<dt>Online</dt>
				<dd>{formatCount(p.up)}</dd>
			</div>
			<div>
				<dt
					title="Assigned to a builder. Includes uploading and fetching inputs. Draining builders included."
				>
					Assigned slots
				</dt>
				<dd>{formatCount(p.running)}<span class="p-of">/{formatCount(p.slots)}</span></dd>
				<!-- Under the value it shows. -->
				<dd class="p-meter" aria-hidden="true"><span style:transform="scaleX({fill})"></span></dd>
			</div>
			<div>
				<dt title="Queued derivations whose system and features some builder of this pool offers">
					Can take
				</dt>
				<dd>{formatCount(p.queuedCanTake)}</dd>
			</div>
		</dl>
		<div class="p-when-group">
			<WindowCaption minutes={POOL_CHURN_MINUTES} since={p.churnSince} />
			<dl class="p-facts facts">
				<div>
					<dt>Joined</dt>
					<dd>{formatCount(p.joined)}</dd>
				</div>
				<div>
					<dt>Left</dt>
					<dd>{formatCount(p.left)}</dd>
				</div>
			</dl>
		</div>
		{#if p.drainingLowDisk + p.drainingStopping + p.drainingLocalDaemon > 0}
			<p class="p-caption">Draining: {poolDrains(p)}.</p>
		{/if}
		<p class="p-caption">
			Offline builders stay {LINGER_MIN}m. Drained ones leave at once, unless they drained for low
			disk.
		</p>
		<div class="toggle">
			<button type="button" class="btn-secondary" onclick={() => pools.set(system, !collapsed)}>
				{collapsed ? 'Show cards' : 'Collapse'}
			</button>
			{#if collapsed && p.builders > MANY_CARDS}
				<span class="p-caption">
					{formatCount(p.builders)} cards are too many to read on the map. The list below is easier.
				</span>
			{/if}
		</div>
		{#if p.features.length}
			<ul class="p-chips" aria-label="Features and how many builders offer them">
				{#each p.features as f (f.name)}
					<li>{f.name} <span class="p-of num">{formatCount(f.builders)}</span></li>
				{/each}
			</ul>
		{/if}
	</section>

	<LineRows {store} {rows} {onopenlines} />

	<p class="p-links">
		<LogsLink label="Logs of this pool" params={{ pool: system }} />
	</p>
{/if}

<section class="p-section grow">
	<h3>Builders</h3>
	<div class="tools">
		<input
			type="search"
			class="search"
			placeholder="Search address or feature"
			aria-label="Search builders by address or feature"
			bind:value={query}
		/>
		<label class="sort">
			<span>Sort</span>
			<select bind:value={sort}>
				<option value="busiest">Busiest first</option>
				<option value="idle">Idle first</option>
				<option value="address">Address</option>
			</select>
		</label>
	</div>
	<Segmented
		label="Show builders"
		options={filters}
		value={filter}
		onchange={(v) => (filter = v)}
	/>
	<div class="p-list" role="group" aria-label="Builders" {...hold.handlers}>
		<p class="p-list-cap num">
			<span>{formatCount(shown.length)} of {formatCount(all.length)}</span>
			{#if hold.held}<span class="p-list-paused">Held</span>{/if}
		</p>
		{#if shown.length === 0}
			<p class="p-list-empty">
				{all.length === 0 ? 'No builders in this pool.' : 'No builders match.'}
			</p>
		{:else}
			<VirtualList
				bind:this={list}
				bind:scrollTop
				items={shown}
				key={(w) => w.addr}
				label="Builders in this pool"
				rowHeight={40}
			>
				{#snippet row(w, tabindex)}
					{@const state = builderState(w)}
					<button type="button" class="p-row item" {tabindex} onclick={() => onopenbuilder(w.addr)}>
						<span class="status-dot {state}" aria-hidden="true"></span>
						<span class="addr mono" title={w.addr}>{w.addr}</span>
						{#if state !== 'up'}
							<span class="badge">{state === 'offline' ? 'Offline' : drainRow(w)}</span>
						{/if}
						<span class="bar" aria-hidden="true"
							><span style:transform="scaleX({loadOf(w)})"></span></span
						>
						<span class="num slots">{w.running}/{w.maxJobs}</span>
						{#if state === 'draining' && w.drainReason === 'low-disk' && w.diskFree !== null}
							<span class="num queued">{formatBytes(w.diskFree)} free</span>
						{:else}
							<span class="num queued">{formatCount(w.queuedCanTake)} queued</span>
						{/if}
					</button>
				{/snippet}
			</VirtualList>
		{/if}
	</div>
</section>

<style>
	/* Four to a row, so the summary leaves room for the list on short screens. */
	.facts {
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-2) var(--space-3);
	}

	.facts dd {
		font-size: var(--text-md);
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.tools {
		display: flex;
		gap: var(--space-2);
	}

	.search {
		flex: 1 1 auto;
		min-width: 0;
		height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-node);
		font-size: var(--text-xs);
	}

	.search::placeholder {
		color: var(--fg-muted);
	}

	.sort {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.sort select {
		height: 30px;
		padding: 0 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-node);
		color: var(--fg);
		font-size: var(--text-xs);
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

	.bar {
		position: relative;
		flex: none;
		width: 48px;
		height: 6px;
		border-radius: 3px;
		background: var(--bg-raised);
		overflow: hidden;
	}

	.bar > span {
		position: absolute;
		inset: 0;
		transform-origin: left center;
		border-radius: inherit;
		background: var(--state-running);
	}

	.slots {
		flex: none;
		min-width: 3.2em;
		font-weight: 600;
		text-align: right;
	}

	.queued {
		flex: none;
		/* "12.3k queued", the widest count, so the meters line up. */
		min-width: 7.5em;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		text-align: right;
	}
</style>
