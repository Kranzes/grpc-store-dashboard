import { create } from '@bufbuild/protobuf';
import type { Page } from '@playwright/test';
import {
	DrvGone_Outcome,
	DrvGone_Status,
	DrvState_Phase,
	SubstituterTrafficSchema,
	WorkerState_DrainReason
} from '../src/lib/gen/events_pb.ts';
import { E, Stream } from '../src/lib/model/fixtures.ts';
import { sleep, type FakeFarm } from './fake-farm.ts';
import {
	ANONYMOUS,
	dotsMove,
	expect,
	lineReport,
	node,
	openFarm,
	panel,
	pill,
	pointOn,
	test,
	viewSettled,
	zoomOf
} from './fixtures.ts';

// The live path against a fake farm (fake-farm.ts): the page, dashboard.json
// and the gRPC-web stream on one origin, behind the farm's auth proxy, with
// the real transport, reducer and store in the browser.

/** A scheduler that started serving a minute ago, without a cache. */
const reset = () =>
	E.reset({ instance: 'fake', cacheUrl: '', servingSinceMs: BigInt(Date.now() - 60_000) });

const signedOutCard = (page: Page) => page.getByRole('region', { name: /^Signed out of/ });
const header = (page: Page) => page.getByRole('banner');
const signOut = (page: Page) => page.getByRole('link', { name: 'Sign out' });

test('a proxy farm streams live', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ mock: { builders: 6 } });
	// Every request the page makes.
	const requests: { url: URL; authorization: string | undefined }[] = [];
	page.on('request', (r) =>
		requests.push({ url: new URL(r.url()), authorization: r.headers().authorization })
	);
	await openFarm(page, farm);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Test farm');
	await expect(pill(page)).toHaveText('Live');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(6);
	// Live traffic: dots travel on the line canvas.
	await dotsMove(page);
	// The page holds no token, sends none, and stores nothing.
	expect(farm.watches).toEqual([{ authorization: undefined }]);
	expect(requests.filter((r) => r.authorization !== undefined)).toEqual([]);
	const stored = await page.evaluate(() => ({
		local: Object.keys(localStorage),
		session: Object.keys(sessionStorage),
		cookie: document.cookie
	}));
	expect(stored.local).toEqual([]);
	expect(stored.session.filter((k) => !k.startsWith('sveltekit:'))).toEqual([]);
	expect(stored.cookie).toBe('');
	// No sign-out address in dashboard.json, so no Sign out.
	await expect(signOut(page)).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Sign (in|out)$/ })).toHaveCount(0);
	// The page talks only to the farm's origin.
	const origin = new URL(farm.url).origin;
	expect(
		requests
			.filter((r) => !['data:', 'blob:'].includes(r.url.protocol))
			.map((r) => r.url.origin)
			.filter((o) => o !== origin)
	).toEqual([]);
	expect(requests.some((r) => r.url.pathname.endsWith('/nix.remote.Events/Watch'))).toBe(true);
});

test('Sign out links to the absolute signOutUrl', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ signOutUrl: 'https://auth.example.com/sign_out?rd=%2F' });
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	await expect(header(page).getByRole('link', { name: 'Sign out' })).toHaveAttribute(
		'href',
		'https://auth.example.com/sign_out?rd=%2F'
	);
});

test('Sign out links to a signOutUrl path on the farm, and leaves the page', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm({ signOutUrl: '/sign-out' });
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	const link = header(page).getByRole('link', { name: 'Sign out' });
	await expect(link).toHaveAttribute('href', `${farm.origin}/sign-out`);
	// A full page load, not the app's own router.
	const left = page.waitForRequest(
		(r) => r.isNavigationRequest() && new URL(r.url()).pathname === '/sign-out'
	);
	await link.click();
	await left;
});

test('an anonymous farm streams without signing in, and has no Sign out', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm({
		dashboardJson: { name: 'Test farm', auth: 'anonymous', signOutUrl: '/sign-out' },
		mock: { builders: 4 }
	});
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(4);
	expect(farm.watches).toHaveLength(1);
	await expect(signOut(page)).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Sign (in|out)/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Leave demo' })).toHaveCount(0);
});

test('a page without dashboard.json offers the demo', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ dashboardJson: null });
	await page.goto(farm.url);
	await expect(page.getByText('This copy of the dashboard has no farm behind it.')).toBeVisible();
	await page.getByRole('button', { name: 'Try the demo' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Demo farm');
	await expect(pill(page)).toHaveText('Live');
});

test('a broken dashboard.json is explained, and Try again reads it again', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm({ dashboardJson: '{"auth": proxy}' });
	await page.goto(farm.url);
	await expect(page.getByRole('alert')).toContainText("The farm's dashboard.json is not valid");
	const loads = page.waitForRequest((r) => r.url().endsWith('/dashboard.json'));
	await page.getByRole('button', { name: 'Try again' }).click();
	await loads;
	await expect(page.getByRole('alert')).toContainText("The farm's dashboard.json is not valid");
});

test('a farm that asks for oauth2 needs a newer dashboard', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ dashboardJson: { name: 'Test farm', auth: 'oauth2' } });
	await page.goto(farm.url);
	await expect(page.getByRole('alert')).toContainText('This farm needs a newer dashboard');
	expect(farm.watches).toEqual([]);
});

test('waits for the first snapshot', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm(ANONYMOUS);
	farm.watch = async (call) => {
		call.send([new Stream(1n, Date.now()).raw(1n, reset())]);
		await call.hold();
	};
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Syncing');
	await expect(page.getByText('Waiting for the farm')).toBeVisible();
	await expect(page.getByRole('group', { name: 'Totals' })).toContainText('–');
});

test('shows an empty farm', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm(ANONYMOUS);
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		call.send(s.snapshot(reset()));
		while (!call.closed) {
			await sleep(1000);
			call.send(s.next(E.stats()));
		}
	};
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	await expect(page.getByText('No builders connected')).toBeVisible();
	await expect(page.getByText('No cache configured')).toBeVisible();
	await expect(page.getByText('No build clients')).toBeVisible();
});

test('retries when the farm is down', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm(ANONYMOUS);
	farm.watch = (call) => call.fail(14, 'no healthy upstream');
	await openFarm(page, farm);
	await expect(page.getByText("Can't reach the farm")).toBeVisible();
	await expect(pill(page)).toContainText(/Reconnecting/);
	await expect(page.getByText('The farm is unavailable: no healthy upstream')).toBeVisible();
	await expect.poll(() => farm.watches.length).toBeGreaterThan(1);
	// Backoff grows to between 2 and 4 s before attempt 4; "Retry now" skips the wait.
	await expect(page.getByText('(attempt 4)')).toBeVisible({ timeout: 10_000 });
	const calls = farm.watches.length;
	await page.getByRole('button', { name: 'Retry now' }).click();
	await expect.poll(() => farm.watches.length, { timeout: 1000 }).toBeGreaterThan(calls);
});

test('says the farm is busy when its cap on streams is full', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm();
	// Envoy's circuit breaker on all viewers of the balancer.
	farm.watch = (call) =>
		call.reply(503, { 'x-envoy-overloaded': 'true', 'grpc-status': '14' }, 'overflow');
	await openFarm(page, farm);
	await expect(page.getByRole('heading', { name: 'The farm is busy' })).toBeVisible();
	await expect(pill(page)).toContainText(/Reconnecting/);
	await expect.poll(() => farm.watches.length).toBeGreaterThan(1);
});

test('keeps the last state while reconnecting', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 4 } });
	let calls = 0;
	farm.watch = async (call) => {
		// The first stream delivers a snapshot and breaks; later ones fail.
		if (calls++ > 0) return call.fail(14, 'scheduler restarting');
		farm.mock.advance(Date.now(), true);
		call.send(farm.mock.snapshot());
		await sleep(1500);
		call.end(14, 'upstream reset');
	};
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	await expect(page.getByText('Connection lost.')).toBeVisible();
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(4);
	await expect(pill(page)).toContainText(/Reconnecting/);
});

test('a 401 at connect shows Signed out with Reload, and Reload loads the page again', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm({ mock: { builders: 3 }, signOutUrl: '/sign-out' });
	farm.watch = (call) => call.reply(401, {}, 'Unauthorized');
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Signed out');
	await expect(signedOutCard(page)).toContainText('Signed out of Test farm');
	await expect(signedOutCard(page)).toContainText(
		'Your session at the farm has likely ended. Reload the page to sign in again.'
	);
	// No retries, and nothing to sign out of.
	await page.waitForTimeout(1500);
	expect(farm.watches).toHaveLength(1);
	await expect(signOut(page)).toHaveCount(0);
	farm.watch = (call) => call.streamMock(farm.mock);
	const reloaded = page.waitForEvent('load');
	await signedOutCard(page).getByRole('button', { name: 'Reload' }).click();
	await reloaded;
	await expect(pill(page)).toHaveText('Live');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(3);
});

test('a 401 as gRPC-web means signed out too', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm();
	farm.watch = (call) =>
		call.reply(401, { 'content-type': 'application/grpc-web+proto', 'grpc-status': '16' });
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Signed out');
	await expect(signedOutCard(page)).toBeVisible();
});

for (const lapse of ['unauthorized', 'redirect'] as const) {
	test(`a proxy session that ends (${lapse}) keeps the last state, and Reload signs in again`, async ({
		page,
		fakeFarm
	}) => {
		const farm = await fakeFarm({ mock: { builders: 3 }, signOutUrl: '/sign-out' });
		let calls = 0;
		farm.watch = async (call) => {
			// The first stream breaks; by then the proxy's session has ended.
			if (calls++ > 0) return call.streamMock(farm.mock);
			farm.mock.advance(Date.now(), true);
			call.send(farm.mock.snapshot());
			await sleep(1000);
			farm.lapsed = lapse;
			call.end(14, 'upstream reset');
		};
		await openFarm(page, farm);
		await expect(pill(page)).toHaveText('Live');
		await expect(page.getByText('Signed out. Showing the last known state.')).toBeVisible();
		await expect(pill(page)).toHaveText('Signed out');
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(3);
		// No session to sign out of.
		await expect(signOut(page)).toHaveCount(0);
		// The reload goes through the proxy's sign-in.
		await page.locator('.banner').getByRole('button', { name: 'Reload' }).click();
		await expect(pill(page)).toHaveText('Live');
		expect(farm.lapsed).toBeNull();
		await expect(header(page).getByRole('link', { name: 'Sign out' })).toBeVisible();
	});
}

test('a 403 with plain text shows that text, and backs off', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm();
	farm.watch = (call) => call.reply(403, {}, 'RBAC: access denied');
	await openFarm(page, farm);
	await expect(page.getByRole('heading', { name: 'The farm refused the stream' })).toBeVisible();
	await expect(
		page.getByText('A proxy in front of the farm refused this page (RBAC: access denied).')
	).toBeVisible();
	await expect(pill(page)).toContainText(/Reconnecting/);
	await expect.poll(() => farm.watches.length).toBeGreaterThan(1);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('explains a denied watch, with Sign out in the card', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ signOutUrl: '/sign-out' });
	farm.watch = (call) => call.fail(7, 'role watch required');
	await openFarm(page, farm);
	await expect(page.getByRole('alert')).toContainText('No access to this farm');
	await expect(page.getByRole('alert')).toContainText('role watch required');
	await expect(page.getByRole('alert')).toContainText(
		"Your account can't watch this farm. Ask the farm operator for the watch role."
	);
	await expect(pill(page)).toHaveText('No access');
	// The card has the one Sign out link; the header has none.
	await expect(header(page).getByRole('link', { name: 'Sign out' })).toHaveCount(0);
	await expect(page.getByRole('alert').getByRole('link', { name: 'Sign out' })).toHaveAttribute(
		'href',
		`${farm.origin}/sign-out`
	);
});

test('a denied watch without signOutUrl has no Sign out', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm();
	farm.watch = (call) => call.fail(7, 'role watch required');
	await openFarm(page, farm);
	await expect(page.getByRole('alert')).toContainText("Your account can't watch this farm.");
	await expect(signOut(page)).toHaveCount(0);
});

test('explains a denied watch from an anonymous network', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm(ANONYMOUS);
	farm.watch = (call) => call.fail(7, "no access rule matches 'dashboard-anon-127.0.0.1'");
	await openFarm(page, farm);
	await expect(page.getByRole('alert')).toContainText(
		"The farm lets this network watch, but its scheduler has no access rule for this network's viewers."
	);
	await expect(page.getByRole('alert').getByRole('button')).toHaveCount(0);
	await expect(page.getByRole('alert').getByRole('link')).toHaveCount(0);
});

test('a scheduler refusal at connect backs off and does not sign out', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm();
	farm.watch = (call) => call.fail(16, 'caller not trusted');
	await openFarm(page, farm);
	await expect(
		page.getByText(
			"The farm's scheduler does not accept the viewers its balancer names (caller not trusted)."
		)
	).toBeVisible();
	await expect(pill(page)).toContainText(/Reconnecting/);
	await expect.poll(() => farm.watches.length).toBeGreaterThan(2);
	await expect(pill(page)).not.toHaveText('Signed out');
});

test('the demo runs on a farm without its stream, and Leave demo returns to the farm', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm({ mock: { builders: 3 } });
	await page.goto(`${farm.url}?demo&builders=5`);
	await expect(pill(page)).toHaveText('Live');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(5);
	expect(farm.watches).toEqual([]);
	await page.getByRole('button', { name: 'Leave demo' }).click();
	await expect(page).toHaveURL(farm.url);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Test farm');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(3);
});

test('a builder panel works on live data', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 4 } });
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');
	await page.locator('[data-node-button^="worker:"]').first().click();
	await expect(
		panel(page).getByRole('list', { name: 'Derivations on this builder' })
	).toBeVisible();
});

test('zoom buttons stop the automatic refit until Fit', async ({ page, fakeFarm }) => {
	const farm = await fakeFarm(ANONYMOUS);
	let join = false;
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		call.send(s.snapshot(reset(), E.worker('b1:1'), E.worker('b2:1')));
		let joined = false;
		while (!call.closed) {
			await sleep(200);
			if (join && !joined) {
				joined = true;
				call.send(s.next(E.worker('b3:1')));
			}
			call.send(s.next(E.stats()));
		}
	};
	await openFarm(page, farm);
	const builders = page.locator('.svelte-flow__node-builder');
	await expect(builders).toHaveCount(2);
	const fitButton = page.getByRole('button', { name: 'Fit the whole farm' });
	await expect(fitButton).toHaveClass(/\bdim\b/);
	await page.waitForTimeout(500);
	await page.getByRole('button', { name: 'Zoom in' }).click();
	await expect(fitButton).not.toHaveClass(/\bdim\b/);
	await page.waitForTimeout(500);
	const view = page.locator('.svelte-flow__viewport');
	const transform = () => view.evaluate((el) => (el as HTMLElement).style.transform);
	const zoomed = await transform();
	// A new builder changes the layout, which refits a view the user has not moved.
	join = true;
	await expect(builders).toHaveCount(3);
	await page.waitForTimeout(600);
	expect(await transform()).toBe(zoomed);
	await fitButton.click();
	await expect(fitButton).toHaveClass(/\bdim\b/);
	await expect.poll(transform).not.toBe(zoomed);
});

test('a group toggled while a panel is open refits, though the layout changes again at once', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm(ANONYMOUS);
	let join = false;
	let joined: () => void = () => {};
	const sent = new Promise<void>((resolve) => (joined = resolve));
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		const pool = Array.from({ length: 11 }, (_, i) => E.worker(`b${i + 1}:1`));
		call.send(s.snapshot(reset(), ...pool));
		while (!call.closed) {
			await sleep(200);
			if (join) {
				join = false;
				call.send(s.next(E.worker('c1:1', { systems: ['aarch64-linux'] })));
				joined();
			}
			call.send(s.next(E.stats()));
		}
	};
	await openFarm(page, farm);
	await expect(node(page, 'pool:x86_64-linux')).toBeVisible();
	await viewSettled(page);
	await node(page, 'scheduler').click();
	await expect(panel(page)).toBeVisible();
	await page.waitForTimeout(600);
	await viewSettled(page);
	const zoom = await zoomOf(page);
	// A builder joins while paused, so resuming changes the layout again.
	await page.keyboard.press('p');
	await expect(pill(page)).toHaveText(/Paused/);
	join = true;
	await sent;
	await page.waitForTimeout(400);
	// Show the pool as cards, then resume within the 30 ms the refit waits.
	await page.evaluate(async () => {
		document.querySelector<HTMLElement>('[data-pool-toggle="x86_64-linux"]')!.click();
		await new Promise((resolve) => setTimeout(resolve, 5));
		document.querySelector<HTMLElement>('.map-controls button.pause')!.click();
	});
	await expect(pill(page)).toHaveText('Live');
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(12);
	// Ten rows of cards do not fit at the old zoom.
	await expect.poll(() => zoomOf(page)).toBeLessThan(zoom * 0.95);
});

test('shows failure reasons, drain reasons and substituters sent over the wire', async ({
	page,
	fakeFarm
}) => {
	const GiB = 1024 ** 3;
	const NIXOS = 'https://cache.nixos.org';
	const FARM = 'https://cache.farm.example';
	const failed = `/nix/store/${'f'.repeat(32)}-hello-2.12.1.drv`;
	const error = [
		`Cannot build '${failed}'.`,
		'Reason: builder timed out after 3600 seconds of silence.',
		'Last 2 log lines:',
		'> running tests',
		'> <script>alert(1)</script> still waiting'
	].join('\n');
	const sub = (url: string, nar: number) =>
		create(SubstituterTrafficSchema, { url, narBytes: BigInt(nar), paths: 1n });
	const farm = await fakeFarm(ANONYMOUS);
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		call.send(
			s.snapshot(
				E.reset({
					instance: 'fake',
					cacheUrl: FARM,
					cacheSubstituterUrl: FARM,
					servingSinceMs: BigInt(Date.now() - 60_000)
				}),
				E.worker('b1:1', {
					draining: true,
					drainReason: WorkerState_DrainReason.LOW_DISK,
					diskFreeBytes: BigInt(Math.round(3.1 * GiB)),
					diskTotalBytes: BigInt(200 * GiB),
					minFreeBytes: BigInt(10 * GiB),
					version: '0.4.0',
					substituters: [sub(FARM, 0), sub(NIXOS, 0)]
				}),
				E.worker('b2:1', { version: '' }),
				E.worker('b3:1', { version: '0.4.0', substituters: [sub(NIXOS, 0)] })
			)
		);
		call.send(
			s.next(
				E.drv(failed, { phase: DrvState_Phase.ASSIGNED, workerAddr: 'b3:1' }),
				E.gone(failed, DrvGone_Outcome.FAILED, {
					workerAddr: 'b3:1',
					status: DrvGone_Status.TIMED_OUT,
					error
				}),
				E.stats({ substituters: [sub(FARM, 0), sub(NIXOS, 0)] })
			)
		);
		let nar = 0;
		while (!call.closed) {
			await sleep(1000);
			nar += 4 * 1024 ** 2;
			call.send(
				s.next(
					E.worker('b3:1', { version: '0.4.0', substituters: [sub(NIXOS, nar)] }),
					E.stats({ substituters: [sub(FARM, 0), sub(NIXOS, nar)] })
				)
			);
		}
	};
	await openFarm(page, farm);
	await expect(pill(page)).toHaveText('Live');

	// The low-disk builder.
	const b1 = page.locator('[data-node-button="worker:b1:1"]');
	await expect(b1.locator('.badge')).toHaveText('Low disk');
	await expect(b1).toContainText('3.1 GiB free');

	// The card: cache.nixos.org, then the farm cache row.
	const card = page.locator('[data-node-button="upstream"]');
	await expect(card.locator('.host')).toHaveText(['cache.nixos.org', 'cache.farm.example']);
	await expect(card.locator('.sub')).toHaveText('1 on 2 builders');
	await expect(card.locator('.sub')).toHaveAttribute(
		'title',
		'1 more builder does not report its substituters.'
	);
	// b2 does not report, so it has no line, and its panel says so.
	const ids = (await lineReport(page))
		.map((l) => l.id)
		.filter((id) => id.startsWith('substitute:'));
	expect(ids.sort()).toEqual(['substitute:b1:1', 'substitute:b3:1']);
	await page.locator('[data-node-button="worker:b2:1"]').click();
	await expect(panel(page)).toContainText('This builder does not report its substituters.');

	// The failed build, from b3's panel.
	await page.locator('[data-node-button="worker:b3:1"]').click();
	await panel(page)
		.getByRole('list', { name: 'Derivations on this builder' })
		.getByRole('button')
		.filter({ hasText: 'Timed out' })
		.click();
	await expect(panel(page).getByRole('note')).toContainText('Build failed: timed out');
	const log = panel(page).locator('pre.p-log');
	await expect(log).toHaveText(error);
	// The build's markup stays plain text.
	await expect(log.locator('script')).toHaveCount(0);
});

test('a layout that moves a line from under a resting pointer lets go of it', async ({
	page,
	fakeFarm
}) => {
	const farm = await fakeFarm(ANONYMOUS);
	let join = false;
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		call.send(s.snapshot(reset(), E.worker('b2:1'), E.worker('b3:1'), E.worker('b4:1')));
		while (!call.closed) {
			await sleep(200);
			if (join) {
				join = false;
				const arm = { systems: ['aarch64-linux'] };
				call.send(s.next(E.worker('a1:1', arm), E.worker('a2:1', arm)));
			}
			call.send(s.next(E.stats()));
		}
	};
	await openFarm(page, farm);
	await expect(node(page, 'worker:b3:1')).toBeVisible();
	await viewSettled(page);
	// The user's own zoom stops refits, whose start would clear the hover anyway.
	await page.keyboard.press('-');
	await viewSettled(page);
	const line = 'assign:b3:1';
	const readout = page.locator('.line-readout');
	// On the short branch into the card, clear of the trunk 18 px out once a second group joins.
	await expect(async () => {
		const p = await pointOn(page, line, -8);
		await page.mouse.move(p.x, p.y - 1);
		await page.mouse.move(p.x, p.y);
		await expect(readout).toBeVisible({ timeout: 1000 });
	}).toPass();
	await expect(readout).toContainText('b3:1');
	// A new group moves the cards down, and the line with them, with the pointer still.
	join = true;
	await expect(node(page, 'worker:a1:1')).toBeVisible();
	await expect(readout).toBeHidden();
	await expect.poll(async () => (await lineReport(page)).every((l) => l.fade === 1)).toBe(true);
});

test('while paused, the legend lists substitutions as the paused map draws them', async ({
	page,
	fakeFarm
}) => {
	const FARM = 'https://cache.farm.example';
	const farm = await fakeFarm(ANONYMOUS);
	let list = false;
	let listed: () => void = () => {};
	const sent = new Promise<void>((resolve) => (listed = resolve));
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		call.send(
			s.snapshot(
				E.reset({
					instance: 'fake',
					cacheUrl: FARM,
					cacheSubstituterUrl: FARM,
					servingSinceMs: BigInt(Date.now() - 60_000)
				}),
				E.worker('b1:1'),
				E.worker('b2:1')
			)
		);
		while (!call.closed) {
			await sleep(200);
			if (list) {
				list = false;
				const sub = create(SubstituterTrafficSchema, {
					url: 'https://cache.nixos.org',
					narBytes: 0n,
					paths: 0n
				});
				call.send(s.next(E.worker('b1:1', { substituters: [sub] })));
				listed();
			}
			call.send(s.next(E.stats()));
		}
	};
	await openFarm(page, farm);
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(2);
	const item = page.locator('.legend li', { hasText: 'Substitutions' });
	const card = page.locator('[data-node-button="upstream"]');
	await expect(item).toHaveCount(0);
	await page.keyboard.press('p');
	await expect(pill(page)).toHaveText(/Paused/);
	// A builder starts listing a substituter while the map holds still.
	list = true;
	await sent;
	await page.waitForTimeout(600);
	await expect(card).toHaveCount(0);
	await expect(item).toHaveCount(0);
	await page.keyboard.press('p');
	await expect(card).toBeVisible();
	await expect(item).toHaveCount(1);
});

test('a legend item that goes away under the pointer stops lighting the map', async ({
	page,
	fakeFarm
}) => {
	const FARM = 'https://cache.farm.example';
	const farm = await fakeFarm(ANONYMOUS);
	let unlist = false;
	farm.watch = async (call) => {
		const s = new Stream(1n, Date.now());
		const sub = create(SubstituterTrafficSchema, {
			url: 'https://cache.nixos.org',
			narBytes: 0n,
			paths: 0n
		});
		call.send(
			s.snapshot(
				E.reset({
					instance: 'fake',
					cacheUrl: FARM,
					cacheSubstituterUrl: FARM,
					servingSinceMs: BigInt(Date.now() - 60_000)
				}),
				E.worker('b1:1', { substituters: [sub] }),
				E.worker('b2:1')
			)
		);
		while (!call.closed) {
			await sleep(200);
			if (unlist) {
				unlist = false;
				call.send(s.next(E.worker('b1:1')));
			}
			call.send(s.next(E.stats()));
		}
	};
	await openFarm(page, farm);
	const item = page.locator('.legend li', { hasText: 'Substitutions' });
	await expect(item).toHaveCount(1);
	// The pointer enters the item and stays. The event comes without a real
	// pointer, so no other item slides under it when this one goes.
	await page.mouse.move(700, 30);
	await item.dispatchEvent('pointerenter');
	await expect
		.poll(async () => {
			const r = await lineReport(page);
			return (
				r.some((l) => l.kind === 'substitute' && l.fade === 1) &&
				r.some((l) => l.kind !== 'substitute' && l.fade === 0.45)
			);
		})
		.toBe(true);
	// The builder stops listing its substituter, and the item goes.
	unlist = true;
	await expect(item).toHaveCount(0);
	await expect
		.poll(async () => {
			const r = await lineReport(page);
			return r.length > 0 && r.every((l) => l.fade === 1);
		})
		.toBe(true);
});

test.describe('logs', () => {
	const viewer = (page: Page) => page.locator('section.viewer');
	const list = (page: Page) => page.getByRole('list', { name: 'Builds' });
	const rows = (page: Page) => list(page).locator('a.item');
	const HELLO = `${'h'.repeat(32)}-hello-2.12.1.drv`;

	/** The fake builders' first builder, as the page names it. */
	const firstBuilder = (farm: FakeFarm) => Object.keys(farm.mock.inspect().machines)[0];

	/** Open a log link on an anonymous fake farm. */
	async function openLog(page: Page, farm: FakeFarm, drv = HELLO, extra = '') {
		const on = firstBuilder(farm);
		await page.goto(`${farm.url}logs/?drv=${drv}&on=${encodeURIComponent(on)}${extra}`);
		await expect(pill(page)).toHaveText('Live');
	}

	test('a finished log arrives as zstd and matches the generated bytes', async ({
		page,
		fakeFarm
	}) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 } });
		await openLog(page, farm);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await expect(viewer(page).locator('.status')).toContainText(`From ${firstBuilder(farm)}`);
		expect(farm.logCalls).toHaveLength(1);
		expect(farm.logCalls[0]).toMatchObject({
			drvPath: HELLO,
			offset: 0,
			limit: 16 * 1024 * 1024,
			follow: false
		});
		await viewer(page).getByRole('button', { name: 'Raw log' }).click();
		const dl = page.waitForEvent('download');
		await viewer(page).getByRole('menuitem', { name: 'Save log' }).click();
		const file = await dl;
		const { readFileSync } = await import('node:fs');
		const got = readFileSync((await file.path())!);
		expect(got.length).toBe(farm.logCalls[0].bytes);
		expect(got.toString('utf8')).toContain('Running phase: buildPhase');
	});

	test('a dropped stream resumes at its offset', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({
			...ANONYMOUS,
			mock: { builders: 3 },
			logs: { dropAfter: 20_000 }
		});
		await openLog(page, farm);
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 15_000 });
		expect(farm.logCalls.length).toBe(2);
		expect(farm.logCalls[1].offset).toBe(farm.logCalls[0].bytes);
		// No repeated or missing line: the numbers run 1 to the end.
		await viewer(page).getByRole('button', { name: 'Expand all' }).click();
		const text = await viewer(page).locator('.status').textContent();
		const lines = Number(/([\d,]+) lines/.exec(text!)![1].replace(/,/g, ''));
		await viewer(page).focus();
		// Expand all may still be counting rows, so press End again until the view is at the end.
		await expect
			.poll(async () => {
				await page.keyboard.press('End');
				return Math.max(...(await viewer(page).locator('.gutter a').allTextContents()).map(Number));
			})
			.toBe(lines);
	});

	test('nothing flows when nobody looks', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 6, speed: 0.5 } });
		await page.goto(`${farm.url}logs/`);
		await expect(pill(page)).toHaveText('Live');
		await expect(rows(page).first()).toBeVisible();
		await page.waitForTimeout(500);
		expect(farm.logCalls).toEqual([]);
		// A running build follows; going to the Overview cancels the call.
		await page.goto(`${farm.url}logs/?status=assigned`);
		await expect(rows(page).first()).toBeVisible();
		await rows(page).first().click();
		await expect.poll(() => farm.logCalls.filter((c) => c.follow).length).toBeGreaterThan(0);
		await page
			.getByRole('navigation', { name: 'Views' })
			.getByRole('link', { name: 'Overview' })
			.click();
		await expect
			.poll(() => farm.logCalls.every((c) => c.cancelled || c.ended), { timeout: 2000 })
			.toBe(true);
	});

	test('follow ends with the build', async ({ page, fakeFarm }) => {
		test.setTimeout(120_000);
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3, speed: 4 } });
		await page.goto(`${farm.url}logs/?status=assigned&sort=newest`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		await rows(page).first().click();
		await expect(viewer(page).locator('.status')).toContainText('Following');
		// The builder sends `ended` after the build's DrvGone, and the call ends with no second call.
		await expect(viewer(page).locator('.ended')).toContainText(/^Build finished: /, {
			timeout: 90_000
		});
		const follow = farm.logCalls.filter((c) => c.follow);
		expect(follow).toHaveLength(1);
		await expect.poll(() => follow[0].ended).toBe(true);
		expect(follow[0].cancelled).toBe(false);
		await expect(viewer(page).getByRole('checkbox', { name: 'Follow' })).toHaveCount(0);
	});

	test('a follow call closes 10 s after the page hides, and resumes when it shows', async ({
		page,
		fakeFarm
	}) => {
		test.setTimeout(60_000);
		// Builds take minutes at this rate, so the one it follows is still
		// running when the page shows again. At the default rate, many end in
		// seconds, and a call that ends with its build never gets closed.
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 6, speed: 0.5, rate: 1 } });
		await page.goto(`${farm.url}logs/?status=assigned`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		await rows(page).first().click();
		await expect.poll(() => farm.logCalls.filter((c) => c.follow && c.bytes > 0).length).toBe(1);
		const setHidden = (hidden: boolean) =>
			page.evaluate((hidden) => {
				Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
				Object.defineProperty(document, 'visibilityState', {
					configurable: true,
					get: () => (hidden ? 'hidden' : 'visible')
				});
				document.dispatchEvent(new Event('visibilitychange'));
			}, hidden);
		await setHidden(true);
		const hiddenAt = Date.now();
		// Still open after 8 s, closed after 10.
		await page.waitForTimeout(8_000);
		expect(farm.logCalls[0].cancelled).toBe(false);
		await expect.poll(() => farm.logCalls[0].cancelled, { timeout: 15_000 }).toBe(true);
		console.log(`closed ${Date.now() - hiddenAt} ms after hiding`);
		expect(farm.logCalls).toHaveLength(1);
		// Shown again, the page makes one more follow call, from where the first stopped.
		const sent = farm.logCalls[0].bytes;
		await setHidden(false);
		await expect.poll(() => farm.logCalls.length).toBe(2);
		expect(farm.logCalls[1]).toMatchObject({ follow: true, offset: sent });
	});

	test('headers carry the counts', async ({ page, fakeFarm }) => {
		const text = [
			'unpacking sources',
			'Running phase: unpackPhase',
			'unpacking source archive /nix/store/abc-hello-2.12.1.tar.gz',
			'Running phase: configurePhase',
			'checking for gcc... gcc',
			'checking whether the C compiler works... yes',
			'configurePhase completed in 1 minutes 12 seconds',
			'Running phase: buildPhase',
			"src/hello.c:3:5: warning: unused variable 'x' [-Wunused-variable]",
			"src/hello.c:9:1: error: expected ';' before '}' token",
			'make: *** [Makefile:1: all] Error 1',
			'Running phase: installPhase',
			'installing'
		].join('\n');
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { text } });
		await openLog(page, farm);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const head = (name: string) =>
			viewer(page)
				.locator('.scroller button.head')
				.filter({ has: page.getByText(name, { exact: true }) });
		// A footer gives a duration; the line counts hold the header line and the group's lines.
		await expect(head('configurePhase')).toContainText('1m 12s');
		await expect(head('configurePhase')).toContainText('4 lines');
		await expect(head('configurePhase')).toHaveAttribute(
			'aria-label',
			'configurePhase, 1 minute 12 seconds, 4 lines'
		);
		// No footer, no duration.
		await expect(head('unpackPhase')).toHaveAttribute('aria-label', 'unpackPhase, 2 lines');
		await expect(head('unpackPhase')).not.toContainText(/\d+s/);
		// A phase with a gcc warning and error says so, in words.
		await expect(head('buildPhase')).toContainText('4 lines');
		await expect(head('buildPhase')).toContainText('1 warning');
		await expect(head('buildPhase')).toContainText('1 error');
		await expect(head('buildPhase')).toHaveAttribute(
			'aria-label',
			'buildPhase, 4 lines, 1 warning, 1 error'
		);
		// The line before the first phase is a plain line at the top, with no header.
		await expect(viewer(page).locator('.scroller button.head')).toHaveCount(4);
		const top = viewer(page).locator('.scroller .row[data-row="0"]');
		await expect(top).toHaveClass(/\bline\b/);
		await expect(top.locator('.text')).toHaveText('unpacking sources');
	});

	test('NOT_FOUND from the builder says it keeps no log', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { notFound: true } });
		await openLog(page, farm);
		await expect(viewer(page)).toContainText(`${firstBuilder(farm)} keeps no log of this build.`, {
			timeout: 15_000
		});
	});

	test('UNIMPLEMENTED says the builder serves no logs', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({
			...ANONYMOUS,
			mock: { builders: 3 },
			logs: { unimplemented: true }
		});
		await openLog(page, farm);
		await expect(viewer(page)).toContainText(`${firstBuilder(farm)} serves no build logs.`);
	});

	test('DATA_LOSS keeps what arrived and says the file is damaged, failed or built', async ({
		page,
		fakeFarm
	}) => {
		const farm = await fakeFarm({
			...ANONYMOUS,
			mock: { builders: 3 },
			// Small enough that every log is longer.
			logs: { dataLossAfter: 5_000 }
		});
		await page.goto(`${farm.url}logs/?status=failed`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		await rows(page).first().click();
		await expect(viewer(page)).toContainText('is damaged.');
		await expect(viewer(page).locator('.scroller .row').first()).toBeVisible();
		// A built build's log says the same, and nothing about a stopped build.
		await openLog(page, farm);
		await expect(viewer(page)).toContainText(`The log file on ${firstBuilder(farm)} is damaged.`);
		await expect(viewer(page)).not.toContainText('the build was stopped');
		await expect(viewer(page).locator('.scroller .row').first()).toBeVisible();
	});

	test('PERMISSION_DENIED says the farm does not let you read logs', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { denied: true } });
		await openLog(page, farm);
		await expect(viewer(page)).toContainText('This farm does not let you read build logs.');
	});

	test('RESOURCE_EXHAUSTED backs off and then loads', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { busy: 1 } });
		await openLog(page, farm);
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 10_000 });
		expect(farm.logCalls.length).toBe(2);
	});

	test('a log store that cannot be read gets its own sentence and slower retries', async ({
		page,
		fakeFarm
	}) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { unreadable: 2 } });
		await openLog(page, farm);
		const on = firstBuilder(farm);
		await expect(viewer(page)).toContainText(
			`${on} cannot read this log from the farm's log store or binary cache right now.`
		);
		await expect(viewer(page)).not.toContainText('Lost the connection');
		// The first retry waits 2 s, not the network's 0.5 s.
		await page.waitForTimeout(1_200);
		expect(farm.logCalls).toHaveLength(1);
		// Retry now skips the wait.
		await viewer(page).getByRole('button', { name: 'Retry now' }).click();
		await expect.poll(() => farm.logCalls.length).toBe(2);
		await viewer(page).getByRole('button', { name: 'Retry now' }).click();
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		expect(farm.logCalls).toHaveLength(3);
	});

	test('an old server cannot follow a running build', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({
			...ANONYMOUS,
			mock: { builders: 3, speed: 0.3 },
			logs: { oldServer: true, dataLossAfter: 1000 }
		});
		await page.goto(`${farm.url}logs/?status=assigned`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		await rows(page).first().click();
		await expect(viewer(page)).toContainText('cannot show logs of builds in progress');
	});

	test('a builder that left the farm', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 } });
		await page.goto(`${farm.url}logs/?drv=${HELLO}&on=10.9.9.9:50051`);
		await expect(viewer(page)).toContainText(
			'10.9.9.9:50051 left the farm, and its logs went with it.'
		);
		await expect(viewer(page)).not.toContainText('keeps no log');
	});

	test('a misrouted answer is retried', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { misroute: 2 } });
		await openLog(page, farm);
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 15_000 });
		expect(farm.logCalls).toHaveLength(3);
		await expect(viewer(page)).not.toContainText('keeps no log');
	});

	test("a retry's log is not shown as the failed build's", async ({ page, fakeFarm }) => {
		// The builder builds the derivation again, so the failed build's log is gone.
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { rebuilding: 7 } });
		await page.goto(`${farm.url}logs/?status=failed`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		// The list folds once a build is open, so read the link first.
		const on = (await rows(page).first().getAttribute('href'))!;
		await rows(page).first().click();
		const worker = new URL(on, page.url()).searchParams.get('on')!;
		await expect(viewer(page)).toContainText(
			`${worker} is building this again, and that build replaced this log.`
		);
		await expect(viewer(page).getByRole('button', { name: 'Follow the new build' })).toBeVisible();
		expect(farm.logCalls[0].assignId).toBeGreaterThan(0);
	});

	test('a log a later build wrote says so over the log', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { keptBy: 99 } });
		await page.goto(`${farm.url}logs/?status=failed`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		await rows(page).first().click();
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await expect(viewer(page).locator('.caption', { hasText: 'built this again' })).toHaveText(
			/ built this again at \d+:\d\d( [AP]M)?\. This is the log of that\s+build\.$/
		);
	});

	test('a large log loads head and tail', async ({ page, fakeFarm }) => {
		test.setTimeout(120_000);
		const KERNEL = `${'k'.repeat(32)}-linux-6.12.21.drv`;
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3, logsize: 6 } });
		await openLog(page, farm, KERNEL);
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 90_000 });
		expect(farm.logCalls.map((c) => [c.offset, c.limit, c.tail])).toEqual([
			[0, 16 * 1024 * 1024, 0],
			[16 * 1024 * 1024, 0, 48 * 1024 * 1024]
		]);
		await viewer(page).getByRole('button', { name: 'Expand all' }).click();
		await expect(viewer(page).locator('.row.gap')).toHaveCount(0);
		await viewer(page).focus();
		await page.keyboard.press('End');
		const status = (await viewer(page).locator('.status').textContent())!;
		const count = Number(/([\d,]+) lines/.exec(status)![1].replace(/,/g, ''));
		expect(count).toBeGreaterThan(4_000_000);
		await expect
			.poll(async () =>
				Math.max(...(await viewer(page).locator('.gutter a').allTextContents()).map(Number))
			)
			.toBe(count);
	});

	test('a large failed log shows its end first, and the head goes in above it', async ({
		page,
		fakeFarm
	}) => {
		test.setTimeout(120_000);
		const KERNEL = `${'k'.repeat(32)}-linux-6.12.21.drv`;
		const farm = await fakeFarm({
			...ANONYMOUS,
			mock: { builders: 3, logsize: 6 },
			logs: { failed: [KERNEL] }
		});
		await openLog(page, farm, KERNEL);
		// The first frame with an error line in view: the log's end is in, its head not yet.
		const first = await page.waitForFunction(
			() => {
				const v = document.querySelector('section.viewer');
				const s = v?.querySelector('.scroller');
				if (!v || !s) return null;
				const box = s.getBoundingClientRect();
				const shown = (el: Element) => {
					const r = el.getBoundingClientRect();
					return r.bottom > box.top + 1 && r.top < box.bottom - 1;
				};
				if (![...v.querySelectorAll('.scroller .row.error')].some(shown)) return null;
				const nums = [...v.querySelectorAll('.scroller .gutter a')]
					.filter(shown)
					.map((a) => Number(a.textContent));
				return { status: v.querySelector('.status')?.textContent ?? '', top: Math.min(...nums) };
			},
			null,
			{ polling: 'raf', timeout: 90_000 }
		);
		const at = (await first.jsonValue())!;
		expect(at.status).toContain('loading');
		expect(at.status).toContain('48 MiB');
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 60_000 });
		await expect(viewer(page).locator('.status')).toContainText('64 MiB');
		// The head went in above, and the view stayed on the same lines.
		const top = Math.min(
			...(await viewer(page)
				.locator('.scroller .gutter a')
				.evaluateAll((as) => {
					const box = as[0].closest('.scroller')!.getBoundingClientRect();
					return as
						.filter((a) => {
							const r = a.getBoundingClientRect();
							return r.bottom > box.top + 1 && r.top < box.bottom - 1;
						})
						.map((a) => Number(a.textContent));
				}))
		);
		expect(Math.abs(top - at.top)).toBeLessThanOrEqual(1);
		await expect(viewer(page).locator('.scroller .row.error').first()).toBeInViewport();
		// At the top: the head's phases, folded, then the gap row.
		await viewer(page).focus();
		await page.keyboard.press('Home');
		await expect(viewer(page).getByRole('button', { name: /^configurePhase, / })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		await expect(viewer(page).locator('.row.gap')).toContainText('not shown (lines 288,');
	});

	test('e and E step from the error in view once the head goes in above it', async ({
		page,
		fakeFarm
	}) => {
		test.setTimeout(120_000);
		const KERNEL = `${'k'.repeat(32)}-linux-6.12.21.drv`;
		// About 80 MB: two errors in the head's first lines, two in the tail's last.
		const fill = (from: number, n: number) =>
			Array.from(
				{ length: n },
				(_, i) => `  CC      drivers/misc/part${from + i}.o ${'x'.repeat(60)}`
			);
		const lines = [
			'Running phase: buildPhase',
			'src/head.c:1:1: error: head one',
			...fill(0, 10),
			'src/head.c:2:1: error: head two',
			...fill(10, 830_000),
			'src/tail.c:1:1: error: tail one',
			...fill(900_000, 10),
			'src/tail.c:2:1: error: tail two',
			...fill(910_000, 50)
		];
		const farm = await fakeFarm({
			...ANONYMOUS,
			mock: { builders: 3 },
			logs: { failed: [KERNEL], text: lines.join('\n') + '\n' }
		});
		await openLog(page, farm, KERNEL);
		const line = (text: string) => viewer(page).locator('.scroller .row', { hasText: text });
		await expect(line('tail one')).toBeInViewport({ timeout: 60_000 });
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 60_000 });
		// Kept: the head and the tail, with a gap between.
		await expect(viewer(page).locator('.status')).toContainText('64 MiB');
		// The head's errors went in before the tail's, and e goes on from the one in view.
		// Each step asks the log worker, which holds all 80 MB, so it gets more than 5 s.
		const shown = { timeout: 15_000 };
		await viewer(page).focus();
		await page.keyboard.press('e');
		await expect(line('tail two')).toBeInViewport(shown);
		await page.keyboard.press('E');
		await expect(line('tail one')).toBeInViewport(shown);
		await page.keyboard.press('E');
		await expect(line('head two')).toBeInViewport(shown);
	});

	test('Download of a large log is the zstd stream', async ({ page, fakeFarm }) => {
		test.setTimeout(120_000);
		const KERNEL = `${'k'.repeat(32)}-linux-6.12.21.drv`;
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3, logsize: 6 } });
		await openLog(page, farm, KERNEL);
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 90_000 });
		await viewer(page).getByRole('button', { name: 'Raw log' }).click();
		const dl = page.waitForEvent('download', { timeout: 60_000 });
		await viewer(page).getByRole('menuitem', { name: 'Save log' }).click();
		const file = await dl;
		expect(file.suggestedFilename()).toBe(`${KERNEL.replace(/\.drv$/, '')}.log.zst`);
		// One more call, from the start with no limit; the viewer's own two stay as they were.
		expect(farm.logCalls.map((c) => [c.offset, c.limit, c.tail])).toEqual([
			[0, 16 * 1024 * 1024, 0],
			[16 * 1024 * 1024, 0, 48 * 1024 * 1024],
			[0, 0, 0]
		]);
		const { readFileSync } = await import('node:fs');
		const { zstdDecompressSync } = await import('node:zlib');
		const got = zstdDecompressSync(readFileSync((await file.path())!));
		const want = await farm.logBytes(KERNEL);
		expect(got.length).toBe(want.length);
		expect(got.length).toBeGreaterThan(250 * 1024 * 1024);
		expect(Buffer.compare(got, Buffer.from(want))).toBe(0);
	});

	test('a log between 16 and 64 MiB loads whole in two calls', async ({ page, fakeFarm }) => {
		test.setTimeout(90_000);
		const KERNEL = `${'k'.repeat(32)}-linux-6.12.21.drv`;
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3, logsize: 1 } });
		await openLog(page, farm, KERNEL);
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 60_000 });
		const MiB = 1024 * 1024;
		expect(farm.logCalls.map((c) => [c.limit, c.tail])).toEqual([
			[16 * MiB, 0],
			[0, 0]
		]);
		// The second call starts where the head's last whole line ends: no byte twice, no gap.
		expect(farm.logCalls[0].offset).toBe(0);
		expect(farm.logCalls[1].offset).toBeGreaterThan(15 * MiB);
		expect(farm.logCalls[1].offset).toBeLessThanOrEqual(16 * MiB);
		await expect(viewer(page).locator('.row.gap')).toHaveCount(0);
		const status = (await viewer(page).locator('.status').textContent())!;
		const count = Number(/([\d,]+) lines/.exec(status)![1].replace(/,/g, ''));
		expect(count).toBeGreaterThan(700_000);
		await expect(viewer(page).locator('div.visually-hidden[aria-live="polite"]')).toHaveText(
			`Log loaded, ${count.toLocaleString('en-US')} lines`
		);
		await viewer(page).getByRole('button', { name: 'Expand all' }).click();
		await viewer(page).focus();
		// Expand all may still be counting rows, so press End again until the view is at the end.
		await expect
			.poll(async () => {
				await page.keyboard.press('End');
				const nums = await viewer(page).locator('.gutter a').allTextContents();
				return Math.max(...nums.map((t) => Number(t.replace(/,/g, '')) || 0));
			})
			.toBe(count);
		// Halfway down the scrollbar, the numbers are about half the count.
		await viewer(page)
			.locator('.scroller')
			.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
		await expect
			.poll(async () => {
				const nums = await viewer(page).locator('.gutter a').allTextContents();
				const n = Math.max(...nums.map((t) => Number(t.replace(/,/g, '')) || 0));
				return Math.abs(n / count - 0.5) < 0.05;
			})
			.toBe(true);
	});

	test("the list loads the scheduler's history", async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3, history: 300 } });
		await page.goto(`${farm.url}logs/`);
		await expect(pill(page)).toHaveText('Live');
		await expect(page.locator('.build-list .foot')).toContainText(
			/kept by the scheduler|The scheduler keeps/
		);
		expect(farm.historyCalls.map((c) => c.failedOnly).sort()).toEqual([false, true]);
		await page
			.getByRole('navigation', { name: 'Views' })
			.getByRole('link', { name: 'Overview' })
			.click();
		await page
			.getByRole('navigation', { name: 'Views' })
			.getByRole('link', { name: 'Logs' })
			.click();
		await expect(rows(page).first()).toBeVisible();
		expect(farm.historyCalls).toHaveLength(2);
	});

	test("a search that finds no build links to the farm's log search", async ({
		page,
		fakeFarm
	}) => {
		const farm = await fakeFarm({
			mock: { builders: 3 },
			dashboardJson: {
				name: 'Test farm',
				auth: 'anonymous',
				logSearchUrl: 'https://logs.example.com/search'
			}
		});
		await page.goto(`${farm.url}logs/`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		const search = page.getByRole('searchbox', { name: 'Search builds by name or hash' });
		await search.fill('no-such-build-anywhere');
		await expect(page.locator('.build-list')).toContainText('No builds match.');
		const link = page.getByRole('link', { name: 'Search every build log' });
		await expect(link).toHaveAttribute('href', 'https://logs.example.com/search');
		await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
		// With nothing typed, there is no link.
		await search.fill('');
		await expect(link).toHaveCount(0);
	});

	test('without a log search the empty search says nothing more', async ({ page, fakeFarm }) => {
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 } });
		await page.goto(`${farm.url}logs/`);
		await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
		await page
			.getByRole('searchbox', { name: 'Search builds by name or hash' })
			.fill('no-such-build-anywhere');
		await expect(page.locator('.build-list')).toContainText('No builds match.');
		await expect(page.getByRole('link', { name: 'Search every build log' })).toHaveCount(0);
	});

	test('log text never becomes markup', async ({ page, fakeFarm }) => {
		const text = [
			'<img src=x onerror=alert(1)>',
			'\x1b]8;;javascript:alert(1)\x1b\\click me\x1b]8;;\x1b\\',
			'abc‮def',
			'see https://example.org/x.'
		].join('\n');
		const farm = await fakeFarm({ ...ANONYMOUS, mock: { builders: 3 }, logs: { text } });
		await openLog(page, farm);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const log = viewer(page).locator('.scroller');
		await expect(log).toContainText('<img src=x onerror=alert(1)>');
		await expect(log).toContainText('click me');
		await expect(log).toContainText('⟨U+202E⟩');
		await expect(log.locator('img')).toHaveCount(0);
		await expect(log.locator('a[href^="javascript:"]')).toHaveCount(0);
		await expect(log.locator('a[href="https://example.org/x"]')).toHaveAttribute(
			'rel',
			'noopener noreferrer'
		);
	});
});
