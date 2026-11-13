import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { sleep, type FakeFarm, type FakeFarmOptions } from './fake-farm.ts';
import {
	ANONYMOUS,
	builderIds,
	demo,
	expect,
	node,
	openFarm,
	panel,
	pill,
	poolToggle,
	test
} from './fixtures.ts';

// Screenshots of every phase, state and panel, light and dark, at two sizes,
// for visual review. Run on demand:
//   SHOTS=1 SHOTS_DIR=/some/dir npx playwright test --project shots

const dir = process.env.SHOTS_DIR ?? 'test-results/shots';
mkdirSync(dir, { recursive: true });

const SIZES = [
	{ name: '1440', width: 1440, height: 900 },
	{ name: '1024', width: 1024, height: 768 }
];

type Farm = (o?: FakeFarmOptions) => Promise<FakeFarm>;
type Scenario = (page: Page, farm: Farm) => Promise<void>;

const settle = (page: Page, ms = 600) => page.waitForTimeout(ms);

const scenarios: Record<string, Scenario> = {
	// The landing, since no farm serves the dev server.
	start: async (page) => {
		await page.goto('./');
		await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
	},
	'farm-error': async (page, farm) => {
		await page.goto((await farm({ dashboardJson: { name: 'Test farm' } })).url);
		await expect(page.getByRole('alert')).toBeVisible();
	},
	'signed-out': async (page, farm) => {
		const f = await farm();
		f.watch = (call) => call.reply(401, {}, 'Unauthorized');
		await openFarm(page, f);
		await expect(page.getByText('Signed out of Test farm')).toBeVisible();
	},
	// While dashboard.json loads.
	loading: async (page, farm) => {
		const f = await farm();
		await page.route(
			(url) => url.pathname === '/dashboard.json',
			() => {}
		);
		await page.goto(f.url);
		await expect(page.locator('.loading .spinner')).toBeVisible();
	},
	demo: async (page) => {
		await demo(page);
		await settle(page, 1500);
	},
	demo50: async (page) => {
		// 50 cards in several columns: both groups would start as pools.
		await demo(page, 'builders=50');
		for (const system of ['x86_64-linux', 'aarch64-linux']) await poolToggle(page, system).click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(50);
		await settle(page, 1500);
	},
	pools300: async (page) => {
		await demo(page, 'builders=300');
		await settle(page, 1500);
	},
	pools1000: async (page) => {
		await demo(page, 'builders=1000&systems=x86_64-linux,aarch64-linux,aarch64-darwin');
		await settle(page, 2000);
	},
	'pools-mixed': async (page) => {
		// 27 x86_64-linux builders stay a pool, 13 aarch64-linux ones show as cards.
		await demo(page, 'builders=40');
		await poolToggle(page, 'aarch64-linux').click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(13);
		await settle(page, 1500);
	},
	'panel-pool': async (page) => {
		await demo(page, 'builders=300&churn=30');
		// Click the summary at the top, since a click on a cell opens that builder instead.
		await node(page, 'pool:x86_64-linux').click({ position: { x: 40, y: 16 } });
		await expect(panel(page).getByRole('list', { name: 'Builders in this pool' })).toBeVisible();
		await settle(page);
	},
	'panel-builder': async (page) => {
		await demo(page);
		await node(page, (await builderIds(page))[0]).click();
		await settle(page);
	},
	'panel-drv': async (page) => {
		await demo(page);
		await node(page, (await builderIds(page))[0]).click();
		await panel(page)
			.getByRole('list', { name: 'Derivations on this builder' })
			.getByRole('button')
			.first()
			.click();
		await settle(page);
	},
	'panel-drv-built': async (page) => {
		await demo(page);
		await node(page, (await builderIds(page))[0]).click();
		const row = panel(page)
			.getByRole('list', { name: 'Derivations on this builder' })
			.getByRole('button')
			.filter({ hasText: 'Built' })
			.first();
		await expect(row).toBeVisible({ timeout: 20_000 });
		await row.click();
		await settle(page);
	},
	'panel-drv-cached': async (page) => {
		await demo(page);
		await node(page, 'cache').click();
		const row = panel(page)
			.getByRole('list', { name: 'Recent cache activity' })
			.getByRole('button')
			.filter({ hasText: 'Cached' })
			.first();
		await expect(row).toBeVisible({ timeout: 20_000 });
		await row.click();
		await settle(page);
	},
	'builder-offline': async (page) => {
		// Faster time, so a builder goes offline within a few seconds.
		await demo(page, 'speed=20');
		const offline = page.locator('button.farm-node.builder.offline').first();
		await expect(offline).toBeVisible({ timeout: 30_000 });
		await offline.click();
		await settle(page);
	},
	'panel-scheduler': async (page) => {
		await demo(page);
		await node(page, 'scheduler').click();
		await settle(page);
	},
	'panel-cache': async (page) => {
		await demo(page);
		await node(page, 'cache').click();
		await settle(page);
	},
	'panel-clients': async (page) => {
		await demo(page);
		await page.locator('[data-node-button^="clients:"]').first().click();
		await settle(page);
	},
	'panel-other': async (page) => {
		await demo(page, 'builders=30');
		await node(page, 'clients:__other').click();
		await settle(page);
	},
	upstream: async (page) => {
		await demo(page, 'builders=12&upstream=3');
		await settle(page, 2500);
	},
	'panel-upstream': async (page) => {
		await demo(page, 'builders=30&upstream=3');
		await node(page, 'upstream').click();
		await settle(page, 1500);
	},
	'builder-lowdisk': async (page) => {
		await demo(page, 'builders=6&lowdisk=1&upstream=3');
		await page.locator('[data-node-button^="worker:"]').filter({ hasText: 'Low disk' }).click();
		await settle(page);
	},
	'panel-drv-failed': async (page) => {
		await demo(page, 'builders=6&fail=0&failing=1&upstream=3');
		await node(page, 'worker:10.0.0.10:50051').click();
		const rows = panel(page).getByRole('list', { name: 'Derivations on this builder' });
		await rows.getByRole('button').first().focus();
		await page.keyboard.press('End');
		const focused = rows.locator('button:focus');
		for (let i = 0; i < 40; i++) {
			if (/Build failed · /.test((await focused.textContent()) ?? '')) break;
			await page.keyboard.press('ArrowUp');
		}
		await page.keyboard.press('Enter');
		await expect(panel(page).locator('pre.p-log')).toBeVisible();
		await settle(page);
	},
	'gap-retrying': async (page) => {
		await demo(page, 'gaps=3');
		await expect(pill(page)).toContainText('Reconnecting', { timeout: 10_000 });
	},
	syncing: async (page, farm) => {
		const f = await farm(ANONYMOUS);
		f.watch = async (call) => {
			// Only the start of a snapshot, then nothing.
			f.mock.advance(Date.now(), true);
			call.send(f.mock.snapshot().slice(0, 1));
			await call.hold();
		};
		await openFarm(page, f);
		await expect(page.getByText('Waiting for the farm')).toBeVisible();
	},
	unreachable: async (page, farm) => {
		const f = await farm(ANONYMOUS);
		f.watch = (call) => call.fail(14, 'no healthy upstream');
		await openFarm(page, f);
		await expect(page.getByText("Can't reach the farm")).toBeVisible();
	},
	busy: async (page, farm) => {
		const f = await farm(ANONYMOUS);
		f.watch = (call) => call.reply(503, { 'x-envoy-overloaded': 'true' }, 'overflow');
		await openFarm(page, f);
		await expect(page.getByRole('heading', { name: 'The farm is busy' })).toBeVisible();
	},
	refused: async (page, farm) => {
		const f = await farm(ANONYMOUS);
		f.watch = (call) => call.reply(403, {}, 'Invalid origin');
		await openFarm(page, f);
		await expect(page.getByText(/refused this page \(Invalid origin\)/)).toBeVisible();
	},
	'refused-at-connect': async (page, farm) => {
		const f = await farm();
		f.watch = (call) => call.fail(16, 'caller not trusted');
		await openFarm(page, f);
		await expect(page.getByText(/does not accept the viewers its balancer names/)).toBeVisible();
	},
	'signed-out-stale': async (page, farm) => {
		const f = await farm({ mock: { builders: 4 }, signOutUrl: '/sign-out' });
		let n = 0;
		f.watch = async (call) => {
			if (n++ > 0) return call.reply(401, {}, 'Unauthorized');
			f.mock.advance(Date.now(), true);
			call.send(f.mock.snapshot());
			await sleep(1000);
			call.end(14, 'upstream reset');
		};
		await openFarm(page, f);
		await expect(page.getByText('Signed out. Showing the last known state.')).toBeVisible();
	},
	'sign-out': async (page, farm) => {
		await openFarm(page, await farm({ mock: { builders: 4 }, signOutUrl: '/sign-out' }));
		await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();
	},
	denied: async (page, farm) => {
		const f = await farm({ signOutUrl: '/sign-out' });
		f.watch = (call) => call.fail(7, 'role watch required');
		await openFarm(page, f);
		await expect(page.getByText('No access to this farm')).toBeVisible();
	},
	'denied-anonymous': async (page, farm) => {
		const f = await farm(ANONYMOUS);
		f.watch = (call) => call.fail(7, "no access rule matches 'dashboard-anon-127.0.0.1'");
		await openFarm(page, f);
		await expect(page.getByText('No access to this farm')).toBeVisible();
	},
	empty: async (page, farm) => {
		const f = await farm({ ...ANONYMOUS, mock: { builders: 1 } });
		f.watch = async (call) => {
			const [reset] = f.mock.snapshot();
			if (reset.event.case === 'reset') reset.event.value.cacheUrl = '';
			const done = f.mock.snapshot().find((e) => e.event.case === 'snapshotDone')!;
			done.seq = reset.seq;
			call.send([reset, done]);
			await call.hold();
		};
		await openFarm(page, f);
		await expect(page.getByText('No builders connected')).toBeVisible();
	},
	// The Logs tab: a failed build, folded down to its failed phase.
	'logs-failed': async (page) => {
		await page.goto('./logs/?demo&builders=12&speed=4&upstream=0&status=failed');
		await page
			.locator('.build-list a.item')
			.filter({ hasText: /Build failed · (src|FAIL)/ })
			.first()
			.click();
		await expect(page.locator('section.viewer .status')).toContainText('loaded');
		await settle(page, 1000);
	},
	// A running build, followed.
	'logs-following': async (page) => {
		await page.goto('./logs/?demo&builders=12&speed=0.5&upstream=0&status=assigned&sort=newest');
		await page
			.locator('.build-list a.item')
			.filter({ hasText: /(build|configure)Phase · / })
			.first()
			.click();
		await expect(
			page.locator('section.viewer').getByRole('checkbox', { name: 'Follow' })
		).toBeChecked();
		// Shoot once the builder's report has caught up with the log's open phase.
		await expect(
			page.locator('section.viewer button.head .now').filter({ hasText: 'elapsed' }).first()
		).toBeVisible({ timeout: 20_000 });
		await settle(page, 500);
	},
	// A failed NixOS test, at its error with the failed subtest's header stuck at the top.
	'logs-nixos-test': async (page) => {
		await page.goto('./logs/?demo&builders=12&speed=4&upstream=0&status=failed&q=vm-test');
		await page
			.locator('.build-list a.item')
			.filter({ hasText: /!!! Test/ })
			.first()
			.click();
		await expect(page.locator('section.viewer .status')).toContainText('loaded');
		await settle(page, 1000);
	}
};

for (const size of SIZES) {
	for (const [name, setup] of Object.entries(scenarios)) {
		test(`${name} ${size.name}`, async ({ page, fakeFarm }) => {
			await page.setViewportSize(size);
			await page.emulateMedia({ colorScheme: 'light' });
			await setup(page, fakeFarm);
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme });
				await page.waitForTimeout(250);
				await page.screenshot({ path: join(dir, `${name}-${size.name}-${scheme}.png`) });
			}
		});
	}
}
