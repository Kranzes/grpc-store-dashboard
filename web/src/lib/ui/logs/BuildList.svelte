<script module lang="ts">
	import type { BuildStateFilter, LogsSort } from '../nav.ts';

	export type Filters = {
		q: string;
		states: readonly BuildStateFilter[];
		system: string | null;
		builder: string | null;
		pool: string | null;
		client: string | null;
		since: number | null;
		sort: LogsSort;
	};
</script>

<script lang="ts">
	import { assignedText, durationMs } from '#lib/model/builds.ts';
	import { OTHER_CLIENTS, type BuildRow, type BuildsView } from '#lib/model/types.ts';
	import { clock } from '../clock.svelte.ts';
	import { formatClockMinutes, formatExact, windowShort } from '../format.ts';
	import { Hold } from '../hold.svelte.ts';
	import Icon from '../Icon.svelte';
	import { SINCE_MINUTES } from '../nav.ts';
	import PhaseChip from '../PhaseChip.svelte';
	import { STATUS_LABEL } from '../panels/status.ts';
	import VirtualList from '../VirtualList.svelte';
	import { keyOf, listItems, type Item } from './items.ts';
	import { short } from './words.ts';

	// The build list: a search box, state chips with counts, menus and sort,
	// then one row per build, each a link to its log. Arrow keys move focus
	// only; Enter or a click opens the log.
	type Props = {
		view: BuildsView;
		filters: Filters;
		onfilters: (f: Filters) => void;
		/** The open build's key, drvPath#assignId. */
		selected: string | null;
		/** The selected build's row, kept in the list when it leaves the filter. */
		selectedRow: BuildRow | null;
		href: (row: BuildRow) => string;
		onnearend: () => void;
		/** Client group identities shown on the map, for "Other clients". */
		groups: readonly string[];
		collapsed: boolean;
		oncollapse: () => void;
		/** The operator's search across build logs, for a search that finds no build. */
		logSearchUrl?: string;
	};
	let {
		view,
		filters,
		onfilters,
		selected,
		selectedRow,
		href,
		onnearend,
		groups,
		collapsed,
		oncollapse,
		logSearchUrl
	}: Props = $props();

	// The order holds still while the pointer or focus is in the list; each
	// row still shows its latest state, duration and phase. A new search,
	// filter or sort shows at once and then holds still.
	const hold = new Hold(
		() => view.rows.map(keyOf),
		() => JSON.stringify(filters)
	);
	const items = $derived(listItems(view.rows, hold.current, filters.sort, selected, selectedRow));

	let newAbove = $state(0);
	let scrollTop = $state(0);
	let list: VirtualList<Item> | undefined = $state();
	let search: HTMLInputElement | undefined = $state();

	export function focusSearch() {
		search?.focus();
		search?.select();
	}

	export function focusSelected() {
		const i = items.findIndex((it) => it.key === selected);
		void list?.focusAt(Math.max(0, i));
	}

	const set = (patch: Partial<Filters>) => onfilters({ ...filters, ...patch });
	const toggleState = (s: BuildStateFilter) =>
		set({
			states: filters.states.includes(s)
				? filters.states.filter((x) => x !== s)
				: [...filters.states, s]
		});

	// Failed, Assigned and Built carry the rows' state dot, so the chips are
	// also the rows' key. Other gathers cancelled and dropped builds and has none.
	const CHIPS: { s: BuildStateFilter; label: string; dot: boolean }[] = [
		{ s: 'failed', label: 'Failed', dot: true },
		{ s: 'assigned', label: 'Assigned', dot: true },
		{ s: 'built', label: 'Built', dot: true },
		{ s: 'other', label: 'Other', dot: false }
	];

	const pools = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not state: read and replaced whole
		const m = new Map<string, string[]>();
		for (const b of view.facets.builders) {
			const p = b.pool ?? 'Gone';
			let a = m.get(p);
			if (!a) m.set(p, (a = []));
			a.push(b.addr);
		}
		return [...m];
	});

	/** Line 1's time: how long it took, or "6m elapsed". */
	function time(r: BuildRow, now: number) {
		const d = durationMs(r, now);
		if (d === null) return null;
		const s = short(d);
		return r.state === 'assigned' ? { text: `${s.text} elapsed`, words: `${s.words} elapsed` } : s;
	}

	function line2(r: BuildRow): string {
		if (r.state === 'failed') {
			const label = r.status ? STATUS_LABEL[r.status] : 'Failed';
			return r.errorLine ? `${label} · ${r.errorLine}` : label;
		}
		if (r.state === 'assigned') return `${assignedText(r)} · ${r.worker}`;
		const parts = [r.system, r.worker];
		if (r.requestedBy.length) parts.push(r.requestedBy[0]);
		return parts.filter(Boolean).join(' · ');
	}

	function spoken(r: BuildRow, now: number): string {
		const t = time(r, now);
		const parts = [r.name, r.state];
		if (t) parts.push(t.words);
		if (r.state === 'assigned') parts.push(`${assignedText(r)} on ${r.worker}`);
		else parts.push(line2(r));
		return parts.join(', ');
	}

	const foot = $derived.by(() => {
		const c = view.coverage;
		if (c.restartMs !== null && c.source === 'page')
			return `A new scheduler took over at ${formatClockMinutes(c.restartMs)} and keeps builds from then on.`;
		if (c.full) return 'This page keeps the newest 10,000 builds.';
		if (c.complete && c.source === 'scheduler')
			return 'The scheduler keeps the last 10,000 builds and 2,000 failures.';
		if (c.sinceMs === null) return null;
		return c.source === 'scheduler'
			? `Builds since ${formatClockMinutes(c.sinceMs)}, kept by the scheduler`
			: `Builds since ${formatClockMinutes(c.sinceMs)}, when this page connected`;
	});
</script>

<div class="build-list" class:collapsed>
	<div class="bar">
		<button
			type="button"
			class="icon-btn"
			onclick={oncollapse}
			aria-expanded={!collapsed}
			title={collapsed ? 'Show the build list ([)' : 'Hide the build list ([)'}
		>
			<Icon name="sidebar" label={collapsed ? 'Show the build list' : 'Hide the build list'} />
		</button>
		{#if !collapsed}
			<span class="search">
				<Icon name="search" />
				<input
					type="search"
					placeholder="Search builds by name or hash"
					aria-label="Search builds by name or hash"
					aria-keyshortcuts="/"
					value={filters.q}
					bind:this={search}
					oninput={(e) => set({ q: (e.currentTarget as HTMLInputElement).value })}
				/>
			</span>
		{/if}
	</div>
	{#if !collapsed}
		<div class="chips" role="group" aria-label="Build states">
			{#each CHIPS as c (c.s)}
				<button
					type="button"
					class="chip {c.s}"
					aria-pressed={filters.states.includes(c.s)}
					onclick={() => toggleState(c.s)}
				>
					{#if c.dot}<span class="dot" aria-hidden="true"></span>{/if}{c.label}
					<span class="num">{formatExact(view.counts[c.s])}</span>
				</button>
			{/each}
		</div>
		<div class="menus">
			<select
				aria-label="System"
				value={filters.system ?? ''}
				onchange={(e) => set({ system: (e.currentTarget as HTMLSelectElement).value || null })}
			>
				<option value="">Any system</option>
				{#each view.facets.systems as s (s)}<option value={s}>{s}</option>{/each}
			</select>
			<select
				aria-label="Builder"
				value={filters.builder ?? (filters.pool ? `pool:${filters.pool}` : '')}
				onchange={(e) => {
					const v = (e.currentTarget as HTMLSelectElement).value;
					set(
						v.startsWith('pool:')
							? { pool: v.slice(5), builder: null }
							: { builder: v || null, pool: null }
					);
				}}
			>
				<option value="">Any builder</option>
				{#each pools as [pool, addrs] (pool)}
					<optgroup label={pool}>
						{#if pool !== 'Gone'}<option value="pool:{pool}">The {pool} pool</option>{/if}
						{#each addrs as a (a)}<option value={a}>{a}</option>{/each}
					</optgroup>
				{/each}
			</select>
			<select
				aria-label="Requested by"
				value={filters.client ?? ''}
				onchange={(e) => set({ client: (e.currentTarget as HTMLSelectElement).value || null })}
			>
				<option value="">Anyone</option>
				{#each view.facets.clients as c (c)}<option value={c}>{c}</option>{/each}
				{#if groups.length}<option value={OTHER_CLIENTS}>Other clients</option>{/if}
			</select>
			<select
				aria-label="Finished within"
				value={filters.since === null ? '' : String(filters.since)}
				onchange={(e) => {
					const v = (e.currentTarget as HTMLSelectElement).value;
					set({ since: v ? Number(v) : null });
				}}
			>
				<option value="">All kept</option>
				{#each SINCE_MINUTES as m (m)}<option value={String(m)}>Last {windowShort(m)}</option
					>{/each}
			</select>
			<select
				aria-label="Sort"
				value={filters.sort}
				onchange={(e) => set({ sort: (e.currentTarget as HTMLSelectElement).value as LogsSort })}
			>
				<option value="failures">Failures first</option>
				<option value="newest">Newest</option>
				<option value="longest">Longest</option>
			</select>
		</div>
		<div class="rows" {...hold.handlers}>
			{#if newAbove > 0 && scrollTop > 0}
				<button
					type="button"
					class="new"
					onclick={() => {
						newAbove = 0;
						void list?.focusAt(0);
					}}>{formatExact(newAbove)} new ↑</button
				>
			{/if}
			{#if items.length === 0}
				<p class="empty">
					{view.coverage.loading ? 'Loading builds' : 'No builds match.'}
				</p>
				{#if !view.coverage.loading && filters.q.trim() && logSearchUrl}
					<p class="empty more">
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the operator's own site -->
						<a href={logSearchUrl} target="_blank" rel="noopener noreferrer"
							>Search every build log</a
						>
					</p>
				{/if}
			{:else}
				<VirtualList
					bind:this={list}
					{items}
					key={(it) => it.key}
					label="Builds"
					rowHeight={52}
					bind:scrollTop
					skip={(i) => items[i]?.kind === 'head'}
					onabove={(n) => (newAbove += n)}
					onnearend={(n) => {
						if (n < 20) onnearend();
						if (scrollTop === 0) newAbove = 0;
					}}
				>
					{#snippet row(it, tabindex)}
						{#if it.kind === 'head'}
							<div class="head-row" aria-hidden="true">{it.label}</div>
						{:else}
							{@const r = it.row}
							{@const t = time(r, clock.now)}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- built from basePath() -->
							<a
								href={href(r)}
								class="p-row item"
								class:selected={it.key === selected}
								aria-current={it.key === selected ? 'page' : undefined}
								aria-label={spoken(r, clock.now)}
								data-sveltekit-reset={false}
								{tabindex}
							>
								<span class="line1">
									<PhaseChip phase={r.state} compact />
									<span class="name" title={r.drvPath}>{r.name}</span>
									<span class="ago num">{t?.text ?? ''}</span>
								</span>
								<span class="line2">{line2(r)}</span>
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
					{/snippet}
				</VirtualList>
			{/if}
		</div>
		{#if foot}<p class="foot">{foot}</p>{/if}
	{/if}
</div>

<style>
	.build-list {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		border-right: 1px solid var(--border-subtle);
		background: var(--bg-panel);
	}

	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
	}

	.collapsed .bar {
		padding: var(--space-2) 6px;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--fg-muted);
	}

	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--fg);
	}

	.search {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 6px;
		height: 30px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--fg-muted);
	}

	.search:focus-within {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.search input {
		flex: 1 1 auto;
		min-width: 0;
		border: 0;
		outline: 0;
		background: none;
		color: var(--fg);
		font: inherit;
		font-size: var(--text-xs);
	}

	.chips,
	.menus {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 0 var(--space-3) var(--space-2);
	}

	/* Only the rows shrink; the bars and menus keep their height, however they wrap. */
	.build-list > :not(.rows) {
		flex: none;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 24px;
		padding: 0 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-full);
		background: var(--bg);
		color: var(--fg);
		font-size: var(--text-2xs);
		font-weight: 550;
	}

	.chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.chip .num {
		color: var(--fg-muted);
	}

	/* The rows' dot, as PhaseChip draws it. */
	.chip .dot {
		width: 7px;
		height: 7px;
		flex: none;
		border-radius: 50%;
		background: var(--c);
	}

	.chip.failed {
		--c: var(--state-failed);
	}

	.chip.assigned {
		--c: var(--state-assigned);
	}

	.chip.built {
		--c: var(--state-built);
	}

	select {
		height: 26px;
		max-width: 100%;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--fg);
		font-size: var(--text-2xs);
	}

	.rows {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid var(--border-subtle);
	}

	.rows :global(.vlist) {
		flex: 1 1 auto;
	}

	.head-row {
		display: flex;
		align-items: flex-end;
		height: 100%;
		padding: 0 12px 6px;
		color: var(--fg-muted);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	/* A p-row link: two lines stacked. */
	.item {
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		color: var(--fg);
		text-decoration: none;
	}

	.item.selected {
		background: var(--accent-soft);
	}

	.line1 {
		display: grid;
		grid-template-columns: 76px 1fr auto;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: var(--text-xs);
	}

	.name {
		min-width: 0;
		overflow: hidden;
		font-weight: 550;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.ago {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		white-space: nowrap;
	}

	.line2 {
		min-width: 0;
		padding-left: 84px;
		overflow: hidden;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.new {
		position: absolute;
		top: 8px;
		left: 50%;
		z-index: 2;
		transform: translateX(-50%);
		padding: 3px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-full);
		background: var(--bg);
		box-shadow: var(--shadow-sm);
		color: var(--fg);
		font-size: var(--text-2xs);
	}

	.empty {
		padding: 24px 12px;
		color: var(--fg-muted);
		font-size: var(--text-xs);
		text-align: center;
	}

	.empty.more {
		padding-top: 0;
	}

	.foot {
		margin: 0;
		padding: 6px 12px;
		border-top: 1px solid var(--border-subtle);
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}
</style>
