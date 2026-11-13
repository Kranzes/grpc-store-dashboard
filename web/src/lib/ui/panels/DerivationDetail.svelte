<script lang="ts">
	import { workerNodeId, type FarmStore } from '#lib/model/types.ts';
	import { clock } from '../clock.svelte.ts';
	import { Copier } from '../copy.svelte.ts';
	import {
		formatAgo,
		formatBytes,
		formatClock,
		formatCount,
		formatSpan,
		spokenAgo,
		spokenSpan
	} from '../format.ts';
	import Icon from '../Icon.svelte';
	import PhaseChip from '../PhaseChip.svelte';
	import Spoken from '../Spoken.svelte';
	import { Throttled } from '../throttle.svelte.ts';
	import { phaseSentence } from '../logs/LogEmpty.svelte';
	import LogsLink from '../logs/LogsLink.svelte';
	import { drvLogParams } from '../nav.ts';
	import { isTracked, noClientCaption, streamsCaption } from './requested.ts';
	import {
		STATUS_LABEL,
		STATUS_SENTENCE,
		anyReportsVersion,
		logCaption,
		statusTitle
	} from './status.ts';

	type Props = {
		store: FarmStore;
		drvPath: string;
		/** The line the derivation was picked from, so it opens after the recent ring lost it. */
		via?: string;
		/** Open another node's panel, such as the builder it runs on. */
		onopennode: (nodeId: string) => void;
	};
	let { store, drvPath, via, onopennode }: Props = $props();

	const q = new Throttled(
		() => store.frame,
		() => store.drv(drvPath, via)
	);
	// Keep the last known state when the scheduler forgets the derivation.
	let last = $state.raw(q.current);
	$effect(() => {
		if (q.current) last = q.current;
	});
	const d = $derived(q.current ?? last);
	const gone = $derived(!q.current && !!last);
	const tracked = $derived(!!d && !gone && isTracked(d.phase));
	const now = $derived(clock.now);

	const waited = $derived(
		d?.queuedMs == null ? null : (d.assignedMs ?? d.finishedMs ?? now) - d.queuedMs
	);
	const ran = $derived(d?.assignedMs == null ? null : (d.finishedMs ?? now) - d.assignedMs);
	// Next to the chip: "Assigned, 3m 20s elapsed", or "Built, took 3m 20s".
	const running = $derived(d?.phase === 'assigned' && ran !== null);
	const took = $derived(
		(d?.phase === 'built' || d?.phase === 'failed') && ran !== null && d.finishedMs !== null
	);
	const fetched = $derived(d?.fetchedBytes ?? 0);
	const failed = $derived(d?.phase === 'failed');
	// Exactly one of the log block and its caption shows for a failed build.
	const builderVersion = $derived(
		d?.workerAddr ? (store.workers.get(d.workerAddr)?.version ?? null) : null
	);
	const anyVersion = $derived(anyReportsVersion(store.workers));
	/** The Logs tab for this build, when it ran on a builder. */
	const logParams = $derived(d ? drvLogParams(d) : null);
	const noLog = $derived(d && failed ? logCaption(d, builderVersion, anyVersion) : null);

	const copier = new Copier<'path' | 'log'>();
</script>

{#if !d}
	<p class="p-caption">The scheduler no longer tracks this derivation.</p>
	<p class="path mono">{drvPath}</p>
{:else}
	<section class="p-section">
		<div class="phase">
			<PhaseChip phase={d.phase} />
			{#if running && ran !== null}
				<span class="num"
					><span class="visually-hidden">,</span>
					<Spoken text="{formatSpan(ran)} elapsed" words="{spokenSpan(ran)} elapsed" /></span
				>
			{:else if took && ran !== null}
				<span class="num"
					><span class="visually-hidden">,</span>
					<Spoken text="Took {formatSpan(ran)}" words="took {spokenSpan(ran)}" /></span
				>
			{/if}
			{#if gone}<span class="p-caption">No longer tracked by the scheduler.</span>{/if}
		</div>
		<div class="pathrow">
			<code class="path">{d.drvPath}</code>
			<button
				type="button"
				class="icon-btn"
				onclick={() => copier.copy('path', drvPath)}
				title="Copy the derivation path"
			>
				<Icon
					name={copier.what === 'path' ? 'check' : 'copy'}
					label={copier.what === 'path' ? 'Copied' : 'Copy path'}
				/>
			</button>
		</div>
		{#if failed}
			{#if d.status}
				<div class="p-callout danger failure" role="note">
					<Icon name="info" />
					<span>
						<strong>{statusTitle(d.status)}</strong>
						<span class="sentence">{STATUS_SENTENCE[d.status]}</span>
					</span>
				</div>
			{/if}
		{:else if d.reason}
			<div class="p-callout" role="note">
				<Icon name="info" />
				<span>{d.reason}</span>
			</div>
		{/if}
		{#if failed}
			{#if d.errorText !== null}
				{@const text = d.errorText}
				<div class="log-head">
					<h3 id="log-title">Last log lines</h3>
					<button
						type="button"
						class="icon-btn"
						onclick={() => copier.copy('log', text)}
						title="Copy the log lines"
					>
						<Icon
							name={copier.what === 'log' ? 'check' : 'copy'}
							label={copier.what === 'log' ? 'Copied' : 'Copy log lines'}
						/>
					</button>
				</div>
				<!-- The build printed this, so it shows as plain text, never markup. It is a tab
				     stop so the keyboard can scroll it. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<pre class="p-log" aria-labelledby="log-title" tabindex="0">{text}</pre>
				{#if logParams}
					<p class="p-links"><LogsLink label="Open the full log" params={logParams} /></p>
				{/if}
			{:else if noLog}
				<p class="p-caption">{noLog}</p>
			{/if}
		{/if}
		<dl class="p-rows">
			{#if d.status && (failed || d.phase === 'built')}
				<dt>Result</dt>
				<dd title={STATUS_SENTENCE[d.status]}>{STATUS_LABEL[d.status]}</dd>
			{/if}
			<dt>System</dt>
			<dd class="mono">{d.system || 'unknown'}</dd>
			{#if d.features.length}
				<dt>Needs</dt>
				<dd class="mono">{d.features.join(', ')}</dd>
			{/if}
			<dt>Builder</dt>
			<dd>
				{#if d.workerAddr}
					<button
						type="button"
						class="p-link mono"
						onclick={() => onopennode(workerNodeId(d.workerAddr!))}
					>
						{d.workerAddr}
					</button>
				{:else}
					<span class="muted">Not assigned</span>
				{/if}
			</dd>
			<dt>Cache</dt>
			<dd>{d.phase === 'cached' ? 'Hit' : d.cacheChecked ? 'Miss' : 'Not checked'}</dd>
			<dt title="Remaining critical path the clients reported. Higher goes first.">
				Priority hint
			</dt>
			<dd>
				{#if d.cpHintMs > 0}<Spoken
						text="{formatSpan(d.cpHintMs)} of critical path"
						words="{spokenSpan(d.cpHintMs)} of critical path"
					/>{:else}–{/if}
			</dd>
		</dl>
	</section>

	<section class="p-section">
		<h3>Build log</h3>
		{#if logParams}
			<p class="p-links">
				<LogsLink
					label={d.phase === 'assigned' ? 'Follow the log' : 'View log'}
					params={logParams}
				/>
			</p>
		{:else}
			<p class="p-caption">
				{phaseSentence(d.phase, d.status === 'dependency-failed') ??
					'Not assigned to a builder yet.'}
			</p>
		{/if}
	</section>

	<section class="p-section">
		<h3>Timings</h3>
		<dl class="p-rows">
			<dt>Queued</dt>
			<dd>{@render stamp(d.queuedMs)}</dd>
			<dt>Assigned</dt>
			<dd>{@render stamp(d.assignedMs)}</dd>
			<dt>Finished</dt>
			<dd>{@render stamp(d.finishedMs)}</dd>
			<dt>Waited</dt>
			<dd class="num">
				{@render span(waited, d.assignedMs === null && d.finishedMs === null)}
			</dd>
			<dt>Ran</dt>
			<dd class="num">{@render span(ran, d.finishedMs === null)}</dd>
		</dl>
		<p class="p-caption">
			"Ran" is the time from assignment to the result. It includes uploading and fetching inputs,
			since the scheduler does not see when the build itself starts.
		</p>
	</section>

	<section class="p-section">
		<h3>Requested by</h3>
		{#if d.identities.length === 0}
			<p class="p-caption">{noClientCaption(tracked)}</p>
		{:else}
			<ul class="p-chips">
				{#each d.identities as id (id)}<li>{id}</li>{/each}
			</ul>
			<p class="p-caption num">{streamsCaption(d.clientIds.length, tracked)}</p>
		{/if}
	</section>

	<section class="p-section">
		<h3>Inputs</h3>
		{#if d.phase === 'cached'}
			<p class="p-caption">
				All outputs were already in the cache, so nothing was built and the inputs are not known.
			</p>
		{:else}
			<p class="p-caption num">
				{formatCount(d.inputs)} input paths{#if fetched > 0}, ≈ {formatBytes(fetched)} via the cache{/if}.
			</p>
		{/if}
		{#if d.inputSources.length || d.inputsUnknown}
			<table class="p-table">
				<thead>
					<tr><th scope="col">Where from</th><th scope="col">Paths</th><th scope="col">Size</th></tr
					>
				</thead>
				<tbody>
					{#each d.inputSources as s (s.workerAddr)}
						<tr>
							<td class="wrap">
								{#if s.local}
									Local, built on this builder
								{:else}
									Likely via cache, built on <button
										type="button"
										class="p-link mono"
										onclick={() => onopennode(workerNodeId(s.workerAddr))}>{s.workerAddr}</button
									>
								{/if}
							</td>
							<td>{formatCount(s.paths)}</td>
							<td>{formatBytes(s.narBytes)}</td>
						</tr>
					{/each}
					{#if d.inputsUnknown > 0}
						<tr>
							<td class="wrap muted">Unknown: sources, client uploads or older cache content</td>
							<td>{formatCount(d.inputsUnknown)}</td>
							<td class="muted">–</td>
						</tr>
					{/if}
				</tbody>
			</table>
		{/if}
	</section>

	{#if d.outputs.length}
		<section class="p-section">
			<h3>Outputs <span class="muted num">{formatBytes(d.outputBytes)}</span></h3>
			<table class="p-table">
				<tbody>
					{#each d.outputs as o (o.path)}
						<tr>
							<td class="wrap mono">{o.path}</td>
							<td>{formatBytes(o.narSize)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
{/if}

{#snippet span(ms: number | null, open: boolean)}
	{#if ms === null}–{:else}<Spoken
			text={formatSpan(ms) + (open ? ' elapsed' : '')}
			words={spokenSpan(ms) + (open ? ' elapsed' : '')}
		/>{/if}
{/snippet}

{#snippet stamp(ms: number | null)}
	{#if ms === null}
		<span class="muted">–</span>
	{:else}
		<span class="num" title={new Date(ms).toLocaleString()}
			><Spoken text={formatAgo(ms, now)} words={spokenAgo(ms, now)} /></span
		>
		<span class="muted num">· {formatClock(ms)}</span>
	{/if}
{/snippet}

<style>
	.phase {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.pathrow {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.path {
		flex: 1;
		min-width: 0;
		padding: 8px 10px;
		border-radius: var(--radius);
		background: var(--bg-sunken);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
		user-select: all;
	}

	.icon-btn {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		flex: none;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg-node);
		color: var(--fg-muted);
	}

	.failure > span {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.failure strong {
		font-weight: 600;
	}

	.log-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	/* As .p-section > h3. */
	.log-head h3 {
		margin: 0;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		font-weight: 650;
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.p-log {
		max-height: calc(18 * 1.4em);
		margin: 0;
		padding: 8px 10px;
		overflow: auto;
		border-radius: var(--radius);
		background: var(--bg-sunken);
		color: var(--fg);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.4;
		/* Nix lays its message out by indentation, so keep each line whole and scroll sideways. */
		white-space: pre;
	}

	.icon-btn:hover {
		color: var(--fg);
		background: var(--bg-raised);
	}

	.muted {
		color: var(--fg-muted);
	}

	h3 .muted {
		margin-left: 4px;
		letter-spacing: 0;
		text-transform: none;
	}
</style>
