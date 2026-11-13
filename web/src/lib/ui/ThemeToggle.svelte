<script lang="ts">
	import { theme, type ThemeMode } from '#lib/theme/theme.svelte.ts';
	import Icon from './Icon.svelte';
	import Segmented from './Segmented.svelte';
</script>

{#snippet sun()}<Icon name="sun" size={15} />{/snippet}
{#snippet moon()}<Icon name="moon" size={15} />{/snippet}
{#snippet monitor()}<Icon name="monitor" size={15} />{/snippet}

<Segmented
	label="Theme, for this tab only"
	value={theme.mode}
	onchange={(v: ThemeMode) => theme.set(v)}
	options={[
		{ value: 'light', label: 'Light theme', content: sun },
		{ value: 'system', label: 'Follow the system theme', content: monitor },
		{ value: 'dark', label: 'Dark theme', content: moon }
	]}
/>
