<script lang="ts">
	import type { NodeLine } from '#lib/flow/lines.ts';
	import { WORKER_LINGER_MS, type FarmStore } from '#lib/model/types.ts';
	import { lineId, type LineKind } from '#lib/flow/kinds.ts';
	import { drainCaption, drainState } from '../drain.ts';
	import { formatByteRate, formatBytes, formatCount, hostOf } from '../format.ts';
	import { Throttled } from '../throttle.svelte.ts';
	import WindowCaption from '../WindowCaption.svelte';
	import LogsLink from '../logs/LogsLink.svelte';
	import DerivationList from './DerivationList.svelte';
	import LineRows from './LineRows.svelte';
	import { anyReportsVersion, failureSummary } from './status.ts';

	type Props = {
		store: FarmStore;
		addr: string;
		/** The Lines rows: assignments, publishes and fetches. */
		rows: readonly NodeLine[];
		onselectderivation: (path: string, via?: string) => void;
		onopenlines: (flow: LineKind, edgeIds: readonly string[]) => void;
	};
	let { store, addr, rows, onselectderivation, onopenlines }: Props = $props();

	const LIMIT = 500;
	const LINGER_MIN = WORKER_LINGER_MS / 60_000;
	const w = $derived(store.workers.get(addr));
	const list = new Throttled(
		() => store.frame,
		() => store.drvsForWorker(addr, LIMIT)
	);
	const state = $derived(!w ? 'Gone' : !w.up ? 'Offline' : w.draining ? drainState(w) : 'Online');
	// An older scheduler sends no versions at all, so then the farm is what is older.
	const anyVersion = $derived(anyReportsVersion(store.workers));
	const fill = $derived(w && w.maxJobs > 0 ? Math.min(1, w.running / w.maxJobs) : 0);
	// Over the builder's recent results, which the list ends with.
	const failures = $derived(failureSummary(list.current));
	const subs = new Throttled(
		() => store.frame,
		() => store.substitutersOf(addr)
	);
</script>

{#if !w}
	<p class="p-caption">
		This builder is no longer shown here. Builders leave {LINGER_MIN}m after they disconnect, or
		when another scheduler takes over.
	</p>
{:else}
	<section class="p-section">
		<dl class="p-facts">
			<!-- Two columns for the longer values: why it drains, and free disk of total. -->
			<div class:wide={w.up && w.draining}>
				<dt>State</dt>
				<dd class="small">{state}</dd>
			</div>
			<div>
				<dt title="Assigned to a builder. Includes uploading and fetching inputs.">
					Assigned slots
				</dt>
				<dd>{w.running}<span class="p-of">/{w.maxJobs}</span></dd>
				<!-- Under the value it shows. -->
				<dd
					class="p-meter"
					aria-hidden="true"
					style:--fill={w.draining ? 'var(--state-unplaceable)' : undefined}
				>
					<span style:transform="scaleX({fill})"></span>
				</dd>
			</div>
			<div>
				<dt title="Queued derivations whose system and features this builder offers">Can take</dt>
				<dd>{formatCount(w.queuedCanTake)}</dd>
			</div>
			{#if w.diskFree !== null}
				<div class:wide={w.diskTotal !== null}>
					<dt title="Free space of the file system that holds the builder's store">Free disk</dt>
					<dd class="small num">
						{formatBytes(w.diskFree)}{#if w.diskTotal !== null}<span class="p-of"
								>{` of ${formatBytes(w.diskTotal)}`}</span
							>{/if}
					</dd>
				</div>
			{/if}
			{#if w.minFree > 0}
				<div>
					<dt title="Its --min-free: below this much free disk it takes no new work">
						Drains below
					</dt>
					<dd class="small num">{formatBytes(w.minFree)}</dd>
				</div>
			{/if}
			{#if w.version}
				<div>
					<dt title="Its nix-grpc-store version">Version</dt>
					<dd class="small mono" title={w.version}>{w.version}</dd>
				</div>
			{/if}
		</dl>
		<!-- Builders count their builds over one minute, whatever the header's window. -->
		<div class="p-when-group">
			<WindowCaption minutes={1} since={null} />
			<dl class="p-facts">
				<div>
					<dt>Built</dt>
					<dd>{formatCount(w.builtPerMin)}</dd>
				</div>
				<div>
					<dt>Failed</dt>
					<dd class:p-bad={w.failedPerMin > 0}>{formatCount(w.failedPerMin)}</dd>
				</div>
			</dl>
		</div>
		{#if failures}
			<p class="p-caption">Recent failures: {failures}</p>
		{/if}
		{#if !w.up}
			<p class="p-caption">Disconnected. Stays {LINGER_MIN}m in case it returns.</p>
		{:else if w.draining}
			<p class="p-caption">{drainCaption(w)}</p>
		{/if}
		{#if !w.version}
			<p class="p-caption">
				{anyVersion
					? 'This builder is older than the scheduler and does not report drain reasons, free disk, substituters or why builds fail.'
					: 'This farm does not report drain reasons, free disk, substituters or why builds fail.'}
			</p>
		{/if}
	</section>

	<section class="p-section">
		<h3>Systems</h3>
		<ul class="p-chips" aria-label="Systems, native first">
			{#each w.systems as s, i (i)}<li class:native={i === 0}>{s}</li>{/each}
		</ul>
		{#if w.features.length}
			<h3>Features</h3>
			<ul class="p-chips">
				{#each w.features as f, i (i)}<li>{f}</li>{/each}
			</ul>
		{/if}
		<!-- A farm where no builder reports says so once, in the caption above. -->
		{#if anyVersion}
			<h3>Substituters</h3>
			{#if !w.version}
				<p class="p-caption">This builder does not report its substituters.</p>
			{:else if subs.current.length === 0}
				<p class="p-caption">No substituters configured.</p>
			{:else}
				<ul class="p-chips" aria-label="Substituters in the builder's order">
					{#each subs.current as s (s.url)}
						<li class:idle={s.narBytesPerSec === 0} title={s.url}>
							{hostOf(s.url)} <span class="num">{formatByteRate(s.narBytesPerSec)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<LineRows {store} {rows} {onopenlines} />
{/if}

<section class="p-section grow">
	<h3>Assigned, then recent results</h3>
	<p class="p-links">
		<LogsLink label="Logs on this builder" params={{ builder: addr }} />
		<LogsLink label="Recent failures" params={{ builder: addr, status: ['failed'] }} />
	</p>
	<DerivationList
		items={list.current}
		limit={LIMIT}
		label="Derivations on this builder"
		context="builder"
		empty="Nothing assigned or finished recently."
		onselect={(path) => onselectderivation(path, lineId('assign', addr))}
	/>
</section>

<style>
	.wide {
		grid-column: span 2;
	}

	/* An idle substituter's chip keeps its text AA and loses only its fill. */
	.idle {
		background: transparent;
		color: var(--fg-muted);
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}
</style>
