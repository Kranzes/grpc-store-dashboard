<script lang="ts">
	import { useViewport } from '@xyflow/svelte';

	/** Grid pitch and dot size in flow px, as Svelte Flow's `<Background gap={24} size={1.2}>`. */
	const GAP = 24;
	const SIZE = 1.2;

	const uid = $props.id();
	const id = `map-grid-${uid}`;
	const viewport = useViewport();

	const zoom = $derived(viewport.current.zoom);
	const gap = $derived(GAP * zoom || 1);
	const r = $derived((SIZE * zoom) / 2);
	// Within one pitch, so a pan only shifts the layer and never repaints it.
	const dx = $derived(mod(viewport.current.x, gap));
	const dy = $derived(mod(viewport.current.y, gap));

	function mod(a: number, n: number) {
		return ((a % n) + n) % n;
	}
</script>

<!--
	Svelte Flow's Background moves its pattern by redrawing it on every pan
	step, which repaints the whole map each frame. This grid draws the same
	dots one pitch larger than the map, on a layer of its own, and moves it
	by a transform, so a pan repaints nothing. Only a zoom redraws it.
-->
<div class="map-grid" aria-hidden="true">
	<svg
		style:inset="-{gap}px auto auto -{gap}px"
		style:width="calc(100% + {gap}px)"
		style:height="calc(100% + {gap}px)"
		style:transform="translate({dx}px, {dy}px)"
	>
		<pattern {id} x={-r} y={-r} width={gap} height={gap} patternUnits="userSpaceOnUse">
			<circle cx={r} cy={r} {r} />
		</pattern>
		<rect width="100%" height="100%" fill="url(#{id})" />
	</svg>
</div>

<style>
	.map-grid {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
	}

	svg {
		position: absolute;
		will-change: transform;
	}

	circle {
		fill: var(--xy-background-pattern-color);
	}
</style>
