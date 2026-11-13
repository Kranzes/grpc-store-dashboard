<script lang="ts">
	// The dashboard's mark: a scheduler fanning out to builders.
	let { size = 22 }: { size?: number } = $props();
</script>

<svg class="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
	<path d="M6 12h4m0 0c3 0 3-6 7-6m-7 6c3 0 3 6 7 6m-7-6h7" />
	<circle cx="5" cy="12" r="2.6" class="hub" />
	<circle cx="18.5" cy="6" r="2.1" />
	<circle cx="18.5" cy="12" r="2.1" />
	<circle cx="18.5" cy="18" r="2.1" />
</svg>

<style>
	.mark {
		flex: none;
	}

	path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	circle {
		fill: var(--accent-alt);
	}

	.hub {
		fill: var(--accent);
	}
</style>
