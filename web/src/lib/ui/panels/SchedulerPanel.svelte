<script lang="ts">
	import type { NodeLine } from '#lib/flow/lines.ts';
	import type { FarmStore } from '#lib/model/types.ts';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import { featureText } from '#lib/flow/queue.ts';
	import { clock } from '../clock.svelte.ts';
	import { formatClock, formatCount, formatSpan, spokenSpan } from '../format.ts';
	import Spoken from '../Spoken.svelte';
	import { Throttled } from '../throttle.svelte.ts';
	import DerivationList from './DerivationList.svelte';
	import LineRows from './LineRows.svelte';

	type Props = {
		store: FarmStore;
		/** The Lines rows: requests in, assignments out and cache hits, as bundles of drawn lines. */
		rows: readonly NodeLine[];
		onselectderivation: (path: string, via?: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, rows, onselectderivation, onopenlines }: Props = $props();

	const CAP = 2000;
	const s = $derived(store.scheduler);
	const meta = $derived(store.meta);
	const since = $derived(meta?.servingSinceMs ?? 0);
	const queue = new Throttled(
		() => store.frame,
		() => store.drvsQueued(CAP)
	);
</script>

<section class="p-section">
	<dl class="p-facts">
		<div>
			<dt>Queued</dt>
			<dd>{formatCount(s.queued)}</dd>
		</div>
		<div>
			<dt>Unplaceable</dt>
			<dd class:warn={s.unplaceable > 0}>{formatCount(s.unplaceable)}</dd>
		</div>
		<div>
			<dt>Assigned</dt>
			<dd>{formatCount(s.assigned)}</dd>
		</div>
		<div>
			<dt>Slots used</dt>
			<dd>{formatCount(s.slots - s.free)}<span class="p-of">/{formatCount(s.slots)}</span></dd>
		</div>
		<div>
			<dt>Builders online</dt>
			<dd>{s.workersUp}</dd>
		</div>
		<div>
			<dt>Streams</dt>
			<dd>{formatCount(s.clients)}</dd>
		</div>
	</dl>
	<dl class="p-rows">
		<dt>Serving since</dt>
		<dd>
			{#if since > 0}
				{formatClock(since)}
				<span class="muted"
					>(<Spoken
						text={formatSpan(clock.now - since)}
						words={spokenSpan(clock.now - since)}
					/>)</span
				>
			{:else}–{/if}
		</dd>
		<dt>Version</dt>
		<dd class="mono">{meta?.version || '–'}</dd>
		<dt>Default system</dt>
		<dd class="mono">{meta?.defaultSystem || '–'}</dd>
	</dl>
</section>

<LineRows {store} {rows} {onopenlines} />

<section class="p-section">
	<h3>Queue by system</h3>
	{#if s.systems.length === 0}
		<p class="p-caption">
			{s.queued + s.assigned > 0
				? 'Per-system numbers arrive with the next update from the scheduler.'
				: 'Nothing queued and no builders offering a system.'}
		</p>
	{:else}
		<table class="p-table">
			<thead>
				<tr>
					<th scope="col">System</th>
					<th scope="col">Queued</th>
					<th scope="col" title="No connected builder offers this system and features">
						Unplaceable
					</th>
					<th scope="col" title="Assigned slots on connected builders that can take these">
						Assigned
					</th>
					<th
						scope="col"
						title="Free slots of all slots on builders that take work and can take these"
					>
						Free
					</th>
				</tr>
			</thead>
			<tbody>
				{#each s.systems as r (`${r.system}|${r.features}`)}
					<tr>
						<td class="wrap">
							<span class="mono">{r.system}</span>
							{#if r.features}<span class="feat">{` ${featureText(r.features)}`}</span>{/if}
						</td>
						<td>{formatCount(r.queued)}</td>
						<td class:warn={r.unplaceable > 0}>{formatCount(r.unplaceable)}</td>
						<td>{formatCount(r.running)}</td>
						<td>{formatCount(r.free)}<span class="p-of">/{formatCount(r.slots)}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p class="p-caption">
			A builder counts in every row it can take, so rows add up to more than the farm has.
		</p>
	{/if}
</section>

<section class="p-section grow">
	<h3>Queued, highest priority first</h3>
	<DerivationList
		items={queue.current}
		total={s.queued}
		limit={CAP}
		label="Queued derivations"
		context="queue"
		empty="The queue is empty."
		onselect={(path) => onselectderivation(path)}
	/>
</section>

<style>
	.muted,
	.feat {
		color: var(--fg-muted);
		font-weight: 500;
	}

	.warn {
		color: var(--warn-fg);
	}
</style>
