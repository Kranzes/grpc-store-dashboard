<script lang="ts">
	import { tick } from 'svelte';
	import type { LineKind } from '#lib/flow/kinds.ts';
	import Flow from '#lib/flow/Flow.svelte';
	import { nodeButtonSelector, poolToggleSelector } from '#lib/flow/context.ts';
	import { lineEnds, type DrawnLine } from '#lib/flow/lines.ts';
	import {
		OTHER_CLIENTS,
		clientGroupNodeId,
		parseNodeId,
		poolNodeId,
		poolOf,
		workerNodeId
	} from '#lib/model/types.ts';
	import MapNotice from './MapNotice.svelte';
	import DetailPanel, { panelFor } from './panels/DetailPanel.svelte';
	import {
		back as popView,
		focusOf,
		openLinesOnMap,
		openNode,
		openerOf,
		push,
		selectedOf,
		type EndsOf,
		type PanelStack
	} from './stack.ts';
	import { isPauseKey } from './pause.svelte.ts';
	import { getShell } from './shell.ts';

	// The map and its side panel. What must survive a visit to the Logs tab
	// lives in the shell's OverviewState: the panel stack, pools, rates on
	// lines and the view.
	const shell = getShell();
	const store = $derived(shell.store);
	const pause = shell.pause;
	const paused = $derived(pause.paused);
	const shown = $derived(shell.shown);
	const overview = $derived(shell.overview);
	const pools = $derived(overview.pools);
	/** The last change of the stack was Back, so the panel scrolls back to where it was. */
	let wentBack = $state(false);
	/**
	 * The lines the map draws, for the scheduler's and the cache's Lines
	 * rows. Flow reports them through its onlines prop.
	 */
	let lines = $state.raw<readonly DrawnLine[]>([]);
	let mapRegion: HTMLElement | undefined = $state();

	const view = $derived(overview.stack.at(-1) ?? null);
	const below = $derived(overview.stack.at(-2) ?? null);
	/** What the map brightens: a node, a line or a bundle, or null. Flow's focus prop. */
	const focus = $derived(focusOf(overview.stack));
	/** The node whose button reads as expanded and whose pool cell is ringed. */
	const selected = $derived(selectedOf(focus));

	const ends: EndsOf = (id) => {
		const e = lineEnds(id, (addr) => store.workers.has(addr));
		return e ? [e.source, e.target] : ['', ''];
	};

	function go(next: PanelStack) {
		if (next.length === 0) {
			close();
			return;
		}
		// A second click on the view under a derivation steps back to it, as Back does.
		wentBack = next.length < overview.stack.length && next.every((v, i) => v === overview.stack[i]);
		overview.stack = next;
		overview.returnTo = null;
	}

	/** Open a node's panel, or close it when it is open. `pool`: picked from that pool. */
	function select(id: string, pool?: string) {
		if (!panelFor(id)) return;
		go(openNode(overview.stack, id, pool));
	}

	/**
	 * Open the panel of a line or a bundle. From the map it opens over the
	 * node panel at an end of every line, and a second click closes it. From a
	 * Lines row or a breakdown row it opens over the current panel.
	 */
	function openLines(flow: LineKind, edgeIds: readonly string[], from: 'map' | 'panel') {
		if (edgeIds.length === 0) return;
		go(
			from === 'map'
				? openLinesOnMap(overview.stack, flow, edgeIds, ends)
				: push(overview.stack, { kind: 'lines', flow, edgeIds })
		);
	}

	/** The element that takes focus back for a node, or for the pool or heading that shows it. */
	function openerElement(id: string): HTMLElement | null {
		const el = document.querySelector<HTMLElement>(nodeButtonSelector(id));
		if (el) return el;
		// A builder inside a pool has no node of its own, and a pool shown as
		// cards again has none either, so focus goes to the pool, or its heading.
		// A group folded into other clients goes there.
		const ref = parseNodeId(id);
		if (ref?.kind === 'clients')
			return document.querySelector<HTMLElement>(
				nodeButtonSelector(clientGroupNodeId(OTHER_CLIENTS))
			);
		const system =
			ref?.kind === 'pool'
				? ref.system
				: ref?.kind === 'builder'
					? poolOf(store.workers.get(ref.addr)?.systems[0] ?? '')
					: null;
		if (system === null) return null;
		return (
			document.querySelector<HTMLElement>(nodeButtonSelector(poolNodeId(system))) ??
			document.querySelector<HTMLElement>(poolToggleSelector(system))
		);
	}

	/** Whether the whole element shows on the map, so focusing it would not pan the view. */
	function inView(el: HTMLElement): boolean {
		const box = mapRegion?.querySelector('.svelte-flow')?.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return (
			!!box &&
			r.left >= box.left &&
			r.top >= box.top &&
			r.right <= box.right &&
			r.bottom <= box.bottom
		);
	}

	async function close() {
		const opener = openerOf(overview.stack, ends);
		// A line picked on the map has no button that opened it.
		const fromMap = overview.stack[0]?.kind === 'lines';
		overview.stack = [];
		overview.returnTo = null;
		await tick();
		if (!opener) return;
		const el = openerElement(opener);
		// preventScroll: the map is transformed, not scrolled. Focus on a node
		// off screen would pan to it and end refitting, so a line panel from the
		// map leaves focus on the map region instead.
		if (fromMap && !(el && inView(el))) mapRegion?.focus({ preventScroll: true });
		else el?.focus({ preventScroll: true });
	}

	/** One view back. A builder picked from a pool goes back to the pool, on its row. */
	function back() {
		if (overview.stack.length < 2) {
			close();
			return;
		}
		const left = overview.stack[overview.stack.length - 1];
		const next = popView(overview.stack);
		const to = next[next.length - 1];
		const ref = left.kind === 'node' ? parseNodeId(left.nodeId) : null;
		overview.stack = next;
		wentBack = true;
		overview.returnTo =
			ref?.kind === 'builder' && to.kind === 'node' && parseNodeId(to.nodeId)?.kind === 'pool'
				? ref.addr
				: null;
	}

	function onkeydown(e: KeyboardEvent) {
		if (isPauseKey(e)) {
			e.preventDefault();
			pause.toggle();
			return;
		}
		if (e.key !== 'Escape' || overview.stack.length === 0 || e.defaultPrevented) return;
		const t = e.target as HTMLElement | null;
		if (t?.closest('input, textarea, select')) return;
		e.preventDefault();
		back();
	}

	// Anything but live means the numbers on the map are not current.
	const stale = $derived(store.status.kind !== 'live');
</script>

<svelte:window {onkeydown} />

<svelte:head>
	<title>{shell.farmName} · nix-grpc-store dashboard</title>
</svelte:head>

<div class="main" class:open={view !== null}>
	<section class="map" class:stale aria-label="Farm map" tabindex="-1" bind:this={mapRegion}>
		<Flow
			{store}
			{pools}
			{selected}
			{focus}
			onselect={select}
			onpaneclick={() => {
				if (overview.stack.length > 0) close();
			}}
			onlines={(l) => (lines = l)}
			onpickline={(flow, edgeIds) => openLines(flow, edgeIds, 'map')}
			{paused}
			ontogglepause={() => pause.toggle()}
			onhold={(h) => pause.hold(h)}
			bind:showRates={overview.showRates}
			bind:userMoved={overview.userMoved}
			initialViewport={overview.userMoved ? overview.viewport : null}
			onviewport={(v) => (overview.viewport = v)}
		/>
		<MapNotice status={store.status} meta={store.meta} />
	</section>
	{#if view}
		<div class="side">
			<DetailPanel
				store={shown}
				{pools}
				{view}
				{below}
				returnTo={overview.returnTo}
				depth={overview.stack.length}
				restored={wentBack}
				{lines}
				onclose={close}
				onback={back}
				onselectderivation={(drvPath, via) =>
					go(push(overview.stack, { kind: 'derivation', drvPath, via }))}
				onopennode={(nodeId) => go([{ kind: 'node', nodeId }])}
				onopenbuilder={(addr, pool) => select(workerNodeId(addr), pool)}
				onopenlines={(flow, edgeIds) => openLines(flow, edgeIds, 'panel')}
			/>
		</div>
	{/if}
</div>

<style>
	.main {
		position: relative;
		display: flex;
		min-height: 0;
	}

	.map {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
	}

	/* Focus lands here after a line panel from the map closes; the ring stays inside. */
	.map:focus-visible {
		outline-offset: -2px;
	}

	/* The nodes lose saturation but do not fade, so their labels stay AA while stale. */
	.map.stale :global(.svelte-flow__viewport) {
		filter: saturate(0.4);
		transition: filter var(--dur-slow);
	}

	/* The lines sit on a canvas outside the viewport, so they lose saturation and fade too. */
	.map.stale :global(.line-canvas) {
		filter: saturate(0.4);
		opacity: 0.45;
		transition:
			filter var(--dur-slow),
			opacity var(--dur-slow);
	}

	.side {
		flex: none;
		width: var(--panel-w);
		min-height: 0;
	}

	/* Below this the map keeps its width and the panel floats over it. */
	@media (max-width: 1439px) {
		.side {
			position: absolute;
			top: 0;
			right: 0;
			bottom: 0;
			z-index: 20;
			box-shadow: var(--shadow-lg);
		}
	}
</style>
