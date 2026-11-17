<script lang="ts">
	import { useViewport } from '@xyflow/svelte';
	import { onDestroy } from 'svelte';
	import { LINE_KINDS, type LineKind } from './kinds.ts';
	import { theme } from '#lib/theme/theme.svelte.ts';
	import type { LineGeom } from './geometry.ts';
	import { FADED, LineLayer, type Colors } from './lineLayer.ts';
	import { browserFrames } from './motion.ts';
	import { probeOn, type LineProbe } from './probe.ts';
	import type { LineLook } from './traffic.ts';

	type Props = {
		/** The drawn lines, from the layout, in layout order. */
		lines: readonly LineGeom[];
		/** Each line's look from the store's numbers. */
		looks: ReadonlyMap<string, LineLook>;
		/** Paint order, bottom first. */
		order: readonly string[];
		/** Ids that stay bright while something is focused or hovered, or null without either. */
		bright: ReadonlySet<string> | null;
		/** What the other lines fade to: FADED for focus, HOVER_FADED for a hover. */
		faded?: number;
		/** The map holds still for a pan or zoom, a pointer down or a pause, and so do the dots. */
		moving: boolean;
	};
	let { lines, looks, order, bright, faded = FADED, moving }: Props = $props();

	const viewport = useViewport();
	const env = browserFrames();
	const layer = env ? new LineLayer(env) : null;
	onDestroy(() => layer?.destroy());
	let canvas: HTMLCanvasElement | undefined = $state();
	let marksCanvas: HTMLCanvasElement | undefined = $state();
	let swatches: HTMLElement | undefined = $state();

	// In this order on mount: the lines, then their looks.
	$effect(() => layer?.setLines(lines));
	$effect(() => layer?.setLooks(looks, order));
	$effect(() => layer?.setFocus(bright, faded));
	$effect(() => {
		if (!moving || !layer) return;
		layer.pause();
		return () => layer.resume();
	});
	// The view's moves draw at once, in the frame that moves the cards.
	$effect(() => {
		const v = viewport.current;
		layer?.setView(v.x, v.y, v.zoom);
	});

	$effect(() => {
		const el = canvas;
		const marksEl = marksCanvas;
		if (!el || !marksEl || !layer) return;
		const ctx = el.getContext('2d');
		const marks = marksEl.getContext('2d');
		layer.attach(ctx, marks);
		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			const w = el.clientWidth;
			const h = el.clientHeight;
			const pw = Math.round(w * dpr);
			const ph = Math.round(h * dpr);
			for (const c of [el, marksEl]) {
				if (c.width !== pw) c.width = pw;
				if (c.height !== ph) c.height = ph;
			}
			layer.setSize(w, h, dpr);
		};
		const ro = new ResizeObserver(resize);
		ro.observe(el);
		resize();
		// A window moved to a screen of another pixel ratio, or a browser zoom.
		let dpr: MediaQueryList | null = null;
		const watchDpr = () => {
			dpr?.removeEventListener('change', onDpr);
			dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
			dpr.addEventListener('change', onDpr);
		};
		const onDpr = () => {
			resize();
			watchDpr();
		};
		watchDpr();
		const onVisibility = () => layer.setHidden(document.visibilityState === 'hidden');
		document.addEventListener('visibilitychange', onVisibility);
		onVisibility();
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
		const onReduced = () => layer.setReduced(reduced.matches);
		reduced.addEventListener('change', onReduced);
		onReduced();
		// A GPU reset clears the canvases; draw again once they are back.
		const onRestored = () => layer.attach(ctx, marks);
		el.addEventListener('contextrestored', onRestored);
		marksEl.addEventListener('contextrestored', onRestored);
		if (probeOn()) {
			const probe: LineProbe = {
				report: () => layer.report(),
				order: () => layer.order,
				draws: () => ({ count: layer.draws, ms: layer.drawMs, strokeDraws: layer.strokeDraws }),
				travel: () => layer.travel(),
				flow: (id, s) => layer.point(id, s),
				client: (id, s) => {
					const p = layer.point(id, s);
					if (!p) return null;
					const box = el.getBoundingClientRect();
					const v = viewport.current;
					return { x: box.left + v.x + p.x * v.zoom, y: box.top + v.y + p.y * v.zoom };
				},
				length: (id) => layer.report().find((l) => l.id === id)?.length ?? null,
				colors: () => layer.colors
			};
			(window as unknown as { __lines?: LineProbe }).__lines = probe;
		}
		return () => {
			ro.disconnect();
			dpr?.removeEventListener('change', onDpr);
			document.removeEventListener('visibilitychange', onVisibility);
			reduced.removeEventListener('change', onReduced);
			el.removeEventListener('contextrestored', onRestored);
			marksEl.removeEventListener('contextrestored', onRestored);
			layer.attach(null, null);
		};
	});

	// Colors come from the theme's tokens, resolved by the browser, so both
	// flavors and the system preference apply as they do to everything else.
	$effect(() => {
		void theme.mode;
		const el = swatches;
		if (!el || !layer) return;
		const color = (cls: string) =>
			getComputedStyle(el.querySelector(`.${cls}`) ?? el).getPropertyValue('color');
		const read = () =>
			layer.setColors({
				...(Object.fromEntries(LINE_KINDS.map((k) => [k, color(`flow-${k}`)])) as Record<
					LineKind,
					string
				>),
				idle: color('idle'),
				danger: color('danger')
			} satisfies Colors);
		read();
		const scheme = window.matchMedia('(prefers-color-scheme: dark)');
		scheme.addEventListener('change', read);
		return () => scheme.removeEventListener('change', read);
	});
</script>

<!--
	Every line on one canvas the size of the visible map, and its dots and
	failure marks on another over it, drawn by lineLayer.ts. They sit under the
	cards and take no pointer events; clicks and hover reach lines through
	LineInput's hit test.
-->
<div class="line-layer" aria-hidden="true">
	<canvas class="line-canvas" bind:this={canvas}></canvas>
	<canvas class="line-canvas marks" bind:this={marksCanvas}></canvas>
</div>
<div class="swatches" bind:this={swatches} aria-hidden="true">
	{#each LINE_KINDS as kind (kind)}<i class="flow-{kind}"></i>{/each}
	<i class="idle"></i>
	<i class="danger"></i>
</div>

<style>
	.line-layer {
		position: absolute;
		inset: 0;
		z-index: -1;
		pointer-events: none;
	}

	.line-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.swatches {
		display: none;
	}

	.swatches i {
		color: var(--flow-c);
	}

	.swatches .idle {
		color: var(--flow-idle);
	}

	.swatches .danger {
		color: var(--danger);
	}
</style>
