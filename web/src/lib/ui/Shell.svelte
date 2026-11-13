<script lang="ts">
	import type { Snippet } from 'svelte';
	import { holdStill } from '#lib/flow/hold.ts';
	import '#lib/ui/panels/panel.css';
	import type { Farm, FarmSession } from '#lib/model/types.ts';
	import { clock } from './clock.svelte.ts';
	import Header from './Header.svelte';
	import { overviewOf } from './overview.svelte.ts';
	import { Pause } from './pause.svelte.ts';
	import { setShell } from './shell.ts';

	// The header and what both tabs share: the session, the pause and the
	// Overview's state while the other tab shows.
	type Props = {
		farmName: string;
		/** The farm that serves this page. null in the demo. */
		farm: Farm | null;
		session: FarmSession;
		/** Load the page again, through the farm's sign-in when it asks for one. */
		onreload: () => void;
		onreconnect: () => void;
		onleavedemo: () => void;
		ondemo: () => void;
		children: Snippet;
	};
	let { farmName, farm, session, onreload, onreconnect, onleavedemo, ondemo, children }: Props =
		$props();

	const store = $derived(session.store);
	/**
	 * The pause button and P freeze the map, the header totals and an open
	 * panel. The stream keeps arriving underneath, and resuming shows the
	 * live state at once. Connection status and notices stay live.
	 */
	const pause = new Pause();
	/**
	 * Paused, or held by a pan, zoom or press on the map. A boolean of its own,
	 * so going from one reason to the other keeps the picture the first began with.
	 */
	const still = $derived(pause.still);
	/** What the header, the map and the panel show: the live store, or that store held still. */
	const shown = $derived(still ? holdStill(store) : store);
	// Relative times such as "3m ago" and "elapsed" stand still with the numbers.
	$effect(() => {
		clock.freeze(pause.since ?? pause.heldSince);
		return () => clock.freeze(null);
	});
	const overview = $derived(overviewOf(session));

	setShell({
		get farmName() {
			return farmName;
		},
		get farm() {
			return farm;
		},
		get session() {
			return session;
		},
		get store() {
			return store;
		},
		get shown() {
			return shown;
		},
		pause,
		get overview() {
			return overview;
		},
		onreload: () => onreload(),
		onreconnect: () => onreconnect(),
		ondemo: () => ondemo()
	});
</script>

<div class="dash">
	<Header
		{farmName}
		{farm}
		{session}
		{shown}
		pausedSince={pause.since}
		onresume={() => pause.resume()}
		{onleavedemo}
	/>
	{@render children()}
</div>

<style>
	.dash {
		display: grid;
		grid-template-rows: auto 1fr;
		height: 100dvh;
		min-width: 1000px;
		overflow: hidden;
	}
</style>
