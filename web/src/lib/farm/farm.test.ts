import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserError } from '#lib/model/types.ts';
import { loadFarm } from './farm.ts';

const BASE = 'https://farm.example.com:8443/';

const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init
	});

function fetchOf(respond: () => Response | Promise<Response>) {
	return vi.fn<typeof globalThis.fetch>(async () => respond());
}

/** What loadFarm threw, as title and detail. */
async function failure(p: Promise<unknown>) {
	const e = await p.then(
		() => null,
		(e: unknown) => e
	);
	expect(e).toBeInstanceOf(UserError);
	const { title, detail } = e as UserError;
	return { title, detail };
}

describe('loadFarm', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('loadFarm reads name and auth, and the name defaults to the host', async () => {
		const fetch = fetchOf(() => json({ name: ' Example farm ', auth: 'proxy' }));
		expect(await loadFarm(BASE, fetch)).toEqual({
			name: 'Example farm',
			auth: 'proxy',
			base: BASE
		});
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://farm.example.com:8443/dashboard.json');
		expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
		expect(
			await loadFarm(
				BASE,
				fetchOf(() => json({ auth: 'anonymous' }))
			)
		).toEqual({
			name: 'farm.example.com:8443',
			auth: 'anonymous',
			base: BASE
		});
		expect(
			await loadFarm(
				BASE,
				fetchOf(() => json({ name: '', auth: 'anonymous' }))
			)
		).toEqual(expect.objectContaining({ name: 'farm.example.com:8443' }));
	});

	it('unknown fields are ignored', async () => {
		const fetch = fetchOf(() =>
			json({ name: 'Example farm', auth: 'anonymous', theme: 'x', v: 2 })
		);
		expect(await loadFarm(BASE, fetch)).toEqual({
			name: 'Example farm',
			auth: 'anonymous',
			base: BASE
		});
	});

	it('logSearchUrl is kept when it is an http or https URL', async () => {
		const load = (logSearchUrl: unknown) =>
			loadFarm(
				BASE,
				fetchOf(() => json({ auth: 'anonymous', logSearchUrl }))
			);
		expect((await load('https://logs.example.com/search'))?.logSearchUrl).toBe(
			'https://logs.example.com/search'
		);
		for (const bad of ['javascript:alert(1)', 'logs.example.com', '', 3, null])
			expect(await load(bad)).not.toHaveProperty('logSearchUrl');
	});

	it('signOutUrl is kept on proxy farms, absolute or resolved against the base', async () => {
		const load = (signOutUrl: unknown, auth = 'proxy', base = BASE) =>
			loadFarm(
				base,
				fetchOf(() => json({ auth, signOutUrl }))
			);
		expect((await load('https://auth.example.com/sign_out?rd=%2F'))?.signOutUrl).toBe(
			'https://auth.example.com/sign_out?rd=%2F'
		);
		expect((await load('/sign-out'))?.signOutUrl).toBe('https://farm.example.com:8443/sign-out');
		expect(
			(await load('/sign-out', 'proxy', 'https://farm.example.com:8443/dash/'))?.signOutUrl
		).toBe('https://farm.example.com:8443/sign-out');
		for (const bad of ['javascript:alert(1)', 'data:text/html,x', '', '  ', 3, null, undefined])
			expect(await load(bad)).not.toHaveProperty('signOutUrl');
		// Only a farm whose proxy signs users in has one to show.
		expect(await load('/sign-out', 'anonymous')).toEqual({
			name: 'farm.example.com:8443',
			auth: 'anonymous',
			base: BASE
		});
	});

	it.each(['oauth2', 'mtls'])('auth "%s" asks for a newer dashboard', async (auth) => {
		expect(
			await failure(
				loadFarm(
					BASE,
					fetchOf(() => json({ auth }))
				)
			)
		).toEqual({
			title: 'This farm needs a newer dashboard',
			detail: `The farm asks for sign-in "${auth}", which this dashboard does not know.`
		});
	});

	it('404 means no farm', async () => {
		const fetch = fetchOf(() => new Response('not found', { status: 404 }));
		expect(await loadFarm(BASE, fetch)).toBeNull();
	});

	it('a 200 that is not JSON means no farm', async () => {
		// A static host with an SPA fallback answers dashboard.json with its page.
		const fetch = fetchOf(
			() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
		);
		expect(await loadFarm(BASE, fetch)).toBeNull();
	});

	it('broken JSON and a missing auth are explained', async () => {
		expect(
			await failure(
				loadFarm(
					BASE,
					fetchOf(() => json('{"auth":'))
				)
			)
		).toEqual({
			title: "The farm's dashboard.json is not valid",
			detail: 'https://farm.example.com:8443/dashboard.json is not valid JSON.'
		});
		expect(
			await failure(
				loadFarm(
					BASE,
					fetchOf(() => json({ name: 'x' }))
				)
			)
		).toEqual({
			title: "The farm's dashboard.json is not valid",
			detail: 'https://farm.example.com:8443/dashboard.json does not say how to sign in.'
		});
		expect(
			await failure(
				loadFarm(
					BASE,
					fetchOf(() => json([]))
				)
			)
		).toMatchObject({
			title: "The farm's dashboard.json is not valid"
		});
	});

	it('a redirect says dashboard.json must answer without one', async () => {
		// What fetch gives for a 302 with redirect: 'manual'.
		const redirect = Response.error();
		Object.defineProperty(redirect, 'type', { value: 'opaqueredirect' });
		expect(
			await failure(
				loadFarm(
					BASE,
					fetchOf(() => redirect)
				)
			)
		).toEqual({
			title: 'The farm redirects dashboard.json',
			detail:
				"dashboard.json must answer on the page's own origin, without a redirect. The farm " +
				'operator has to fix that (docs/operators.md).'
		});
	});

	it('other HTTP errors and network errors say the farm did not answer', async () => {
		const fetch = fetchOf(
			() => new Response('', { status: 503, statusText: 'Service Unavailable' })
		);
		expect(await failure(loadFarm(BASE, fetch))).toEqual({
			title: 'The farm did not answer',
			detail:
				'https://farm.example.com:8443/dashboard.json returned HTTP 503 Service Unavailable. ' +
				'Try again later.'
		});
		const down = fetchOf(() => Promise.reject(new TypeError('Failed to fetch')));
		expect(await failure(loadFarm(BASE, down))).toEqual({
			title: 'The farm did not answer',
			detail:
				'The browser could not load https://farm.example.com:8443/dashboard.json. Try again later.'
		});
	});

	it('gives up after 10 s', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_, reject) =>
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
				)
		);
		const result = failure(loadFarm(BASE, fetch));
		await vi.advanceTimersByTimeAsync(9_999);
		expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toEqual({
			title: 'The farm did not answer',
			detail:
				'https://farm.example.com:8443/dashboard.json gave no answer within 10s. Try again later.'
		});
	});
});
