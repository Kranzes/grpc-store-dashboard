<script lang="ts">
	import { failPercent } from '../labels.ts';
	import { getFlowContext } from '../context.ts';
	import { farmFailShare, outlierShare } from '../outliers.ts';

	type Props = {
		/** The id of the card's own line: its assignments, or its group's requests. */
		line: string;
		/**
		 * Only the share, "62%", beside a state badge, so the two badges leave
		 * room for the address. The tooltip and the card's name still say "failed".
		 */
		short?: boolean;
	};
	let { line, short = false }: Props = $props();
	const ctx = getFlowContext();

	const farm = $derived(farmFailShare(ctx.store.totals));
	const share = $derived(outlierShare(ctx.store.edges.get(line), farm));
	const pct = $derived(failPercent(share));
</script>

<!--
	Only on a card whose line fails far more than the farm, by the rule in
	outliers.ts, so the badge points at the broken builder or client group.
	It is part of the card's button, so screen readers hear it with the
	card's name.
-->
{#if share !== null}
	<span
		class="badge fail num"
		title="{pct} of the builds that ended here failed, against {failPercent(farm) ??
			'0%'} for the farm, in the selected window"
	>
		{#if short}{pct} <span class="visually-hidden">failed</span>{:else}{pct} failed{/if}
	</span>
{/if}
