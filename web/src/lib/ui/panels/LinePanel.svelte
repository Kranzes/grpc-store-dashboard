<script lang="ts">
	import LogsLink from '../logs/LogsLink.svelte';
	import type { LogsParams } from '../nav.ts';
	import { untrack } from 'svelte';
	import { lineEnds, type LineEnds } from '#lib/flow/lines.ts';
	import type { PoolToggles } from '#lib/flow/pools.svelte.ts';
	import {
		OTHER_CLIENTS,
		WORKER_LINGER_MS,
		failShare,
		parseNodeId,
		poolOf,
		type DrvView,
		type EdgeRowView,
		type FarmStore
	} from '#lib/model/types.ts';
	import { countsFailures, type LineKind } from '#lib/flow/kinds.ts';
	import { failPercent, rateText } from '#lib/flow/labels.ts';
	import { formatBytes, plural } from '../format.ts';
	import { Hold } from '../hold.svelte.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import VirtualList from '../VirtualList.svelte';
	import WindowCaption from '../WindowCaption.svelte';
	import DerivationList from './DerivationList.svelte';
	import LineChart from './LineChart.svelte';
	import {
		FETCH_CAVEAT,
		SUBSTITUTE_NO_BUILDS,
		chartTitle,
		failCaption,
		failFact,
		lineCaption,
		spokenRate,
		totalLabel,
		totalText,
		type LineShape
	} from './line.ts';
	import { nodeMono, nodeTitle, type PanelNames } from './titles.ts';

	// One line or a bundle: its numbers over the header window, its history,
	// its ends, its members and the latest derivations on it.
	type Props = {
		store: FarmStore;
		pools: PoolToggles;
		flow: LineKind;
		edgeIds: readonly string[];
		names: PanelNames;
		onopennode: (nodeId: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
		onselectderivation: (path: string, via?: string) => void;
	};
	let { store, pools, flow, edgeIds, names, onopennode, onopenlines, onselectderivation }: Props =
		$props();

	/** One assignment or request line: its failed builds in the Logs tab. */
	const failedLogs = $derived.by((): LogsParams | null => {
		if (edgeIds.length !== 1) return null;
		const [kind, ...rest] = edgeIds[0].split(':');
		const end = rest.join(':');
		if (kind === 'assign')
			return end.startsWith('pool:')
				? { pool: end.slice(5), status: ['failed'] }
				: { builder: end, status: ['failed'] };
		if (kind === 'want') return { client: end, status: ['failed'] };
		return null;
	});

	const LIMIT = 50;
	const LINGER_MIN = WORKER_LINGER_MS / 60_000;
	// Buckets are 30 s wide, so a faster query would not move the chart.
	const q = new Throttled(
		() => store.frame,
		() => store.edgeDetail(edgeIds, LIMIT),
		1000
	);
	const d = $derived(q.current);

	// The panel is keyed by its view, so its lines never change here.
	const ends: LineEnds | null = untrack(() =>
		edgeIds.length === 1 ? lineEnds(edgeIds[0], names.isBuilder) : null
	);
	const shape: LineShape = untrack(() => edgeIds.length > 1)
		? 'bundle'
		: ends?.endpoint.kind === 'pool'
			? 'pool'
			: 'one';
	const builder = ends?.endpoint.kind === 'builder' ? ends.endpoint.addr : null;
	const group = ends?.endpoint.kind === 'clients' ? ends.endpoint.group : null;
	const isOther = group === OTHER_CLIENTS;

	/** The pool that carries this builder's line on the map, when it is collapsed. */
	const carrier = $derived.by(() => {
		if (!builder) return null;
		const w = store.workers.get(builder);
		const system = w ? poolOf(w.systems[0] ?? '') : null;
		return system !== null && pools.collapsed(system) ? system : null;
	});
	const folded = $derived(group !== null && !isOther && !!d && !store.clientGroups.has(group));

	// Members, busiest first, held still while pointed at.
	const hold = new Hold(() => d?.rows ?? []);
	const rows = $derived(hold.current);
	const busiest = $derived(Math.max(0, ...rows.map((r) => r.rate)));

	function memberName(r: EdgeRowView): { text: string; mono: boolean } {
		const e = lineEnds(r.edgeId, names.isBuilder);
		if (!e) return { text: r.edgeId, mono: true };
		switch (e.endpoint.kind) {
			case 'builder':
				return { text: e.endpoint.addr, mono: true };
			case 'pool': {
				const n = store.pools.get(e.endpoint.system)?.builders ?? 0;
				return {
					text: `${e.endpoint.system} pool, ${plural(n, 'builder', 'builders')}`,
					mono: false
				};
			}
			case 'clients':
				return {
					text: nodeTitle(e.own ?? '', names),
					mono: nodeMono(e.own ?? '')
				};
			case 'scheduler':
				return { text: 'Cache hits', mono: false };
		}
	}

	const breakdown = $derived(
		shape === 'pool'
			? {
					title: 'Builders',
					caption: "Builders on the map now. Builders that left still count in the pool's numbers.",
					label: 'Builders on this line',
					one: 'builder',
					many: 'builders'
				}
			: isOther
				? {
						title: 'Client groups',
						caption: 'Identities beyond the busiest few, each counted on its own.',
						label: 'Client groups on this line',
						one: 'client group',
						many: 'client groups'
					}
				: {
						title: 'Lines',
						caption: null,
						label: 'Lines in this bundle',
						one: 'line',
						many: 'lines'
					}
	);

	// Each path once, so a path names its item.
	const items = $derived(new Map((d?.items ?? []).map((i) => [i.drv.drvPath, i])));
	const drvs = $derived((d?.items ?? []).map((i) => i.drv));
	function note(dv: DrvView): string | null {
		const bytes = items.get(dv.drvPath)?.bytes ?? 0;
		if (flow === 'publish') return `Published ${formatBytes(bytes)}`;
		if (flow === 'fetch') return `Fetching ≈ ${formatBytes(bytes)}`;
		return null;
	}
</script>

{#if !d}
	<p class="p-caption">
		{#if builder && !store.workers.has(builder)}
			This builder left the map. Builders leave {LINGER_MIN}m after they disconnect, or when another
			scheduler takes over.
		{:else}
			This line is no longer on the map.
		{/if}
	</p>
{:else}
	<section class="p-section">
		<WindowCaption minutes={d.windowMinutes} since={d.since} />
		<dl class="p-facts">
			<div>
				<dt>Now</dt>
				<dd class="small wrap">{rateText(flow, d.rate)}</dd>
			</div>
			<div>
				<dt>{totalLabel(flow)}</dt>
				<dd class="small wrap">{totalText(flow, d.unit, d.total)}</dd>
			</div>
			{#if countsFailures(flow)}
				<div>
					<dt>Failed</dt>
					<dd class="small wrap" class:p-bad={d.failed > 0}>{failFact(d.finished, d.failed)}</dd>
				</div>
			{/if}
		</dl>
		<p class="p-caption">{lineCaption(flow, shape)}</p>
		{#if carrier}
			<p class="p-caption">
				This builder is in the <span class="mono">{carrier}</span> pool, so the map shows the pool's line.
			</p>
		{/if}
		{#if folded}
			<p class="p-caption">This client group is counted under other clients on the map.</p>
		{/if}
		{#if flow === 'fetch'}<p class="p-caption">{FETCH_CAVEAT}</p>{/if}
	</section>

	<section class="p-section">
		<h3>{chartTitle(flow, d.unit)}</h3>
		<LineChart detail={d} />
		{#if countsFailures(flow)}
			{@const fc = failCaption(flow, shape, isOther)}
			<p class="p-caption">{fc.line}</p>
			<details class="p-more">
				<summary>How failures count</summary>
				<ul>
					{#each fc.bullets as b (b)}<li>{b}</li>{/each}
				</ul>
			</details>
		{/if}
	</section>
{/if}

{#if ends}
	<section class="p-section">
		<dl class="p-rows">
			<dt>From</dt>
			<dd>{@render end(ends.source)}</dd>
			<dt>To</dt>
			<dd>{@render end(ends.target)}</dd>
		</dl>
	</section>
{/if}

{#if d && rows.length > 0}
	<section class="p-section">
		<h3>{breakdown.title}</h3>
		{#if breakdown.caption}<p class="p-caption">{breakdown.caption}</p>{/if}
		<div
			class="p-list breakdown"
			role="group"
			style:--rows={Math.min(rows.length, 6)}
			{...hold.handlers}
		>
			<p class="p-list-cap num">
				<span>{plural(rows.length, breakdown.one, breakdown.many)}</span>
				{#if hold.held}<span class="p-list-paused">Held</span>{/if}
			</p>
			<VirtualList items={rows} key={(r) => r.edgeId} label={breakdown.label} rowHeight={40}>
				{#snippet row(r, tabindex)}
					{@const name = memberName(r)}
					{@const pct = countsFailures(flow) ? failPercent(failShare(r)) : null}
					<button
						type="button"
						class="p-row member"
						{tabindex}
						aria-label={[name.text, spokenRate(flow, r.rate), pct && `${pct} failed`]
							.filter(Boolean)
							.join(', ')}
						onclick={() => onopenlines(flow, [r.edgeId])}
					>
						<span class="member-name" class:mono={name.mono} title={name.text}>{name.text}</span>
						<span class="bar flow-{flow}" aria-hidden="true"
							><span style:transform="scaleX({busiest > 0 ? r.rate / busiest : 0})"></span></span
						>
						<span class="num rate">{rateText(flow, r.rate)}</span>
						<span class="num fail">
							{#if pct}<span class="fail-bar" aria-hidden="true"></span>{pct}{/if}
						</span>
					</button>
				{/snippet}
			</VirtualList>
		</div>
	</section>
{/if}

{#if failedLogs}
	<section class="p-section">
		<p class="p-links"><LogsLink label="Failed builds on this line" params={failedLogs} /></p>
	</section>
{/if}

{#if d && flow === 'substitute'}
	<section class="p-section">
		<p class="p-caption">{SUBSTITUTE_NO_BUILDS}</p>
	</section>
{:else if d}
	<section class="p-section grow">
		<h3>Latest on this line</h3>
		<DerivationList
			items={drvs}
			limit={LIMIT}
			label="Derivations on this line"
			context={builder ? 'builder' : 'line'}
			{note}
			empty="Nothing on this line."
			onselect={(path) => onselectderivation(path, items.get(path)?.via)}
		/>
	</section>
{/if}

{#snippet end(nodeId: string)}
	{@const pool = parseNodeId(nodeId)?.kind === 'pool'}
	<button
		type="button"
		class="p-link"
		class:mono={!pool && nodeMono(nodeId)}
		onclick={() => onopennode(nodeId)}
	>
		{#if pool}<span class="mono">{nodeTitle(nodeId, names)}</span> pool{:else}{nodeTitle(
				nodeId,
				names
			)}{/if}
	</button>
{/snippet}

<style>
	/* "379 of 3,798, 10%" is wider than a fact column, so wrap at a space and never cut. */
	.wrap {
		white-space: normal;
	}

	/* As tall as its rows, up to six, so the latest list keeps its room. */
	.breakdown {
		flex: none;
		min-height: 0;
	}

	.breakdown :global(.vlist) {
		flex: none;
		height: calc(var(--rows) * 40px);
	}

	.member {
		align-items: center;
		gap: 8px;
		font-size: var(--text-xs);
	}

	.member-name {
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
		background: color-mix(in oklab, var(--flow-c) 80%, var(--fg));
	}

	.rate {
		flex: none;
		min-width: 6.5em;
		text-align: right;
	}

	/* --fg after a red bar, because --danger-fg on the hover fill is below AA in Latte. */
	.fail {
		flex: none;
		min-width: 3.5em;
		text-align: right;
	}
</style>
