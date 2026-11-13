<script lang="ts">
	import { goto } from '$app/navigation';
	import { basePath } from '#lib/farm/farm.ts';
	import type { DrvView } from '#lib/model/types.ts';
	import Icon from '../Icon.svelte';
	import { drvLogParams, hereUrl, logsHref } from '../nav.ts';
	import { clock } from '../clock.svelte.ts';
	import {
		formatAgo,
		formatBytes,
		formatCount,
		formatShort,
		spokenAgo,
		spokenShort
	} from '../format.ts';
	import { Hold } from '../hold.svelte.ts';
	import PhaseChip from '../PhaseChip.svelte';
	import Spoken from '../Spoken.svelte';
	import VirtualList from '../VirtualList.svelte';
	import type { Said } from '../logs/words.ts';
	import { STATUS_LABEL } from './status.ts';

	type Props = {
		items: readonly DrvView[];
		label: string;
		/**
		 * Which detail to show under the name. `line`: system, builder and
		 * clients, for the latest rows of a line.
		 */
		context: 'builder' | 'queue' | 'cache' | 'clients' | 'line';
		/** Text before the detail, such as "Published 12 MiB". null for none. */
		note?: (d: DrvView) => string | null;
		/** The query's limit; reaching it means the list was cut off. */
		limit: number;
		/** Known total, to say how much was cut off. */
		total?: number;
		empty: string;
		onselect: (drvPath: string) => void;
	};
	let { items, label, context, note, limit, total, empty, onselect }: Props = $props();

	const hold = new Hold(() => items);
	const shown = $derived(hold.current);
	const held = $derived(hold.held);

	/** "3m elapsed" for a derivation in progress, else when it last changed: "3m ago". */
	function when(d: DrvView, now: number): Said | null {
		if (d.phase === 'assigned' && d.assignedMs !== null) {
			const ran = Math.max(0, now - d.assignedMs);
			return { text: `${formatShort(ran)} elapsed`, words: `${spokenShort(ran)} elapsed` };
		}
		const t = d.finishedMs ?? d.assignedMs ?? d.queuedMs;
		return t === null ? null : { text: formatAgo(t, now), words: spokenAgo(t, now) };
	}

	/** The build's log in the Logs tab, for a derivation that ran on a builder. */
	function logOf(d: DrvView): string | null {
		const p = drvLogParams(d);
		return p && logsHref(basePath(), hereUrl(), p);
	}

	function detail(d: DrvView): string {
		const parts = [d.system || 'unknown system'];
		if (context === 'cache') {
			// A cached row's chip already says so.
			if (d.phase === 'built') parts.unshift(`Published ${formatBytes(d.outputBytes)}`);
			else if (d.fetchedBytes > 0) parts.unshift(`Fetching ≈ ${formatBytes(d.fetchedBytes)}`);
		} else if (context !== 'builder' && d.workerAddr) {
			parts.push(d.workerAddr);
		}
		if (context === 'queue' && d.reason) parts.push(d.reason);
		if (context !== 'clients' && d.identities.length > 0) {
			parts.push(d.identities.length === 1 ? d.identities[0] : `${d.identities.length} identities`);
		}
		const n = note?.(d);
		if (n) parts.unshift(n);
		// Why a build failed comes first, in every list.
		if (d.phase === 'failed' && d.status) parts.unshift(STATUS_LABEL[d.status]);
		return parts.join(' · ');
	}
</script>

<div class="p-list" role="group" {...hold.handlers}>
	{#if shown.length >= limit || held}
		<p class="p-list-cap num">
			<span>
				{#if shown.length >= limit}
					Showing {formatCount(shown.length)}{#if total !== undefined && total > shown.length}
						of {formatCount(total)}{/if}
				{/if}
			</span>
			{#if held}<span class="p-list-paused">Held</span>{/if}
		</p>
	{/if}
	{#if shown.length === 0}
		<p class="p-list-empty">{empty}</p>
	{:else}
		<VirtualList items={shown} key={(d) => d.drvPath} {label}>
			{#snippet row(d, tabindex)}
				{@const t = when(d, clock.now)}
				{@const log = logOf(d)}
				<button
					type="button"
					class="p-row item"
					{tabindex}
					onclick={() => onselect(d.drvPath)}
					aria-keyshortcuts={log ? 'L' : undefined}
					onkeydown={(e) => {
						if (log && (e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
							e.preventDefault();
							// eslint-disable-next-line svelte/no-navigation-without-resolve -- built from basePath()
							void goto(log);
						}
					}}
				>
					<span class="line1">
						<PhaseChip phase={d.phase} compact />
						<span class="name" title={d.drvPath}>{d.name}</span>
						<span class="ago num"
							>{#if t}<Spoken {...t} />{/if}</span
						>
					</span>
					<span class="line2">{detail(d)}</span>
				</button>
				{#if log}
					<!-- One tab stop per row. The log link is for the pointer, and L for the keyboard. -->
					<!-- eslint-disable svelte/no-navigation-without-resolve -- built from basePath() -->
					<a
						class="log-link"
						href={log}
						tabindex="-1"
						title="Build log (L)"
						aria-label="Build log of {d.name}"><Icon name="log" size={14} /></a
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}
			{/snippet}
		</VirtualList>
	{/if}
</div>

<style>
	.log-link {
		position: absolute;
		top: 50%;
		right: 8px;
		display: none;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		transform: translateY(-50%);
		border-radius: var(--radius-sm);
		background: var(--bg);
		color: var(--fg-muted);
	}

	.log-link:hover {
		color: var(--accent-strong);
	}

	/* Shows on hover and while the row has focus. */
	:global(.vrow:hover) .log-link,
	:global(.vrow:focus-within) .log-link {
		display: inline-flex;
	}

	.item {
		flex-direction: column;
		justify-content: center;
		gap: 2px;
	}

	.line1 {
		display: grid;
		grid-template-columns: 96px 1fr auto;
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
		padding-left: 104px;
		overflow: hidden;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
