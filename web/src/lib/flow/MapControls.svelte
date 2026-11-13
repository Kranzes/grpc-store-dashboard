<script lang="ts">
	import {
		Panel,
		getViewportForBounds,
		useStore,
		useSvelteFlow,
		type Rect,
		type Viewport
	} from '@xyflow/svelte';
	import { tick, untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { parseNodeId } from '#lib/model/types.ts';
	import Icon from '#lib/ui/Icon.svelte';
	import { formatCount } from '#lib/ui/format.ts';
	import { mapViewKey } from '#lib/ui/pause.svelte.ts';
	import {
		FIT_PADDING,
		FIT_VIEW,
		MAX_ZOOM,
		MIN_ZOOM,
		PANEL_ID,
		getFlowContext,
		poolToggleSelector
	} from './context.ts';
	import { MAX_ROWS, POOL_GRID, poolCellAt, systemHeadingId } from './layout.ts';
	import { clampViewport, panExtent, zoomFloor, type Bounds, type Size } from './limits.ts';
	import type { FlowNode } from './types.ts';

	type Props = {
		/** Changes when nodes come, go, move or resize. */
		layoutVersion: number;
		/** The box around every node, which pans and zooms stay near. null without nodes. */
		bounds: Bounds | null;
		/**
		 * Set once the user pans or zooms, with the mouse, the zoom buttons or by
		 * moving keyboard focus off screen. We then stop refitting on our own.
		 */
		userMoved: boolean;
		/** A detail panel is open: the view holds, and goes back when it closes. */
		panelOpen?: boolean;
		/** Counts the user's own pans and zooms on the map. */
		userMoves?: number;
		/** Counts the user's group toggles, which refit even while a panel is open. */
		toggles?: number;
		/** The dashboard is paused. */
		paused?: boolean;
		/** The pause button; without it, there is none. */
		ontogglepause?: () => void;
	};
	let {
		layoutVersion,
		bounds,
		userMoved = $bindable(),
		panelOpen = false,
		userMoves = 0,
		toggles = 0,
		paused = false,
		ontogglepause
	}: Props = $props();

	const flow = useSvelteFlow();
	const store = useStore();
	const ctx = getFlowContext();
	const duration = $derived(prefersReducedMotion.current ? 0 : 300);
	let toolbar: HTMLElement | undefined = $state();
	const pane = $derived(toolbar?.closest<HTMLElement>('.svelte-flow') ?? null);

	/** Where a refit's animation goes, and until when it runs, in performance.now() ms. */
	let fitting: { to: Viewport; until: number } | null = null;
	/** The view a running refit ends at. */
	const fitTarget = () => (fitting && performance.now() < fitting.until ? fitting.to : null);

	/**
	 * Fit the whole farm. Unless forced, skip it when the fit would keep the
	 * zoom and the farm is still in view, so a pool growing a row of cells does
	 * not nudge the picture every time.
	 */
	function refit(force = false) {
		if (!pane) return;
		const { width, height } = pane.getBoundingClientRect();
		const nodes = flow.getNodes();
		fitting = null;
		if (width > 0 && height > 0 && nodes.length > 0) {
			const bounds = flow.getNodesBounds(nodes);
			const fit = getViewportForBounds(
				bounds,
				width,
				height,
				MIN_ZOOM,
				FIT_VIEW.maxZoom ?? 1,
				FIT_VIEW.padding ?? 0
			);
			const now = flow.getViewport();
			const fitted = Math.abs(fit.zoom - now.zoom) < 1e-3 && inView(bounds, now, width, height);
			if (!force && fitted) return;
			// Svelte Flow starts the animation within a frame or two.
			if (duration > 0) fitting = { to: fit, until: performance.now() + duration + 50 };
		}
		flow.fitView({ ...FIT_VIEW, duration });
	}

	// A press on the map stops a refit's animation where it is, since d3-zoom
	// interrupts it on mousedown and touchstart. A click is no move of the
	// user's, so nothing would fit the view again. Finish the fit on release,
	// before the click opens a panel.
	$effect(() => {
		// The pane at setup: by teardown, the derived may read null.
		const el = pane;
		if (!el) return;
		const stop = () => {
			window.removeEventListener('pointerup', onup, true);
			window.removeEventListener('pointercancel', onup, true);
		};
		const onup = () => {
			stop();
			if (!userMoved) refit(true);
		};
		const ondown = (e: PointerEvent) => {
			if (!fitTarget()) return;
			if (!(e.target as Element | null)?.closest?.('.svelte-flow__zoom')) return;
			window.addEventListener('pointerup', onup, true);
			window.addEventListener('pointercancel', onup, true);
		};
		el.addEventListener('pointerdown', ondown, true);
		return () => {
			stop();
			el.removeEventListener('pointerdown', ondown, true);
		};
	});

	function inView(b: Rect, v: { x: number; y: number; zoom: number }, w: number, h: number) {
		const e = 0.5;
		return (
			b.x * v.zoom + v.x >= FIT_PADDING.left - e &&
			b.y * v.zoom + v.y >= FIT_PADDING.top - e &&
			(b.x + b.width) * v.zoom + v.x <= w - FIT_PADDING.right + e &&
			(b.y + b.height) * v.zoom + v.y <= h - FIT_PADDING.bottom + e
		);
	}

	/**
	 * The view when a panel opened, to go back to when it closes: during a
	 * refit, the fit. `keep` turns false once the user moves the view or the
	 * window changes size meanwhile.
	 */
	let opened: {
		view: { x: number; y: number; zoom: number };
		layout: number;
		keep: boolean;
	} | null = null;
	let seenToggles = untrack(() => toggles);

	// Initial fitView runs before the first snapshot arrives, so fit again
	// whenever the map changes, unless the user has taken over the view.
	// While a panel is open the view holds still, and a change waits for the
	// panel to close, but a group the user toggles refits at once.
	$effect(() => {
		void layoutVersion;
		const toggled = toggles !== seenToggles;
		if (userMoved) {
			seenToggles = toggles;
			return;
		}
		if (untrack(() => panelOpen) && !toggled) return;
		if (toggled && opened) opened.keep = false;
		// Let Svelte Flow measure the new nodes first. A toggle counts as seen
		// once its refit runs, so a layout change meanwhile does not drop it.
		const seen = toggles;
		const t = setTimeout(() => {
			seenToggles = seen;
			refit();
		}, 30);
		return () => clearTimeout(t);
	});

	// A panel opening keeps the zoom and the pan: reveal pans only when the
	// node would be hidden. Closing it goes back to the view from before,
	// unless the user moved the view, toggled a group or resized the window
	// meanwhile, or the layout changed under a view that refits. Then it
	// refits, unless the user has taken over the view.
	$effect(() => {
		const open = panelOpen;
		untrack(() => {
			if (open && !opened) {
				const view = fitTarget() ?? flow.getViewport();
				opened = { view, layout: layoutVersion, keep: true };
			} else if (!open && opened) {
				const was = opened;
				opened = null;
				// After the pane has its width back.
				// A view the user chose before the panel opened comes back even when the
				// layout changed meanwhile, as no refit would replace reveal's pan.
				setTimeout(() => {
					if (panelOpen) return;
					if (was.keep && (was.layout === layoutVersion || userMoved))
						flow.setViewport(limited(was.view), { duration });
					else if (!userMoved) refit();
				}, 30);
			}
		});
	});

	// The user's own pans and zooms while a panel is open: the view stays where they put it.
	$effect(() => {
		void userMoves;
		if (opened) opened.keep = false;
	});

	// The window changes size: fit the farm into it. A panel docking beside
	// the map narrows the pane without that, and the view stays.
	$effect(() => {
		if (!pane) return;
		let t: ReturnType<typeof setTimeout> | undefined;
		let win: { w: number; h: number } | null = null;
		const ro = new ResizeObserver(() => {
			const r = pane.getBoundingClientRect();
			paneSize = { width: r.width, height: r.height };
			const resized = !win || win.w !== window.innerWidth || win.h !== window.innerHeight;
			win = { w: window.innerWidth, h: window.innerHeight };
			if (!resized) return;
			if (opened) opened.keep = false;
			clearTimeout(t);
			t = setTimeout(() => {
				if (userMoved) return;
				refit();
				// The refit may put the open node under a floating panel.
				const id = ctx.selected;
				if (id) t = setTimeout(() => reveal(id), 60 + duration);
			}, 30);
		});
		ro.observe(pane);
		return () => {
			clearTimeout(t);
			ro.disconnect();
		};
	});

	// Pans and zooms stay near the farm, by the limits in limits.ts. Svelte
	// Flow's pan extent and zoom range follow the layout, the pane, the zoom and
	// a panel that floats over the map. They hold back the user's own pans and
	// zooms; the views that refits, Fit, reveal and focus set are inside them.
	let paneSize = $state<Size | null>(null);
	/** Screen px at the pane's right under a floating panel. */
	let cover = $state(0);
	const zoom = $derived(store.viewport.zoom);
	$effect(() => {
		const pz = store.panZoom;
		if (!pz || !bounds || !paneSize || paneSize.width <= 0 || paneSize.height <= 0) return;
		const floor = zoomFloor(bounds, paneSize);
		pz.setScaleExtent([floor, MAX_ZOOM]);
		pz.setTranslateExtent(panExtent(bounds, paneSize, Math.max(zoom, floor), cover));
	});

	/** A view moved inside the limits, or as it is without them yet. */
	function limited(v: { x: number; y: number; zoom: number }) {
		return bounds && paneSize && paneSize.width > 0 ? clampViewport(v, bounds, paneSize, cover) : v;
	}

	// When the farm shrinks or the pane changes under a view the user chose,
	// or that holds for an open panel, bring the view back inside. Otherwise
	// the refit does.
	$effect(() => {
		void bounds;
		void paneSize;
		untrack(() => {
			if (!(userMoved || panelOpen) || store.dragging) return;
			const v = flow.getViewport();
			const next = limited(v);
			if (next !== v) flow.setViewport(next, { duration });
		});
	});

	// No panel, nothing floats over the map.
	$effect(() => {
		if (!ctx.selected) cover = 0;
	});

	// Keep the node whose panel is open in view: a narrower screen floats the
	// panel over the map, and the farm's right side ends up under it. Runs
	// after any refit for the new map size has settled.
	$effect(() => {
		const id = ctx.selected;
		if (!id) return;
		const t = setTimeout(() => reveal(id), 60 + duration);
		return () => clearTimeout(t);
	});

	/**
	 * Pan, without zooming, until the selected node or its cell in a pool shows,
	 * clear of a floating panel and of the zoom buttons.
	 */
	function reveal(id: string) {
		if (!pane) return;
		const box = pane.getBoundingClientRect();
		const panel = document.getElementById(PANEL_ID)?.getBoundingClientRect();
		// The part of the map left of a panel that floats over it.
		const right =
			panel && panel.left < box.right && panel.right > box.left
				? Math.min(box.width, panel.left - box.left)
				: box.width;
		cover = Math.max(0, box.width - right);
		const ref = parseNodeId(id);
		let n = flow.getNode(id) as FlowNode | undefined;
		let cell = -1;
		if (!n && ref?.kind === 'builder') {
			n = (flow.getNodes() as FlowNode[]).find(
				(x) => x.type === 'pool' && x.data.cells?.includes(ref.addr)
			);
			cell = n?.data.cells?.indexOf(ref.addr) ?? -1;
		}
		if (!n) return;
		const v = flow.getViewport();
		const node = rectOf(n.position.x, n.position.y, n.width ?? 0, n.height ?? 0, v);
		const margin = 16;
		const fits = (r: Rect) => r.width <= right - 2 * margin && r.height <= box.height - 2 * margin;
		// The whole node if it fits, else the builder's cell, else the node's top left.
		let target = node;
		if (!fits(node) && cell >= 0) {
			const at = poolCellAt(cell);
			target = rectOf(
				n.position.x + POOL_GRID.pad + POOL_GRID.border + at.x,
				n.position.y + POOL_GRID.head + at.y,
				POOL_GRID.cell,
				POOL_GRID.cell,
				v
			);
		}
		let dx = shift(target.x, target.width, margin, right - margin);
		let dy = shift(target.y, target.height, margin, box.height - margin);
		// The zoom buttons cover the map's bottom right corner, as a docked panel
		// covers its side: clear them by the shorter pan, left or up, that fits.
		const controls = toolbar?.closest('.svelte-flow__panel')?.getBoundingClientRect();
		if (controls) {
			const x = target.x + dx;
			const y = target.y + dy;
			const left = controls.left - box.left - margin;
			const top = controls.top - box.top - margin;
			const under =
				x < controls.right - box.left &&
				x + target.width > left &&
				y < controls.bottom - box.top &&
				y + target.height > top;
			if (under) {
				const byX = x + target.width - left;
				const byY = y + target.height - top;
				const canX = x - byX >= margin;
				const canY = y - byY >= margin;
				if (canX && (!canY || byX <= byY)) dx -= byX;
				else if (canY) dy -= byY;
			}
		}
		if (dx === 0 && dy === 0) return;
		// Not a move of the user's: the view goes back when the panel closes,
		// and the layout effect holds refits until then.
		flow.setViewport(limited({ x: v.x + dx, y: v.y + dy, zoom: v.zoom }), { duration });
	}

	function rectOf(
		x: number,
		y: number,
		w: number,
		h: number,
		v: { x: number; y: number; zoom: number }
	): Rect {
		return { x: x * v.zoom + v.x, y: y * v.zoom + v.y, width: w * v.zoom, height: h * v.zoom };
	}

	/** How far to move [start, start + size] into [lo, hi]; its start wins when it cannot fit. */
	function shift(start: number, size: number, lo: number, hi: number): number {
		if (start < lo || size > hi - lo) return lo - start;
		if (start + size > hi) return hi - (start + size);
		return 0;
	}

	// Keyboard users tab through node buttons and group toggles; bring the
	// focused one's node into view. Svelte Flow does this for its own
	// focusable wrappers, which we turn off.
	$effect(() => {
		const onfocusin = (e: FocusEvent) => {
			const el = e.target as HTMLElement;
			const id = el.closest?.('.svelte-flow__node')?.getAttribute('data-id');
			const box = el.closest?.('.svelte-flow')?.getBoundingClientRect();
			const n = id ? flow.getNode(id) : undefined;
			if (!n || !box || !el.matches(':focus-visible')) return;
			// Flow coordinates, not DOM rects: the browser may have scrolled the
			// pane to the element already, and Svelte Flow undoes that scroll.
			const { x, y, zoom } = flow.getViewport();
			const w = n.measured?.width ?? n.width ?? 0;
			const h = n.measured?.height ?? n.height ?? 0;
			const left = n.position.x * zoom + x;
			const top = n.position.y * zoom + y;
			if (left >= 0 && top >= 0 && left + w * zoom <= box.width && top + h * zoom <= box.height)
				return;
			// The user moved focus there, so a refit must not take it away again.
			// Near the farm's edge the limits keep it off the middle, but on screen.
			userMoved = true;
			if (opened) opened.keep = false;
			const cx = n.position.x + w / 2;
			const cy = n.position.y + h / 2;
			const at = { x: box.width / 2 - cx * zoom, y: box.height / 2 - cy * zoom, zoom };
			flow.setViewport(limited(at), { duration });
		};
		document.addEventListener('focusin', onfocusin);
		return () => document.removeEventListener('focusin', onfocusin);
	});

	function fit() {
		userMoved = false;
		if (opened) opened.keep = false;
		refit(true);
	}

	// +, - and 0 work like the buttons, anywhere but in a field, as mapViewKey
	// in pause.svelte.ts decides.
	function onkeydown(e: KeyboardEvent) {
		const action = mapViewKey(e);
		if (!action) return;
		e.preventDefault();
		if (action === 'fit') fit();
		else zoomBy(action);
	}

	// Programmatic zooms report no input event to onmovestart, so mark them here.
	function zoomBy(step: 'in' | 'out') {
		userMoved = true;
		if (opened) opened.keep = false;
		if (step === 'in') flow.zoomIn({ duration });
		else flow.zoomOut({ duration });
	}

	// Groups the user opened as cards although they would be pools. Hundreds of
	// cards do not fit on screen, and the heading toggle gets tiny, so offer a
	// way back here too.
	const expanded = $derived(
		ctx.pools
			.expanded()
			.map((system) => ({ system, n: ctx.store.pools.get(system)?.builders ?? 0 }))
			.filter((g) => g.n > MAX_ROWS && !ctx.pools.collapsed(g.system))
	);
	/** A group's builder count as its heading shows it, which counts lingering offline cards too. */
	const headingCount = (system: string) => {
		const id = systemHeadingId(system);
		return (store.nodes.find((n) => n.id === id)?.data as FlowNode['data'] | undefined)?.count ?? 0;
	};

	async function collapse(system: string) {
		ctx.pools.set(system, true);
		await tick();
		document.querySelector<HTMLElement>(poolToggleSelector(system))?.focus({ preventScroll: true });
	}
</script>

<svelte:window {onkeydown} />

<Panel position="bottom-right" class="map-controls">
	<div class="wrap">
		{#if expanded.length > 0}
			<ul class="chips" aria-label="Pools shown as cards">
				{#each expanded as g (g.system)}
					<li>
						<button
							type="button"
							class="chip"
							title="Collapse these {formatCount(headingCount(g.system))} builders into one pool"
							onclick={() => collapse(g.system)}
						>
							<span class="mono">{g.system}</span>
							<span class="muted" aria-hidden="true">·</span>
							<span class="action">Collapse</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="group" role="toolbar" aria-label="Map view" bind:this={toolbar}>
			<button type="button" onclick={() => zoomBy('in')} title="Zoom in (+)" aria-keyshortcuts="+">
				<Icon name="plus" label="Zoom in" />
			</button>
			<button
				type="button"
				onclick={() => zoomBy('out')}
				title="Zoom out (-)"
				aria-keyshortcuts="-"
			>
				<Icon name="minus" label="Zoom out" />
			</button>
			<button
				type="button"
				onclick={fit}
				title="Fit the whole farm (0)"
				aria-keyshortcuts="0"
				class:dim={!userMoved}
			>
				<Icon name="fit" label="Fit the whole farm" />
			</button>
			{#if ontogglepause}
				<button
					type="button"
					class="toggle pause"
					aria-pressed={paused}
					aria-keyshortcuts="P"
					title={paused ? 'Resume (P)' : 'Pause (P)'}
					onclick={ontogglepause}
				>
					<Icon name={paused ? 'play' : 'pause'} label="Pause" />
				</button>
			{/if}
		</div>
	</div>
</Panel>

<style>
	.wrap {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.chips {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
		height: 32px;
		padding: 0 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg-node);
		box-shadow: var(--shadow-md);
		color: var(--fg);
		font-size: var(--text-xs);
		line-height: 30px;
		white-space: nowrap;
	}

	.chip:hover {
		border-color: var(--border-strong);
	}

	.chip .mono {
		font-weight: 600;
	}

	.muted {
		color: var(--fg-muted);
	}

	.action {
		color: var(--accent-strong);
		font-weight: 600;
	}

	.chip:hover .action {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.group {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg-node);
		box-shadow: var(--shadow-md);
	}

	.group button {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		border-bottom: 1px solid var(--border-subtle);
		background: transparent;
		color: var(--fg-muted);
		transition:
			background var(--dur-fast),
			color var(--dur-fast);
	}

	.group button:last-child {
		border-bottom: 0;
	}

	.group button:hover {
		background: var(--bg-raised);
		color: var(--fg);
	}

	.group button:focus-visible,
	.chip:focus-visible {
		outline-offset: -2px;
	}

	.dim {
		color: var(--fg-faint);
	}

	.group .toggle[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent-strong);
	}

	/* Paused, in the status pill's pink. */
	.group .pause[aria-pressed='true'] {
		background: var(--paused-soft);
		color: var(--paused-fg);
	}
</style>
