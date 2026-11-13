<script lang="ts">
	import type { ConnectionStatus, FarmMeta } from '#lib/model/types.ts';
	import { retrySeconds } from './clock.svelte.ts';
	import Icon, { type IconName } from './Icon.svelte';
	import { getShell } from './shell.ts';

	// What sits on top of the map while the stream is not live:
	// a centered card when there is nothing to show, a banner when the
	// picture is stale.
	type Props = { status: ConnectionStatus; meta: FarmMeta | null };
	let { status, meta }: Props = $props();

	// The rest comes from the shell, which this always renders inside.
	const shell = getShell();
	const farmName = $derived(shell.farmName);
	/** The farm that serves this page. null in the demo. */
	const farm = $derived(shell.farm);
	/** The auth proxy's sign-out link. Proxy farms that name one only. */
	const signOutUrl = $derived(shell.farm?.auth === 'proxy' ? shell.farm.signOutUrl : undefined);
	const onreload = () => shell.onreload();
	const onreconnect = () => shell.onreconnect();
	const ondemo = () => shell.ondemo();
	/** Skip the wait before the next attempt. Live sessions only. */
	const onretry = $derived(shell.session.retryNow && (() => shell.session.retryNow?.()));

	const seconds = $derived(retrySeconds(status));
	const retryText = $derived(
		status.kind === 'retrying'
			? `${seconds > 0 ? `Reconnecting in ${seconds}s` : 'Reconnecting now'} (attempt ${status.attempt}).`
			: ''
	);
	// What a retry is about, for its card or banner.
	const retryLook = $derived.by((): { icon: IconName; title: string } => {
		if (status.kind !== 'retrying') return { icon: 'plug', title: '' };
		if (status.reason === 'busy') return { icon: 'clock', title: 'The farm is busy' };
		if (status.reason === 'refused') return { icon: 'alert', title: 'The farm refused the stream' };
		return { icon: 'plug', title: meta ? 'Connection lost' : "Can't reach the farm" };
	});
</script>

{#if status.kind === 'denied'}
	<div class="scrim">
		<div class="card" role="alert">
			<span class="icon danger"><Icon name="lock" size={22} /></span>
			<h2>No access to this farm</h2>
			{#if farm?.auth === 'anonymous'}
				<p>
					The farm lets this network watch, but its scheduler has no access rule for this network's
					viewers. Ask the farm operator.
				</p>
				<p class="detail mono">{status.error}</p>
			{:else}
				<p>
					Your account can't watch this farm. Ask the farm operator for the <code>watch</code> role.
				</p>
				<p class="detail mono">{status.error}</p>
				{#if signOutUrl}
					<div class="buttons">
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the farm's sign-out -->
						<a class="btn-primary" href={signOutUrl} data-sveltekit-reload>Sign out</a>
					</div>
				{/if}
			{/if}
		</div>
	</div>
{:else if !meta}
	<div class="scrim soft">
		{#if status.kind === 'signed-out'}
			<section class="card" aria-labelledby="signed-out-title">
				<span class="icon accent"><Icon name="lock" size={22} /></span>
				<h2 id="signed-out-title">Signed out of {farmName}</h2>
				<p>Your session at the farm has likely ended. Reload the page to sign in again.</p>
				<div class="buttons">
					<button type="button" class="btn-primary" onclick={onreload}>Reload</button>
					<button type="button" class="secondary" onclick={ondemo}>Try the demo</button>
				</div>
			</section>
		{:else}
			<div class="card" role="status">
				{#if status.kind === 'retrying'}
					<span class="icon warn"><Icon name={retryLook.icon} size={22} /></span>
					<h2>{retryLook.title}</h2>
					<!-- The countdown ticks every second, so it stays out of the live region. -->
					<p class="num" aria-hidden="true">{retryText}</p>
					<p class="detail mono">{status.error}</p>
					{#if onretry && seconds > 0}
						<div class="buttons">
							<button type="button" class="btn-primary" onclick={onretry}>Retry now</button>
						</div>
					{/if}
				{:else if status.kind === 'stopped'}
					<h2>Disconnected</h2>
					<div class="buttons">
						<button type="button" class="btn-primary" onclick={onreconnect}>Reconnect</button>
					</div>
				{:else}
					<span class="spinner" aria-hidden="true"></span>
					<h2>Waiting for the farm</h2>
					<p>
						{status.kind === 'syncing'
							? 'Connected. Receiving the current state of the scheduler…'
							: status.kind === 'connecting' && status.attempt > 1
								? `Opening the stream, attempt ${status.attempt}…`
								: 'Opening the stream to the scheduler…'}
					</p>
				{/if}
			</div>
		{/if}
	</div>
{:else if status.kind !== 'live'}
	<div
		class="banner"
		class:warn={status.kind === 'retrying'}
		class:danger={status.kind === 'signed-out' || status.kind === 'stopped'}
		role="status"
	>
		{#if status.kind === 'connecting' || status.kind === 'syncing'}
			<span class="spinner small" aria-hidden="true"></span>
			<p>
				<strong>Reconnecting.</strong>
				{status.kind === 'syncing'
					? 'Receiving the current state…'
					: 'Showing the last known state until the stream is back.'}
			</p>
		{:else if status.kind === 'retrying'}
			<Icon name={retryLook.icon} />
			<div class="text">
				<p>
					<strong>{retryLook.title}.</strong> Showing the last known state.
				</p>
				<p class="err">{status.error}</p>
			</div>
			{#if onretry && seconds > 0}
				<button type="button" onclick={onretry}>Retry now</button>
			{/if}
		{:else if status.kind === 'signed-out'}
			<Icon name="lock" />
			<p><strong>Signed out.</strong> Showing the last known state.</p>
			<button type="button" onclick={onreload}>Reload</button>
		{:else}
			<Icon name="info" />
			<p><strong>Disconnected.</strong> Showing the last known state.</p>
			<button type="button" onclick={onreconnect}>Reconnect</button>
		{/if}
	</div>
{/if}

<style>
	.scrim {
		position: absolute;
		inset: 0;
		z-index: 10;
		display: grid;
		place-items: center;
		padding: var(--space-6);
		background: var(--scrim);
		backdrop-filter: blur(2px);
	}

	.scrim.soft {
		background: color-mix(in srgb, var(--canvas-bg) 60%, transparent);
	}

	.card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		max-width: 440px;
		padding: var(--space-7) var(--space-7) var(--space-6);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		background: var(--bg);
		box-shadow: var(--shadow-lg);
		text-align: center;
	}

	h2 {
		overflow-wrap: anywhere;
		font-size: var(--text-lg);
		font-weight: 650;
	}

	p {
		color: var(--fg-muted);
		font-size: var(--text-sm);
	}

	.detail {
		max-width: 100%;
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		background: var(--bg-panel);
		font-size: var(--text-2xs);
		overflow-wrap: anywhere;
	}

	.icon {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 50%;
	}

	.icon.danger {
		background: var(--danger-soft);
		color: var(--danger-fg);
	}

	.icon.warn {
		background: var(--warn-soft);
		color: var(--warn-fg);
	}

	.icon.accent {
		background: var(--accent-soft);
		color: var(--fg);
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	/* The sign-out link looks like the buttons beside it. */
	.buttons a {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}

	.buttons button,
	.buttons a {
		height: 34px;
		padding: 0 16px;
		border-radius: var(--radius);
	}

	.buttons .secondary {
		border: 1px solid var(--border);
		background: var(--bg-panel);
		color: var(--fg);
		font-weight: 600;
	}

	.buttons .secondary:hover {
		border-color: var(--border-strong);
		background: var(--bg-raised);
	}

	.spinner {
		flex: none;
		width: 28px;
		height: 28px;
		border-width: 2.5px;
		animation-duration: 0.9s;
	}

	.spinner.small {
		width: 14px;
		height: 14px;
		border-width: 2px;
	}

	.banner {
		position: absolute;
		top: var(--space-3);
		left: 50%;
		z-index: 10;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		max-width: min(720px, calc(100% - 32px));
		padding: 8px 10px 8px 14px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		box-shadow: var(--shadow-md);
		transform: translateX(-50%);
		font-size: var(--text-sm);
	}

	.banner.warn {
		border-color: color-mix(in srgb, var(--warn) 50%, var(--border));
		color: var(--fg);
	}

	.banner.warn :global(.icon) {
		color: var(--warn-fg);
	}

	.banner.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
	}

	.banner.danger :global(.icon) {
		color: var(--danger-fg);
	}

	.banner p {
		color: var(--fg);
	}

	.banner strong {
		font-weight: 650;
	}

	.text {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.banner p.err {
		color: var(--fg-muted);
		font-size: var(--text-xs);
	}

	.banner button {
		flex: none;
		height: 28px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-sm);
		background: var(--accent-strong);
		color: var(--fg-on-accent);
		font-size: var(--text-xs);
		font-weight: 600;
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 3s;
		}
	}
</style>
