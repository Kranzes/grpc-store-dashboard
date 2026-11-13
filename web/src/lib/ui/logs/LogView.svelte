<script lang="ts">
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import type { LogClient } from '#lib/logs/client.svelte.ts';
	import type { Group } from '#lib/logs/groups.ts';
	import type { GroupView, RenderedRow } from '#lib/logs/protocol.ts';
	import { formatBytes, formatExact } from '../format.ts';
	import type { LineRange } from '../nav.ts';
	import GroupHeader from './GroupHeader.svelte';
	import type { ReportedPhase } from './words.ts';
	import './log.css';

	// The log, drawn virtualized: one absolutely placed block per visible row,
	// text in text nodes only, a sticky gutter of line numbers, group headers
	// that fold, and the headers of the groups around the first line stuck at
	// the top. Below 8,000,000 px it scrolls natively; above, the spacer
	// stays at 8,000,000 px and positions map proportionally, with wheel and
	// keys moved in rows.
	type Props = {
		client: LogClient;
		wrap: boolean;
		/** The view stays at the end as lines arrive. */
		following: boolean;
		/** The selected lines, for the gutter bar. */
		selected: LineRange | null;
		/** Groups the user opened or folded, which defaults leave alone. */
		ontouch: (id: number) => void;
		/** A click on a line number; with shift it extends the range. */
		onselectline: (line: number, extend: boolean) => void;
		/** The user scrolled up, so stop following, or reached the end, so follow again. */
		onfollow: (on: boolean) => void;
		/** Lines that arrived since following stopped. */
		onnewlines?: (n: number) => void;
		/** "Show more" on a long line. */
		onmore: (slot: number) => void;
		/** The gap row's button. */
		onsavewhole: () => void;
		/** While the build runs, elapsed time on the current group. */
		running: boolean;
		/** The phase the builder last reported, for elapsed on its header. */
		phase: ReportedPhase | null;
		/** The failed group and those around it, for the ✕. */
		failedChain: ReadonlySet<number>;
		nowMs: number;
		/** Below the last line: how the build ended, what Nix reported. */
		footer?: Snippet;
	};
	let {
		client,
		wrap,
		following,
		selected,
		ontouch,
		onselectline,
		onfollow,
		onnewlines,
		onmore,
		onsavewhole,
		running,
		phase,
		failedChain,
		nowMs,
		footer
	}: Props = $props();

	const MAX_PX = 8_000_000;
	const STICKY_MAX = 3;

	let scroller: HTMLDivElement | undefined = $state();
	let probe: HTMLSpanElement | undefined = $state();
	let rowH = $state(18);
	let charW = $state(7.8);
	let width = $state(0);
	let height = $state(0);
	let scrollTop = $state(0);
	/** Rows drawn: the answer for the last window asked. */
	let drawn = $state.raw<readonly RenderedRow[]>([]);
	let maxCells = $state(0);
	const GUTTER_CELLS = 8;

	const total = $derived(client.total);
	const fullPx = $derived(total * rowH);
	const scaled = $derived(fullPx > MAX_PX);
	const spacerPx = $derived(Math.min(fullPx, MAX_PX));
	/** The virtual offset of the top of the view, in px of the full log. */
	const virtualTop = $derived(
		scaled ? (scrollTop / Math.max(1, MAX_PX - height)) * Math.max(0, fullPx - height) : scrollTop
	);
	const firstRow = $derived(Math.floor(virtualTop / rowH));
	const visibleRows = $derived(Math.ceil(height / rowH) + 1);
	const cols = $derived(
		Math.max(20, Math.floor((width - (GUTTER_CELLS + 3) * charW - 24) / charW))
	);

	$effect(() => {
		client.setLayout(cols, wrap);
	});

	// Ask for the rows in view and two screens around them, whenever the
	// view moves or the log changes. One answer at a time.
	let asking = false;
	let again = false;
	async function fetchRows() {
		if (asking) {
			again = true;
			return;
		}
		asking = true;
		const screen = visibleRows;
		const from = Math.max(0, firstRow - screen * 2);
		const to = Math.min(total, firstRow + screen * 3);
		const r = await client.rows(from, to);
		drawn = r.rows;
		let m = maxCells;
		for (const row of r.rows) {
			let n = 0;
			for (const s of row.segs ?? []) n += s[0].length;
			if (n > m) m = n;
		}
		maxCells = m;
		asking = false;
		if (again) {
			again = false;
			void fetchRows();
		}
	}
	$effect(() => {
		void client.version;
		void firstRow;
		void visibleRows;
		void total;
		untrack(() => void fetchRows());
	});

	const view = $derived(
		drawn.filter((r) => r.row >= firstRow - 1 && r.row <= firstRow + visibleRows)
	);

	/** Where a row's block sits in the spacer. */
	function topOf(row: number): number {
		return scaled ? scrollTop + (row * rowH - virtualTop) : row * rowH;
	}

	const groupsById = $derived(new Map(client.groups.map((g) => [g.id, g])));

	/** The headers of the open groups that hold the first visible line, at most 3, innermost last. */
	const sticky = $derived.by((): GroupView[] => {
		const top = view.find((r) => r.row >= firstRow);
		if (!top || top.slot < 0) return [];
		const out: GroupView[] = [];
		for (const g of client.groups) {
			if (client.folded.has(g.id)) continue;
			if (top.slot > g.headerSlot && top.slot <= g.lastSlot) out.push(g);
		}
		out.sort((a, b) => a.depth - b.depth);
		return out.slice(-STICKY_MAX);
	});

	// ------------------------------------------------------------- measure

	onMount(() => {
		const measure = () => {
			if (!probe) return;
			const r = probe.getBoundingClientRect();
			if (r.height > 0) rowH = Math.round(r.height * 100) / 100;
			if (r.width > 0) charW = r.width / 10;
		};
		measure();
		const ro = new ResizeObserver(measure);
		if (probe) ro.observe(probe);
		return () => ro.disconnect();
	});

	// ------------------------------------------------------------- scroll

	let selfScroll = false;
	/** The scroller's scrollTop for a virtual offset, in px of the full log. */
	const nativeTop = (v: number) =>
		scaled ? (v / Math.max(1, fullPx - height)) * (MAX_PX - height) : v;
	/** Scroll the scroller to `px` without counting it as the user's scroll. */
	function setScroll(px: number) {
		if (!scroller) return;
		selfScroll = true;
		scroller.scrollTop = px;
		scrollTop = scroller.scrollTop;
	}

	/** Scroll so row `row` is at `align` of the view: 0 top, 0.5 middle, 1 bottom. */
	export function scrollToRow(row: number, align = 0) {
		setScroll(nativeTop(Math.max(0, row * rowH - align * (height - rowH))));
	}

	// Rows that go in above keep the view still: the head of a log whose tail came first.
	$effect(() =>
		client.onMoved((m) => {
			if (!scroller || m.shift === 0) return;
			const top = virtualTop + m.shift * rowH;
			void tick().then(() => setScroll(nativeTop(top)));
		})
	);

	export function scrollToEnd() {
		if (scroller) setScroll(scroller.scrollHeight);
	}

	export function firstVisibleSlot(): number | null {
		const top = view.find((r) => r.row >= firstRow);
		return top && top.slot >= 0 ? top.slot : null;
	}

	/** Rows down, or up when negative, as the wheel does in a log too tall to scroll natively. */
	function moveRows(n: number) {
		scrollToRow(Math.max(0, Math.min(total - 1, firstRow + n)));
	}

	const atEnd = () =>
		!!scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;

	function onscroll() {
		if (!scroller) return;
		scrollTop = scroller.scrollTop;
		if (selfScroll) {
			selfScroll = false;
			return;
		}
		if (!following && atEnd()) onfollow(true);
	}

	// Follow: stay at the end as rows arrive, one write per frame.
	let frame = 0;
	$effect(() => {
		void total;
		void client.version;
		if (!following) return;
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => scrollToEnd());
	});
	// Count lines that arrive while not following.
	let linesAtStop = 0;
	$effect(() => {
		const lines = client.progress?.lines ?? 0;
		if (following) linesAtStop = lines;
		else onnewlines?.(Math.max(0, lines - linesAtStop));
	});

	function onwheel(e: WheelEvent) {
		if (e.deltaY < 0 && following) onfollow(false);
		if (scaled && !e.ctrlKey) {
			e.preventDefault();
			const px =
				e.deltaMode === 1 ? e.deltaY * rowH : e.deltaMode === 2 ? e.deltaY * height : e.deltaY;
			moveRows(Math.round(px / rowH));
		}
	}

	let touchY = 0;
	function ontouchstart(e: TouchEvent) {
		touchY = e.touches[0]?.clientY ?? 0;
	}
	function ontouchmove(e: TouchEvent) {
		const y = e.touches[0]?.clientY ?? 0;
		// A finger moving down drags the content down, which means upward intent.
		if (y > touchY + 2 && following) onfollow(false);
		touchY = y;
	}

	function onpointerdown(e: PointerEvent) {
		if (!scroller) return;
		// On the scrollbar, past the content box.
		const r = scroller.getBoundingClientRect();
		if (e.clientX > r.left + scroller.clientWidth && following) onfollow(false);
	}

	/** Keys the view handles itself: up keys stop following; in a tall log, keys move in rows. */
	export function key(e: KeyboardEvent): boolean {
		const up = e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home';
		if (up && following) onfollow(false);
		if (!scaled) return false;
		const page = Math.max(1, visibleRows - 2);
		const n =
			e.key === 'ArrowDown'
				? 1
				: e.key === 'ArrowUp'
					? -1
					: e.key === 'PageDown'
						? page
						: e.key === 'PageUp'
							? -page
							: 0;
		if (!n) return false;
		moveRows(n);
		return true;
	}

	// ------------------------------------------------------------- groups

	async function toggle(g: Group, fromSticky: boolean) {
		ontouch(g.id);
		const open = client.folded.has(g.id);
		const anchor = firstVisibleSlot();
		const row = await client.fold([g.id], open, fromSticky ? g.headerSlot : anchor);
		if (fromSticky && row !== null) {
			// Fold it and bring its header row to the top.
			await tick();
			scrollToRow(row);
		}
	}

	/** Focus the header row before or after the focused one, in view order. */
	export async function focusHeader(dir: 1 | -1) {
		const headers = client.groups
			.filter((g) => isShownHeader(g))
			.sort((a, b) => a.headerSlot - b.headerSlot);
		if (!headers.length) return;
		const active = document.activeElement as HTMLElement | null;
		const cur = Number(active?.closest<HTMLElement>('[data-header]')?.dataset.header ?? NaN);
		const curSlot = Number.isFinite(cur) ? (groupsById.get(cur)?.headerSlot ?? -1) : null;
		const base = curSlot ?? firstVisibleSlot() ?? 0;
		const pick =
			dir > 0
				? (headers.find((h) => (curSlot === null ? h.headerSlot >= base : h.headerSlot > base)) ??
					headers.at(-1)!)
				: ([...headers].reverse().find((h) => h.headerSlot < base) ?? headers[0]);
		if (pick.line === null) return;
		const row = await client.reveal(pick.line);
		if (typeof row === 'number') {
			const first = firstRow;
			if (row < first || row >= first + visibleRows - 1) scrollToRow(row, 0.3);
		}
		focusGroupId = pick.id;
		await tick();
		await new Promise((r) => requestAnimationFrame(r));
		scroller?.querySelector<HTMLElement>(`[data-header="${pick.id}"] button`)?.focus();
	}
	let focusGroupId = $state<number | null>(null);

	function isShownHeader(g: Group): boolean {
		// Headers inside a folded group are skipped.
		let p = g.parent === null ? null : groupsById.get(g.parent);
		while (p) {
			if (client.folded.has(p.id)) return false;
			p = p.parent === null ? null : groupsById.get(p.parent);
		}
		return true;
	}

	// --------------------------------------------------------------- copy

	/** A copy of drawn rows, where the parts of one wrapped line join without a newline. */
	function oncopy(e: ClipboardEvent) {
		const sel = document.getSelection();
		if (!sel || sel.rangeCount === 0 || !scroller) return;
		const range = sel.getRangeAt(0);
		const rows = [...scroller.querySelectorAll<HTMLElement>('.row[data-slot]')].filter((el) =>
			range.intersectsNode(el)
		);
		if (rows.length < 2) return;
		rows.sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row));
		let text = '';
		let lastSlot: string | null = null;
		for (const el of rows) {
			const t = el.querySelector('.text');
			if (!t) continue;
			const r = document.createRange();
			r.selectNodeContents(t);
			if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0)
				r.setStart(range.startContainer, range.startOffset);
			if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0)
				r.setEnd(range.endContainer, range.endOffset);
			const piece = r.toString();
			if (lastSlot !== null) text += el.dataset.slot === lastSlot ? '' : '\n';
			text += piece;
			lastSlot = el.dataset.slot ?? null;
		}
		e.clipboardData?.setData('text/plain', text);
		e.preventDefault();
	}

	const inRange = (line: number | null) =>
		line !== null && !!selected && line >= selected.from && line <= selected.to;
	const lineSelected = (r: RenderedRow) => {
		if (!selected) return false;
		// Every row of a selected line, its later rows included.
		const first = drawn.find((x) => x.slot === r.slot && x.line !== null);
		return inRange(first?.line ?? r.line);
	};
</script>

<div class="log-view" class:nowrap={!wrap} style:--view-w="{width}px" style:--char-w="{charW}px">
	<span class="probe" bind:this={probe} aria-hidden="true">0123456789</span>
	{#if sticky.length}
		<div class="sticky" style:--row-h="{rowH}px">
			{#each sticky as g (g.id)}
				<div class="row header-row" data-header={g.id}>
					<GroupHeader
						group={g}
						folded={false}
						failed={failedChain.has(g.id)}
						current={running && client.openGroups.includes(g.id)}
						{phase}
						{nowMs}
						line={g.line}
						onclick={() => toggle(g, true)}
					/>
				</div>
			{/each}
		</div>
	{/if}
	<!-- Wheel, touch and pointer events only tell upward intent; the keys are the viewer's. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="scroller"
		bind:this={scroller}
		bind:clientWidth={width}
		bind:clientHeight={height}
		{onscroll}
		{onwheel}
		{ontouchstart}
		{ontouchmove}
		{onpointerdown}
		{oncopy}
		style:--row-h="{rowH}px"
	>
		<div
			class="spacer"
			style:height="{spacerPx}px"
			style:width={wrap ? undefined : `${(maxCells + GUTTER_CELLS + 4) * charW + 24}px`}
		>
			{#each view as r (r.row)}
				<div
					class="row {r.kind}"
					class:error={r.error}
					class:sel={lineSelected(r)}
					class:nix={r.nix}
					data-row={r.row}
					data-slot={r.slot}
					data-header={r.group}
					style:top="{topOf(r.row)}px"
				>
					{#if r.kind === 'header'}
						{@const g = groupsById.get(r.group ?? -1)}
						{#if g}
							<GroupHeader
								group={g}
								folded={client.folded.has(g.id)}
								failed={failedChain.has(g.id)}
								current={running && client.openGroups.includes(g.id)}
								{phase}
								{nowMs}
								line={r.line}
								onclick={() => toggle(g, false)}
								onselectline={(extend) => r.line !== null && onselectline(r.line, extend)}
								focused={focusGroupId === g.id}
							/>
						{/if}
					{:else}
						<span class="gutter num">
							{#if r.line !== null}
								<a
									href="#L{r.line}"
									tabindex="-1"
									onclick={(e) => {
										e.preventDefault();
										onselectline(r.line!, e.shiftKey);
									}}>{r.line}</a
								>
							{/if}
						</span>
						{#if r.kind === 'gap' && r.gap}
							<span class="text gap-text">
								{formatBytes(r.gap.bytes)} not shown (lines {formatExact(r.gap.from)} to {formatExact(
									r.gap.to
								)}) ·
								<button type="button" class="link" tabindex="-1" onclick={onsavewhole}
									>Save the whole log</button
								>
							</span>
						{:else if r.kind === 'more' && r.more}
							<span class="text">
								<button type="button" class="link" tabindex="-1" onclick={() => onmore(r.slot)}
									>Show {formatBytes(r.more.bytes)} more of this line</button
								>
							</span>
						{:else}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- links the build printed, to other sites -->
							<span class="text"
								>{#each r.segs ?? [] as s, i (i)}{#if s[3]}<a
											class={s[1]}
											style={s[2] || undefined}
											href={s[3]}
											target="_blank"
											rel="noopener noreferrer"
											tabindex="-1">{s[0]}</a
										>{:else if s[1].includes('hit')}<mark class={s[1]} style={s[2] || undefined}
											>{s[0]}</mark
										>{:else if s[1] || s[2]}<span class={s[1]} style={s[2] || undefined}
											>{s[0]}</span
										>{:else}{s[0]}{/if}{/each}</span
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
					{/if}
				</div>
			{/each}
		</div>
		{#if footer}
			<div class="footer">{@render footer()}</div>
		{/if}
	</div>
</div>

<style>
	.log-view {
		/* The line numbers' column, here and in GroupHeader. */
		--gutter-w: calc(var(--char-w) * 8 + 16px);
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		background: var(--log-bg);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		line-height: 1.5;
	}

	.probe {
		position: absolute;
		visibility: hidden;
		white-space: pre;
		pointer-events: none;
	}

	.scroller {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		contain: strict;
	}

	.spacer {
		position: relative;
		min-width: 100%;
	}

	.row {
		position: absolute;
		left: 0;
		right: 0;
		display: flex;
		min-height: var(--row-h);
		white-space: pre;
	}

	.nowrap .row {
		right: auto;
		min-width: 100%;
	}

	/* With wrapping off, only the log text scrolls sideways. A header stays beside its line
	   number, as wide as the view, so its duration and counts stay in sight. */
	.nowrap .row.header :global(.head) {
		position: sticky;
		left: var(--gutter-w);
		flex: none;
		width: calc(var(--view-w) - var(--gutter-w));
	}

	.gutter {
		position: sticky;
		left: 0;
		z-index: 1;
		flex: none;
		width: var(--gutter-w);
		padding-right: 8px;
		border-left: 3px solid transparent;
		background: var(--log-bg);
		color: var(--fg-muted);
		text-align: right;
		user-select: none;
	}

	.gutter a {
		color: inherit;
		text-decoration: none;
	}

	.gutter a:hover {
		color: var(--fg);
		text-decoration: underline;
	}

	/* Error and selected lines mark only the gutter. */
	.row.error .gutter {
		border-left-color: var(--danger);
	}

	.row.sel .gutter {
		border-left-color: var(--accent);
		color: var(--fg);
	}

	.text {
		flex: 1 1 auto;
		min-width: 0;
		padding-left: 8px;
		color: var(--fg);
	}

	.row.nix .text {
		color: var(--fg-muted);
	}

	.gap {
		background: var(--bg-panel);
		border-block: 1px solid var(--border-subtle);
	}

	.gap-text,
	.more .text {
		font-family: var(--font-sans);
		color: var(--fg-muted);
	}

	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.footer {
		position: sticky;
		left: 0;
		width: min(100%, var(--footer-w, 100%));
		padding: 12px 16px 24px calc(var(--gutter-w) + 11px);
		font-family: var(--font-sans);
	}

	/* As wide as the scroller without its scrollbar, whatever width the system's scrollbar has. */
	.sticky {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--view-w);
		z-index: 3;
		box-shadow: var(--shadow-sm);
	}

	.sticky .row {
		position: relative;
	}

	/* A hit forces the text to --fg, so a highlight never sits behind colored text. */
	.text :global(mark.hit) {
		background: var(--warn-soft);
		color: var(--fg);
	}

	.text :global(mark.cur) {
		outline: 2px solid var(--focus-ring);
		outline-offset: -1px;
	}

	.text :global(a[href]) {
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
