<script lang="ts" module>
	import { parseNodeId } from '#lib/model/types.ts';

	/** Node id to panel, or null for nodes without one. */
	export const panelFor = parseNodeId;
</script>

<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { PANEL_ID } from '#lib/flow/context.ts';
	import { nodeLines, type DrawnLine } from '#lib/flow/lines.ts';
	import type { PoolToggles } from '#lib/flow/pools.svelte.ts';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import type { FarmStore } from '#lib/model/types.ts';
	import Icon from '../Icon.svelte';
	import { viewKey, type PanelView } from '../stack.ts';
	import BuilderPanel from './BuilderPanel.svelte';
	import CachePanel from './CachePanel.svelte';
	import ClientsPanel from './ClientsPanel.svelte';
	import DerivationDetail from './DerivationDetail.svelte';
	import LinePanel from './LinePanel.svelte';
	import PoolPanel from './PoolPanel.svelte';
	import SchedulerPanel from './SchedulerPanel.svelte';
	import UpstreamPanel from './UpstreamPanel.svelte';
	import { backLabel, viewKicker, viewName, viewTitle, type PanelNames } from './titles.ts';

	type Props = {
		store: FarmStore;
		pools: PoolToggles;
		/** The view the panel shows: the top of the stack. */
		view: PanelView;
		/** The view under it, where Back goes. null when Back would close. */
		below: PanelView | null;
		/** Back in a pool from this builder: focus its row, not the heading. */
		returnTo: string | null;
		/** How many views the stack holds, this one included. */
		depth: number;
		/** This view came back from the one above it, so it gets its scroll position back. */
		restored: boolean;
		/** The lines the map draws, for the scheduler's and the cache's Lines rows. */
		lines: readonly DrawnLine[];
		onclose: () => void;
		/** One view back. */
		onback: () => void;
		/** `via`: the line the derivation was picked from. */
		onselectderivation: (path: string, via?: string) => void;
		onopennode: (nodeId: string) => void;
		onopenbuilder: (addr: string, pool: string) => void;
		/** A Lines row or a breakdown row: a line panel over this one. */
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let {
		store,
		pools,
		view,
		below,
		returnTo,
		depth,
		restored,
		lines,
		onclose,
		onback,
		onselectderivation,
		onopennode,
		onopenbuilder,
		onopenlines
	}: Props = $props();

	const names: PanelNames = {
		isBuilder: (addr) => store.workers.has(addr),
		groupLabel: (group) => store.clientGroups.get(group)?.label
	};

	const key = $derived(viewKey(view));
	const target = $derived(view.kind === 'node' ? panelFor(view.nodeId) : null);
	const title = $derived(viewTitle(view, names));
	// A line's heading names only its varying end; screen readers hear the kind too.
	const spoken = $derived(view.kind === 'lines' ? viewName(view, names) : null);
	const back = $derived(below ? backLabel(below, names) : null);
	const rows = $derived(
		target ? nodeLines(target, lines, store.topology.hasCache, (id) => store.edges.has(id)) : []
	);

	let heading: HTMLHeadingElement | undefined = $state();
	let body: HTMLDivElement | undefined = $state();
	/**
	 * Where the body was scrolled, per stack depth. A new view starts at the
	 * top, and Back returns to where the user left the view under it. Scroll
	 * events count only once a view has settled, since a view that replaces
	 * a longer one clamps the old offset first.
	 */
	const scrolls: number[] = [];
	let settled = true;
	$effect.pre(() => {
		void key;
		settled = false;
	});
	$effect(() => {
		void key;
		const { at, back, el } = untrack(() => ({ at: depth, back: restored, el: body }));
		if (!el) return;
		scrolls.length = Math.min(scrolls.length, back ? at : at - 1);
		// After the new view has mounted and laid out.
		tick().then(() => {
			el.scrollTop = back ? (scrolls[at - 1] ?? 0) : 0;
			settled = true;
		});
	});
	let poolPanel: PoolPanel | undefined = $state();
	// Move focus into the panel whenever it shows something new: to the
	// heading, or back in a pool to the row of the builder just left.
	$effect(() => {
		void key;
		const to = target?.kind === 'pool' ? returnTo : null;
		if (!to) {
			heading?.focus();
			return;
		}
		// After the list has mounted and bound.
		tick().then(async () => {
			if (!(await poolPanel?.focusBuilder(to))) heading?.focus();
		});
	});
</script>

<div id={PANEL_ID} class="panel" role="dialog" aria-modal="false" aria-labelledby="panel-title">
	<header>
		<div class="bar">
			{#if back !== null}
				<button type="button" class="back" onclick={onback}>
					<Icon name="back" />
					<span class="back-label">{back}</span>
				</button>
			{:else}
				{@render kicker()}
			{/if}
			<button type="button" class="close" onclick={onclose} title="Close (Escape)">
				<Icon name="close" label="Close panel" />
			</button>
		</div>
		<!-- A line's kicker names its kind, so it stays when Back takes the bar. -->
		{#if back !== null && view.kind === 'lines'}{@render kicker()}{/if}
		<h2
			id="panel-title"
			tabindex="-1"
			bind:this={heading}
			class:mono={title.parts.length === 1 && title.parts[0].mono}
			aria-label={spoken ?? undefined}
		>
			{#if title.parts.length === 1}{title.text}{:else}{#each title.parts as p, i (i)}<span
						class:mono={p.mono}>{p.text}</span
					>{/each}{/if}
		</h2>
		{#if view.kind === 'derivation'}<p class="sub">Derivation</p>{/if}
	</header>

	<div
		class="body"
		bind:this={body}
		onscroll={() => {
			if (settled && body) scrolls[depth - 1] = body.scrollTop;
		}}
	>
		{#key key}
			{#if view.kind === 'derivation'}
				<DerivationDetail {store} drvPath={view.drvPath} via={view.via} {onopennode} />
			{:else if view.kind === 'lines'}
				<LinePanel
					{store}
					{pools}
					{names}
					flow={view.flow}
					edgeIds={view.edgeIds}
					{onopennode}
					{onopenlines}
					{onselectderivation}
				/>
			{:else if target?.kind === 'builder'}
				<BuilderPanel {store} addr={target.addr} {rows} {onselectderivation} {onopenlines} />
			{:else if target?.kind === 'pool'}
				<PoolPanel
					bind:this={poolPanel}
					{store}
					{pools}
					system={target.system}
					{rows}
					onopenbuilder={(addr) => onopenbuilder(addr, view.kind === 'node' ? view.nodeId : '')}
					{onopenlines}
				/>
			{:else if target?.kind === 'scheduler'}
				<SchedulerPanel {store} {rows} {onselectderivation} {onopenlines} />
			{:else if target?.kind === 'cache'}
				<CachePanel {store} {rows} {onselectderivation} {onopenlines} />
			{:else if target?.kind === 'upstream'}
				<UpstreamPanel
					{store}
					{rows}
					onopenbuilder={(addr) => onopenbuilder(addr, view.kind === 'node' ? view.nodeId : '')}
					{onopenlines}
				/>
			{:else if target?.kind === 'clients'}
				<ClientsPanel {store} group={target.group} {rows} {onselectderivation} {onopenlines} />
			{/if}
		{/key}
	</div>
</div>

{#snippet kicker()}
	<span class="kicker" aria-hidden={view.kind === 'lines' ? 'true' : undefined}>
		{#if view.kind === 'lines'}<span class="kind-dot flow-{view.flow}"></span>{/if}{viewKicker(
			view
		)}
	</span>
{/snippet}

<style>
	.panel {
		display: flex;
		flex-direction: column;
		width: var(--panel-w);
		max-width: 100%;
		height: 100%;
		border-left: 1px solid var(--border);
		background: var(--bg);
		animation: slide-in var(--dur) var(--ease-out);
	}

	header {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-3) var(--space-5) var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-height: 32px;
	}

	.kicker {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	/* The line's color, as on the map and in the legend. */
	.kind-dot {
		width: 8px;
		height: 8px;
		flex: none;
		border-radius: 50%;
		background: var(--flow-c);
	}

	h2 {
		overflow-wrap: anywhere;
		font-size: var(--text-xl);
		font-weight: 650;
		letter-spacing: -0.01em;
		line-height: var(--leading-tight);
	}

	h2.mono {
		font-size: var(--text-lg);
	}

	h2:focus {
		outline: none;
	}

	h2:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 4px;
		border-radius: 2px;
	}

	.sub {
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		height: 28px;
		margin-left: -6px;
		padding: 0 8px 0 4px;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--accent-strong);
		font-size: var(--text-xs);
		font-weight: 600;
	}

	/* --accent-strong on --accent-soft is 3.92:1 in Latte, so the text turns --fg. */
	.back:hover {
		background: var(--accent-soft);
		color: var(--fg);
	}

	.back-label {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		max-width: 300px;
	}

	.close {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		margin-right: -8px;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--fg-muted);
	}

	.close:hover {
		background: var(--bg-raised);
		color: var(--fg);
	}

	.body {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: var(--space-5);
		min-height: 0;
		padding: var(--space-4) var(--space-5) var(--space-5);
		overflow-y: auto;
	}

	@keyframes slide-in {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
	}
</style>
