<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { DrvGone_Outcome, DrvGone_Status } from '#lib/gen/events_pb.ts';
	import { LogClient } from '#lib/logs/client.svelte.ts';
	import { nixGist, stepError } from '#lib/logs/errors.ts';
	import type { Group } from '#lib/logs/groups.ts';
	import type { GroupView } from '#lib/logs/protocol.ts';
	import { outcomePhase } from '#lib/model/reducer.ts';
	import type { BuildRow, BuildStatus } from '#lib/model/types.ts';
	import type { LogBackend } from '#lib/source/types.ts';
	import { clock } from '../clock.svelte.ts';
	import { Copier } from '../copy.svelte.ts';
	import { formatBytes, formatClock, formatClockMinutes, formatExact, plural } from '../format.ts';
	import Icon from '../Icon.svelte';
	import type { LineRange } from '../nav.ts';
	import PhaseChip from '../PhaseChip.svelte';
	import { STATUS_LABEL, STATUS_SENTENCE, statusTitle } from '../panels/status.ts';
	import Spoken from '../Spoken.svelte';
	import LogEmpty, { problemSentence } from './LogEmpty.svelte';
	import LogView from './LogView.svelte';
	import { lines as linesWord, span, type Said } from './words.ts';

	// One build's log: its header, the failure callout, the toolbar, the
	// log, and the status bar. Keys work only while focus is inside it.
	type Props = {
		build: BuildRow;
		/** Nix's message for a failed build, when the page has it. */
		errorText: string | null;
		backend: LogBackend;
		range: LineRange | null;
		onrange: (range: LineRange | null) => void;
		/** Escape with nothing to clear goes back to the list. */
		onescape: () => void;
		onshowmap?: () => void;
		/** Whether a builder is in the farm now. */
		inFarm?: (addr: string) => boolean;
		/** Open the build that replaced this log. */
		onopenbuild?: (assignId: number) => void;
	};
	let {
		build,
		errorText,
		backend,
		range,
		onrange,
		onescape,
		onshowmap,
		inFarm,
		onopenbuild
	}: Props = $props();

	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
	const touched = new Set<number>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
	const seen = new Set<number>();

	// One client per build, since the page keys the viewer on the build.
	const c = untrack(
		() =>
			new LogClient(
				{
					drvPath: build.drvPath,
					name: build.name,
					worker: build.worker,
					system: build.system,
					assignId: build.assignId,
					running: build.state === 'assigned',
					finishedMs: build.finishedMs,
					state: build.state
				},
				backend,
				{ inFarm }
			)
	);
	// The head went in front of the tail, so group ids moved.
	const off = c.onMoved((m) => {
		for (const set of [touched, seen]) {
			const ids = [...set];
			set.clear();
			for (const id of ids) {
				const to = m.remap[id];
				if (to !== null && to !== undefined) set.add(to);
			}
		}
	});
	onDestroy(() => {
		off();
		c.stop();
	});

	let view: LogView | undefined = $state();
	let findBox: HTMLInputElement | undefined = $state();
	let wrap = $state(true);
	let following = $state(untrack(() => c.following));
	let newLines = $state(0);
	let announce = $state('');
	let query = $state('');
	let caseSensitive = $state(false);
	let onlyMatching = $state(false);
	let hit = $state(-1);
	/** The error line e and E last went to. */
	let errorLine: number | null = null;
	let menu = $state(false);
	const copier = new Copier<'link' | 'lines' | 'path'>();
	let overlay = $state<string | null>(null);
	let positioned = $state(false);
	let nixOpen = $state(false);

	const failed = $derived(
		build.state === 'failed' || c.ended?.ending.outcome === DrvGone_Outcome.FAILED
	);
	const running = $derived(build.state === 'assigned' && !c.ended);
	const groups = $derived(c.groups);
	/** Every group is folded, so Collapse all has nothing to do. */
	const allFolded = $derived(groups.length > 0 && groups.every((g) => c.folded.has(g.id)));
	const byId = $derived(new Map(groups.map((g) => [g.id, g])));

	/** Nix rejected what the build made after the build ran to its end, so no group failed. */
	const ranToEnd = $derived.by(() => {
		const s = c.ended ? statusKey(c.ended.ending.status) : build.status;
		return s === 'not-deterministic' || s === 'output-rejected';
	});

	/** The failed group and every group around it, once a failed build's log is complete. */
	const failedChain = $derived.by((): ReadonlySet<number> => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
		const out = new Set<number>();
		if (!failed || !c.loaded || ranToEnd) return out;
		for (let id = c.failedGroup; id !== null; id = byId.get(id)?.parent ?? null) out.add(id);
		return out;
	});

	// Follow state from the client: on while a running build streams.
	$effect(() => {
		if (!c.following && c.ended && following) following = false;
	});
	// The end of a followed build, from the demo or the store's build, said once.
	let endSaid = false;
	$effect(() => {
		const t = endedText;
		if (t && !endSaid) {
			endSaid = true;
			announce = t;
		}
	});

	// ------------------------------------------------------------- defaults

	/**
	 * Open by default: a failed build's failed group and those around it;
	 * every group of a running build, so following shows all it printed, and
	 * nothing folds when the build ends; nothing else. A group the user
	 * opened or folded stays as the user left it.
	 */
	$effect(() => {
		const gs = groups;
		const loaded = c.loaded;
		const fold: number[] = [];
		const unfold: number[] = [];
		// A linked line's groups open too.
		const linked = range;
		const holdsLink = (g: GroupView) =>
			linked !== null &&
			g.line !== null &&
			g.line <= linked.to &&
			(g.closed ? (g.lastLine ?? Infinity) >= linked.from : true);
		for (const g of gs) {
			if (seen.has(g.id)) continue;
			seen.add(g.id);
			if (touched.has(g.id) || holdsLink(g)) continue;
			// A running build keeps every group open, so following shows the whole log.
			if (!running) fold.push(g.id);
		}
		if (loaded && failed)
			for (const id of failedChain) if (!touched.has(id) && c.folded.has(id)) unfold.push(id);
		const fixed = fold.filter((id) => !failedChain.has(id) || touched.has(id));
		untrack(() => {
			if (fixed.length) void c.fold(fixed, false, null);
			if (unfold.length) void c.fold(unfold, true, null);
		});
	});

	// ------------------------------------------------------------- position

	/** Where the view starts: a linked line, a failed build's first error, a running build's end. */
	$effect(() => {
		if (positioned || !view) return;
		const r = range;
		// A linked line takes precedence. A finished log loads first, so its groups exist to open.
		if (r && c.progress && c.progress.lines >= r.from && (running || c.loaded)) {
			positioned = true;
			void untrack(async () => {
				const row = await c.reveal(r.from);
				await tick();
				if (typeof row === 'number') view?.scrollToRow(row, 0.5);
			});
			return;
		}
		if (r && !c.loaded) return;
		if (running && c.following) {
			positioned = true;
			following = true;
			announce = 'Following';
			return;
		}
		// A failed build goes to its end once the tail is in, while the head may still load.
		if (!(c.loaded || (failed && c.endIn)) || !c.errors) return;
		positioned = true;
		if (failed) void untrack(() => jumpToFirstError());
		else announce = `Log loaded, ${linesWord(c.progress?.lines ?? 0)}`;
	});

	async function jumpToFirstError() {
		const e = c.errors;
		if (!e) return;
		const line = e.first ?? e.lastLines;
		const row = await c.reveal(line);
		await tick();
		await new Promise((r) => requestAnimationFrame(r));
		// Seven lines of context above it.
		if (typeof row === 'number') view?.scrollToRow(Math.max(0, row - 7));
		errorLine = e.first;
		// Now that the view is drawn, a head still on its way may go in above it.
		requestAnimationFrame(() => requestAnimationFrame(() => c.endShown()));
		if (c.loaded) sayLoaded();
	}

	let loadedSaid = false;
	function sayLoaded() {
		loadedSaid = true;
		announce = `Log loaded, ${linesWord(c.progress?.lines ?? 0)}`;
	}
	// A failed build that went to its end before its head arrived says so once it is all in.
	$effect(() => {
		if (c.loaded && positioned && failed && !loadedSaid) untrack(() => sayLoaded());
	});

	async function goToError(dir: 1 | -1) {
		const e = c.errors;
		const line = e ? stepError(e.lines, errorLine, dir) : null;
		if (line === null) return;
		errorLine = line;
		const row = await c.reveal(line);
		await tick();
		if (typeof row === 'number') view?.scrollToRow(row, 0.3);
	}

	// ---------------------------------------------------------------- find

	$effect(() => {
		const q = query;
		const cs = caseSensitive;
		const only = onlyMatching;
		untrack(() => {
			c.setSearch(q, cs, only);
			hit = -1;
		});
	});

	async function stepHit(dir: 1 | -1) {
		const s = c.search;
		if (!s || s.count === 0) return;
		hit = hit < 0 ? (dir > 0 ? 0 : s.count - 1) : (hit + dir + s.count) % s.count;
		const r = await c.gotoHit(hit);
		await tick();
		if (r.row !== null) view?.scrollToRow(r.row, 0.3);
	}

	const hitText = $derived.by(() => {
		const s = c.search;
		if (!s || !query) return '';
		const n = s.capped ? `${formatExact(s.count)}+` : formatExact(s.count);
		const where = s.gapSkipped ? ' in the shown parts' : '';
		if (s.count === 0) return s.complete ? `No matches${where}` : 'Searching';
		return hit >= 0 ? `${formatExact(hit + 1)} of ${n}${where}` : `${n} matches${where}`;
	});

	// ------------------------------------------------------------- actions

	async function foldAll(open: boolean) {
		for (const g of groups) touched.add(g.id);
		const anchor = view?.firstVisibleSlot() ?? null;
		const g = anchor === null ? null : headerOf(anchor);
		const row = await c.foldAll(open, g?.headerSlot ?? anchor);
		await tick();
		if (row !== null) view?.scrollToRow(row);
	}

	/** The outermost header of the group that holds a slot, to keep in place. */
	function headerOf(slot: number): Group | null {
		let best: Group | null = null;
		for (const g of groups)
			if (g.depth === 0 && slot >= g.headerSlot && slot <= g.lastSlot) best = g;
		return best;
	}

	function resumeFollow() {
		if (!running) return;
		following = true;
		newLines = 0;
		announce = 'Following';
		view?.scrollToEnd();
	}

	function setFollow(on: boolean) {
		if (!running || on === following) return;
		if (on) resumeFollow();
		else {
			following = false;
			announce = 'Not following';
		}
	}

	const fileName = $derived(`${build.drvPath.replace(/\.drv$/, '')}.log`);

	/** The whole log is being fetched again for "Save log". */
	let saving = $state(false);

	async function saveLog() {
		menu = false;
		if (saving) return;
		// For a log with a part not shown, save the builder's whole stream, compressed, as it arrives.
		let blob: Blob | null = null;
		let name = fileName;
		if (c.progress?.gap && c.backend.kind === 'grpc') {
			saving = true;
			blob = await c.zstdBlob();
			saving = false;
			name = `${fileName}.zst`;
		}
		if (!blob) {
			blob = await c.blob('raw');
			name = fileName;
		}
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}

	async function openAsText() {
		menu = false;
		const blob = await c.blob('text');
		const url = URL.createObjectURL(blob);
		window.open(url, '_blank', 'noopener');
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	async function copy(what: 'link' | 'lines' | 'path') {
		let text = '';
		if (what === 'link') text = location.href;
		else if (what === 'path') text = `/nix/store/${build.drvPath}`;
		else if (range) text = await c.range(range.from, range.to);
		await copier.copy(what, text);
	}

	function selectLine(line: number, extend: boolean) {
		const r: LineRange =
			extend && range
				? { from: Math.min(range.from, line), to: Math.max(range.to, line) }
				: { from: line, to: line };
		onrange(r);
	}

	async function showMore(slot: number) {
		overlay = await c.lineText(slot);
	}

	// ---------------------------------------------------------------- keys

	function onkeydown(e: KeyboardEvent) {
		if (e.defaultPrevented) return;
		const t = e.target as HTMLElement;
		const typing = !!t.closest('input, textarea, select');
		if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
			// The first press finds in the log; a second goes to the browser.
			if (document.activeElement === findBox) return;
			e.preventDefault();
			findBox?.focus();
			findBox?.select();
			return;
		}
		if (e.key === 'F3') {
			e.preventDefault();
			void stepHit(e.shiftKey ? -1 : 1);
			return;
		}
		if (e.key === 'Escape') {
			if (overlay) overlay = null;
			else if (menu) menu = false;
			else if (query) query = '';
			else onescape();
			e.preventDefault();
			return;
		}
		if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
		if (view?.key(e)) {
			e.preventDefault();
			return;
		}
		switch (e.key) {
			case 'End':
			case 'G':
				e.preventDefault();
				if (running) resumeFollow();
				else view?.scrollToEnd();
				break;
			case 'Home':
				e.preventDefault();
				view?.scrollToRow(0);
				break;
			case 'e':
			case 'E':
				e.preventDefault();
				void goToError(e.key === 'e' ? 1 : -1);
				break;
			case 'n':
			case 'N':
				e.preventDefault();
				void stepHit(e.key === 'n' ? 1 : -1);
				break;
			case '[':
			case ']':
				e.preventDefault();
				void view?.focusHeader(e.key === ']' ? 1 : -1);
				break;
			case 'w':
				e.preventDefault();
				wrap = !wrap;
				break;
		}
	}

	// ---------------------------------------------------------------- words

	const now = $derived(clock.now);
	const facts = $derived.by(() => {
		const b = build;
		const parts: Said[] = [];
		const from = b.startedMs ?? b.assignedMs;
		if (b.state === 'assigned') {
			if (from !== null) {
				const s = span(Math.max(0, now - from));
				const head = b.startedMs !== null ? 'Running' : 'Assigned';
				parts.push({ text: `${head}, ${s.text} elapsed`, words: `${head}, ${s.words} elapsed` });
			}
		} else if (from !== null && b.finishedMs !== null) {
			const s = span(Math.max(0, b.finishedMs - from));
			parts.push({ text: `Took ${s.text}`, words: `Took ${s.words}` });
		}
		const plain = (t: string) => parts.push({ text: t, words: t });
		if (b.system) plain(b.system);
		if (b.worker) plain(`on ${b.worker}`);
		if (b.requestedBy.length) plain(`requested by ${b.requestedBy.join(', ')}`);
		if (b.assignedMs !== null) plain(`assigned ${formatClock(b.assignedMs)}`);
		if (b.startedMs !== null) plain(`started ${formatClock(b.startedMs)}`);
		// When it ended: "failed 10:42:16 AM", "finished 10:42:16 AM".
		if (b.state !== 'assigned' && b.finishedMs !== null)
			plain(`${b.state === 'built' ? 'finished' : b.state} ${formatClock(b.finishedMs)}`);
		return parts;
	});

	const builder = $derived(c.node || build.worker);
	const where = $derived.by(() => {
		if (!c.source) return '';
		if (c.source === 'store') return "From the farm's log store";
		if (c.source === 'cache') return 'From the binary cache';
		return `${following ? 'Following' : 'From'} ${builder}`;
	});
	const statusLine = $derived.by(() => {
		const p = c.progress;
		if (!p) return '';
		const parts = [linesWord(p.lines), formatBytes(p.bytes)];
		if (c.loaded) parts.push('loaded');
		else if (!running) parts.push('loading');
		if (saving) parts.push('saving the whole log');
		return parts.join(' · ');
	});
	/** A problem replaces the log, unless lines arrived before it and stay. */
	/** Problems the client retries on its own, with "Retry now" to skip the wait. */
	const retries = (k: string | undefined) => k === 'lost' || k === 'busy' || k === 'unreadable';
	const keeps = (k: string) => ['damaged', 'ended-early', 'lost', 'busy', 'unreadable'].includes(k);
	const empty = $derived(
		c.problem && !(keeps(c.problem.kind) && (c.progress?.lines ?? 0) > 0)
			? problemSentence(
					c.problem,
					builder,
					build.finishedMs !== null && now - build.finishedMs > 3_600_000
				)
			: null
	);
	const waiting = $derived(running && !c.started && (c.progress?.lines ?? 0) === 0);
	/** A running build the viewer followed ended: from the demo, or the store's build. */
	let wasRunning = $state(false);
	$effect(() => {
		if (build.state === 'assigned') wasRunning = true;
	});
	const endedText = $derived.by(() => {
		const e = c.ended;
		if (!e && wasRunning && build.state !== 'assigned') {
			const label =
				build.state === 'failed'
					? `failed${build.status && build.status !== 'build-failed' ? ` (${STATUS_LABEL[build.status].toLowerCase()})` : ''}`
					: build.state;
			return `Build finished: ${label}${build.finishedMs ? ` at ${formatClock(build.finishedMs)}` : ''}`;
		}
		if (!e) return null;
		const st = e.ending.status;
		const label =
			e.ending.outcome === DrvGone_Outcome.FAILED
				? `failed${st !== DrvGone_Status.UNSPECIFIED && st !== DrvGone_Status.PERMANENT_FAILURE ? ` (${(STATUS_LABEL[statusKey(st)] ?? '').toLowerCase()})` : ''}`
				: outcomePhase(e.ending.outcome);
		return `Build finished: ${label} at ${formatClock(e.atMs)}`;
	});

	function statusKey(s: DrvGone_Status): BuildStatus {
		switch (s) {
			case DrvGone_Status.TIMED_OUT:
				return 'timed-out';
			case DrvGone_Status.LOG_LIMIT_EXCEEDED:
				return 'log-limit';
			case DrvGone_Status.OUTPUT_REJECTED:
				return 'output-rejected';
			case DrvGone_Status.TRANSIENT_FAILURE:
				return 'transient';
			case DrvGone_Status.MISC_FAILURE:
				return 'misc';
			case DrvGone_Status.NOT_DETERMINISTIC:
				return 'not-deterministic';
			default:
				return 'build-failed';
		}
	}

	const phase = $derived(
		build.phase && build.phaseStartedMs !== null
			? { name: build.phase, startedMs: build.phaseStartedMs }
			: null
	);
	/** For a running build past the builder's cap, the last line says so. */
	const truncated = $derived(running && (c.progress?.bytes ?? 0) >= 64 * 1024 * 1024);
	const hasGroups = $derived(groups.length > 0);
	const progressPct = $derived(
		!c.loaded && c.size > 0 && c.progress ? Math.min(100, (c.progress.bytes / c.size) * 100) : null
	);
</script>

<!-- Keys work only while focus is inside the viewer (WCAG 2.1.4). It is not role="log",
     which would read every line aloud. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<section class="viewer" aria-label="Log of {build.name}" tabindex="0" {onkeydown}>
	<header class="head">
		<div class="title">
			<PhaseChip phase={build.state} />
			<h2 title={build.drvPath}>{build.name}</h2>
			<div class="actions">
				{#if onshowmap}
					<button type="button" class="btn" onclick={onshowmap} title="Show this build on the map">
						<Icon name="map" />Show on map
					</button>
				{/if}
				<button
					type="button"
					class="btn"
					onclick={() => copy('link')}
					title="Copy a link to this log"
				>
					<Icon name={copier.what === 'link' ? 'check' : 'link'} />{copier.what === 'link'
						? 'Copied'
						: 'Copy link'}
				</button>
				<div class="menu-wrap">
					<button
						type="button"
						class="btn"
						aria-haspopup="menu"
						aria-expanded={menu}
						onclick={() => (menu = !menu)}
						title="The raw log"
					>
						<Icon name="save" />Raw log
					</button>
					{#if menu}
						<div class="menu" role="menu">
							<button type="button" role="menuitem" onclick={saveLog}>Save log</button>
							<button type="button" role="menuitem" onclick={openAsText}>Open as text</button>
						</div>
					{/if}
				</div>
			</div>
		</div>
		<div class="path">
			<code>/nix/store/{build.drvPath}</code>
			<button
				type="button"
				class="icon-btn"
				onclick={() => copy('path')}
				title="Copy the derivation path"
			>
				<Icon
					name={copier.what === 'path' ? 'check' : 'copy'}
					label={copier.what === 'path' ? 'Copied' : 'Copy path'}
				/>
			</button>
		</div>
		<p class="facts">
			{#each facts as f, i (i)}{#if i > 0}<span class="dot" aria-hidden="true">·</span>{/if}<Spoken
					{...f}
				/>{/each}
		</p>
		{#if failed && build.status}
			<div class="p-callout danger" role="note">
				<Icon name="info" />
				<span>
					<strong>{statusTitle(build.status)}</strong>
					<span class="sentence">{STATUS_SENTENCE[build.status]}</span>
				</span>
			</div>
		{/if}
	</header>

	{#if empty}
		<LogEmpty sentence={empty}>
			{#if c.problem?.kind === 'rebuilding' && onopenbuild}
				{@const id = c.problem.assignId}
				<button type="button" class="btn" onclick={() => onopenbuild(id)}
					>Follow the new build</button
				>
			{:else if retries(c.problem?.kind)}
				<button type="button" class="btn" onclick={() => c.retryNow()}>Retry now</button>
			{/if}
		</LogEmpty>
	{:else}
		<div class="toolbar" role="toolbar" aria-label="Log tools">
			<span class="find">
				<Icon name="search" />
				<input
					type="search"
					placeholder="Find in log"
					aria-label="Find in log"
					bind:value={query}
					bind:this={findBox}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							void stepHit(e.shiftKey ? -1 : 1);
						}
					}}
				/>
			</span>
			<span class="count num" aria-live="polite">{hitText}</span>
			<button
				type="button"
				class="icon-btn"
				onclick={() => stepHit(-1)}
				disabled={!c.search?.count}
				title="Previous match (Shift+Enter)"><Icon name="up" label="Previous match" /></button
			>
			<button
				type="button"
				class="icon-btn"
				onclick={() => stepHit(1)}
				disabled={!c.search?.count}
				title="Next match (Enter)"><Icon name="down" label="Next match" /></button
			>
			<label class="toggle"><input type="checkbox" bind:checked={caseSensitive} />Match case</label>
			<label class="toggle"
				><input type="checkbox" bind:checked={onlyMatching} />Only matching lines</label
			>
			<span class="sep"></span>
			{#if c.errors && (c.errors.lines.length > 0 || failed)}
				<span class="errors num">
					{#if c.errors.lines.length > 0}
						Errors {c.errors.capped
							? `${formatExact(c.errors.lines.length)}+`
							: formatExact(c.errors.lines.length)}
						<button
							type="button"
							class="icon-btn"
							onclick={() => goToError(-1)}
							title="Previous error (E)"><Icon name="up" label="Previous error" /></button
						>
						<button
							type="button"
							class="icon-btn"
							onclick={() => goToError(1)}
							title="Next error (e)"><Icon name="down" label="Next error" /></button
						>
					{:else}
						<button type="button" class="btn" onclick={jumpToFirstError}>Last lines</button>
					{/if}
				</span>
			{/if}
			{#if hasGroups}
				<button
					type="button"
					class="icon-btn"
					data-fold="open"
					onclick={() => foldAll(true)}
					disabled={c.folded.size === 0}
					title="Expand all"><Icon name="expand" label="Expand all" /></button
				>
				<button
					type="button"
					class="icon-btn"
					data-fold="close"
					onclick={() => foldAll(false)}
					disabled={allFolded}
					title="Collapse all"><Icon name="collapse" label="Collapse all" /></button
				>
			{/if}
			{#if range}
				<button type="button" class="btn" onclick={() => copy('lines')}
					>{copier.what === 'lines' ? 'Copied' : 'Copy lines'}</button
				>
			{/if}
			<label class="toggle"><input type="checkbox" bind:checked={wrap} />Wrap</label>
			{#if running}
				<label class="toggle"
					><input
						type="checkbox"
						checked={following}
						onchange={(e) =>
							(e.currentTarget as HTMLInputElement).checked ? resumeFollow() : setFollow(false)}
					/>Follow</label
				>
			{/if}
		</div>

		{#if c.problem && !empty}
			<p class="caption problem" role="status">
				{problemSentence(c.problem, builder, false)}
				{#if retries(c.problem.kind)}
					<button type="button" class="btn" onclick={() => c.retryNow()}>Retry now</button>
				{/if}
			</p>
		{/if}
		{#if waiting}
			<p class="caption">Waiting for the build to start on {build.worker}</p>
		{/if}
		{#if c.rebuiltAt !== null}
			<p class="caption" role="note">
				{builder} built this again at {formatClockMinutes(c.rebuiltAt)}. This is the log of that
				build.
			</p>
		{/if}
		{#if truncated}
			<p class="caption">
				The builder keeps the first 64 MiB while the build runs. The whole log is here when it ends.
			</p>
		{/if}

		<div class="log">
			<LogView
				bind:this={view}
				client={c}
				{wrap}
				{following}
				selected={range}
				ontouch={(id) => touched.add(id)}
				onselectline={selectLine}
				onfollow={(on) => setFollow(on)}
				onnewlines={(n) => (newLines = n)}
				onmore={showMore}
				onsavewhole={saveLog}
				{running}
				{phase}
				{failedChain}
				nowMs={now}
			>
				{#snippet footer()}
					{#if endedText}
						<div class="ended">
							<span>{endedText}</span>
							{#if failed}<button type="button" class="btn" onclick={jumpToFirstError}
									>Jump to first error</button
								>{/if}
						</div>
					{/if}
					{#if failed && errorText && c.loaded}
						{@const gist = nixGist(errorText)}
						<!-- One line until opened, since Nix's message often repeats the log's last lines. -->
						<details
							class="nix"
							bind:open={nixOpen}
							ontoggle={(e) =>
								e.currentTarget.open && e.currentTarget.scrollIntoView({ block: 'nearest' })}
						>
							<summary
								><span class="gist">Nix reported{gist ? `: ${gist}` : ''}</span><span
									class="sep"
									aria-hidden="true">·</span
								><span class="more">{nixOpen ? 'Hide' : 'Show'}</span></summary
							>
							<pre>{errorText}</pre>
						</details>
					{/if}
				{/snippet}
			</LogView>
			{#if running && !following && positioned}
				<button type="button" class="pill" onclick={resumeFollow}>
					Not following · {plural(newLines, 'new line', 'new lines', formatExact)} · Jump to end (End)
				</button>
			{/if}
		</div>

		<footer class="status">
			<span class="num">{statusLine}</span>
			{#if progressPct !== null}
				<span
					class="bar"
					role="progressbar"
					aria-valuenow={Math.round(progressPct)}
					aria-valuemin="0"
					aria-valuemax="100"><span style:width="{progressPct}%"></span></span
				>
			{/if}
			{#if where}<span>{where}</span>{/if}
			{#if c.maybeReplaced}<span
					>A later build of this derivation on the same builder replaces its log.</span
				>{/if}
		</footer>
	{/if}
	<div class="visually-hidden" aria-live="polite">{announce}</div>

	{#if overlay !== null}
		<div class="overlay" role="dialog" aria-label="The whole line">
			<button type="button" class="btn close" onclick={() => (overlay = null)}>Close</button>
			<pre>{overlay}</pre>
		</div>
	{/if}
</section>

<style>
	.viewer {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		height: 100%;
		background: var(--bg);
	}

	.viewer:focus-visible {
		outline-offset: -2px;
	}

	.head {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
	}

	.title {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
	}

	h2 {
		margin: 0;
		overflow: hidden;
		font-size: var(--text-lg);
		font-weight: 650;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		margin-left: auto;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--fg);
		font-size: var(--text-xs);
		font-weight: 550;
		white-space: nowrap;
	}

	.btn:hover {
		background: var(--bg-panel);
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--fg-muted);
	}

	.icon-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--fg);
	}

	.icon-btn:disabled {
		opacity: 0.4;
	}

	.menu-wrap {
		position: relative;
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		min-width: 160px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		box-shadow: var(--shadow-md);
	}

	.menu button {
		padding: 6px 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--fg);
		font-size: var(--text-xs);
		text-align: left;
	}

	.menu button:hover,
	.menu button:focus-visible {
		background: var(--bg-hover);
	}

	.path {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 0;
	}

	.path code {
		overflow: hidden;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.facts .dot {
		margin: 0 0.4em;
	}

	.facts {
		margin: 0;
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.p-callout .sentence {
		display: block;
		color: var(--fg);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border-bottom: 1px solid var(--border-subtle);
		font-size: var(--text-xs);
	}

	.find {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--fg-muted);
	}

	.find input {
		width: 180px;
		border: 0;
		outline: 0;
		background: none;
		color: var(--fg);
		font: inherit;
	}

	.find:focus-within {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.count {
		min-width: 9ch;
		color: var(--fg-muted);
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--fg);
		white-space: nowrap;
	}

	.sep {
		flex: 1 1 auto;
	}

	.errors {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		color: var(--danger-fg);
	}

	.caption {
		margin: 0;
		padding: var(--space-2) var(--space-4);
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.log {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
	}

	.pill {
		position: absolute;
		bottom: 12px;
		left: 50%;
		z-index: 5;
		transform: translateX(-50%);
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-full);
		background: var(--bg);
		box-shadow: var(--shadow-md);
		color: var(--fg);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.ended {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
		color: var(--fg);
		font-size: var(--text-sm);
		font-weight: 550;
	}

	.nix summary {
		display: flex;
		gap: var(--space-2);
		width: fit-content;
		max-width: 100%;
		font-size: var(--text-sm);
		font-weight: 550;
		list-style: none;
		cursor: pointer;
	}

	.nix summary::-webkit-details-marker {
		display: none;
	}

	.nix .gist {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.nix .sep {
		color: var(--fg-muted);
	}

	.nix .more {
		color: var(--accent-strong);
	}

	.nix pre {
		margin: var(--space-2) 0 0;
		padding: var(--space-3);
		overflow-x: auto;
		border-radius: var(--radius);
		background: var(--bg-panel);
		font-size: var(--text-2xs);
		white-space: pre-wrap;
	}

	.status {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		padding: 4px var(--space-4);
		border-top: 1px solid var(--border-subtle);
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	.bar {
		width: 120px;
		height: 4px;
		border-radius: 2px;
		background: var(--bg-raised);
	}

	.bar span {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: var(--accent);
	}

	.overlay {
		position: absolute;
		inset: 40px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg);
		box-shadow: var(--shadow-lg);
	}

	.overlay pre {
		flex: 1 1 auto;
		margin: 0;
		overflow: auto;
		font-size: var(--text-2xs);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.close {
		align-self: flex-end;
	}
</style>
