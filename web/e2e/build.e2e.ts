import type { Page } from '@playwright/test';
import { demo, expect, openFarm, pill, test } from './fixtures.ts';

// The production build, served as plain files under /dash/ by e2e/static-server.ts.
// It was built for no path in particular, so this proves one build works under any sub-path.

/**
 * Fail on any request to the site that misses, such as an asset resolved
 * against the wrong path.
 */
function noMisses(page: Page, baseURL = '', allow: string[] = []) {
	const misses: string[] = [];
	const origin = new URL(baseURL).origin;
	page.on('response', (r) => {
		if (r.status() >= 400 && r.url().startsWith(`${origin}/`) && !allow.includes(r.url()))
			misses.push(r.url());
	});
	page.on('requestfailed', (r) => misses.push(`${r.url()} ${r.failure()?.errorText}`));
	return misses;
}

test('landing and demo under /dash/', async ({ page, baseURL }) => {
	// A static host serves no dashboard.json, so no farm is behind this copy.
	const misses = noMisses(page, baseURL, [new URL('dashboard.json', baseURL).href]);
	await page.goto('./');
	await expect(page).toHaveURL(baseURL ?? '');
	await expect(page.getByRole('heading', { name: 'Watch your build farm, live' })).toBeVisible();
	await expect(page.getByText('This copy of the dashboard has no farm behind it.')).toBeVisible();
	await page.getByRole('button', { name: 'Try the demo' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Demo farm');
	await expect(pill(page)).toHaveText('Live');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(12);
	expect(misses).toEqual([]);
});

test('?demo&builders=300 under /dash/ draws pools', async ({ page }) => {
	await demo(page, 'builders=300');
	await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(2);
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(0);
});

test('a proxy farm in front of /dash/ streams', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ base: '/dash/', mock: { builders: 3 }, signOutUrl: '/sign-out' });
	const watches: string[] = [];
	page.on('request', (r) => {
		if (r.url().endsWith('/Watch')) watches.push(new URL(r.url()).pathname);
	});
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	await expect(page).toHaveURL(farm.url);
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(3);
	expect(new Set(watches)).toEqual(new Set(['/dash/nix.remote.Events/Watch']));
	expect(farm.watches).toHaveLength(1);
	// An absolute path stays one, outside the page's base.
	await expect(page.getByRole('link', { name: 'Sign out' })).toHaveAttribute(
		'href',
		`${farm.origin}/sign-out`
	);
});

test('an unknown path under /dash/ is a plain 404 without the app', async ({ page }) => {
	const res = await page.goto('./nope/');
	expect(res?.status()).toBe(404);
	expect(await res?.text()).not.toContain('_app/');
	await expect(page.getByRole('heading', { name: 'Watch your build farm, live' })).toHaveCount(0);
	// The build has no fallback page to send instead.
	expect((await page.request.get('./404.html')).status()).toBe(404);
});

test('/dash/logs/?demo loads from the plain static server', async ({ page, baseURL }) => {
	const misses = noMisses(page, baseURL);
	await page.goto('./logs/?demo');
	await expect(pill(page)).toHaveText('Live');
	await expect(page).toHaveTitle('Logs · Demo farm');
	await expect(
		page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Logs', exact: true })
	).toHaveAttribute('aria-current', 'page');
	await page.getByRole('link', { name: 'Overview', exact: true }).click();
	await expect(page).toHaveURL(`${baseURL}?demo`);
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(12);
	expect(misses).toEqual([]);
});
