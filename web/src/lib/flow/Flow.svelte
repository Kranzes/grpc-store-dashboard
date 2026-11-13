<script module lang="ts">
	import type { NodeTypes } from '@xyflow/svelte';
	import BuilderNode from './nodes/BuilderNode.svelte';
	import CacheNode from './nodes/CacheNode.svelte';
	import ClientGroupNode from './nodes/ClientGroupNode.svelte';
	import EmptyNode from './nodes/EmptyNode.svelte';
	import GroupHeading from './nodes/GroupHeading.svelte';
	import LaneHeading from './nodes/LaneHeading.svelte';
	import PoolNode from './nodes/PoolNode.svelte';
	import SchedulerNode from './nodes/SchedulerNode.svelte';
	import UpstreamNode from './nodes/UpstreamNode.svelte';

	// Module scope so Svelte Flow never sees new component maps.
	const nodeTypes: NodeTypes = {
		clients: ClientGroupNode,
		scheduler: SchedulerNode,
		builder: BuilderNode,
		pool: PoolNode,
		cache: CacheNode,
		upstream: UpstreamNode,
		lane: LaneHeading,
		system: GroupHeading,
		'empty-clients': EmptyNode,
		'empty-builders': EmptyNode,
		'empty-cache': EmptyNode
	};
</script>

<script lang="ts">
	import { SvelteFlow, type Viewport } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import '#lib/theme/flow.css';
	import './nodes/nodes.css';
	import './focus.css';
	import { untrack } from 'svelte';
	import { reconcile } from '#lib/model/reconcile.ts';
	import { hasUpstream, type FarmStore, type Topology } from '#lib/model/types.ts';
	import type { LineKind } from './kinds.ts';
	import { theme } from '#lib/theme/theme.svelte.ts';
	import { windowCaption } from '#lib/ui/format.ts';
	import { Throttled } from '#lib/ui/throttle.svelte.ts';
	import MapControls from './MapControls.svelte';
	import MapGrid from './MapGrid.svelte';
	import { holdStill } from './hold.ts';
	import Legend, { type LegendItem } from './Legend.svelte';
	import LineCanvas from './LineCanvas.svelte';
	import LineInput from './LineInput.svelte';
	import RateLabels from './RateLabels.svelte';
	import { FIT_VIEW, MAX_ZOOM, MIN_ZOOM, repeatClick, setFlowContext } from './context.ts';
	import {
		EMPTY_INDEX,
		Tokens,
		brightIds,
		drawnIds,
		focusCss,
		focusIndex,
		type Focus,
		type FocusIndex
	} from './focus.ts';
	import { lineGeometry, type LineGeom } from './geometry.ts';
	import {
		labelObstacles,
		labelSlots,
		type Box,
		type LabelSlot,
		type Obstacles
	} from './labels.ts';
	import { layoutTopology, type LayoutState, type PoolChoices } from './layout.ts';
	import { FADED, HOVER_FADED, HOVER_REST_MS } from './lineLayer.ts';
	import { farmBounds, type Bounds } from './limits.ts';
	import type { LineNames } from './lines.ts';
	import type { PoolToggles } from './pools.svelte.ts';
	import { reuseNodes, reuseSet } from './reuse.ts';
	import { lineLooks, paintOrder } from './traffic.ts';
	import type { FlowNode } from './types.ts';

	type Props = {
		store: FarmStore;
		pools: PoolToggles;
		selected: string | null;
		onselect: (nodeId: string, from?: string) => void;
		/** A click on the empty map. */
		onpaneclick: () => void;
		/** The drawn lines, after every layout, for the scheduler's and the cache's Lines rows. */
		onlines?: (lines: readonly LineGeom[]) => void;
		/**
		 * What stays bright on the map. Everything else fades, and the view
		 * does not move. Ids that are not drawn map to the node or line that
		 * carries them; with nothing left to show, the map does not focus.
		 */
		focus?: Focus;
		/**
		 * A click or tap on a line or its label: one id for a line, several of
		 * one kind for a bundle. Without it, such a click counts as a click on the empty map.
		 */
		onpickline?: (flow: LineKind, edgeIds: readonly string[]) => void;
		/** The user paused the dashboard, and the map holds still until they resume. */
		paused?: boolean;
		/** The pause button by the zoom controls. */
		ontogglepause?: () => void;
		/** The view moves or a pointer is down on the map: true while that lasts. The page holds still with it. */
		onhold?: (held: boolean) => void;
		/** Rates on lines. */
		showRates?: boolean;
		/** The user moved the view, so it stopped refitting. */
		userMoved?: boolean;
		/** Where the view starts instead of a fit: the view the user left, when the map mounts again. */
		initialViewport?: Viewport | null;
		/** The view after each move the user made. */
		onviewport?: (viewport: Viewport) => void;
	};
	let {
		store,
		pools,
		selected,
		onselect,
		onpaneclick,
		onlines,
		focus = null,
		onpickline,
		paused = false,
		ontogglepause,
		onhold,
		showRates = $bindable(false),
		userMoved = $bindable(false),
		initialViewport = null,
		onviewport
	}: Props = $props();
	// Read once: the map mounts with the view it had, or fits.
	const startView = untrack(() => initialViewport);

	let nodes = $state.raw<FlowNode[]>([]);
	/**
	 * Where the drawn lines run, for the line canvas, hit tests and labels.
	 * Changes with the layout only. Svelte Flow gets no edges. LineCanvas.svelte
	 * draws every line from this geometry.
	 */
	let lines = $state.raw<readonly LineGeom[]>([]);
	let slots = $state.raw<readonly LabelSlot[]>([]);
	let obstacles = $state.raw<Obstacles>({ nodes: [], buses: [] });
	/** Boxes of the labels a viewer can see, which a click picks before lines. */
	let labelBoxes = $state.raw<ReadonlyMap<string, Box>>(new Map());
	/** The lines under a resting mouse or pen, from the hit test. */
	let hoverLines = $state.raw<readonly string[]>([]);
	/** The legend item under the pointer. */
	let legendHover = $state<LegendItem | null>(null);
	/** The legend item keyboard focus is on. It lights at once. The rest below is for the pointer. */
	let legendFocus = $state<LegendItem | null>(null);
	/** A mouse or pen rests on a line. */
	const hovering = $derived(hoverLines.length > 0);
	/**
	 * What the canvas lights for a hover: the lines or legend item the
	 * pointer has rested on for HOVER_REST_MS. A pointer sweeping across the
	 * map crosses lines every few frames, and lighting each at once dimmed
	 * and restored the whole map over and over. Leaving clears it at once.
	 */
	const NO_LINES: readonly string[] = [];
	let restedLines = $state.raw(NO_LINES);
	let restedLegend = $state<LegendItem | null>(null);
	$effect(() => {
		const ids = hoverLines;
		const item = legendHover;
		restedLines = NO_LINES;
		restedLegend = null;
		if (ids.length === 0 && item === null) return;
		const timer = setTimeout(() => {
			restedLines = ids;
			restedLegend = item;
		}, HOVER_REST_MS);
		return () => clearTimeout(timer);
	});
	let canvas: HTMLDivElement | undefined = $state();
	let lineInput: LineInput | undefined = $state();

	/**
	 * True while the user pans or zooms: by hand, with the zoom buttons, or
	 * when a node they picked or focused comes into view. The map holds
	 * its numbers, dots pause, nodes take no hover and the viewport gets its
	 * own layer, so the browser moves finished cards instead of painting them
	 * every frame. The line canvas draws each frame the view moves. Refits
	 * leave it false: under churn they come every few seconds, and the dots
	 * and numbers must keep going through them.
	 */
	let moving = $state(false);
	/**
	 * True while a pointer is down anywhere on the map: on its empty part, a
	 * card or a line. The map holds as it does while the view moves, so what
	 * the user is about to click stays put. The click still acts on release.
	 */
	let pressed = $state(false);
	/**
	 * The map holds still: the view moves, a pointer is down, or the user
	 * paused. A boolean of its own, so going from one reason to another
	 * keeps the picture the hold began with.
	 */
	const held = $derived(moving || pressed || paused);
	/** What the map draws: the live store, held still while `held`. */
	const view = $derived(held ? holdStill(store) : store);
	/** The header, the panel and relative times hold with the map, as when paused. */
	const gesture = $derived(moving || pressed);
	$effect(() => onhold?.(gesture));
	// A map that goes away mid-gesture ends the page's hold.
	$effect(() => () => onhold?.(false));

	$effect(() => {
		if (!pressed) return;
		// Capture on the window, so the hold ends before the click it ends in.
		const up = () => (pressed = false);
		window.addEventListener('pointerup', up, true);
		window.addEventListener('pointercancel', up, true);
		window.addEventListener('blur', up);
		return () => {
			window.removeEventListener('pointerup', up, true);
			window.removeEventListener('pointercancel', up, true);
			window.removeEventListener('blur', up);
		};
	});

	// Labels and the hover readout read numbers once a second, so text does
	// not flicker and placement rarely re-runs.
	const slow = new Throttled(
		() => store.edges,
		() => store.edges,
		1000
	);
	/** Those numbers, held still with the rest of the map. */
	const slowEdges = $derived(held ? untrack(() => slow.current) : slow.current);
	/** Focus class tokens of the drawn ids; forgets ids that leave the map. */
	const tokens = new Tokens();
	let index = $state.raw<FocusIndex>(EMPTY_INDEX);
	const bright = $derived(brightIds(focus, index));
	const focusing = $derived(bright.size > 0);
	/**
	 * What a hover lights on the line canvas while no panel has focus: the
	 * lines the pointer rests on, or every line of the legend item it rests on
	 * or keyboard focus is on. The pointer wins. The cards do not change.
	 */
	// Kept while it holds the same lines. The failed ones are worked out again
	// on every publish, and a new set would make the canvas look again.
	let lastHoverBright: ReadonlySet<string> | null = null;
	const hoverBright = $derived.by((): ReadonlySet<string> | null => {
		const next = (() => {
			if (focusing) return null;
			const item = restedLegend ?? (restedLines.length > 0 ? null : legendFocus);
			if (item === 'failed')
				return new Set(lines.filter((l) => (looks.get(l.id)?.fails ?? 0) > 0).map((l) => l.id));
			if (item) return new Set(lines.filter((l) => l.kind === item).map((l) => l.id));
			return restedLines.length > 0 ? new Set(restedLines) : null;
		})();
		return (lastHoverBright = reuseSet(lastHoverBright, next));
	});
	/** "Last 15m" in the middle of the readout: "8% failed (last 15m)". */
	const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
	const names: LineNames = {
		isBuilder: (addr) => view.workers.has(addr),
		groupLabel: (group) => view.clientGroups.get(group)?.label
	};

	// Every line's look from the numbers, and the order lines paint in: idle
	// lines first, so a grey line never cuts through an active one on a
	// shared track. The hit test breaks ties by the same order.
	const looks = $derived(lineLooks(lines, view.edges));
	let lastOrder: readonly string[] = [];
	const order = $derived.by(() => (lastOrder = reconcile(lastOrder, paintOrder(lines, looks))));
	const rank = $derived(new Map(order.map((id, i) => [id, i])));

	setFlowContext({
		get store() {
			return view;
		},
		get selected() {
			return selected;
		},
		get pools() {
			return pools;
		},
		select: (nodeId, from) => onselect(nodeId, from)
	});

	/** Bumped when nodes come, go, move or resize, so the viewport can refit. */
	let layoutVersion = $state(0);
	/** The box around every node, which the view stays near. */
	let bounds = $state.raw<Bounds | null>(null);
	/** A pool is on the map, so the legend explains its cells. */
	let hasPools = $state(false);
	let last: LayoutState | undefined;
	let builtVersion = -1;
	let builtChoices: PoolChoices | null = null;
	/** Counts the user's pans and zooms, and their group toggles, for MapControls. */
	let userMoves = $state(0);
	let toggles = $state(0);

	// Rebuild nodes and lines only when the topology or a pool choice changes.
	// Live numbers reach the node components through the store, never through `data`.
	$effect.pre(() => {
		const topo = view.topology;
		const choices = pools.choices;
		untrack(() => rebuild(topo, choices));
	});

	function rebuild(topo: Topology, choices: PoolChoices) {
		if (topo.version === builtVersion && choices === builtChoices) return;
		// The user toggled a group: show the whole new picture, and keep
		// refitting from here as after the Fit button.
		if (builtChoices && choices !== builtChoices) {
			userMoved = false;
			toggles++;
		}
		builtVersion = topo.version;
		builtChoices = choices;
		// Builders taking work per system, for the more-than-10 rule, so
		// offline and draining builders cannot tip a group into a pool.
		const active = new Map([...view.pools].map(([system, p]) => [system, p.up]));
		const layout = layoutTopology(topo, last, choices, active);
		last = layout;
		pools.shown(layout.pools);
		hasPools = layout.nodes.some((n) => n.kind === 'pool');
		const next = reuseNodes(nodes, layout.nodes, tokens.token);
		nodes = next.nodes;
		index = focusIndex(layout);
		tokens.retain(drawnIds(index));
		lines = lineGeometry(layout);
		slots = labelSlots(lines);
		obstacles = labelObstacles(layout.nodes, lines);
		onlines?.(lines);
		// Refit when the picture changes shape, not when only cells change.
		if (next.moved) {
			layoutVersion++;
			bounds = farmBounds(layout.nodes);
		}
	}

	// One adopted sheet holds the bright rule. A focus change replaces its
	// text and toggles one class, and no node component re-renders. Lines
	// fade on the line canvas.
	let sheet: CSSStyleSheet | undefined;
	$effect(() => {
		const s = new CSSStyleSheet();
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
		sheet = s;
		return () => {
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
			sheet = undefined;
		};
	});
	// A string, so a layout that keeps the bright set replaces nothing.
	const focusRule = $derived(focusCss(bright, tokens.token));
	$effect(() => {
		sheet?.replaceSync(focusRule);
	});
</script>

<div
	class="farm-map"
	class:moving
	class:held
	class:focusing
	class:hovering
	bind:this={canvas}
	onpointerdowncapture={(e) => {
		if (e.isPrimary && e.button === 0) pressed = true;
	}}
>
	<SvelteFlow
		bind:nodes
		{nodeTypes}
		colorMode={theme.mode}
		fitView={!startView}
		initialViewport={startView ?? undefined}
		fitViewOptions={FIT_VIEW}
		minZoom={MIN_ZOOM}
		maxZoom={MAX_ZOOM}
		nodesDraggable={false}
		nodesConnectable={false}
		nodesFocusable={false}
		edgesFocusable={false}
		elementsSelectable={false}
		deleteKey={[]}
		selectionOnDrag={false}
		zoomOnDoubleClick={false}
		onpaneclick={({ event }) => {
			if (repeatClick(event)) return;
			if (!lineInput?.pick(event)) onpaneclick();
		}}
		onmovestart={() => lineInput?.clear()}
		onmove={(event) => {
			// Only a real pan or zoom. A click on a node starts a gesture too,
			// but moves nothing, and must not stop the refits or pause the dots.
			if (event) {
				userMoved = true;
				userMoves++;
			}
			// A move without an input event is an animation. The zoom buttons,
			// reveal and focus set userMoved before they start one, and refits
			// run only while it is false.
			if (userMoved) moving = true;
		}}
		onmoveend={(_, viewport) => {
			moving = false;
			if (userMoved) onviewport?.(viewport);
		}}
		disableKeyboardA11y
		proOptions={{ hideAttribution: true }}
	>
		<MapGrid />
		<LineCanvas
			{lines}
			{looks}
			{order}
			bright={focusing ? bright : hoverBright}
			faded={focusing ? FADED : HOVER_FADED}
			moving={held}
		/>
		<MapControls
			{layoutVersion}
			{bounds}
			bind:userMoved
			panelOpen={focus !== null}
			{userMoves}
			{toggles}
			{paused}
			{ontogglepause}
		/>
		<Legend
			bind:showRates
			{moving}
			pools={hasPools}
			upstream={hasUpstream(view.topology)}
			onhover={(item) => (legendHover = item)}
			onfocusitem={(item) => (legendFocus = item)}
		/>
		{#if showRates}
			<RateLabels
				{slots}
				{obstacles}
				edges={slowEdges}
				{moving}
				bright={focusing ? bright : null}
				token={tokens.token}
				onplaced={(boxes) => (labelBoxes = boxes)}
			/>
		{/if}
		<LineInput
			bind:this={lineInput}
			{lines}
			{rank}
			labels={labelBoxes}
			edges={slowEdges}
			{names}
			window={lower(windowCaption(view.totals.windowMinutes, view.linesSince, 0).text)}
			container={canvas}
			{moving}
			{onpickline}
			onhover={(ids) => (hoverLines = ids)}
		/>
	</SvelteFlow>
</div>

<style>
	.farm-map {
		position: absolute;
		inset: 0;
	}

	/*
	 * While the view moves, the browser shifts and scales a finished picture
	 * of the cards, and the line canvas redraws the lines at the new view.
	 * When it stops, the layer goes, so text paints sharp at the new zoom.
	 */
	.farm-map.moving :global(.svelte-flow__viewport) {
		will-change: transform;
	}

	/*
	 * Nodes sliding under a resting pointer would take hover, and restyle and
	 * repaint as they pass. The drag and the wheel belong to the pane anyway.
	 */
	.farm-map.moving :global(.svelte-flow__node) {
		pointer-events: none;
	}

	.farm-map :global(.svelte-flow__node.passive) {
		pointer-events: none;
	}

	.farm-map.hovering :global(.svelte-flow__pane) {
		cursor: pointer;
	}
</style>
