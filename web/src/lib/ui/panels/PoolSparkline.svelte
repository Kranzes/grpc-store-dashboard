<script lang="ts">
	import { POOL_HISTORY_MINUTES, type PoolView } from '#lib/model/types.ts';
	import WindowCaption from '../WindowCaption.svelte';
	import {
		SPARK,
		nearestPoint,
		sparkPath,
		sparkReading,
		sparkX,
		sparkY,
		type SparkKey
	} from './sparkline.ts';

	// A pool's last hour: slots in use in the slots' blue, and busy CPUs in
	// muted ink, as on the builder cards. The legend names both lines and
	// gives their latest values, or the picked minute's while the pointer or
	// the arrow keys pick one.
	type Props = { pool: PoolView };
	let { pool }: Props = $props();

	// Measured width. The first paint and server rendering assume the panel body's width.
	let width = $state(430);
	const points = $derived(pool.history);
	const withCpu = $derived(points.some((p) => p.cpu !== null));
	const paths = $derived({
		slots: sparkPath(points, 'slots', width),
		cpu: sparkPath(points, 'cpu', width)
	});
	const end = $derived(points.at(-1)?.t ?? 0);
	const last = $derived(points.length - 1);

	/** The minute the pointer is on, or the keys picked. null: none, the legend shows now. */
	let hover = $state<number | null>(null);
	let cursor = $state<number | null>(null);
	let focused = $state(false);
	const picked = $derived(hover ?? (focused ? cursor : null));
	const at = $derived(picked !== null && picked <= last ? picked : null);
	const shown = $derived(points[at ?? last]);
	const reading = $derived(shown ? sparkReading(shown, withCpu) : null);
	const keyed = $derived(cursor ?? last);

	function point(e: PointerEvent) {
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const i = nearestPoint(points, e.clientX - box.left, width);
		if (i < 0) return;
		hover = i;
		cursor = i;
	}

	// As on any slider, Up and Down step too.
	const STEPS: Record<string, (i: number) => number> = {
		ArrowLeft: (i) => i - 1,
		ArrowDown: (i) => i - 1,
		ArrowRight: (i) => i + 1,
		ArrowUp: (i) => i + 1,
		Home: () => 0,
		End: () => last
	};

	function key(e: KeyboardEvent) {
		const step = STEPS[e.key];
		if (!step) return;
		e.preventDefault();
		hover = null;
		cursor = Math.max(0, Math.min(last, step(keyed)));
	}

	// A dot where each line is at the shown minute.
	const ends = $derived(
		(['slots', 'cpu'] as SparkKey[])
			.map((k) => {
				const v = shown?.[k] ?? null;
				return v === null ? null : { k, x: sparkX(shown.t, end, width), y: sparkY(v) };
			})
			.filter((e) => e !== null)
	);
</script>

<section class="p-section">
	<div class="p-head">
		<h3>{withCpu ? 'Slots and CPU' : 'Slots in use'}</h3>
		<WindowCaption minutes={POOL_HISTORY_MINUTES} since={pool.historySince} />
	</div>
	{#if points.length === 0}
		<p class="p-caption">The history starts with the scheduler's next update.</p>
	{:else}
		<!-- Names both lines, so color is never alone; values of now, or of the picked minute. -->
		<p class="legend num" aria-hidden="true">
			<span class="when">{at === null ? 'Now' : reading?.time}</span>
			<span><i class="key slots"></i>Slots <strong>{reading?.slots}</strong></span>
			{#if withCpu}
				<span><i class="key cpu"></i>CPU <strong>{reading?.cpu}</strong></span>
			{/if}
		</p>
		<div class="plot" bind:clientWidth={width}>
			<svg {width} height={SPARK.height} aria-hidden="true">
				<line class="rule" x1="0" x2={width} y1={sparkY(1)} y2={sparkY(1)} />
				<text class="top num" x={width} y={sparkY(1) - 4} text-anchor="end">100%</text>
				<line class="base" x1="0" x2={width} y1={sparkY(0)} y2={sparkY(0)} />
				{#if paths.cpu}<path class="line cpu" d={paths.cpu} />{/if}
				<path class="line slots" d={paths.slots} />
				{#if at !== null}
					{@const x = sparkX(points[at].t, end, width)}
					<line class="hair" x1={x} x2={x} y1="0" y2={SPARK.height} />
				{/if}
				{#each ends as e (e.k)}
					<circle class="dot {e.k}" cx={e.x} cy={e.y} r="4" />
				{/each}
			</svg>
			<div
				class="scrub"
				role="slider"
				tabindex="0"
				aria-label={withCpu
					? 'Slots in use and busy CPUs, a minute a step'
					: 'Slots in use, a minute a step'}
				aria-valuemin={0}
				aria-valuemax={last}
				aria-valuenow={at ?? last}
				aria-valuetext={reading?.spoken}
				onpointermove={point}
				onpointerdown={point}
				onpointerleave={() => (hover = null)}
				onkeydown={key}
				onfocus={() => (focused = true)}
				onblur={() => (focused = false)}
			></div>
		</div>
	{/if}
</section>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px var(--space-3);
		margin: 0;
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.legend strong {
		color: var(--fg);
		font-weight: 600;
	}

	.when {
		min-width: 3.5em;
	}

	.key {
		display: inline-block;
		width: 10px;
		height: 2px;
		margin-right: 5px;
		border-radius: 1px;
		vertical-align: middle;
	}

	.key.slots {
		background: var(--state-running);
	}

	.key.cpu {
		background: var(--fg-muted);
	}

	.plot {
		position: relative;
	}

	svg {
		display: block;
		overflow: visible;
	}

	.rule {
		stroke: var(--border);
		stroke-dasharray: 2 3;
	}

	.base {
		stroke: var(--border);
	}

	.line {
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.line.slots {
		stroke: var(--state-running);
	}

	.line.cpu {
		stroke: var(--fg-muted);
	}

	.hair {
		stroke: var(--fg-muted);
		stroke-width: 1;
	}

	/* The surface ring keeps an end dot apart from the line under it. */
	.dot {
		stroke: var(--bg-panel);
		stroke-width: 2;
	}

	.dot.slots {
		fill: var(--state-running);
	}

	.dot.cpu {
		fill: var(--fg-muted);
	}

	.top {
		fill: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	.scrub {
		position: absolute;
		inset: 0;
		border-radius: var(--radius-sm);
		touch-action: pan-y;
	}

	.scrub:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
