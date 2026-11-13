<script lang="ts">
	import type { NodeLine } from '#lib/flow/lines.ts';
	import { OTHER_CLIENTS, type EdgeView, type FarmStore } from '#lib/model/types.ts';
	import { lineId, type LineKind } from '#lib/flow/kinds.ts';
	import { formatCount } from '../format.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import LogsLink from '../logs/LogsLink.svelte';
	import DerivationList from './DerivationList.svelte';
	import LineRows from './LineRows.svelte';

	type Props = {
		store: FarmStore;
		group: string;
		/** The Lines rows: the group's request line. */
		rows: readonly NodeLine[];
		onselectderivation: (path: string, via?: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, group, rows, onselectderivation, onopenlines }: Props = $props();

	const LIMIT = 1000;
	const shown = $derived(store.clientGroups.get(group));
	// A group that left the map can still have streams, folded into "other clients".
	const known = new Throttled(
		() => store.frame,
		() => store.clientGroup(group)
	);
	const g = $derived(shown ?? known.current);
	const folded = $derived(!shown && !!known.current);
	// A folded group has no line of its own on the map, so its rate comes from the group.
	const own = $derived(lineId('request', group));
	const fallback = (id: string): EdgeView | undefined =>
		folded && g && id === own
			? { rate: g.wantsPerSec, unit: 'builds', finished: 0, failed: 0 }
			: undefined;
	const waiting = new Throttled(
		() => store.frame,
		() => store.drvsForClientGroup(group, LIMIT)
	);
</script>

{#if !g}
	<p class="p-caption">
		{group === OTHER_CLIENTS
			? 'No identities are grouped here any more.'
			: 'These clients have disconnected.'}
	</p>
{:else}
	<section class="p-section">
		<dl class="p-facts">
			<div>
				<dt>Streams</dt>
				<dd>{formatCount(g.clients)}</dd>
			</div>
			<div>
				<dt>Waiting on</dt>
				<dd>{formatCount(g.waiting)}</dd>
			</div>
		</dl>
		<p class="p-caption">
			{#if group === OTHER_CLIENTS}
				Identities beyond the busiest few are grouped here.
			{:else if folded}
				Still connected, but counted under other clients on the map.
			{:else}
				Builds in hook mode open one stream per derivation, so one identity often has many streams.
			{/if}
		</p>
	</section>

	<LineRows {store} {rows} {fallback} {onopenlines} />

	<p class="p-links">
		<LogsLink label="Builds of this client group" params={{ client: group }} />
	</p>
	<p class="p-caption">Builds that more than 4 clients waited on may be missing.</p>
{/if}

<section class="p-section grow">
	<h3>Waiting on</h3>
	<DerivationList
		items={waiting.current}
		total={g?.waiting}
		limit={LIMIT}
		label="Derivations these clients wait on"
		context={group === OTHER_CLIENTS ? 'queue' : 'clients'}
		empty="Not waiting on anything right now."
		onselect={(path) => onselectderivation(path, own)}
	/>
</section>
