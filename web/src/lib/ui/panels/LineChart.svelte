<script lang="ts">
	import { untrack } from 'svelte';
	import { lineKind } from '#lib/flow/kinds.ts';
	import type { EdgeDetailView } from '#lib/model/types.ts';
	import { clock } from '../clock.svelte.ts';
	import { beside } from '../place.ts';
	import {
		formatBytes,
		formatCount,
		formatPerMinute,
		windowCaption,
		windowShort
	} from '../format.ts';
	import {
		CHART,
		barPath,
		chartLayout,
		chartPer,
		chartReading,
		chartSlotAt,
		chartTitle,
		chartValue,
		slotCenter,
		spokenRate
	} from './line.ts';

	// A line's history over the header window: one bar per whole 30 s bucket,
	// and on assignment and request lines a strip of failed builds under it.
	// The start of the window the page did not see is hatched. A hairline and
	// a readout follow the pointer, or the arrow keys once the chart has focus.
	type Props = { detail: EdgeDetailView };
	let { detail }: Props = $props();
	const uid = $props.id();
	const kind = $derived(lineKind(detail.flow));
	const hatch = `uncovered-${uid}`;
	const edgeClip = `edge-${uid}`;

	// Measured width. The first paint and server rendering assume the panel body's width.
	let width = $state(400);
	const layout = $derived(chartLayout(detail.series, detail.unit, width, detail.rate));
	const failsTop = CHART.height + CHART.gap;
	const plotHeight = $derived(layout.height - CHART.axis);
	const since = $derived(detail.since);
	const caption = $derived(
		windowCaption(detail.windowMinutes, since, since ? clock.now : 0).phrase
	);
	const before = $derived(
		since?.cause === 'restart'
			? 'Before the scheduler restarted'
			: since?.cause === 'history'
				? "Before the scheduler's history"
				: 'Before this page opened'
	);
	const label = $derived.by(() => {
		const per = chartPer(detail.unit);
		const peak = detail.unit === 'builds' ? formatPerMinute(layout.peak) : formatBytes(layout.peak);
		const parts = [
			`${chartTitle(kind, detail.unit)} ${caption}`,
			`Peak ${peak} per ${per}, now ${spokenRate(kind, detail.rate)}`
		];
		if (layout.fails) parts.push(`${formatCount(detail.failed)} failed`);
		return `${parts.join('. ')}.`;
	});

	// The slot under the pointer, and the one the keys move, which starts at
	// now. Both keep their place as the buckets move on.
	let hover = $state<number | null>(null);
	let cursor = $state<number | null>(null);
	let focused = $state(false);
	const last = $derived(layout.slots - 1);
	const clamp = (i: number) => Math.max(0, Math.min(last, i));
	const keyed = $derived(clamp(cursor ?? last));
	const at = $derived(hover !== null ? clamp(hover) : focused ? keyed : null);
	/** The slot the readout and the slider read: the pointer's, else the keys'. */
	const slot = $derived(at ?? keyed);
	const reading = $derived(
		chartReading(kind, detail.unit, detail.series, detail.rate, slot, before)
	);
	// The slider's value as screen readers hear it, read again when the slot
	// or the line changes but not as the numbers move on. The panel updates
	// every second, and a focused slider would speak each new value.
	const line = $derived(`${detail.flow} ${detail.unit} ${detail.edgeIds.join(' ')}`);
	const spoken = $derived.by(() => {
		void line;
		const [i, b] = [slot, before];
		return untrack(() => chartReading(kind, detail.unit, detail.series, detail.rate, i, b).spoken);
	});

	let readoutWidth = $state(0);
	// Right of the hairline, or left of it where the chart ends.
	const readoutLeft = $derived(
		at === null ? 0 : beside(slotCenter(layout, at), readoutWidth, width, 8)
	);

	function point(e: PointerEvent) {
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const i = chartSlotAt(layout, CHART.gutter + e.clientX - box.left);
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
		const next = step(keyed);
		e.preventDefault();
		hover = null;
		cursor = clamp(next);
	}
</script>

<div class="chart flow-{kind}" bind:clientWidth={width}>
	<svg role="img" aria-label={label} {width} height={layout.height} class:reading={at !== null}>
		<defs>
			<pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse">
				<path class="hatch" d="M-1 1 l2 -2 M0 6 l6 -6 M5 7 l2 -2" />
			</pattern>
			{#if layout.live}
				<clipPath id={edgeClip}>
					<rect x={layout.live.x} y={layout.live.y} width={layout.live.w} height={CHART.edge} />
				</clipPath>
			{/if}
		</defs>
		{#if layout.uncovered}
			{@const u = layout.uncovered}
			<g class="uncovered">
				<title>{before}</title>
				<rect x={u.x} y={0} width={u.w} height={plotHeight} fill="url(#{hatch})" />
			</g>
		{/if}
		{#if at !== null}
			{@const x = Math.round(slotCenter(layout, at)) + 0.5}
			<line class="hair" x1={x} x2={x} y1={0} y2={plotHeight} />
		{/if}
		<line
			class="base"
			x1={CHART.gutter}
			x2={width}
			y1={CHART.height - 0.5}
			y2={CHART.height - 0.5}
		/>
		{#each layout.bars as b (b.i)}
			<path class="bar" class:on={b.i === at} d={barPath(b)} />
		{/each}
		<!-- The bucket still filling, drawn from the rate now. It is lighter, since it is not
		     a whole bucket, and its top edge is in full color. -->
		{#if layout.live}
			{@const b = layout.live}
			<g class="live" class:on={b.i === at}>
				<path class="body" d={barPath(b)} />
				<path class="edge" d={barPath(b)} clip-path="url(#{edgeClip})" />
			</g>
		{/if}
		<!-- An empty chart has no scale, since "0/min" says nothing the facts above don't. -->
		{#if layout.peak > 0}
			<text class="axis" x={CHART.gutter - 6} y={9} text-anchor="end">
				{chartValue(detail.unit, layout.peak)}
			</text>
		{/if}
		{#if layout.fails}
			<line
				class="base"
				x1={CHART.gutter}
				x2={width}
				y1={failsTop + CHART.strip - 0.5}
				y2={failsTop + CHART.strip - 0.5}
			/>
			{#each layout.fails as b (b.i)}
				<path class="fail" class:on={b.i === at} d={barPath(b)} />
			{/each}
			<text class="axis" x={CHART.gutter - 6} y={failsTop + CHART.strip - 2} text-anchor="end">
				Failed
			</text>
		{/if}
		<text class="axis" x={CHART.gutter} y={layout.height - 3}>
			{windowShort(detail.windowMinutes)} ago
		</text>
		<text class="axis" x={width} y={layout.height - 3} text-anchor="end">now</text>
	</svg>
	<!-- On the panel's own color, so it reads like any muted text and not through the stripes. -->
	{#if layout.uncovered && layout.uncovered.w >= 132}
		<span
			class="note"
			aria-hidden="true"
			style:left="{layout.uncovered.x + layout.uncovered.w / 2}px"
			style:top="{CHART.height / 2}px">{before}</span
		>
	{/if}
	{#if layout.slots > 0}
		<!-- Over the plot: the pointer's target, and a slider through the buckets for the keys. -->
		<div
			class="scrub"
			role="slider"
			tabindex="0"
			aria-label={chartTitle(kind, detail.unit)}
			aria-valuemin={0}
			aria-valuemax={last}
			aria-valuenow={slot}
			aria-valuetext={spoken}
			style:left="{CHART.gutter}px"
			style:width="{Math.max(0, width - CHART.gutter)}px"
			style:height="{plotHeight}px"
			onpointermove={point}
			onpointerdown={point}
			onpointerleave={() => (hover = null)}
			onkeydown={key}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		></div>
	{/if}
	{#if at !== null}
		<!-- The slider's value says the same to screen readers. -->
		<div
			class="readout"
			aria-hidden="true"
			bind:clientWidth={readoutWidth}
			style:transform="translateX({readoutLeft}px)"
		>
			<span class="time num">{reading.time}</span>
			{#if reading.value !== null}
				<span class="value"><i class="key"></i><strong class="num">{reading.value}</strong></span>
				{#if reading.failed !== null}
					<span class="value"
						><i class="key fail-key"></i><strong class="num">{formatCount(reading.failed)}</strong>
						failed</span
					>
				{/if}
			{:else}
				<span class="unseen">{reading.unseen}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.chart {
		position: relative;
		width: 100%;
	}

	svg {
		display: block;
		overflow: visible;
	}

	/* Plain Latte lavender and green are below 3:1 on --bg; the mix with text clears it. */
	.bar,
	.live {
		fill: color-mix(in oklab, var(--flow-c) 80%, var(--fg));
	}

	.live .body {
		fill-opacity: 0.5;
	}

	.fail {
		fill: var(--danger);
	}

	/* The bucket under the hairline stays, and the rest fade, as lines do on the map. */
	.bar,
	.live,
	.fail {
		transition: opacity var(--dur-fast) var(--ease-out);
	}

	.reading .bar:not(.on),
	.reading .live:not(.on),
	.reading .fail:not(.on) {
		opacity: 0.45;
	}

	.hair {
		stroke: var(--border-strong);
		stroke-width: 1;
	}

	.base {
		stroke: var(--border);
		stroke-width: 1;
	}

	.axis {
		fill: var(--fg-muted);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.hatch {
		stroke: var(--border);
		stroke-width: 1;
	}

	.note {
		position: absolute;
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--fg-muted);
		font-size: 10px;
		line-height: 1.2;
		white-space: nowrap;
		pointer-events: none;
		transform: translate(-50%, -50%);
	}

	.scrub {
		position: absolute;
		top: 0;
		border-radius: var(--radius-sm);
		touch-action: pan-y;
	}

	.readout {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-node);
		box-shadow: var(--shadow-md);
		color: var(--fg);
		font-size: 11px;
		line-height: 1.3;
		white-space: nowrap;
		pointer-events: none;
	}

	.time,
	.unseen {
		color: var(--fg-muted);
	}

	.value {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--fg-muted);
	}

	strong {
		color: var(--fg);
		font-weight: 600;
	}

	/* A short stroke of the series color keys each value. */
	.key {
		width: 8px;
		height: 3px;
		flex: none;
		border-radius: 2px;
		background: color-mix(in oklab, var(--flow-c) 80%, var(--fg));
	}

	.key.fail-key {
		background: var(--danger);
	}
</style>
