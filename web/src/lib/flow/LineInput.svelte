<script lang="ts">
	import { useSvelteFlow, useViewport } from '@xyflow/svelte';
	import { untrack } from 'svelte';
	import { reconcile } from '#lib/model/reconcile.ts';
	import type { EdgeView } from '#lib/model/types.ts';
	import type { LineKind } from './kinds.ts';
	import { hitLines, type LineGeom } from './geometry.ts';
	import { readoutText, sumLines, type Box } from './labels.ts';
	import LineReadout from './LineReadout.svelte';
	import { lineTitle, type LineNames } from './lines.ts';

	type Props = {
		/** The drawn lines, from the layout. */
		lines: readonly LineGeom[];
		/** Each line's place in the paint order: where lines cross, the one on top wins. */
		rank: ReadonlyMap<string, number>;
		/** Boxes of the labels a viewer can see, in flow px. A label stands for its line. */
		labels: ReadonlyMap<string, Box>;
		/** Live numbers, refreshed once a second. */
		edges: ReadonlyMap<string, EdgeView>;
		names: LineNames;
		/** What line counts cover: "last 15m", or "since 23:41" before the page was live that long. */
		window: string;
		/** The element the canvas fills. Hover listens on it. */
		container: HTMLElement | undefined;
		/** The user pans or zooms. Hover then runs no hit test and shows nothing. */
		moving: boolean;
		/** A click or tap picked one line id, or several ids of one kind for a bundle. */
		onpickline?: (flow: LineKind, edgeIds: readonly string[]) => void;
		/** The lines under a resting mouse or pen changed. Empty when there are none. */
		onhover?: (edgeIds: readonly string[]) => void;
	};
	let { lines, rank, labels, edges, names, window, container, moving, onpickline, onhover }: Props =
		$props();

	const flow = useSvelteFlow();
	const viewport = useViewport();
	const kinds = $derived(new Map(lines.map((l) => [l.id, l.kind])));

	/** Mouse and pen reach a line within 6 screen px; a finger within 14. */
	function tolerance(touch: boolean): number {
		const { zoom } = flow.getViewport();
		return touch ? 14 / zoom : Math.max(6, 6 / zoom);
	}

	/** The lines a point on screen means: a visible label's line first, then the hit test. */
	function linesAt(clientX: number, clientY: number, touch: boolean): string[] {
		const p = flow.screenToFlowPosition({ x: clientX, y: clientY }, { snapToGrid: false });
		for (const [id, b] of labels) {
			if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return [id];
		}
		return hitLines(lines, [p.x, p.y], tolerance(touch), rank);
	}

	/**
	 * Handles a click on the pane. True when it picked a line, so the caller
	 * does not treat it as a click on the empty map.
	 */
	export function pick(event: MouseEvent): boolean {
		if (!onpickline) return false;
		const touch = 'pointerType' in event && (event as PointerEvent).pointerType === 'touch';
		const ids = linesAt(event.clientX, event.clientY, touch);
		const kind = ids.length > 0 ? kinds.get(ids[0]) : undefined;
		if (!kind) return false;
		clear();
		onpickline(kind, ids);
		return true;
	}

	let hovered = $state.raw<readonly string[]>([]);
	let at = $state.raw({ x: 0, y: 0, width: 0, height: 0 });

	function show(ids: readonly string[]) {
		if (reconcile(hovered, ids) === hovered) return;
		hovered = ids;
		onhover?.(ids);
	}

	/** Hide the readout: the pointer left, a button went down, or the view moves. */
	export function clear() {
		show([]);
	}

	/** Tests again where the pointer rests on the map. Set while the listeners are. */
	let again: (() => void) | null = null;

	$effect(() => {
		const el = container;
		if (!el) return;
		let frame = 0;
		let last: PointerEvent | null = null;
		const run = (rested = false) => {
			frame = 0;
			const e = last;
			if (!e || moving) return;
			// A card may have moved under a pointer that rests.
			const under = rested ? document.elementFromPoint(e.clientX, e.clientY) : null;
			if (rested && !under?.classList.contains('svelte-flow__pane')) {
				last = null;
				show([]);
				return;
			}
			const box = el.getBoundingClientRect();
			const ids = linesAt(e.clientX, e.clientY, false);
			at = {
				x: e.clientX - box.left,
				y: e.clientY - box.top,
				width: box.width,
				height: box.height
			};
			show(ids);
		};
		const onmove = (e: PointerEvent) => {
			const pane = (e.target as Element | null)?.classList?.contains('svelte-flow__pane');
			// Lines slide under a resting pointer while the view moves, and the
			// map holds still then, so hover waits until the view stops.
			if (moving || e.pointerType === 'touch' || e.buttons !== 0 || !pane) {
				last = null;
				show([]);
				return;
			}
			// At most one hit test per frame while the pointer moves. While it
			// rests, only when the lines or the view move under it, through `again`.
			last = e;
			if (!frame) frame = requestAnimationFrame(() => run());
		};
		const onleave = () => {
			last = null;
			show([]);
		};
		again = () => {
			if (last && !moving && !frame) frame = requestAnimationFrame(() => run(true));
		};
		el.addEventListener('pointermove', onmove);
		el.addEventListener('pointerleave', onleave);
		el.addEventListener('pointerdown', onleave);
		return () => {
			again = null;
			cancelAnimationFrame(frame);
			el.removeEventListener('pointermove', onmove);
			el.removeEventListener('pointerleave', onleave);
			el.removeEventListener('pointerdown', onleave);
		};
	});

	// A new layout, or a refit, moves the lines under a resting pointer
	// without a pointermove: test again, or the readout and the light stay
	// on lines that moved away or are gone.
	$effect(() => {
		void lines;
		void viewport.current;
		untrack(() => again?.());
	});

	const kind = $derived(hovered.length > 0 ? kinds.get(hovered[0]) : undefined);
	const title = $derived(kind ? lineTitle(kind, hovered, names) : null);
	const numbers = $derived(kind ? readoutText(kind, sumLines(hovered, edges), window) : null);
</script>

{#if kind && title && numbers}
	<LineReadout {kind} {title} {numbers} x={at.x} y={at.y} width={at.width} height={at.height} />
{/if}
