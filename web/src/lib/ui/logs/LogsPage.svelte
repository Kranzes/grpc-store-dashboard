<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { basePath } from '#lib/farm/farm.ts';
	import { ANY_QUERY } from '#lib/model/builds.ts';
	import {
		buildKey,
		drvName,
		workerNodeId,
		type BuildQuery,
		type BuildRow,
		type FinishedBuildView
	} from '#lib/model/types.ts';
	import MapNotice from '../MapNotice.svelte';
	import {
		logsHref,
		logsSearch,
		overviewHref,
		parseLogsParams,
		type LineRange,
		type LogsParams
	} from '../nav.ts';
	import { getShell } from '../shell.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import BuildList, { type Filters } from './BuildList.svelte';
	import LogEmpty, { phaseSentence } from './LogEmpty.svelte';
	import LogViewer from './LogViewer.svelte';

	// The Logs tab: the build list beside one build's log, both in the URL.
	// Filters, search and the line range replace the URL; opening a build
	// is a navigation, so Back steps through builds.
	const shell = getShell();
	const store = $derived(shell.shown);
	/** Connection status and notices stay live while paused. */
	const live = $derived(shell.store);
	const session = $derived(shell.session);
	/**
	 * The URL this tab shows, with what filters and the line range wrote
	 * since, which replace it without a navigation. page.url stays the URL
	 * before those writes, also on Back to them; page.shallow.url has them.
	 * Set at once on a write, before goto updates page.shallow.
	 */
	let here = $derived((page.shallow?.url ?? page.url).href);
	const url = $derived(new URL(here));
	const params = $derived(parseLogsParams(url));

	const base = $derived(basePath());

	/** Replace the URL without a navigation: filters, search and the line range. */
	function replace(next: string) {
		here = new URL(next, here).href;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- this page's own URL
		void goto(next, { shallow: true, replace: true, state: page.state });
	}

	const filters = $derived<Filters>({
		q: params.q ?? '',
		states: params.status ?? [],
		system: params.system ?? null,
		builder: params.builder ?? null,
		pool: params.pool ?? null,
		client: params.client ?? null,
		since: params.since ?? null,
		sort: params.sort ?? 'failures'
	});

	function writeUrl(p: LogsParams) {
		replace(`${url.pathname}${logsSearch(url, p)}`);
	}

	function setFilters(f: Filters) {
		writeUrl({
			...params,
			q: f.q || undefined,
			status: f.states.length ? f.states : undefined,
			system: f.system ?? undefined,
			builder: f.builder ?? undefined,
			pool: f.pool ?? undefined,
			client: f.client ?? undefined,
			since: f.since ?? undefined,
			sort: f.sort
		});
	}

	function setRange(r: LineRange | null) {
		writeUrl({ ...params, range: r ?? undefined });
	}

	const query = $derived<BuildQuery>({
		...ANY_QUERY,
		states: new Set(filters.states),
		system: filters.system,
		builder: filters.builder,
		pool: filters.pool,
		client: filters.client,
		q: filters.q,
		withinMs: filters.since === null ? null : filters.since * 60_000,
		sort: filters.sort
	});
	const view = new Throttled(
		() => [store.frame, query],
		() => store.builds(query),
		500
	);

	// Load history once per scheduler instance, however often the tab opens.
	$effect(() => {
		void live.meta?.instance;
		if (live.status.kind === 'live') live.ensureHistory();
	});

	// --------------------------------------------------------- the open build

	let fromHistory = $state.raw<FinishedBuildView | null>(null);
	let historyFor = '';
	// One request per derivation. This effect reruns on every URL or store
	// change, so the request outlives the run and stops only for the next one.
	let historyCtl: AbortController | undefined;
	$effect(() => {
		const drv = params.drv;
		if (!drv) return;
		const found = store.build(drv, params.a ?? 0);
		// A row from history keeps only its error line, and the text comes by path.
		const needText = found?.state === 'failed' && !store.drv(drv)?.errorText;
		if ((found && !needText) || historyFor === drv) return;
		historyCtl?.abort();
		historyFor = drv;
		fromHistory = null;
		const ctl = (historyCtl = new AbortController());
		store
			.finishedBuild(drv, ctl.signal)
			.then((b) => {
				if (historyFor === drv) fromHistory = b;
			})
			.catch(() => {});
	});
	$effect(() => () => historyCtl?.abort());

	/** The build from history, if it is the one named. The scheduler sends the derivation's newest. */
	const historyOf = (drv: string, a: number | undefined) =>
		fromHistory?.drvPath === drv && (!a || fromHistory.assignId === a) ? fromHistory : null;

	/** The build the URL names: one the page has, one from history, or what the link says. */
	const build = $derived.by((): BuildRow | null => {
		const drv = params.drv;
		if (!drv) return null;
		void store.frame;
		const found = store.build(drv, params.a ?? 0) ?? historyOf(drv, params.a);
		if (found) return found;
		const d = store.drv(drv);
		// A derivation that never ran, unless the link names the build that ran.
		if (d && d.phase !== 'assigned' && d.workerAddr === null && !params.on) return null;
		if (!d && !params.on) {
			// For a link without its builder, the demo makes up a log for any derivation.
			if (session.logs.kind !== 'demo') return null;
		}
		return {
			drvPath: drv,
			name: drvName(drv),
			system: d?.system ?? '',
			worker: params.on ?? d?.workerAddr ?? '',
			assignId: params.a ?? d?.assignId ?? 0,
			state:
				d && d.phase !== 'queued' && d.phase !== 'unplaceable' && d.phase !== 'cached'
					? d.phase
					: 'built',
			status: d?.status ?? null,
			errorLine: null,
			assignedMs: d?.assignedMs ?? null,
			startedMs: d?.buildStartedMs ?? null,
			reportsStarts: false,
			finishedMs: params.t !== undefined ? store.browserMs(params.t) : (d?.finishedMs ?? null),
			finishedServerMs: params.t ?? d?.finishedServerMs ?? null,
			phase: null,
			phaseStartedMs: null,
			requestedBy: d?.identities ?? [],
			from: 'history'
		};
	});
	const noLog = $derived.by(() => {
		const drv = params.drv;
		if (!drv || build) return null;
		const d = store.drv(drv);
		return phaseSentence(d?.phase ?? null, d?.status === 'dependency-failed');
	});
	const errorText = $derived.by(() => {
		if (!build || build.state !== 'failed') return null;
		const d = store.drv(build.drvPath);
		if (d?.errorText && (d.assignId === build.assignId || !build.assignId)) return d.errorText;
		return historyOf(build.drvPath, build.assignId)?.errorText ?? null;
	});
	const selectedKey = $derived(build ? buildKey(build.drvPath, build.assignId) : null);

	const href = (r: BuildRow) =>
		logsHref(base, url, {
			...params,
			drv: r.drvPath,
			on: r.worker || undefined,
			a: r.assignId || undefined,
			t: r.finishedServerMs ?? undefined,
			range: undefined
		});

	/** The Overview with the builder's panel and this derivation's on its stack. */
	function showOnMap(b: BuildRow) {
		const o = shell.overview;
		o.stack = [
			{ kind: 'node', nodeId: workerNodeId(b.worker) },
			{ kind: 'derivation', drvPath: b.drvPath, via: `assign:${b.worker}` }
		];
		o.returnTo = null;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- built from basePath()
		void goto(overviewHref(base, url));
	}

	// ------------------------------------------------------------------ keys

	/** The list folds while a build is open, until the reader shows or hides it. */
	let hideList = $state<boolean | null>(null);
	const collapsed = $derived(hideList ?? build !== null);
	let list: BuildList | undefined = $state();

	/** Show the list, then focus in it once it is there. */
	function showList(then: (l: BuildList) => void) {
		hideList = false;
		void tick().then(() => list && then(list));
	}

	/** In the list pane only: / searches and [ hides the pane. */
	function onlistkey(e: KeyboardEvent) {
		if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
		const typing = (e.target as HTMLElement).closest('input, textarea, select');
		if (e.key === '/' && !typing) {
			e.preventDefault();
			showList((l) => l.focusSearch());
		} else if (e.key === '[' && !typing) {
			e.preventDefault();
			hideList = !collapsed;
		}
	}

	const title = $derived(
		build ? `${build.name} · Logs · ${shell.farmName}` : `Logs · ${shell.farmName}`
	);
</script>

<svelte:head>
	<title>{title}</title>
</svelte:head>

<main class="logs" class:collapsed>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="list-pane" onkeydown={onlistkey}>
		<BuildList
			bind:this={list}
			view={view.current}
			{filters}
			onfilters={setFilters}
			selected={selectedKey}
			selectedRow={build}
			{href}
			onnearend={() =>
				store.loadOlderBuilds(filters.states.length === 1 && filters.states[0] === 'failed')}
			groups={store.topology.clientGroups}
			{collapsed}
			oncollapse={() => (hideList = !collapsed)}
			logSearchUrl={shell.farm?.logSearchUrl}
		/>
	</div>
	<div class="view-pane">
		{#if build && store.meta}
			{#key selectedKey}
				<LogViewer
					{build}
					{errorText}
					backend={session.logs}
					range={params.range ?? null}
					onrange={setRange}
					onescape={() => showList((l) => l.focusSelected())}
					onshowmap={build.worker ? () => showOnMap(build) : undefined}
					inFarm={(addr) => {
						const w = store.workers.get(addr);
						return !!w && (w.up || !w.retired);
					}}
					onopenbuild={(a) =>
						// eslint-disable-next-line svelte/no-navigation-without-resolve -- built from basePath()
						goto(logsHref(base, url, { ...params, a, t: undefined, range: undefined }))}
				/>
			{/key}
		{:else if noLog}
			<LogEmpty sentence={noLog} />
		{:else}
			<LogEmpty sentence="Pick a build to see its log." />
		{/if}
	</div>
	<MapNotice status={live.status} meta={live.meta} />
</main>

<style>
	.logs {
		position: relative;
		display: grid;
		grid-template-columns: var(--list-w) minmax(0, 1fr);
		min-height: 0;
		min-width: 1000px;
	}

	.logs.collapsed {
		grid-template-columns: 40px minmax(0, 1fr);
	}

	@media (max-width: 1439px) {
		.logs:not(.collapsed) {
			grid-template-columns: 360px minmax(0, 1fr);
		}
	}

	.list-pane,
	.view-pane {
		min-height: 0;
		min-width: 0;
	}
</style>
