<script lang="ts">
	import { basePath } from '#lib/farm/farm.ts';
	import Icon from '../Icon.svelte';
	import { hereUrl, logsHref, type LogsParams } from '../nav.ts';

	// A link from the Overview into the Logs tab, filtered or to one build.
	type Props = { label: string; params: LogsParams; icon?: boolean };
	let { label, params, icon = true }: Props = $props();
	// Read when drawn, since the session's options stay in the query whichever tab shows.
	const href = $derived(logsHref(basePath(), hereUrl(), params));
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- built from basePath() -->
<a class="btn-secondary logs-link" {href}
	>{#if icon}<Icon name="log" size={14} />{/if}{label}</a
>

<style>
	/* A panel's action into the Logs tab: a link styled as .btn-secondary, with the log icon. */
	.logs-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		text-decoration: none;
	}
</style>
