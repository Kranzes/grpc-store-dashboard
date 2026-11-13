<script lang="ts" generics="V extends string | number">
	import type { Snippet } from 'svelte';
	import { rovingIndex } from './keys.ts';

	// A radio group drawn as joined buttons. Arrow keys move the choice.
	/** `label` is the accessible name; `text` or `content` is what shows, when shorter. */
	type Option = { value: V; label: string; text?: string; content?: Snippet };
	type Props = {
		label: string;
		options: readonly Option[];
		value: V;
		onchange: (value: V) => void;
	};
	let { label, options, value, onchange }: Props = $props();

	let buttons: HTMLButtonElement[] = $state([]);

	function onkeydown(e: KeyboardEvent, i: number) {
		const next = rovingIndex(e.key, i, options.length);
		if (next < 0) return;
		e.preventDefault();
		onchange(options[next].value);
		buttons[next]?.focus();
	}
</script>

<div class="seg" role="radiogroup" aria-label={label}>
	{#each options as opt, i (opt.value)}
		<button
			bind:this={buttons[i]}
			type="button"
			role="radio"
			aria-checked={opt.value === value}
			aria-label={opt.content || opt.text ? opt.label : undefined}
			title={opt.content ? opt.label : undefined}
			tabindex={opt.value === value ? 0 : -1}
			onclick={() => onchange(opt.value)}
			onkeydown={(e) => onkeydown(e, i)}
		>
			{#if opt.content}{@render opt.content()}{:else}{opt.text ?? opt.label}{/if}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		align-items: stretch;
		padding: 2px;
		gap: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius);
		background: var(--bg-panel);
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		height: 24px;
		padding: 0 7px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--fg-muted);
		font-size: var(--text-2xs);
		font-weight: 550;
		font-variant-numeric: tabular-nums;
		transition:
			background var(--dur-fast),
			color var(--dur-fast);
	}

	button:hover {
		color: var(--fg);
	}

	button[aria-checked='true'] {
		background: var(--bg-node);
		box-shadow: var(--shadow-sm);
		color: var(--fg);
	}

	button:focus-visible {
		outline-offset: 0;
	}
</style>
