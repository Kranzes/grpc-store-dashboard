<script module lang="ts">
	// 24x24 stroke icons, drawn for this dashboard.
	const PATHS = {
		sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
		moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
		monitor:
			'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 15h8m-4-3v3',
		close: 'M6 6l12 12M18 6 6 18',
		back: 'M15 18l-6-6 6-6',
		chevron: 'M9 6l6 6-6 6',
		plus: 'M12 5v14M5 12h14',
		minus: 'M5 12h14',
		fit: 'M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4m0 6v4a1 1 0 0 1-1 1h-4m-6 0H5a1 1 0 0 1-1-1v-4',
		copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Zm-4 6H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
		check: 'M5 12.5l4.5 4.5L19 7.5',
		alert:
			'M12 9v4m0 3.5v.5M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z',
		lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z',
		plug: 'M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5',
		clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
		info: 'M12 11v6m0-9.5v.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
		logout: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h10',
		pause: 'M9 6v12m6-12v12',
		play: 'M8 6.2v11.6a.8.8 0 0 0 1.2.7l9.4-5.8a.8.8 0 0 0 0-1.4L9.2 5.5a.8.8 0 0 0-1.2.7Z',
		log: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3 5h8M8 12h8m-8 3h5',
		save: 'M12 4v11m-4-4 4 4 4-4M5 19h14',
		map: 'M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Zm0 0v14m6-12v14',
		link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
		search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 4 4',
		sidebar: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 0v14',
		up: 'M12 19V5m-6 6 6-6 6 6',
		/** Chevrons apart, to expand every group. */
		expand: 'M8 9l4-4 4 4M8 15l4 4 4-4',
		/** Chevrons together, to collapse every group. */
		collapse: 'M8 5l4 4 4-4M8 19l4-4 4 4',
		down: 'M12 5v14m6-6-6 6-6-6'
	} as const;
	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	type Props = { name: IconName; size?: number; label?: string };
	let { name, size = 16, label }: Props = $props();
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	<path d={PATHS[name]} />
</svg>

<style>
	.icon {
		flex: none;
		display: block;
	}
</style>
