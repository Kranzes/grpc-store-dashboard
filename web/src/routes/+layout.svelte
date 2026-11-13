<script lang="ts">
	import '#lib/theme/catppuccin.css';
	import '#lib/theme/base.css';
	import { onMount } from 'svelte';
	import { installTrimFallback } from '#lib/ui/trim.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	onMount(() => installTrimFallback());
</script>

<svelte:head>
	<title>nix-grpc-store dashboard</title>
</svelte:head>

{@render children()}
