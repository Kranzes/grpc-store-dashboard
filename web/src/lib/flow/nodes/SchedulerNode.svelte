<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import { formatCount, formatPerMinute } from '#lib/ui/format.ts';
	import Icon from '#lib/ui/Icon.svelte';
	import { getFlowContext, nodeButton } from '../context.ts';
	import { QUEUE_TRACK, featureText, needText, queueCard, stuckTitle } from '../queue.ts';
	import { queueTrend } from '../trend.ts';
	import type { FlowNode } from '../types.ts';

	let { id }: NodeProps<FlowNode> = $props();
	const ctx = getFlowContext();

	const s = $derived(ctx.store.scheduler);
	const version = $derived(ctx.store.meta?.version ?? '');
	const used = $derived(s.slots > 0 ? Math.min(1, (s.slots - s.free) / s.slots) : 0);
	// Rows with unplaceable work fold into one row first, so the largest queues keep the rest.
	// Keyed on the rows alone, since they change with Stats, about once a second, not with every publish.
	const systems = $derived(s.systems);
	const card = $derived(queueCard(systems));
	const trend = $derived(queueTrend(s.queuedPerMin, s.queued));
	// Per-system rows come with Stats, about a second after the snapshot.
	const pending = $derived(s.queued + s.assigned > 0);
</script>

<Handle type="target" position={Position.Left} id="in" class="farm-handle" />
<Handle type="source" position={Position.Right} id="out" class="farm-handle" />
<Handle type="source" position={Position.Top} id="top" class="farm-handle" />
<button type="button" class="farm-node hub scheduler" {...nodeButton(ctx, id)}>
	<span class="row">
		<span class="title">Scheduler</span>
		<span class="spacer"></span>
		{#if version}<span class="badge mono">{version}</span>{/if}
	</span>

	<span class="stats">
		<span class="stat">
			<span class="label">Queued</span>
			<span class="value num">{formatCount(s.queued)}</span>
			<!-- Always there, so the card keeps its rows while a trend comes and goes. -->
			<span class="trend num" title="Change of the queue over the last minute">
				{#if trend}<span aria-hidden="true">{trend.text}</span><span class="visually-hidden"
						>{trend.spoken}</span
					>{/if}
			</span>
		</span>
		<span class="stat">
			<span class="label" title="Assigned to a builder. Includes uploading and fetching inputs."
				>Assigned</span
			>
			<span class="value num">{formatCount(s.assigned)}</span>
		</span>
		<span class="stat">
			<span class="label" title="No connected builder offers the system and features they need"
				>Unplaceable</span
			>
			<span class="value num" class:warn={s.unplaceable > 0}>{formatCount(s.unplaceable)}</span>
		</span>
	</span>

	<span class="slots">
		<span class="row line">
			<span class="label">Slots</span>
			<span class="spacer"></span>
			<span class="num">
				<strong>{formatCount(s.slots - s.free)}</strong>/{formatCount(s.slots)} used
			</span>
		</span>
		<span class="meter" aria-hidden="true"><span style:transform="scaleX({used})"></span></span>
	</span>

	<span class="row line facts">
		<span class="num"><strong>{s.workersUp}</strong> builders</span>
		<span class="num"><strong>{formatCount(s.clients)}</strong> streams</span>
		<span class="num"><strong>{formatPerMinute(s.assignedPerSec * 60)}</strong> assigned/min</span>
	</span>

	<span class="queues" style:--track="{QUEUE_TRACK}px">
		<span class="kicker">Queue by system</span>
		{#if card.stuck}
			{@const st = card.stuck}
			{@const one = st.rows.length === 1 ? st.rows[0] : null}
			<span class="qrow warn" title={stuckTitle(st.rows)}>
				<span class="fold">
					<Icon name="alert" size={12} />
					<span class="sys">
						Unplaceable
						<span class="feat">
							<span aria-hidden="true">·</span>
							{#if one}
								<span class="mono">{one.system}</span>{one.features
									? ` ${featureText(one.features)}`
									: ''}
							{:else if st.systems.length === 1}
								<span class="mono">{st.systems[0]}</span>
							{:else}
								{st.systems.length} systems
							{/if}
						</span>
					</span>
				</span>
				<span class="num qn">{formatCount(st.unplaceable)}</span>
			</span>
		{/if}
		{#each card.bars as { row: r, fill } (`${r.system}|${r.features}`)}
			<span class="qrow">
				<span class="sys" title={needText(r)}>
					<span class="mono">{r.system}</span>{#if r.features}<span class="feat"
							>{` ${featureText(r.features)}`}</span
						>{/if}
				</span>
				<span class="qbar" aria-hidden="true">
					<span style:transform="scaleX({fill})"></span>
				</span>
				<span class="num qn">{formatCount(r.queued)}</span>
			</span>
		{:else}
			{#if !card.stuck}
				<span class="none">{pending ? 'Counting per system…' : 'Nothing queued'}</span>
			{/if}
		{/each}
		{#if card.more > 0}
			<span class="more">+{card.more} more</span>
		{/if}
	</span>
</button>

<style>
	.scheduler {
		gap: 10px;
	}

	.title {
		font-size: var(--text-md);
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.warn {
		color: var(--warn-fg);
	}

	.trend {
		height: 12px;
		color: var(--fg-muted);
		font-size: 10px;
		line-height: 12px;
		white-space: nowrap;
	}

	.slots {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.line {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}

	.label {
		font-weight: 500;
	}

	.facts {
		justify-content: space-between;
	}

	strong {
		color: var(--fg);
		font-weight: 600;
	}

	.queues {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding-top: 8px;
		border-top: 1px solid var(--border-subtle);
	}

	.qrow {
		display: grid;
		grid-template-columns: minmax(0, 1fr) var(--track) 44px;
		align-items: center;
		gap: 8px;
		font-size: var(--text-2xs);
	}

	.sys {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.feat {
		color: var(--fg-muted);
	}

	.qbar {
		position: relative;
		height: 4px;
		border-radius: 2px;
		background: var(--bg-raised);
		opacity: var(--chrome, 1);
		overflow: hidden;
	}

	.qbar > span {
		position: absolute;
		inset: 0;
		transform-origin: left center;
		background: var(--state-queued);
		transition: transform var(--dur-slow) var(--ease-out);
	}

	:global(.farm-map.moving) .qbar > span {
		transition: none;
	}

	.fold {
		display: flex;
		grid-column: 1 / 3;
		align-items: center;
		gap: 4px;
		min-width: 0;
		font-weight: 500;
	}

	.fold .sys {
		min-width: 0;
	}

	.fold .feat {
		font-weight: 400;
	}

	.qn {
		text-align: right;
	}

	.none,
	.more {
		color: var(--fg-muted);
		font-size: var(--text-2xs);
	}
</style>
