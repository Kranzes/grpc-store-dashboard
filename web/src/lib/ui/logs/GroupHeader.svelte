<script lang="ts">
	import type { Group } from '#lib/logs/groups.ts';
	import type { ReportedPhase } from './words.ts';
	import Spoken from '../Spoken.svelte';
	import { errors, groupWords, lines, span, warnings } from './words.ts';

	// One group's header row: the group's first line drawn as a header, with
	// its chevron, name and counts. A button with tabindex -1, so the viewer
	// keeps one tab stop; [ and ] move between headers.
	type Props = {
		group: Group;
		folded: boolean;
		failed: boolean;
		/** The group a running build is in now. */
		current: boolean;
		/** The phase the builder last reported, and when it started, in browser ms. */
		phase: ReportedPhase | null;
		nowMs: number;
		/** The header's line number. */
		line?: number | null;
		onclick: () => void;
		onselectline?: (extend: boolean) => void;
		focused?: boolean;
	};
	let {
		group: g,
		folded,
		failed,
		current,
		phase,
		nowMs,
		line = null,
		onclick,
		onselectline,
		focused = false
	}: Props = $props();

	/**
	 * "2m 10s elapsed" on a running build's current phase, when it is the
	 * phase the builder reported, since reports lag the log by up to 2 s.
	 * Otherwise, and on a subtest, only the dot.
	 */
	const elapsed = $derived(
		current && g.kind === 'phase' && phase !== null && phase.name === g.name
			? span(Math.max(0, nowMs - phase.startedMs))
			: null
	);
	const label = $derived(groupWords(g, failed, elapsed));
	let button: HTMLButtonElement | undefined = $state();
	$effect(() => {
		if (focused && button && document.activeElement !== button)
			button.focus({ preventScroll: true });
	});
</script>

<span class="gutter num">
	{#if line !== null}
		<a
			href="#L{line}"
			tabindex="-1"
			onclick={(e) => {
				e.preventDefault();
				onselectline?.(e.shiftKey);
			}}>{line}</a
		>
	{/if}
</span>
<button
	type="button"
	class="head"
	class:failed
	tabindex="-1"
	aria-expanded={!folded}
	aria-label={label}
	style:--depth={g.depth}
	bind:this={button}
	{onclick}
>
	<span class="chev" aria-hidden="true">{folded ? '▸' : '▾'}</span>
	<span class="name">{g.kind === 'subtest' ? `subtest: ${g.name}` : g.name}</span>
	{#if failed}<span class="x" aria-hidden="true">✕</span>{/if}
	<span class="facts" aria-hidden="true">
		{#if g.durationS !== null}
			<span class="num"><Spoken {...span(g.durationS * 1000)} /></span>
		{/if}
		{#if current}
			<span class="now"
				><span class="dot"></span>{#if elapsed}{elapsed.text} elapsed{/if}</span
			>
		{/if}
		<span class="num">{lines(g.lines)}</span>
		{#if g.warnings}<span class="warn num">{warnings(g.warnings)}</span>{/if}
		{#if g.errors}<span class="err num">{errors(g.errors)}</span>{/if}
	</span>
</button>

<style>
	.gutter {
		position: sticky;
		left: 0;
		z-index: 1;
		flex: none;
		width: var(--gutter-w);
		padding-right: 8px;
		border-left: 3px solid transparent;
		background: var(--bg-panel);
		color: var(--fg-muted);
		text-align: right;
		user-select: none;
	}

	.gutter a {
		color: inherit;
		text-decoration: none;
	}

	.head {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: var(--row-h, 18px);
		padding: 0 12px 0 calc(8px + var(--depth) * 12px);
		border: 0;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-panel);
		color: var(--fg);
		font: inherit;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.head:hover {
		background: var(--bg-hover);
	}

	.head:focus-visible {
		outline-offset: -2px;
	}

	.head.failed {
		color: var(--danger-fg);
	}

	.chev {
		width: 1ch;
		color: var(--fg-muted);
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.x {
		color: var(--danger-fg);
	}

	.facts {
		display: flex;
		gap: 12px;
		margin-left: auto;
		font-family: var(--font-sans);
		font-weight: 500;
		color: var(--fg-muted);
		white-space: nowrap;
	}

	.warn {
		color: var(--fg-muted);
	}

	.err {
		color: var(--danger-fg);
	}

	.now {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--fg);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--state-running);
	}
</style>
