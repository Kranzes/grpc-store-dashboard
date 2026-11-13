import type { Page } from '@playwright/test';
import {
	builderIds,
	demo,
	expect,
	lineReport,
	node,
	panel,
	pointOn,
	poolToggle,
	test,
	viewSettled,
	zoomOf,
	type ProbeWindow
} from './fixtures.ts';

// The map's smaller behaviors: clicks, keys, card text and pool cards.

test.describe('clicks and keys', () => {
	test('Escape logs no shortcut warning', async ({ page }) => {
		const warnings: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
		});
		await demo(page);
		await page.locator('[data-node-button^="worker:"]').first().click();
		await expect(panel(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await page.keyboard.press('Escape');
		expect(warnings.filter((w) => w.includes('Trigger'))).toEqual([]);
	});

	test('a double click opens a panel and leaves it open', async ({ page }) => {
		await demo(page);
		const card = page.locator('[data-node-button^="worker:"]').first();
		await card.dblclick();
		await expect(panel(page)).toBeVisible();
		await expect(card).toHaveAttribute('aria-expanded', 'true');
		// A single click on the open node still closes it.
		await page.waitForTimeout(400);
		await card.click();
		await expect(panel(page)).toBeHidden();
	});

	test('a double click on a pool cell leaves its builder open', async ({ page }) => {
		await demo(page, 'builders=60');
		const cell = node(page, 'pool:x86_64-linux').locator('[data-addr]').nth(3);
		const addr = await cell.getAttribute('data-addr');
		await cell.dblclick();
		await expect(page.locator('#panel-title')).toHaveText(addr ?? '');
	});

	test('+, - and 0 zoom and fit the map, but not while typing', async ({ page }) => {
		await demo(page, 'builders=60');
		await viewSettled(page);
		const fit = await zoomOf(page);
		await page.keyboard.press('+');
		await expect.poll(() => zoomOf(page)).toBeGreaterThan(fit * 1.1);
		await viewSettled(page);
		const zoomed = await zoomOf(page);
		await page.keyboard.press('-');
		await expect.poll(() => zoomOf(page)).toBeLessThan(zoomed * 0.9);
		await page.keyboard.press('=');
		await page.keyboard.press('=');
		await viewSettled(page);
		await page.keyboard.press('0');
		await expect.poll(() => zoomOf(page)).toBeCloseTo(fit, 2);
		await expect(page.getByRole('button', { name: 'Zoom in' })).toHaveAttribute(
			'title',
			'Zoom in (+)'
		);

		// In the pool panel's search box the keys type.
		await node(page, 'pool:x86_64-linux').click({ position: { x: 40, y: 16 } });
		const search = panel(page).getByRole('searchbox', { name: /Search builders/ });
		await viewSettled(page);
		const before = await zoomOf(page);
		await search.focus();
		await page.keyboard.type('+-0');
		await expect(search).toHaveValue('+-0');
		await page.waitForTimeout(400);
		expect(await zoomOf(page)).toBe(before);
	});

	test('a press on the map while the fit animates still ends fitted', async ({ page }) => {
		await demo(page, 'builders=60');
		await viewSettled(page);
		const fit = await zoomOf(page);
		await page.keyboard.press('+');
		await page.keyboard.press('+');
		await viewSettled(page);
		expect(await zoomOf(page)).toBeGreaterThan(fit * 1.1);
		// A press 100 ms into the fit's 300 ms animation stops it, and is no pan.
		// It lands on the empty map, clear of the lines, since a card or a line
		// would open a panel, and the fit would then be for the narrower map.
		const spot = await page.evaluate(() => {
			const probe = (window as unknown as ProbeWindow).__lines;
			const track: { x: number; y: number }[] = [];
			for (const l of probe.report())
				for (let s = 0; s <= (probe.length(l.id) ?? 0); s += 8) {
					const p = probe.client(l.id, s);
					if (p) track.push(p);
				}
			const pane = document.querySelector('.svelte-flow__pane')!.getBoundingClientRect();
			for (let y = pane.top + 40; y < pane.bottom - 140; y += 20)
				for (let x = pane.left + 60; x < pane.right - 60; x += 20)
					if (
						document.elementFromPoint(x, y)?.classList.contains('svelte-flow__pane') &&
						track.every((p) => Math.hypot(p.x - x, p.y - y) > 30)
					)
						return { x, y };
			return null;
		});
		expect(spot).not.toBeNull();
		await page.mouse.move(spot!.x, spot!.y);
		await page.keyboard.press('0');
		await page.waitForTimeout(100);
		await page.mouse.down();
		await page.mouse.up();
		await viewSettled(page);
		await expect(panel(page)).toBeHidden();
		expect(await zoomOf(page)).toBeCloseTo(fit, 2);
		await expect(page.getByRole('button', { name: 'Fit the whole farm' })).toHaveClass(/dim/);
	});
});

test.describe('cards', () => {
	test('a card names its features, not the system its heading names', async ({ page }) => {
		await demo(page);
		const subs = await page
			.locator('[data-node-button^="worker:"] .sub')
			.evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
		expect(subs.length).toBeGreaterThan(0);
		for (const s of subs) expect(s).not.toMatch(/^(x86_64|aarch64|i686|riscv64)-/);
		// A builder with a second system says so last.
		expect(subs.some((s) => / \+1 system$|^\+1 system$/.test(s))).toBe(true);
	});

	test('a pool card leaves joins and leaves to its panel', async ({ page }) => {
		await demo(page, 'builders=60');
		const pool = node(page, 'pool:x86_64-linux');
		await expect(pool).toBeVisible();
		await expect(pool).not.toContainText('joined');
		await expect(pool).not.toContainText('left');
		await pool.click({ position: { x: 40, y: 16 } });
		await expect(panel(page).getByText('Joined', { exact: true })).toBeVisible();
		await expect(panel(page).getByText('Left', { exact: true })).toBeVisible();
	});

	test('the group heading names its system as large as the card titles', async ({ page }) => {
		await demo(page);
		const size = (sel: string) =>
			page
				.locator(sel)
				.first()
				.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		const heading = await size('[data-pool-toggle] .mono');
		expect(heading).toBe(13);
		expect(heading).toBeGreaterThanOrEqual(await size('[data-node-button^="worker:"] .title'));
		expect(await size('[data-pool-toggle] .count')).toBe(12);
		await expect(poolToggle(page, 'x86_64-linux')).toBeVisible();
	});
});

test.describe('failure outliers', () => {
	test('only the two failing builders say how much failed', async ({ page }) => {
		await demo(page, 'fail=0.2&failing=2');
		const badges = page.locator('[data-node-button^="worker:"] .badge.fail');
		await expect(badges).toHaveCount(2, { timeout: 30_000 });
		for (const b of await badges.all()) await expect(b).toHaveText(/^\d+% failed$/);
		// Part of the card's button, so its name says it.
		const card = page
			.locator('[data-node-button^="worker:"]', { has: page.locator('.badge.fail') })
			.first();
		await expect(card).toHaveAccessibleName(/\d+% failed/);
		// Client groups wait on many builders, so none stands out here.
		await expect(page.locator('[data-node-button^="clients:"] .badge.fail')).toHaveCount(0);
		// A steady share keeps the same two.
		await page.waitForTimeout(3000);
		await expect(badges).toHaveCount(2);
	});

	test('beside a state badge, the failure badge shows only the share', async ({ page }) => {
		// With this seed and speed, one of the three failing builders stops within about 20 s.
		await demo(page, 'builders=12&fail=0.2&failing=3&speed=20&seed=3');
		const cards = page.locator('[data-node-button^="worker:"]');
		const stated = cards.filter({ has: page.locator('.badge:not(.fail)') });
		const short = stated.locator('.badge.fail').first();
		await expect(short).toBeVisible({ timeout: 40_000 });
		// "failed" is there for screen readers only.
		const shown = await short.evaluate((e) =>
			[...e.childNodes].map((n) => (n instanceof HTMLElement ? '' : n.textContent)).join('')
		);
		expect(shown.trim()).toMatch(/^\d+%$/);
		await expect(short.locator('.visually-hidden')).toHaveText('failed');
		await expect(short).toHaveAttribute('title', /^\d+% of the builds that ended here failed/);
		const card = stated.filter({ has: page.locator('.badge.fail') }).first();
		// A builder that went offline says for how long: "Offline for 12 seconds 80% failed".
		await expect(card).toHaveAccessibleName(
			/(Draining|Low disk|Stopping|Offline( for [\w ]+?)?) \d+% failed/
		);
		// It leaves room for most of the address: 8 of "10.0.0.10:50051" beside Stopping.
		const title = card.locator('.title');
		expect(await title.evaluate((e) => e.clientWidth / e.scrollWidth)).toBeGreaterThan(0.6);
		// The other failing builders keep the whole word.
		const long = cards
			.filter({ hasNot: page.locator('.badge:not(.fail)') })
			.locator('.badge.fail')
			.first();
		await expect(long).toHaveText(/^\d+% failed$/);
	});

	// outliers.test.ts checks the rule over a seeded simulation, churn included;
	// this checks the default demo, the farm a viewer sees first.
	test("builders at the farm's rate show no badge", async ({ page }) => {
		await demo(page);
		const badges = page.locator('.badge.fail');
		// Long enough for every line to finish well over 10 builds.
		for (let i = 0; i < 24; i++) {
			expect(await badges.count()).toBe(0);
			await page.waitForTimeout(500);
		}
	});

	test('a pool counts its failing builders on its head row', async ({ page }) => {
		await demo(page, 'builders=60&fail=0.2&failing=2');
		const badges = page.locator('[data-node-button^="pool:"] .badge.fail');
		await expect(badges.first()).toBeVisible({ timeout: 30_000 });
		await expect
			.poll(async () => {
				let n = 0;
				for (const t of await badges.allTextContents()) n += parseInt(t);
				return n;
			})
			.toBe(2);
		for (const t of await badges.allTextContents()) expect(t.trim()).toMatch(/^\d+ failing$/);
		// The sentence itself is outliers.test.ts's to check.
		await expect(badges.first()).toHaveAttribute('title', /^Builders failing /);
	});
});

test.describe('hover lights lines', () => {
	/** Every drawn line's fade, by id. */
	const fades = async (page: Page) =>
		new Map((await lineReport(page)).map((l) => [l.id, l.fade] as const));

	test('a hovered line and its bundle stay bright while the rest fade lightly', async ({
		page
	}) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		await viewSettled(page);
		// The builder's own stretch: only its line.
		await expect(async () => {
			const p = await pointOn(page, `assign:${addr}`, -20);
			await page.mouse.move(p.x, p.y - 1);
			await page.mouse.move(p.x, p.y);
			await expect(page.locator('.line-readout')).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect
			.poll(async () => {
				const f = await fades(page);
				const others = [...f].filter(([k]) => k !== `assign:${addr}`).map(([, v]) => v);
				return [f.get(`assign:${addr}`), Math.max(...others)];
			})
			.toEqual([1, 0.45]);
		// The stub out of the scheduler, before the lines spread onto their
		// tracks: every assignment line.
		await expect(async () => {
			const p = await pointOn(page, `assign:${addr}`, 20);
			await page.mouse.move(p.x, p.y - 1);
			await page.mouse.move(p.x, p.y);
			await expect(page.locator('.line-readout')).toContainText('Assignments to 12 builders', {
				timeout: 1000
			});
		}).toPass();
		await expect
			.poll(async () => {
				const f = await fades(page);
				return [...f].every(([k, v]) => (k.startsWith('assign:') ? v === 1 : v === 0.45));
			})
			.toBe(true);
		// The first group's track, past the spread: that group's lines only.
		let group = 0;
		await expect(async () => {
			const p = await pointOn(page, `assign:${addr}`, 60);
			await page.mouse.move(p.x, p.y - 1);
			await page.mouse.move(p.x, p.y);
			const text = await page.locator('.line-readout').textContent({ timeout: 1000 });
			group = Number(/Assignments to (\d+) builders/.exec(text ?? '')?.[1]);
			expect(group).toBeGreaterThan(1);
			expect(group).toBeLessThan(12);
		}).toPass();
		await expect
			.poll(async () => {
				const f = await fades(page);
				const bright = [...f].filter(([k, v]) => k.startsWith('assign:') && v === 1);
				return [bright.length, bright.some(([k]) => k === `assign:${addr}`)];
			})
			.toEqual([group, true]);
		// Off the line, everything is bright again; no card changed.
		await node(page, id).hover();
		await expect
			.poll(async () => [...(await fades(page)).values()].every((v) => v === 1))
			.toBe(true);
		await expect(page.locator('.farm-map')).not.toHaveClass(/focusing/);
	});

	test('a quick sweep across the map lights nothing, a rest does', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		await viewSettled(page);
		await page.evaluate(() => {
			const w = window as unknown as ProbeWindow & { __minFade: number; __sampling: boolean };
			w.__minFade = 1;
			w.__sampling = true;
			const tick = () => {
				for (const l of w.__lines.report()) w.__minFade = Math.min(w.__minFade, l.fade);
				if (w.__sampling) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		const box = (await page.locator('.farm-map').boundingBox())!;
		const { x, y, width: w, height: h } = box;
		await page.mouse.move(x + 10, y + 10);
		await page.mouse.move(x + w - 10, y + h - 10, { steps: 30 });
		await page.mouse.move(x + 10, y + h / 2, { steps: 15 });
		await page.mouse.move(x + w - 10, y + h / 2, { steps: 15 });
		await page.waitForTimeout(300);
		const min = await page.evaluate(() => {
			const w = window as unknown as { __minFade: number; __sampling: boolean };
			w.__sampling = false;
			return w.__minFade;
		});
		expect(min).toBe(1);
		// Resting on the builder's own stretch lights it after the wait.
		await expect(async () => {
			const p = await pointOn(page, `assign:${addr}`, -20);
			await page.mouse.move(p.x, p.y - 1);
			await page.mouse.move(p.x, p.y);
			await expect(page.locator('.line-readout')).toBeVisible({ timeout: 1000 });
		}).toPass();
		await expect
			.poll(async () => {
				const f = await fades(page);
				return f.get(`assign:${addr}`) === 1 && [...f.values()].some((v) => v === 0.45);
			})
			.toBe(true);
	});

	test('a click focus wins over a hover', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		await node(page, id).click();
		await expect(panel(page)).toBeVisible();
		await page.locator('.legend li', { hasText: 'Publishes' }).hover();
		await page.waitForTimeout(400);
		const f = await fades(page);
		// Focus fades to 0.2; the hover's 0.45 never shows.
		expect([...f.values()].some((v) => v === 0.2)).toBe(true);
		expect([...f.values()].some((v) => v === 0.45)).toBe(false);
	});

	test('a legend item lights its kind, and Failed builds the failing lines', async ({ page }) => {
		await demo(page, 'fail=0.2&failing=2');
		await page.locator('.legend li', { hasText: 'Fetches' }).hover();
		await expect
			.poll(async () =>
				[...(await fades(page))].every(([k, v]) => (k.startsWith('fetch:') ? v === 1 : v === 0.45))
			)
			.toBe(true);
		await page.locator('.legend li', { hasText: 'Failed builds' }).hover();
		await expect
			.poll(async () => {
				const r = await lineReport(page);
				return r.length > 0 && r.every((l) => (l.fails > 0 ? l.fade === 1 : l.fade === 0.45));
			})
			.toBe(true);
		const lit = (await lineReport(page)).filter((l) => l.fade === 1);
		expect(lit.length).toBeGreaterThan(0);
		for (const l of lit) expect(l.kind === 'assign' || l.kind === 'request').toBe(true);
		await page.mouse.move(700, 30);
		await expect
			.poll(async () => [...(await fades(page)).values()].every((v) => v === 1))
			.toBe(true);
	});

	test('the legend is one tab stop, and keyboard focus lights an item as a hover does', async ({
		page
	}) => {
		await demo(page, 'fail=0.2&failing=2');
		const items = page.locator('.legend li');
		await expect(page.locator('.legend li[tabindex="0"]')).toHaveCount(1);
		// The hint is the description screen readers hear.
		const fetches = items.filter({ hasText: 'Fetches' });
		await expect(fetches).toHaveAttribute(
			'aria-description',
			'Estimated input bytes builders fetch from the cache'
		);
		await expect(fetches).toHaveAccessibleDescription(
			'Estimated input bytes builders fetch from the cache'
		);
		// End goes to Failed builds, the last item, and the left arrow to Fetches.
		await items.first().focus();
		await page.keyboard.press('End');
		await expect(items.last()).toBeFocused();
		await expect
			.poll(async () => {
				const r = await lineReport(page);
				return r.length > 0 && r.every((l) => (l.fails > 0 ? l.fade === 1 : l.fade === 0.45));
			})
			.toBe(true);
		await page.keyboard.press('ArrowLeft');
		await expect(fetches).toBeFocused();
		await expect(fetches).toHaveAttribute('tabindex', '0');
		await expect
			.poll(async () =>
				[...(await fades(page))].every(([k, v]) => (k.startsWith('fetch:') ? v === 1 : v === 0.45))
			)
			.toBe(true);
		// Tab leaves the list for the Rates switch, and the map is bright again.
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Rates on lines' })).toBeFocused();
		await expect
			.poll(async () => [...(await fades(page)).values()].every((v) => v === 1))
			.toBe(true);
		// A click focuses an item too, but only the pointer lights it, so leaving clears it.
		await items.filter({ hasText: 'Publishes' }).click();
		await page.mouse.move(700, 30);
		await page.waitForTimeout(400);
		expect([...(await fades(page)).values()].every((v) => v === 1)).toBe(true);
	});
});

test.describe('header', () => {
	test('Failed carries its share of finished builds, also at the narrowest width', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1000, height: 800 });
		await demo(page, 'fail=0.2&failing=2');
		const failed = page.locator('.totals .window > div', { hasText: 'Failed' }).locator('dd');
		await expect(failed).toHaveText(/^[\d,.k]+ · (\d+|<1)%$/);
		const text = (await failed.textContent())!.trim();
		const [count, pct] = text.split(' · ');
		const built = await page
			.locator('.totals .window > div', { hasText: 'Built' })
			.locator('dd')
			.textContent();
		const parse = (t: string) => Number(t.replace(/[^\d.]/g, '')) * (t.includes('k') ? 1e3 : 1);
		const share = parse(count) / (parse(count) + parse(built!));
		expect(Math.abs(parseInt(pct) - share * 100)).toBeLessThan(3);
		// Nothing in the header overflows or wraps.
		const header = page.locator('header.header');
		expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		const box = (await failed.boundingBox())!;
		expect(box.height).toBeLessThan(30);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
	});
});

test.describe('pool key', () => {
	test('the legend explains pool cells once, only while a pool is on the map', async ({ page }) => {
		await demo(page);
		await expect(page.locator('.legend .cells')).toHaveCount(0);
		await page.goto('./?demo&builders=60');
		await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(2);
		const key = page.locator('.legend .cells');
		await expect(key).toHaveCount(1);
		await expect(key).toContainText('Pool cells');
		await expect(key).toContainText('Draining');
		await expect(key).toContainText('Offline');
		// The pools themselves end under their grid.
		for (const pool of await page.locator('[data-node-button^="pool:"]').all()) {
			await expect(pool).not.toContainText('Idle');
			const gap = await pool.evaluate((el) => {
				const cells = el.querySelector('.cells')!.getBoundingClientRect();
				return (
					(el.getBoundingClientRect().bottom - cells.bottom) /
					(el.getBoundingClientRect().height / (el as HTMLElement).offsetHeight)
				);
			});
			expect(gap).toBeCloseTo(11, 0);
		}
		// Shown as cards, the key goes.
		await poolToggle(page, 'x86_64-linux').click();
		await poolToggle(page, 'aarch64-linux').click();
		await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(0);
		await expect(key).toHaveCount(0);
	});
});

test.describe('marks at high zoom', () => {
	test('labels stop growing past zoom 1.25', async ({ page }) => {
		await demo(page);
		await viewSettled(page);
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		const label = page.locator('.rate-label[data-id^="assign:"]').first();
		await expect(label).toBeVisible();
		/** On-screen px per CSS px of a label, and its right edge against its builder's left. */
		const measure = () =>
			label.evaluate((el) => {
				const r = el.getBoundingClientRect();
				const id = el.getAttribute('data-id')!.slice('assign:'.length);
				const card = document
					.querySelector(`[data-node-button="worker:${CSS.escape(id)}"]`)!
					.getBoundingClientRect();
				return { k: r.height / (el as HTMLElement).offsetHeight, gap: card.left - r.right };
			});
		const at1 = await measure();
		const zoom1 = await zoomOf(page);
		// Zoom in to 2 with the keyboard, around the middle of the map.
		for (let i = 0; i < 12 && (await zoomOf(page)) < 1.999; i++) {
			await page.keyboard.press('+');
			await page.waitForTimeout(400);
		}
		await expect.poll(() => zoomOf(page)).toBeCloseTo(2, 2);
		await viewSettled(page);
		await expect(label).toBeVisible();
		const at2 = await measure();
		expect(at2.k).toBeCloseTo(1.25, 2);
		// Anchored on the side that touches the line: the same flow px from its builder.
		expect(at2.gap).toBeCloseTo((at1.gap / zoom1) * 2, 0);
	});
});

test.describe('panel scroll', () => {
	test('a new view starts at the top, and Back returns to where the user was', async ({ page }) => {
		await demo(page, 'builders=50');
		await node(page, 'scheduler').click();
		const body = panel(page).locator('.body');
		const list = panel(page).getByRole('list', { name: 'Queued derivations' });
		await expect(list.getByRole('listitem').first()).toBeVisible();
		// Once the queue table has its rows, the body is taller than the panel.
		await expect
			.poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight))
			.toBeGreaterThan(250);
		await body.evaluate((el) => (el.scrollTop = 250));
		await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
		const at = await body.evaluate((el) => el.scrollTop);
		// A derivation opens over the scheduler, at its top.
		await list.getByRole('button').first().click();
		await expect(panel(page).locator('.sub')).toHaveText('Derivation');
		await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0);
		// Back finds the scheduler as it was left.
		await panel(page).locator('button.back').click();
		await expect(list).toBeVisible();
		await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(at);
	});
});

test.describe('rates switch', () => {
	test('lives in the legend, labeled, also on a narrow map', async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await demo(page);
		const toolbar = page.getByRole('toolbar', { name: 'Map view' });
		await expect(toolbar.getByRole('button', { name: 'Rates on lines' })).toHaveCount(0);
		await expect(toolbar.getByRole('button', { name: 'Zoom in' })).toBeVisible();
		const toggle = page.locator('.legend').getByRole('button', { name: 'Rates on lines' });
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveText('Rates');
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		// The note hides below 1280 px; the switch does not.
		await expect(page.locator('.legend .note')).toBeHidden();
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		// At this width the fit is below zoom 0.6, so the labels wait for a zoom in.
		await expect(page.locator('.rate-labels')).toHaveCount(1);
		await toggle.press('Space');
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(page.locator('.rate-labels')).toHaveCount(0);
	});
});

test.describe('panel marks', () => {
	test('the Lines rows mark failures with the short level bar', async ({ page }) => {
		await demo(page, 'fail=0&failing=1');
		const card = page
			.locator('[data-node-button^="worker:"]', { has: page.locator('.badge.fail') })
			.first();
		await expect(card).toBeVisible({ timeout: 30_000 });
		await card.click();
		const bar = panel(page).locator('.fail-bar').first();
		await expect(bar).toBeVisible({ timeout: 10_000 });
		const box = await bar.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { w: r.width, h: r.height };
		});
		expect(box).toEqual({ w: 7, h: 3 });
	});
});

/**
 * The contrast of an element's text against what is under it: its own
 * background, laid over the first opaque one of its ancestors.
 */
function contrastOf(page: Page, selector: string) {
	return page
		.locator(selector)
		.first()
		.evaluate((el) => {
			// Computed colors come as rgb(), color(srgb ...) or oklab(); a canvas turns any into pixels.
			const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
			const parse = (c: string) => {
				cx.clearRect(0, 0, 1, 1);
				cx.fillStyle = c;
				cx.fillRect(0, 0, 1, 1);
				const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
				return { r, g, b, a: a / 255 };
			};
			const under = (node: Element | null): { r: number; g: number; b: number } => {
				for (let e = node; e; e = e.parentElement) {
					const c = parse(getComputedStyle(e).backgroundColor);
					if (c.a === 0) continue;
					if (c.a > 0.99) return c;
					const below = under(e.parentElement);
					return {
						r: c.r * c.a + below.r * (1 - c.a),
						g: c.g * c.a + below.g * (1 - c.a),
						b: c.b * c.a + below.b * (1 - c.a)
					};
				}
				return { r: 255, g: 255, b: 255 };
			};
			const lum = (c: { r: number; g: number; b: number }) => {
				const [r, g, b] = [c.r, c.g, c.b].map((v) => {
					const s = v / 255;
					return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * b;
			};
			const [x, y] = [lum(parse(getComputedStyle(el).color)), lum(under(el))].sort((p, q) => q - p);
			return (x + 0.05) / (y + 0.05);
		});
}

test.describe('contrast', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`the chart's hatch note and the failure badge read at AA, ${scheme}`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme });
			await demo(page, 'fail=0&failing=1');
			// A line panel on a fresh page hatches the part of the window before it.
			const [id] = await builderIds(page);
			await node(page, id).click();
			await panel(page)
				.getByRole('button', { name: /^Assignments from the scheduler, / })
				.click();
			const note = panel(page).locator('.chart .note');
			await expect(note).toHaveText('Before this page opened');
			// On the panel's own color, padded, so the stripes stay clear of the words.
			const bg = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
			expect(bg).toBe(await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor));
			expect(await contrastOf(page, '.chart .note')).toBeGreaterThanOrEqual(4.5);
			await page.keyboard.press('Escape');
			await page.keyboard.press('Escape');
			const badge = '[data-node-button^="worker:"] .badge.fail';
			await expect(page.locator(badge).first()).toBeVisible({ timeout: 30_000 });
			expect(await contrastOf(page, badge)).toBeGreaterThanOrEqual(4.5);
		});
	}
});

test.describe('pause and the window picker', () => {
	test('a click on the picker shows at once while paused; the totals catch up on resume', async ({
		page
	}) => {
		await demo(page);
		const picker = page.getByRole('radiogroup', { name: 'Time window' });
		await expect(picker.getByRole('radio', { name: '15 minutes' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		const built = page.locator('.totals .window dd').first();
		const pause = page
			.getByRole('toolbar', { name: 'Map view' })
			.getByRole('button', { name: 'Pause' });
		await page.keyboard.press('p');
		await expect(pause).toHaveAttribute('aria-pressed', 'true');
		const held = await built.textContent();
		await picker.getByRole('radio', { name: '1 hour' }).click();
		await expect(picker.getByRole('radio', { name: '1 hour' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await expect(picker.getByRole('radio', { name: '15 minutes' })).toHaveAttribute(
			'aria-checked',
			'false'
		);
		// The numbers hold still until resume.
		await page.waitForTimeout(1200);
		expect(await built.textContent()).toBe(held);
		await pause.click();
		await expect(pause).toHaveAttribute('aria-pressed', 'false');
		await expect(built).not.toHaveText(held ?? '');
		await expect(picker.getByRole('radio', { name: '1 hour' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
	});
});

test.describe('panels and the view', () => {
	const transform = (page: Page) =>
		page.locator('.svelte-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);

	test('a docked panel keeps the zoom, and closing it goes back to the same view', async ({
		page
	}) => {
		await demo(page);
		await viewSettled(page);
		const before = await transform(page);
		const zoom = await zoomOf(page);
		const card = page.locator('[data-node-button^="worker:"]').first();
		await card.click();
		await expect(panel(page)).toBeVisible();
		await page.waitForTimeout(600);
		await viewSettled(page);
		// No refit into the narrower map, so the clicked card keeps its size.
		expect(await zoomOf(page)).toBeCloseTo(zoom, 4);
		await expect(card).toBeInViewport();
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await page.waitForTimeout(600);
		await viewSettled(page);
		expect(await transform(page)).toBe(before);

		// A move of the user's while the panel is open stays when it closes.
		await card.click();
		await expect(panel(page)).toBeVisible();
		await page.waitForTimeout(600);
		await page.getByRole('button', { name: 'Zoom in' }).click();
		await page.waitForTimeout(500);
		await viewSettled(page);
		const moved = await transform(page);
		expect(moved).not.toBe(before);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(600);
		await viewSettled(page);
		expect(await transform(page)).toBe(moved);
	});

	test('a floating panel pans a hidden card out from under it, and closing pans back', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await demo(page);
		await viewSettled(page);
		const before = await transform(page);
		const zoom = await zoomOf(page);
		// The rightmost card ends up under the panel, which floats over the map's right side.
		const ids = await page
			.locator('[data-node-button^="worker:"]')
			.evaluateAll((els) =>
				els
					.map((e) => ({ id: e.getAttribute('data-node-button')!, x: e.getBoundingClientRect().x }))
					.sort((a, b) => b.x - a.x)
			);
		const card = node(page, ids[0].id);
		await card.click();
		await expect(panel(page)).toBeVisible();
		await page.waitForTimeout(800);
		await viewSettled(page);
		expect(await zoomOf(page)).toBeCloseTo(zoom, 4);
		const c = (await card.boundingBox())!;
		const p = (await panel(page).boundingBox())!;
		expect(c.x + c.width).toBeLessThanOrEqual(p.x);
		// Not a move of the user's, so the Fit button still reads as fitted, and closing pans back.
		await expect(page.getByRole('button', { name: 'Fit the whole farm' })).toHaveClass(/dim/);
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await page.waitForTimeout(600);
		await viewSettled(page);
		expect(await transform(page)).toBe(before);
	});

	test('closing goes back to a view the user chose, though the layout changed meanwhile', async ({
		page
	}) => {
		await page.setViewportSize({ width: 1100, height: 800 });
		await demo(page, 'churn=60');
		await viewSettled(page);
		await page.getByRole('button', { name: 'Zoom in' }).click();
		await page.waitForTimeout(500);
		await viewSettled(page);
		const before = await transform(page);
		// The rightmost card on screen ends up under the panel, so reveal pans.
		const pane = (await page.locator('.svelte-flow').boundingBox())!;
		const ids = await page.locator('[data-node-button^="worker:"]').evaluateAll(
			(els, right) =>
				els
					.map((e) => ({ id: e.getAttribute('data-node-button')!, r: e.getBoundingClientRect() }))
					.filter(({ r }) => r.left >= 0 && r.top >= 0 && r.right <= right && r.bottom <= 760)
					.sort((a, b) => b.r.right - a.r.right)
					.map((c) => c.id),
			pane.x + pane.width
		);
		await node(page, ids[0]).click();
		await expect(panel(page)).toBeVisible();
		await page.waitForTimeout(800);
		await viewSettled(page);
		expect(await transform(page)).not.toBe(before);
		// Builders join and leave, and the cards move.
		const layout = () =>
			page
				.locator('.svelte-flow__node')
				.evaluateAll((els) =>
					els
						.map((e) => `${e.getAttribute('data-id')} ${(e as HTMLElement).style.transform}`)
						.join()
				);
		const was = await layout();
		await expect.poll(layout, { timeout: 20_000 }).not.toBe(was);
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await page.waitForTimeout(600);
		await viewSettled(page);
		expect(await transform(page)).toBe(before);
	});

	test('opening a panel pans its card out from under the zoom buttons', async ({ page }) => {
		await demo(page, 'upstream=3');
		await viewSettled(page);
		// Zoom 1 around the upstream card, at the map's bottom right.
		const card = node(page, 'upstream');
		const b = (await card.boundingBox())!;
		await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
		for (let i = 0; i < 100 && Math.abs((await zoomOf(page)) - 1) > 0.02; i++) {
			const z = await zoomOf(page);
			await page.mouse.wheel(0, z < 1 ? -Math.max(5, 120 * (1 - z)) : Math.max(5, 120 * (z - 1)));
			await page.waitForTimeout(80);
		}
		await page.mouse.move(5, 300);
		await viewSettled(page);
		await card.click();
		await expect(panel(page)).toBeVisible();
		await page.waitForTimeout(800);
		await viewSettled(page);
		const c = (await card.boundingBox())!;
		const z = (await page.locator('.map-controls').boundingBox())!;
		const p = (await panel(page).boundingBox())!;
		expect(c.x + c.width).toBeLessThanOrEqual(p.x);
		const clear = c.x + c.width <= z.x || c.y + c.height <= z.y;
		expect(clear, `card ${JSON.stringify(c)} under the buttons ${JSON.stringify(z)}`).toBe(true);
	});

	test('a window resize still refits while a panel is open', async ({ page }) => {
		await demo(page);
		await viewSettled(page);
		const zoom = await zoomOf(page);
		await page.locator('[data-node-button^="worker:"]').first().click();
		await expect(panel(page)).toBeVisible();
		await page.waitForTimeout(600);
		await page.setViewportSize({ width: 1200, height: 900 });
		await expect.poll(() => zoomOf(page)).toBeLessThan(zoom * 0.95);
	});
});
