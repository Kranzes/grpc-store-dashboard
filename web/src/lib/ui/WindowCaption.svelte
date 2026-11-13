<script lang="ts">
	import type { Coverage } from '#lib/model/types.ts';
	import { clock } from './clock.svelte.ts';
	import { windowCaption } from './format.ts';

	// The muted time caption of a card or a panel section: "Last 15m", or
	// "Since 23:41" with a tooltip while the window fills. Screen readers get
	// words: "Last 15 minutes".
	type Props = {
		minutes: number;
		/** Where the counts start while they cover less than the window. */
		since: Coverage | null;
	};
	let { minutes, since }: Props = $props();

	// The clock only matters to the tooltip of a window that fills.
	const c = $derived(windowCaption(minutes, since, since ? clock.now : 0));
</script>

<span class="when num" title={c.title ?? undefined}
	><span aria-hidden="true">{c.text}</span><span class="visually-hidden">{c.spoken}</span></span
>

<style>
	.when {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		font-weight: 500;
		letter-spacing: normal;
		text-transform: none;
		white-space: nowrap;
	}
</style>
