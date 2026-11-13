<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { app } from '#lib/app.svelte.ts';
	import Landing from '#lib/ui/Landing.svelte';
	import Shell from '#lib/ui/Shell.svelte';
	import type { LayoutProps } from './$types';

	// Both tabs share this layout, so a switch between them keeps the session.
	// /?demo and /logs/?demo both start the demo here.
	let { children }: LayoutProps = $props();
	const phase = $derived(app.phase);

	onMount(() => {
		const params = page.url.searchParams;
		// /?demo starts the simulator straight away; its options come from the
		// same query string, as in /?demo&builders=50&gaps=20.
		if (params.has('demo')) app.demo();
		else void app.load();
	});

	async function leaveDemo() {
		// Leaving the demo should not restart it on reload. Not shallow: from
		// /logs/?demo, the page goes to / and its route.
		if (page.url.searchParams.has('demo')) await goto(resolve('/(app)'), { replace: true });
		await app.leaveDemo();
	}
</script>

<!-- A session's tab names its own title. -->
<svelte:head>
	{#if phase.kind !== 'session'}
		<title>nix-grpc-store dashboard</title>
	{/if}
</svelte:head>

{#if phase.kind === 'session'}
	{#key phase.session}
		<Shell
			farmName={phase.farmName}
			farm={phase.farm}
			session={phase.session}
			onreload={() => app.reload()}
			onreconnect={() => app.reconnect()}
			onleavedemo={leaveDemo}
			ondemo={() => app.startDemo()}
		>
			{@render children()}
		</Shell>
	{/key}
{:else}
	<Landing {phase} ondemo={() => app.demo()} onretry={() => app.load()} />
{/if}
