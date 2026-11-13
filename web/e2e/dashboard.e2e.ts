import type { Page } from '@playwright/test';
import { SPEED } from '../src/lib/flow/particles.ts';
import {
	builderIds,
	demo,
	dotsMove,
	expect,
	lineOf,
	lineReport,
	node,
	opacity,
	panel,
	pill,
	pointOn,
	poolToggle,
	test,
	travel,
	viewSettled,
	zoomOf,
	type LineReport,
	type ProbeWindow
} from './fixtures.ts';

// The demo farm in #lib/source/mock.ts, through the real reducer and store.

// Catppuccin base colors, as the browser computes them.
const LATTE_BASE = 'rgb(239, 241, 245)';
const MACCHIATO_BASE = 'rgb(36, 39, 58)';
const LATTE_BLUE = 'rgb(30, 102, 245)';
const MACCHIATO_BLUE = 'rgb(138, 173, 244)';

/** A point on the empty map, where a drag pans the view. */
async function emptyPanePoint(page: Page) {
	const point = await page.evaluate(() => {
		const pane = document.querySelector('.svelte-flow__pane')!.getBoundingClientRect();
		for (let y = pane.bottom - 140; y > pane.top + 40; y -= 20)
			for (let x = pane.left + 60; x < pane.right - 60; x += 20)
				if (document.elementFromPoint(x, y)?.classList.contains('svelte-flow__pane'))
					return { x, y };
		return null;
	});
	expect(point).not.toBeNull();
	return point!;
}

/** Parses "2,384" as 2384 and "12.3k" as 12300. */
const parseCount = (t: string) =>
	Number(t.replace(/[^\d.]/g, '')) * (t.includes('M') ? 1e6 : t.includes('k') ? 1e3 : 1);

/** The viewport's transform, which changes on every pan, zoom and refit. */
const viewport = (page: Page) =>
	page.locator('.svelte-flow__viewport').evaluate((el) => getComputedStyle(el).transform);

/** Click a line `at` flow px along it, once the view holds still. */
async function clickLine(page: Page, edge: string, at: number) {
	await viewSettled(page, {});
	const p = await pointOn(page, edge, at);
	await page.mouse.click(p.x, p.y);
}

/**
 * Whether a line's dots went on from `a` to `b` without a jump: every dot
 * still on the line moved by the same distance, the line's own time since.
 */
function onCourse(a: LineReport, b: LineReport): boolean {
	const moved = ((b.time - a.time) * 56) / 1000;
	return a.dots
		.filter((d) => d.s + moved < b.length - 0.5)
		.every((d) => b.dots.some((e) => Math.abs(e.s - (d.s + moved)) < 0.5));
}

const byId = (lines: readonly LineReport[]) => new Map(lines.map((l) => [l.id, l]));

/** One frame of a wheel gesture, as wheelGesture samples it. */
type GestureFrame = { moving: boolean; zoom: number; labels: number; readout: boolean };

/**
 * One wheel gesture at a point: wheel steps 40 ms apart, from inside the
 * page, so a busy machine cannot stretch the gap past the 150 ms after
 * which d3-zoom ends a gesture. Stops after `steps` steps or once the zoom
 * is below `until`. `wiggle` sends a pointer move after each step. Returns
 * every frame from the first step to the last.
 */
function wheelGesture(
	page: Page,
	at: { x: number; y: number },
	o: { steps: number; deltaY: number; until?: number; wiggle?: boolean }
) {
	return page.evaluate(
		({ at, o }) =>
			new Promise<GestureFrame[]>((done) => {
				const vp = document.querySelector<HTMLElement>('.svelte-flow__viewport')!;
				const zoom = () => new DOMMatrix(getComputedStyle(vp).transform).a;
				const target = document.elementFromPoint(at.x, at.y)!;
				const frames: GestureFrame[] = [];
				let stop = false;
				const sample = () => {
					frames.push({
						moving: !!document.querySelector('.farm-map.moving'),
						zoom: zoom(),
						labels: document.querySelectorAll('.rate-label').length,
						readout: !!document.querySelector('.line-readout')
					});
					if (!stop) requestAnimationFrame(sample);
				};
				let i = 0;
				const step = () => {
					if (i >= o.steps || zoom() < (o.until ?? -Infinity)) {
						stop = true;
						done(frames);
						return;
					}
					const opts = { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true };
					target.dispatchEvent(new WheelEvent('wheel', { ...opts, deltaY: o.deltaY }));
					if (o.wiggle)
						target.dispatchEvent(
							new PointerEvent('pointermove', {
								...opts,
								clientX: at.x + (i % 2),
								pointerType: 'mouse'
							})
						);
					if (i++ === 0) requestAnimationFrame(sample);
					setTimeout(step, 40);
				};
				step();
			}),
		{ at, o }
	);
}

test.describe('start page', () => {
	test('the dev server without a farm shows the landing', async ({ page }) => {
		await page.goto('./');
		await expect(page.getByRole('heading', { name: 'Watch your build farm, live' })).toBeVisible();
		await expect(page.getByText('This copy of the dashboard has no farm behind it.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
		expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
	});

	test('starts and leaves the demo', async ({ page }) => {
		await page.goto('./');
		await page.getByRole('button', { name: 'Try the demo' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Demo farm');
		// The name says it is a demo, so no badge repeats it; the tooltip says what it is.
		await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute(
			'title',
			'A simulated farm running in this browser tab'
		);
		await expect(page.locator('header .badge')).toHaveCount(0);
		await expect(pill(page)).toHaveText('Live');
		await page.getByRole('button', { name: 'Leave demo' }).click();
		await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
	});

	test('?demo starts the demo, and leaving it clears the flag', async ({ page }) => {
		// The dev server warns about deprecated navigation calls.
		const warnings: string[] = [];
		page.on('console', (m) => {
			if (m.text().includes('[sveltekit]')) warnings.push(m.text());
		});
		await demo(page, 'builders=5');
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(5);
		await page.getByRole('button', { name: 'Leave demo' }).click();
		await expect(page).toHaveURL(/\/$/);
		expect(warnings).toEqual([]);
		await page.reload();
		await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible();
	});
});

test.describe('map', () => {
	test('draws the lanes and 12 builders by default', async ({ page }) => {
		await demo(page);
		for (const lane of ['Clients', 'Scheduler', 'Builders', 'Cache']) {
			await expect(page.getByRole('heading', { name: lane, exact: true })).toBeVisible();
		}
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(12);
		await expect(page.locator('.svelte-flow__node-system')).toHaveCount(2);
		await expect(page.locator('.svelte-flow__node-scheduler')).toHaveCount(1);
		await expect(page.locator('.svelte-flow__node-cache')).toHaveCount(1);
		// Busiest client groups, 10 cards at most with "other clients", like a builder column.
		const groups = page.locator('.svelte-flow__node-clients');
		await expect(groups.first()).toBeVisible();
		expect(await groups.count()).toBeLessThanOrEqual(10);
		// Cards and the scheduler count streams, not "open" or "clients".
		await expect(groups.first()).toContainText(/\d+ streams · \d+ waiting/);
		await expect(node(page, 'scheduler')).toContainText(/\d+ streams/);
		await expect(node(page, 'scheduler')).not.toContainText('free');
		// Honest labels on the map.
		await expect(page.getByText('Scheduler lookups only')).toBeVisible();
		// The fetch label says it is an estimate once, so no caption repeats it.
		await expect(page.getByText('Fetch (estimated)', { exact: true })).toBeVisible();
		await expect(page.getByText('Fetch is an estimate')).toHaveCount(0);
	});

	test('draws 50 builders with ?demo&builders=50', async ({ page }) => {
		await demo(page, 'builders=50');
		// Both groups have more than 10 builders, so they start as pools.
		await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(2);
		for (const system of ['x86_64-linux', 'aarch64-linux']) await poolToggle(page, system).click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(50);
		// Thousands of derivations in flight, queued plus assigned, none of them on the map.
		const now = await page.locator('.totals .now dd').allTextContents();
		expect(now.map(parseCount).reduce((a, b) => a + b, 0)).toBeGreaterThan(3000);
		expect(await page.locator('.svelte-flow__node').count()).toBeLessThan(80);
	});

	test('animates lines, and rates change', async ({ page }) => {
		await demo(page);
		// The dots travel. The line canvas moves them along their lines at
		// 56 px a second. It waits while a fit animates the view, as the
		// demo's first clients arrive.
		await dotsMove(page, 5);
		const a = byId(await lineReport(page));
		await expect.poll(() => travel(page)).toBeGreaterThan([...a.values()][0].time + 300);
		const b = byId(await lineReport(page));
		const moving = [...a.values()].filter((l) => l.dots.length > 0);
		expect(moving.length).toBeGreaterThan(5);
		for (const l of moving) {
			const now = b.get(l.id);
			if (!now) continue;
			expect(now.time).toBeGreaterThan(l.time);
			expect(onCourse(l, now), l.id).toBe(true);
		}
		// Line widths, dot densities and the rates printed on nodes move with traffic.
		const sample = () =>
			page.evaluate(() => [
				...(window as unknown as ProbeWindow).__lines
					.report()
					.map((l) => `${l.id}:${l.targetWidth}/${l.level}`),
				...[...document.querySelectorAll('.svelte-flow__node-clients .rate')].map(
					(e) => e.textContent
				),
				document.querySelector('.svelte-flow__node-scheduler .facts')?.textContent
			]);
		const before = await sample();
		await expect.poll(sample, { timeout: 15_000 }).not.toEqual(before);
	});

	test('pauses the dots while the view moves, and resumes them in place', async ({ page }) => {
		await demo(page);
		await dotsMove(page);
		const canvas = page.locator('.farm-map.moving');
		await viewSettled(page);
		await expect(canvas).toHaveCount(0);
		const viewport = page.locator('.svelte-flow__viewport');
		await expect(viewport).toHaveCSS('will-change', 'auto');

		// Hold a drag for 300 ms, then let go.
		const start = await emptyPanePoint(page);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 40, start.y + 10, { steps: 4 });
		await expect(canvas).toHaveCount(1);
		await expect(viewport).toHaveCSS('will-change', 'transform');
		const held = await travel(page);
		const heldLines = await lineReport(page);
		await page.waitForTimeout(300);
		expect(await travel(page)).toBe(held);
		// Every dot stands where it stood.
		const still = byId(await lineReport(page));
		for (const l of heldLines) expect(still.get(l.id)?.dots, l.id).toEqual(l.dots);

		const up = await page.evaluate(() => performance.now());
		await page.mouse.up();
		await expect(canvas).toHaveCount(0);
		await expect(viewport).toHaveCSS('will-change', 'auto');
		await expect.poll(() => travel(page)).toBeGreaterThan(held);
		const [after, now] = await Promise.all([travel(page), page.evaluate(() => performance.now())]);
		// They pick up where they stopped, no further than the time since the
		// release allows, and not 300 ms more for the time the drag held.
		expect(after - held).toBeLessThanOrEqual(now - up + 20);
	});

	test('keeps the dots moving through a refit under churn', async ({ page }) => {
		await demo(page, 'churn=600');
		await dotsMove(page);
		// Builders join fast at first, and each refit shows the whole farm.
		await viewSettled(page, { intervals: [400], timeout: 20_000 });
		// Each frame for a while: the view's transform, the canvas clock, and
		// whether the map holds still.
		type Frame = { transform: string; travel: number; moving: boolean };
		const sampling = page.evaluate(
			() =>
				new Promise<Frame[]>((done) => {
					const frames: Frame[] = [];
					const vp = document.querySelector<HTMLElement>('.svelte-flow__viewport')!;
					const canvas = vp.closest('.farm-map')!;
					const probe = (window as unknown as ProbeWindow).__lines;
					const end = performance.now() + 1500;
					const step = (t: number) => {
						frames.push({
							transform: vp.style.transform,
							travel: probe.travel(),
							moving: canvas.classList.contains('moving')
						});
						if (t < end) requestAnimationFrame(step);
						else done(frames);
					};
					requestAnimationFrame(step);
				})
		);
		// A narrower map makes the view refit, with a 300 ms animation.
		await page.setViewportSize({ width: 1000, height: 900 });
		const frames = await sampling;
		const animating = frames.filter((f, i) => i > 0 && f.transform !== frames[i - 1].transform);
		expect(animating.length).toBeGreaterThan(3);
		expect(frames.filter((f) => f.moving)).toEqual([]);
		expect(new Set(animating.map((f) => f.travel)).size).toBeGreaterThan(3);
	});

	test('the grid follows the view', async ({ page }) => {
		await demo(page);
		await viewSettled(page);
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		const offsets = () =>
			page.evaluate(() => {
				const vp = document.querySelector<HTMLElement>('.svelte-flow__viewport')!;
				const [, x, y, k] = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/
					.exec(vp.style.transform)!
					.map(Number);
				const svg = document.querySelector<SVGSVGElement>('.map-grid svg')!;
				const box = svg.getBoundingClientRect();
				const pane = document.querySelector('.svelte-flow')!.getBoundingClientRect();
				const pattern = svg.querySelector('pattern')!;
				const gap = Number(pattern.getAttribute('width'));
				const r = Number(pattern.querySelector('circle')!.getAttribute('r'));
				// How far the grid's dots sit from the flow origin's, within one pitch.
				const off = (a: number) => {
					const m = ((a % gap) + gap) % gap;
					return Math.min(m, gap - m);
				};
				return {
					gap: +(gap / k).toFixed(3),
					size: +((2 * r) / k).toFixed(3),
					// Layout rounds positions to 1/64 px.
					aligned: off(box.left - pane.left - x) < 0.05 && off(box.top - pane.top - y) < 0.05
				};
			});
		expect(await offsets()).toEqual({ gap: 24, size: 1.2, aligned: true });
		await page.getByRole('button', { name: 'Zoom in' }).click();
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		const start = await emptyPanePoint(page);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 37, start.y - 13, { steps: 3 });
		await page.mouse.up();
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		expect(await offsets()).toEqual({ gap: 24, size: 1.2, aligned: true });
	});

	test('header totals change over time', async ({ page }) => {
		await demo(page);
		const built = page.locator('.totals .window dd').first();
		await expect(built).not.toHaveText('–');
		const first = await built.textContent();
		await expect(built).not.toHaveText(first ?? '', { timeout: 20_000 });
	});

	test('keeps node positions while live numbers change', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		// The node's place on the map, not on screen, since the view refits with
		// a short animation whenever client groups come or go.
		const wrapper = page.locator('.svelte-flow__node', { has: node(page, id) });
		const place = () => wrapper.evaluate((el) => (el as HTMLElement).style.transform);
		const before = await place();
		expect(before).toMatch(/^translate\(/);
		await page.waitForTimeout(1500);
		expect(await place()).toBe(before);
	});

	test('pans a keyboard-focused node into view', async ({ page }) => {
		await demo(page, 'builders=50');
		for (const system of ['x86_64-linux', 'aarch64-linux']) await poolToggle(page, system).click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(50);
		const ids = await builderIds(page);
		const zoomIn = page.getByRole('button', { name: 'Zoom in' });
		for (let i = 0; i < 8; i++) {
			await zoomIn.click();
			await page.waitForTimeout(350);
		}
		const target = node(page, ids[ids.length - 1]);
		await expect(target).not.toBeInViewport();
		await node(page, ids[ids.length - 2]).focus();
		await page.keyboard.press('Tab');
		await expect(target).toBeFocused();
		await expect(target).toBeInViewport({ ratio: 1 });
	});

	test('hides traffic dots for reduced motion', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await demo(page);
		await expect
			.poll(async () => (await lineReport(page)).filter((l) => l.active).length)
			.toBeGreaterThan(5);
		await viewSettled(page);
		expect((await lineReport(page)).every((l) => l.dots.length === 0)).toBe(true);
	});

	test('recovers from a seq gap with a fresh snapshot', async ({ page }) => {
		await demo(page, 'builders=6&gaps=3');
		const since = await pill(page).getAttribute('title');
		await expect(pill(page)).toContainText('Reconnecting', { timeout: 10_000 });
		await expect(page.getByText('Connection lost.')).toBeVisible();
		await expect(page.getByText(/The stream skipped events/)).toBeVisible();
		// The countdown ticks in the pill only, outside the banner's live region.
		await expect(page.locator('.banner')).not.toContainText('Reconnecting in');
		await expect(page.locator('.banner')).not.toContainText('attempt');
		// The old picture stays while reconnecting.
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(6);
		await expect(pill(page)).toHaveText('Live', { timeout: 10_000 });
		// A new stream, live from a later time.
		expect(await pill(page).getAttribute('title')).not.toBe(since);
	});
});

/** A point on the empty map where no line takes the pointer, so a click there picks nothing. */
async function quietPanePoint(page: Page) {
	const points = await page.evaluate(() => {
		const pane = document.querySelector('.svelte-flow__pane')!.getBoundingClientRect();
		const found: { x: number; y: number }[] = [];
		for (let y = pane.top + 60; y < pane.bottom - 60 && found.length < 40; y += 37)
			for (let x = pane.left + 60; x < pane.right - 60 && found.length < 40; x += 53)
				if (document.elementFromPoint(x, y)?.classList.contains('svelte-flow__pane'))
					found.push({ x, y });
		return found;
	});
	for (const p of points) {
		await page.mouse.move(p.x, p.y);
		await page.waitForTimeout(50);
		if ((await page.locator('.farm-map.hovering').count()) === 0) return p;
	}
	throw new Error('no quiet point on the canvas');
}

/**
 * Counts every change of text or elements under the selectors from now on.
 * Attributes are left out: focus and selection change those.
 */
async function changeCounter(page: Page, selectors: readonly string[]) {
	const box = await page.evaluateHandle((selectors) => {
		const box = { n: 0 };
		const o = new MutationObserver((records) => (box.n += records.length));
		for (const sel of selectors)
			for (const el of document.querySelectorAll(sel))
				o.observe(el, { subtree: true, childList: true, characterData: true });
		return box;
	}, selectors);
	return () => box.evaluate((b) => b.n);
}

test.describe('hold and pause', () => {
	test('a pointer held down anywhere on the map holds it and the header, and the click still acts', async ({
		page
	}) => {
		await demo(page);
		await dotsMove(page);
		await viewSettled(page);
		const held = page.locator('.farm-map.held');
		// The header's totals hold with the map, as when paused.
		const changes = await changeCounter(page, ['.svelte-flow__nodes', '.totals']);
		await expect(held).toHaveCount(0);
		await expect.poll(changes, { timeout: 10_000 }).toBeGreaterThan(0);

		/** Hold the pointer still at a point for 1.5 s, and nothing on the map changes. */
		const holdAt = async (at: { x: number; y: number }) => {
			await page.mouse.move(at.x, at.y);
			await page.mouse.down();
			await expect(held).toHaveCount(1);
			// The pill keeps saying Live, since the hold ends by itself on release.
			await expect(page.locator('.pill')).toContainText('Live');
			// A press is not a pan, so the cards keep their hover and transitions.
			await expect(page.locator('.farm-map.moving')).toHaveCount(0);
			const n = await changes();
			const t = await travel(page);
			await page.waitForTimeout(1500);
			expect(await changes()).toBe(n);
			expect(await travel(page)).toBe(t);
			await page.mouse.up();
			await expect(held).toHaveCount(0);
			// The dots go on and the numbers catch up.
			await expect.poll(() => travel(page)).toBeGreaterThan(t);
			await expect.poll(changes, { timeout: 10_000 }).toBeGreaterThan(n);
		};

		// On the empty map, away from every line, the click opens nothing.
		await holdAt(await quietPanePoint(page));
		await expect(panel(page)).toBeHidden();

		// On a card, the click on release opens its panel.
		const [id] = await builderIds(page);
		const box = (await node(page, id).boundingBox())!;
		await holdAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
		await expect(page.locator('#panel-title')).toHaveText(id.slice('worker:'.length));
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();

		// On a line, the click opens the line's panel.
		await viewSettled(page, {});
		await holdAt(await pointOn(page, `assign:${id.slice('worker:'.length)}`, -20));
		await expect(panel(page)).toBeVisible();
		await expect(panel(page)).toContainText('Assignments');
	});

	test('the pause button and P freeze the map, the totals and a panel; resume catches up', async ({
		page
	}) => {
		await demo(page);
		const [id] = await builderIds(page);
		await node(page, id).click();
		await expect(panel(page)).toBeVisible();
		const built = page.locator('.totals .window dd').first();
		await expect(built).not.toHaveText('–');
		const changes = await changeCounter(page, ['.totals', '.svelte-flow__nodes', '.side']);
		await expect.poll(changes, { timeout: 10_000 }).toBeGreaterThan(0);

		const button = page.getByRole('button', { name: 'Pause', exact: true });
		await expect(button).toHaveAttribute('aria-pressed', 'false');
		await expect(button).toHaveAttribute('aria-keyshortcuts', 'P');
		await button.click();
		await expect(button).toHaveAttribute('aria-pressed', 'true');
		await expect(pill(page)).toHaveText(/Paused · [01]s$/);
		await expect(page.locator('.farm-map.held')).toHaveCount(1);
		// The panel's throttled rows settle on the numbers of the moment of the pause.
		await page.waitForTimeout(1100);
		const totals = page.locator('.totals');
		const n = await changes();
		const t = await travel(page);
		const frozen = (await totals.textContent()) ?? '';
		await page.waitForTimeout(2500);
		expect(await changes()).toBe(n);
		expect(await travel(page)).toBe(t);
		await expect(totals).toHaveText(frozen);
		await expect(pill(page)).toHaveText(/Paused · [3-6]s$/);

		// P resumes, and the numbers are current at once, since the stream kept arriving.
		await page.keyboard.press('p');
		await expect(button).toHaveAttribute('aria-pressed', 'false');
		await expect(pill(page)).toHaveText('Live');
		await expect(totals).not.toHaveText(frozen, { timeout: 1000 });
		await expect.poll(changes, { timeout: 1000 }).toBeGreaterThan(n);
		await expect.poll(() => travel(page)).toBeGreaterThan(t);

		// P pauses again; the pill resumes.
		await page.keyboard.press('p');
		await expect(pill(page)).toHaveText(/Paused/);
		await expect(button).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'Paused. Resume' }).click();
		await expect(pill(page)).toHaveText('Live');
		await expect(button).toHaveAttribute('aria-pressed', 'false');
	});

	test('P does nothing while typing', async ({ page }) => {
		await demo(page, 'builders=300');
		await node(page, 'pool:x86_64-linux').click({ position: { x: 40, y: 16 } });
		const search = panel(page).getByRole('searchbox', { name: /Search builders/ });
		await search.click();
		await page.keyboard.type('pP');
		await expect(search).toHaveValue('pP');
		await expect(pill(page)).toHaveText('Live');
		// With a modifier it is someone else's shortcut.
		await page.locator('#panel-title').focus();
		await page.keyboard.press('Alt+p');
		await expect(pill(page)).toHaveText('Live');
		// Outside the field, on its own, it pauses.
		await page.keyboard.press('p');
		await expect(pill(page)).toHaveText(/Paused/);
	});

	test('the paused pill: a steady pink pause sign, announced once', async ({ page }) => {
		await demo(page);
		const live = page.locator('.status [aria-live]');
		await expect(live).toHaveCount(2);
		await expect(live.nth(1)).toHaveText('');
		await page.keyboard.press('p');
		const mark = pill(page).locator('.pause-mark');
		await expect(mark).toBeVisible();
		await expect(pill(page).locator('.dot')).toHaveCount(0);
		await expect(mark).toHaveCSS('animation-name', 'none');
		const pink = await page.evaluate(() => {
			const probe = document.createElement('i');
			probe.style.color = 'var(--paused-fg)';
			document.body.append(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		});
		await expect(mark).toHaveCSS('border-left-color', pink);
		await expect(pill(page)).toHaveAttribute(
			'title',
			/^Paused at .+\. Click or press P to resume\.$/
		);
		await expect(live.nth(1)).toHaveText('Paused');
		// The seconds count on, but the live regions do not change.
		const changes = await changeCounter(page, ['.status [aria-live]']);
		await expect(pill(page)).toHaveText(/Paused · [2-5]s$/, { timeout: 6000 });
		expect(await changes()).toBe(0);
		await expect(live.first()).toHaveText('Connection: Live');
		await pill(page).click();
		await expect(live.nth(1)).toHaveText('Live again');
		await expect(pill(page)).toHaveText('Live');
	});
});

test.describe('header', () => {
	test('switches the totals window', async ({ page }) => {
		await demo(page);
		const window = page.getByRole('radiogroup', { name: 'Time window' });
		await expect(window.getByRole('radio')).toHaveText(['5m', '15m', '30m', '1h']);
		await expect(window.getByRole('radio', { name: '15 minutes' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		// A full window needs no caption, since the selected segment names it.
		await expect(page.locator('.totals .caption')).toHaveCount(0);
		const cache = node(page, 'cache');
		await expect(cache.locator('.when')).toHaveText('Last 15mLast 15 minutes');
		await window.getByRole('radio', { name: '30 minutes' }).click();
		await expect(cache.locator('.when')).toContainText('Last 30m');
		await window.getByRole('radio', { name: '1 hour' }).click();
		await expect(window.getByRole('radio', { name: '1 hour' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await expect(cache.locator('.when')).toContainText('Last 1h');
		await expect(cache.locator('.label').first()).toHaveText('Hit ratio');
		await expect(page.locator('.totals .caption')).toHaveCount(0);
	});

	test('theme toggle switches Latte and Macchiato for this tab only', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'light' });
		await demo(page);
		const html = page.locator('html');
		const body = page.locator('body');
		await expect(body).toHaveCSS('background-color', LATTE_BASE);
		// The line canvas draws with the theme's colors, resolved by the browser.
		const blue = () =>
			page.evaluate(() => (window as unknown as ProbeWindow).__lines.colors()?.assign);
		await expect.poll(blue).toBe(LATTE_BLUE);
		await page.getByRole('radio', { name: 'Dark theme' }).click();
		await expect(html).toHaveAttribute('data-theme', 'dark');
		await expect(body).toHaveCSS('background-color', MACCHIATO_BASE);
		await expect(page.locator('.svelte-flow')).toHaveClass(/dark/);
		await expect.poll(blue).toBe(MACCHIATO_BLUE);
		await page.getByRole('radio', { name: 'Follow the system theme' }).click();
		await expect(html).not.toHaveAttribute('data-theme');
		await expect(body).toHaveCSS('background-color', LATTE_BASE);
		await expect.poll(blue).toBe(LATTE_BLUE);
		// The system preference changes too.
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect.poll(blue).toBe(MACCHIATO_BLUE);
		await page.emulateMedia({ colorScheme: 'light' });
		// The choice is not remembered, so after a reload the system preference decides again.
		await page.getByRole('radio', { name: 'Dark theme' }).click();
		await page.reload();
		await expect(html).not.toHaveAttribute('data-theme');
		await expect(body).toHaveCSS('background-color', LATTE_BASE);
		const stored = await page.evaluate(() => [
			...Object.keys(localStorage),
			...Object.keys(sessionStorage)
		]);
		// SvelteKit's own scroll and history entries only.
		expect(stored.filter((k) => !k.startsWith('sveltekit:'))).toEqual([]);
	});

	test('follows a dark system preference', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto('./');
		await expect(page.locator('body')).toHaveCSS('background-color', MACCHIATO_BASE);
	});
});

test.describe('drill-down', () => {
	test('builder panel, derivation detail, Escape and focus', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		const b = node(page, id);
		await b.click();
		await expect(panel(page)).toBeVisible();
		await expect(page.locator('#panel-title')).toHaveText(addr);
		await expect(page.locator('#panel-title')).toBeFocused();
		await expect(b).toHaveAttribute('aria-expanded', 'true');

		const rows = panel(page).getByRole('list', { name: 'Derivations on this builder' });
		await expect(rows.getByRole('button').first()).toBeVisible();
		const name = await rows.getByRole('button').first().locator('.name').textContent();
		await rows.getByRole('button').first().click();
		await expect(panel(page).getByText('Derivation', { exact: true })).toBeVisible();
		await expect(page.locator('#panel-title')).toHaveText(name ?? '');
		await expect(panel(page).locator('code.path')).toContainText(/^[0-9a-z]{32}-.+\.drv$/);
		for (const h of ['Timings', 'Requested by', 'Inputs']) {
			await expect(panel(page).getByRole('heading', { name: h })).toBeVisible();
		}
		await expect(panel(page)).toContainText('since the scheduler does not see when the build');

		await page.keyboard.press('Escape');
		await expect(page.locator('#panel-title')).toHaveText(addr);
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(b).toBeFocused();
	});

	test('opens from the keyboard', async ({ page }) => {
		await demo(page);
		const s = node(page, 'scheduler');
		await s.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#panel-title')).toHaveText('Scheduler');
		await expect(panel(page).getByRole('table')).toBeVisible();
	});

	test('the queue table counts the slots of builders that can take each row', async ({ page }) => {
		await demo(page);
		await node(page, 'scheduler').click();
		const table = panel(page).getByRole('table');
		await expect(table).toBeVisible();
		await expect(panel(page)).toContainText(
			'A builder counts in every row it can take, so rows add up to more than the farm has.'
		);
		// System, queued, unplaceable, assigned, free as "free/slots".
		const rows = () =>
			table
				.locator('tbody tr')
				.evaluateAll((trs) =>
					trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''))
				);
		// A placeable row has slots, also one that needs features no builder offers exactly.
		await expect
			.poll(async () => {
				const r = await rows();
				const placeable = r.filter((c) => c[2] === '0');
				return (
					r.some((c) => /^x86_64-linux\s+\S/.test(c[0])) &&
					placeable.length > 0 &&
					placeable.every((c) => !c[4].endsWith('/0'))
				);
			})
			.toBe(true);
	});

	test('scheduler queue list is windowed', async ({ page }) => {
		await demo(page, 'builders=50');
		await node(page, 'scheduler').click();
		const list = panel(page).getByRole('list', { name: 'Queued derivations' });
		await expect(list).toBeVisible();
		// Thousands queued, a screenful rendered.
		await expect(list.getByRole('listitem').first()).toBeVisible();
		const count = await list.getByRole('listitem').count();
		expect(count).toBeGreaterThan(5);
		expect(count).toBeLessThan(60);
		// Rows hold still while the keyboard is in the list.
		await list.getByRole('button').first().focus();
		await expect(panel(page).getByText('Held', { exact: true })).toBeVisible();
		const setsize = Number(await list.getByRole('listitem').first().getAttribute('aria-setsize'));
		expect(setsize).toBeGreaterThan(1000);
		// Arrow keys move through rows beyond the rendered window.
		await page.keyboard.press('End');
		await expect(list.locator(`[data-index="${setsize - 1}"] button`)).toBeFocused();
	});

	test('cache and client panels', async ({ page }) => {
		await demo(page);
		await node(page, 'cache').click();
		await expect(page.locator('#panel-title')).toHaveText('Binary cache');
		await expect(panel(page)).toContainText("only the scheduler's own lookups");
		await expect(
			panel(page).getByRole('list', { name: 'Recent cache activity' }).getByRole('button').first()
		).toBeVisible();

		const group = page.locator('[data-node-button^="clients:"]').first();
		const label = await group.locator('.title').textContent();
		await group.click();
		await expect(page.locator('#panel-title')).toHaveText(label ?? '');
		await expect(panel(page).getByRole('list', { name: /wait on/ })).toBeVisible();
		await page.getByRole('button', { name: 'Close panel' }).click();
		await expect(panel(page)).toBeHidden();
	});

	test('a derivation links to its builder', async ({ page }) => {
		await demo(page);
		await node(page, 'scheduler').click();
		await page.locator('#panel-title').waitFor();
		// Pick an assigned derivation from a builder and follow the link back.
		await node(page, (await builderIds(page))[1]).click();
		const rows = panel(page).getByRole('list', { name: 'Derivations on this builder' });
		await rows.getByRole('button').first().click();
		const link = panel(page).locator('dd button.p-link').first();
		const addr = await link.textContent();
		await link.click();
		await expect(page.locator('#panel-title')).toHaveText(addr?.trim() ?? '');
	});
});

test.describe('pools', () => {
	test('shows pools, not 300 cards, with ?demo&builders=300', async ({ page }) => {
		await demo(page, 'builders=300');
		await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(2);
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(0);
		expect(await page.locator('.svelte-flow__node').count()).toBeLessThan(40);
		const pool = node(page, 'pool:x86_64-linux');
		expect(await pool.locator('[data-addr]').count()).toBeGreaterThan(150);
		// A cell names its builder and its load on hover.
		await expect(pool.locator('[data-addr]').first()).toHaveAttribute(
			'title',
			/^10\.\d+\.\d+\.\d+:50051 · \d+\/\d+ assigned/
		);
		// One line of each kind per pool, not per builder.
		const kinds = async () => (await lineReport(page)).map((l) => l.kind);
		await expect.poll(async () => (await kinds()).filter((k) => k === 'assign').length).toBe(2);
		expect((await kinds()).filter((k) => k === 'publish').length).toBe(2);
	});

	test('a pool opens its panel; search, filter and a row lead to a builder and back', async ({
		page
	}) => {
		await demo(page, 'builders=300');
		const pool = node(page, 'pool:x86_64-linux');
		// Click the summary at the top, since a cell would open its builder.
		await pool.click({ position: { x: 40, y: 16 } });
		await expect(page.locator('#panel-title')).toHaveText('x86_64-linux');
		await expect(pool).toHaveAttribute('aria-expanded', 'true');
		const list = panel(page).getByRole('list', { name: 'Builders in this pool' });
		const rows = list.getByRole('listitem');
		await expect(rows.first()).toBeVisible();
		expect(Number(await rows.first().getAttribute('aria-setsize'))).toBeGreaterThan(150);

		// One quiet x86_64-linux builder, among cloud VMs and own metal.
		const search = panel(page).getByRole('searchbox', { name: /Search builders/ });
		await search.fill('quiet');
		await expect(rows).toHaveCount(1);
		const addr = (await rows.first().locator('.addr').textContent())!.trim();
		expect(addr).toBe('metal-x86-quiet:50051');
		await search.fill(addr);
		await expect(rows).toHaveCount(1);
		await search.fill('no such builder');
		await expect(panel(page).getByText('No builders match.')).toBeVisible();
		await search.fill('');

		// Draining only. The filter's name carries its count.
		const draining = panel(page).getByRole('radio', { name: /^Draining, \d+ builders?$/ });
		await draining.click();
		for (const row of await rows.all()) await expect(row).toContainText('Draining');
		await panel(page).getByRole('radio', { name: 'All' }).click();

		// The way back finds the list as the user left it, focus on the builder's row.
		const sort = panel(page).getByLabel('Sort');
		await search.fill('kvm');
		await sort.selectOption('idle');
		const kvm = (await rows.nth(2).locator('.addr').textContent())!.trim();
		await rows.nth(2).getByRole('button').click();
		await expect(page.locator('#panel-title')).toHaveText(kvm);
		await panel(page).getByRole('button', { name: 'x86_64-linux pool' }).click();
		await expect(page.locator('#panel-title')).toHaveText('x86_64-linux');
		await expect(search).toHaveValue('kvm');
		await expect(sort).toHaveValue('idle');
		await expect(rows.filter({ hasText: kvm }).getByRole('button')).toBeFocused();
	});

	test("a held pool list still follows the user's search", async ({ page }) => {
		await demo(page, 'builders=300');
		await node(page, 'pool:x86_64-linux').click({ position: { x: 40, y: 16 } });
		const list = panel(page).getByRole('list', { name: 'Builders in this pool' });
		await expect(list.getByRole('listitem').first()).toBeVisible();
		// The pointer rests on the list, so live updates hold still.
		await list.hover();
		await list.hover({ position: { x: 60, y: 30 } });
		await expect(panel(page).getByText('Held', { exact: true })).toBeVisible();
		await panel(page)
			.getByRole('searchbox', { name: /Search builders/ })
			.fill('no such builder');
		await expect(panel(page).getByText('No builders match.')).toBeVisible();
	});

	test('a cell opens its builder; Escape goes back to the pool, then closes', async ({ page }) => {
		await demo(page, 'builders=300');
		const pool = node(page, 'pool:x86_64-linux');
		const cell = pool.locator('[data-addr]').nth(5);
		const addr = await cell.getAttribute('data-addr');
		await cell.click();
		await expect(page.locator('#panel-title')).toHaveText(addr ?? '');
		await expect(page.locator('#panel-title')).toBeFocused();
		// The open builder is ringed in the grid.
		await expect(pool.locator('.ring')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('#panel-title')).toHaveText('x86_64-linux');
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(pool).toBeFocused();
	});

	test('the heading toggle shows the cards, refits, and collapses them again', async ({ page }) => {
		await demo(page, 'builders=60');
		await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(2);
		const toggle = poolToggle(page, 'aarch64-linux');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		const count = Number((await toggle.locator('.count').textContent())?.split(' ')[0]);
		// Zoom in first, since a toggle refits anyway.
		const zoomIn = page.getByRole('button', { name: 'Zoom in' });
		for (let i = 0; i < 4; i++) {
			await zoomIn.click();
			await page.waitForTimeout(350);
		}
		await toggle.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(count);
		await expect(node(page, 'pool:aarch64-linux')).toHaveCount(0);
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(toggle).toBeFocused();
		const ids = await builderIds(page);
		await expect(node(page, ids[ids.length - 1])).toBeInViewport();
		await toggle.click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(0);
		await expect(node(page, 'pool:aarch64-linux')).toBeVisible();

		// Many cards shrink the heading; a chip by the zoom buttons collapses them too.
		await toggle.click();
		const chip = page.getByRole('list', { name: 'Pools shown as cards' }).getByRole('button');
		// One count for the group, the heading's; the chip names only the action.
		await expect(chip).toHaveText(/^\s*aarch64-linux\s*·\s*Collapse\s*$/);
		await expect(chip).toHaveAttribute('title', `Collapse these ${count} builders into one pool`);
		await chip.click();
		await expect(node(page, 'pool:aarch64-linux')).toBeVisible();
		await expect(chip).toHaveCount(0);
		await expect(toggle).toBeFocused();
	});

	test('every line draws on one canvas, also after a toggle', async ({ page }) => {
		await demo(page, 'builders=60');
		const layout = () =>
			page.evaluate(() => {
				const canvases = [...document.querySelectorAll<HTMLCanvasElement>('canvas.line-canvas')];
				const c = canvases[0];
				const ids = (window as unknown as ProbeWindow).__lines.report().map((l) => l.id);
				return {
					canvases: canvases.length,
					// Svelte Flow draws no edges of its own.
					edges: document.querySelectorAll('.svelte-flow__edge, .svelte-flow__edge-wrapper').length,
					// The canvas covers the map at the screen's pixel ratio.
					sized:
						c.width === Math.round(c.clientWidth * devicePixelRatio) &&
						c.height === Math.round(c.clientHeight * devicePixelRatio) &&
						c.clientWidth === c.parentElement!.clientWidth,
					lines: ids.length,
					unique: new Set(ids).size
				};
			});
		const check = async () => {
			const l = await layout();
			expect(l.canvases).toBe(1);
			expect(l.edges).toBe(0);
			expect(l.sized).toBe(true);
			expect(l.unique).toBe(l.lines);
			return l.lines;
		};
		await expect(page.locator('.svelte-flow__node-pool')).toHaveCount(2);
		const pooled = await check();
		await page.evaluate(() => {
			(document.querySelector('canvas.line-canvas') as unknown as { tag: number }).tag = 1;
		});
		const toggle = poolToggle(page, 'aarch64-linux');
		await toggle.click();
		await expect(page.locator('.svelte-flow__node-builder').first()).toBeVisible();
		await expect.poll(check).toBeGreaterThan(pooled);
		await toggle.click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(0);
		await expect.poll(check).toBe(pooled);
		// The same canvas throughout.
		expect(
			await page.evaluate(
				() => (document.querySelector('canvas.line-canvas') as unknown as { tag?: number }).tag
			)
		).toBe(1);
	});

	test("lines meet the cache's handles after a toggle moves the buses", async ({ page }) => {
		await demo(page, 'builders=40');
		await poolToggle(page, 'aarch64-linux').click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(13);
		// Distance in px between where each line ends and its handle at the cache.
		const gaps = async () => {
			const out: number[] = [];
			for (const kind of ['publish', 'fetch'] as const) {
				// publish ends at the cache, fetch starts there.
				const p = await pointOn(page, `${kind}:pool:x86_64-linux`, kind === 'publish' ? 1e9 : 0);
				const h = (await page
					.locator(`.svelte-flow__node-cache .svelte-flow__handle[data-handleid="${kind}"]`)
					.boundingBox())!;
				out.push(Math.hypot(p.x - (h.x + h.width / 2), p.y - (h.y + h.height / 2)));
			}
			return out;
		};
		await expect.poll(async () => Math.max(...(await gaps()))).toBeLessThan(3);
	});

	test('lines meet the handles of a builder card and a pool', async ({ page }) => {
		// The canvas draws lines from handlePoint in geometry.ts; the cards place
		// their handles with CSS. A line that misses its handle shows here.
		await demo(page, 'builders=40&upstream=3');
		await poolToggle(page, 'aarch64-linux').click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(13);
		const [card] = await builderIds(page);
		const addr = card.slice('worker:'.length);
		const pool = 'pool:x86_64-linux';
		/** Distance in px from a line's end (or start) to the handle it should meet. */
		const gap = async (line: string, end: boolean, node: string, handle: string) => {
			const p = await pointOn(page, line, end ? 1e9 : 0);
			const h = (await page
				.locator(
					`.svelte-flow__node[data-id="${node}"] .svelte-flow__handle[data-handleid="${handle}"]`
				)
				.boundingBox())!;
			return Math.hypot(p.x - (h.x + h.width / 2), p.y - (h.y + h.height / 2));
		};
		const gaps = async () =>
			Promise.all([
				gap(`assign:${addr}`, true, card, 'in'),
				gap(`publish:${addr}`, false, card, 'publish'),
				gap(`fetch:${addr}`, true, card, 'fetch'),
				gap(`substitute:${addr}`, true, card, 'substitute'),
				gap(`assign:${pool}`, true, pool, 'in'),
				gap(`publish:${pool}`, false, pool, 'publish'),
				gap(`fetch:${pool}`, true, pool, 'fetch'),
				gap(`substitute:${pool}`, true, pool, 'substitute')
			]);
		await expect.poll(async () => Math.max(...(await gaps()))).toBeLessThan(3);
	});

	test('the pool panel shows the pool as cards and collapses it again', async ({ page }) => {
		await demo(page, 'builders=60');
		await node(page, 'pool:aarch64-linux').click({ position: { x: 40, y: 16 } });
		await panel(page).getByRole('button', { name: 'Show cards' }).click();
		await expect(page.locator('.svelte-flow__node-builder').first()).toBeVisible();
		await expect(poolToggle(page, 'aarch64-linux')).toHaveAttribute('aria-expanded', 'true');
		await panel(page).getByRole('button', { name: 'Collapse' }).click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(0);
		await expect(node(page, 'pool:aarch64-linux')).toBeVisible();
	});

	test('churn changes cells and numbers, and the pool stays in place', async ({ page }) => {
		await demo(page, 'builders=300&churn=300');
		const pool = node(page, 'pool:x86_64-linux');
		const wrapper = page.locator('.svelte-flow__node', { has: pool });
		const place = () => wrapper.evaluate((el) => (el as HTMLElement).style.transform);
		const before = await place();
		const first = await pool.locator('[data-addr]').first().getAttribute('data-addr');
		const up = await pool.locator('.title').textContent();
		await expect(pool.locator('.title')).not.toHaveText(up ?? '', { timeout: 20_000 });
		expect(await place()).toBe(before);
		// A builder keeps its cell.
		await expect(pool.locator('[data-addr]').first()).toHaveAttribute('data-addr', first ?? '');
	});
});

test.describe('lines', () => {
	test('the cache hits line is thin and dashed, carries no dots, and its dashes creep', async ({
		page
	}) => {
		await demo(page);
		const cached = () => lineOf(page, 'cached:scheduler');
		await expect.poll(async () => (await cached())?.lookup).toBe(true);
		// Hits come in, which colors it, but it never carries dots or turns active.
		await expect.poll(async () => (await cached())?.hits, { timeout: 10_000 }).toBe(true);
		const line = (await cached())!;
		expect(line.dash.length).toBeGreaterThan(0);
		expect(line.stroke).toBeLessThanOrEqual(1.5);
		expect(line.active).toBe(false);
		expect(line.dots).toEqual([]);
		// While hits come in, its dashes creep along it, far slower than dots.
		await expect
			.poll(async () => {
				const now = (await cached())!;
				if (!now.hits || !line.hits) return null;
				const speed = ((now.dashOffset - line.dashOffset) * 1000) / (now.time - line.time);
				return speed > 1 && speed < SPEED / 4;
			})
			.toBe(true);
		await expect(page.getByRole('list', { name: 'Line colors' })).toContainText('Cache hits');
	});

	test("a failing builder's assignment line carries red bars, and no fixed mark", async ({
		page
	}) => {
		// One builder fails 80% of its builds, and no other builder fails.
		await demo(page, 'builders=6&fail=0&failing=1&speed=4');
		const assign = async () => (await lineReport(page)).filter((l) => l.kind === 'assign');
		await expect
			.poll(async () => (await assign()).filter((l) => l.fails > 0).length, { timeout: 15_000 })
			.toBe(1);
		const id = (await assign()).find((l) => l.fails > 0)!.id;
		// Red bars travel among its dots, in the same stream, and move as the dots do.
		await expect
			.poll(async () => (await lineOf(page, id))?.dots.some((d) => d.red), { timeout: 15_000 })
			.toBe(true);
		const a = (await lineOf(page, id))!;
		await page.waitForTimeout(300);
		const b = (await lineOf(page, id))!;
		expect(onCourse(a, b)).toBe(true);
		// Nothing red stays fixed at its end, where the user found those squares stuck.
		expect('flag' in b).toBe(false);
		// No other assignment line has red bars.
		for (const l of await assign()) {
			if (l.id === id) continue;
			expect(
				l.dots.some((d) => d.red),
				l.id
			).toBe(false);
		}
		// The groups that waited on its failed builds carry the share on their request lines.
		expect((await lineReport(page)).some((l) => l.kind === 'request' && l.fails > 0)).toBe(true);
		const legend = page.getByRole('list', { name: 'Line colors' });
		await expect(legend).toContainText('Failed builds');
	});

	test('the legend: kinds, then the note and the Rates switch, as wide as the wider row', async ({
		page
	}) => {
		await demo(page);
		const legend = page.locator('.legend');
		const geometry = () =>
			legend.evaluate((box) => {
				const r = (el: Element) => el.getBoundingClientRect();
				const items = [...box.querySelectorAll('.items li')].map(r);
				const note = box.querySelector('.note')!;
				const pad = parseFloat(getComputedStyle(box).paddingLeft);
				const border = parseFloat(getComputedStyle(box).borderLeftWidth);
				return {
					box: r(box).width,
					rows: new Set(items.map((i) => Math.round(i.top))).size,
					itemsRight: Math.max(...items.map((i) => i.right)) - r(box).left,
					noteTop: r(note).top,
					itemsBottom: Math.max(...items.map((i) => i.bottom)),
					// The note's text and the Rates switch, not the row's block, which fills the box.
					noteText: (() => {
						const range = document.createRange();
						range.selectNodeContents(box.querySelector('.note-row')!);
						return range.getBoundingClientRect().width;
					})(),
					inner: r(box).width - 2 * (pad + border)
				};
			});
		const wide = await geometry();
		// One row of kinds at 1440 px, the note under it.
		expect(wide.rows).toBe(1);
		expect(wide.noteTop).toBeGreaterThanOrEqual(wide.itemsBottom);
		// No empty strip. The box ends where its wider row does.
		const row = wide.itemsRight - (wide.box - wide.inner) / 2;
		expect(Math.abs(Math.max(row, wide.noteText) - wide.inner)).toBeLessThan(2);

		// A narrow map wraps the kinds, and the box stays inside the map.
		await page.locator('.farm-map').evaluate((el) => {
			(el as HTMLElement).style.right = 'auto';
			(el as HTMLElement).style.width = '520px';
		});
		await expect.poll(async () => (await geometry()).rows).toBeGreaterThan(1);
		const narrow = await geometry();
		expect(narrow.box).toBeLessThanOrEqual(520 - 150);
	});

	test('reduced motion keeps still failure bars', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await demo(page, 'builders=6&fail=0&failing=1&speed=4');
		const assign = async () => (await lineReport(page)).filter((l) => l.kind === 'assign');
		await expect
			.poll(async () => (await assign()).filter((l) => l.fails > 0 && l.still.length > 0).length, {
				timeout: 15_000
			})
			.toBe(1);
		for (const l of await lineReport(page)) {
			expect(l.dots, l.id).toEqual([]);
			if (l.kind !== 'assign') continue;
			const failing = l.fails > 0;
			expect(l.still.length > 0, l.id).toBe(failing);
		}
		// They stand still.
		const a = (await assign()).find((l) => l.fails > 0)!;
		await page.waitForTimeout(500);
		const b = (await lineOf(page, a.id))!;
		if (b.level === a.level && b.fails === a.fails) expect(b.still).toEqual(a.still);
	});

	test('rates on lines: toggle, text, no overlap, session only', async ({ page }) => {
		// One builder fails 80% of its builds, and no other builder fails.
		await demo(page, 'builders=12&fail=0&failing=1');
		const toggle = page.getByRole('button', { name: 'Rates on lines' });
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await expect(page.locator('.rate-label')).toHaveCount(0);
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.rate-label').first()).toBeVisible();

		// Every drawn line with traffic has one label with a rate, except request
		// lines, whose client card shows the rate. Labels read once a second, so
		// a line that just woke up may wait for the next. While the farm warms
		// up, lines wake often, so give it a few seconds.
		const missing = () =>
			page.evaluate(() => {
				const labels = [...document.querySelectorAll('.rate-label')];
				const text = new Map(labels.map((l) => [l.getAttribute('data-id'), l.textContent ?? '']));
				if (text.size !== labels.length) return ['duplicate label'];
				return (window as unknown as ProbeWindow).__lines
					.report()
					.filter((l) => (l.active || l.hits) && l.kind !== 'request')
					.map((l) => l.id)
					.filter((id) => !/\/(s|min)\b/.test(text.get(id) ?? ''));
			});
		await expect.poll(missing, { timeout: 10_000 }).toEqual([]);
		// A request line's label, where there is one, gives only its failure share.
		for (const t of await page.locator('.rate-label[data-id^="want:"]').allTextContents())
			expect(t).toMatch(/^\s*(<1|\d+)% failed\s*$/);

		// The failing builder's assignment label gives its share on a second line.
		const failing = page
			.locator('.rate-label[data-id^="assign:"]')
			.filter({ hasText: /\d+% failed/ });
		await expect(failing).toHaveCount(1, { timeout: 10_000 });
		const danger = await page.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--danger-fg)';
			document.querySelector('.svelte-flow')!.append(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		});
		await expect(failing.locator('.fail')).toHaveCSS('color', danger);

		// Label boxes overlap neither each other nor any card.
		const overlaps = await page.evaluate(() => {
			const box = (e: Element) => e.getBoundingClientRect();
			const hit = (a: DOMRect, b: DOMRect) =>
				a.left < b.right - 0.5 &&
				b.left < a.right - 0.5 &&
				a.top < b.bottom - 0.5 &&
				b.top < a.bottom - 0.5;
			const labels = [...document.querySelectorAll('.rate-label')];
			const nodes = [...document.querySelectorAll('.farm-node')].map(box);
			const out: string[] = [];
			labels.forEach((l, i) => {
				const a = box(l);
				const id = l.getAttribute('data-id');
				for (const m of labels.slice(i + 1))
					if (hit(a, box(m))) out.push(`${id} / ${m.getAttribute('data-id')}`);
				if (nodes.some((n) => hit(a, n))) out.push(`${id} on a card`);
			});
			return out;
		});
		expect(overlaps).toEqual([]);

		// The labels hold still, and each label's text changes at most once a
		// second. A label comes and goes only as its line wakes up or goes
		// idle, and one that keeps its size keeps its place.
		const placed = () =>
			page
				.locator('.rate-label')
				.evaluateAll((els) =>
					Object.fromEntries(
						els.map((e) => [
							e.getAttribute('data-id')!,
							`${(e as HTMLElement).style.transform} ${(e as HTMLElement).style.width} ${(e as HTMLElement).style.height}`
						])
					)
				);
		const before = await placed();
		await page.evaluate(() => {
			const w = window as unknown as { __changes: Record<string, number> };
			w.__changes = {};
			new MutationObserver((records) => {
				const seen = new Set<string>();
				for (const r of records) {
					const el = (r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
						'.rate-label'
					);
					const id = el?.getAttribute('data-id');
					if (id) seen.add(id);
				}
				for (const id of seen) w.__changes[id] = (w.__changes[id] ?? 0) + 1;
			}).observe(document.querySelector('.rate-labels')!, {
				subtree: true,
				childList: true,
				characterData: true
			});
		});
		await page.waitForTimeout(3000);
		const after = await placed();
		const kept = Object.keys(before).filter((id) => id in after);
		expect(kept.length).toBeGreaterThanOrEqual(Object.keys(before).length - 3);
		const size = (v: string) => v.split(' ').slice(-2).join(' ');
		const moved = kept.filter(
			(id) => size(before[id]) === size(after[id]) && before[id] !== after[id]
		);
		expect(moved).toEqual([]);
		const changes = await page.evaluate(
			() => (window as unknown as { __changes: Record<string, number> }).__changes
		);
		expect(Math.max(0, ...Object.values(changes))).toBeLessThanOrEqual(4);

		await toggle.click();
		await expect(page.locator('.rate-label')).toHaveCount(0);

		// It lasts for the session only. After a reload the toggle is off, and nothing was stored.
		await toggle.click();
		await page.reload();
		await expect(pill(page)).toHaveText('Live');
		await expect(page.getByRole('button', { name: 'Rates on lines' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
		await expect(page.locator('.rate-label')).toHaveCount(0);
		const stored = await page.evaluate(() => [
			...Object.keys(localStorage),
			...Object.keys(sessionStorage)
		]);
		expect(
			stored.filter((k) => k !== 'nix-grpc-dashboard:farm-address' && !k.startsWith('sveltekit:'))
		).toEqual([]);
	});

	test('labels and badges trim their text to the capitals, with even padding', async ({ page }) => {
		// One builder fails 80% of its builds, so its assignment label has two lines.
		await demo(page, 'builders=12&fail=0&failing=1');
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		const failing = page
			.locator('.rate-label[data-id^="assign:"]')
			.filter({ hasText: /\d+% failed/ });
		await expect(failing).toHaveCount(1, { timeout: 10_000 });

		/** An element's content box against its font's capital height, in CSS px at zoom 1. */
		const measure = (sel: string) =>
			page.evaluate((sel) => {
				const el = document.querySelector<HTMLElement>(sel)!;
				const s = getComputedStyle(el);
				const r = el.getBoundingClientRect();
				// Labels scale with the map; offsetHeight does not.
				const zoom = r.height / el.offsetHeight;
				const ctx = document.createElement('canvas').getContext('2d')!;
				// At 100 px, so hinting at small sizes does not round the capitals.
				ctx.font = `${s.fontWeight} 100px ${s.fontFamily}`;
				const px = (v: string) => parseFloat(v);
				return {
					trim: s.getPropertyValue('text-box-trim'),
					edge: s.getPropertyValue('text-box-edge'),
					cap: (ctx.measureText('H').actualBoundingBoxAscent * px(s.fontSize)) / 100,
					content:
						r.height / zoom -
						px(s.paddingTop) -
						px(s.paddingBottom) -
						px(s.borderTopWidth) -
						px(s.borderBottomWidth),
					padTop: px(s.paddingTop),
					padBottom: px(s.paddingBottom)
				};
			}, sel);

		// The label has two lines of capitals, with the same padding above and below, inside a border.
		const label = await failing.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const zoom = r.height / (el as HTMLElement).offsetHeight;
			const rows = [...el.children].map((c) => c.getBoundingClientRect());
			const bar = el.querySelector('.fail i')!.getBoundingClientRect();
			// Where each line's text sits in its row: the same for both when both are trimmed.
			const textTop = (row: Element) => {
				const span = row.querySelector('.text') ?? row;
				const range = document.createRange();
				range.selectNodeContents(span);
				return (range.getClientRects()[0].top - row.getBoundingClientRect().top) / zoom;
			};
			// How far the g of "assigned/min" and the line under it reach below each baseline.
			const s = getComputedStyle(el.querySelector('.text')!);
			const ctx = document.createElement('canvas').getContext('2d')!;
			ctx.font = `${s.fontWeight} 100px ${s.fontFamily}`;
			const g = ctx.measureText('gq');
			const font = g.fontBoundingBoxDescent / 10;
			const ink = g.actualBoundingBoxDescent / 10;
			const baseline = (row: Element) => {
				const range = document.createRange();
				range.selectNodeContents(row.querySelector('.text') ?? row);
				return (range.getClientRects()[0].bottom - r.top) / zoom - font;
			};
			const [first, second] = [...el.children];
			return {
				// Room from each line's descenders to what is under them: the next
				// line's capitals, or the border.
				clear: [
					(second.getBoundingClientRect().top - r.top) / zoom - baseline(first) - ink,
					(el as HTMLElement).offsetHeight - 1 - baseline(second) - ink
				],
				textTops: [...el.children].map(textTop),
				h: (el as HTMLElement).offsetHeight,
				// The height the placement planned the label at, from labelSize.
				planned: parseFloat((el as HTMLElement).style.height),
				above: (rows[0].top - r.top) / zoom,
				below: (r.bottom - rows[1].bottom) / zoom,
				rows: rows.map((x) => Math.round((x.height / zoom) * 10) / 10),
				bar: { w: Math.round(bar.width / zoom), h: Math.round(bar.height / zoom) }
			};
		});
		// The box is the size the placement planned, so labels it kept apart stay apart.
		expect(label.h).toBe(label.planned);
		expect(label.rows[0]).toBe(label.rows[1]);
		// The same padding above the capitals and below the baseline, so the text is centred.
		expect(label.above).toBeCloseTo(label.below, 1);
		// The descenders of "assigned/min" keep 2 px from the next line's capitals.
		expect(label.clear[0], `${label.clear}`).toBeGreaterThanOrEqual(2);
		// The last line's descenders hang into the bottom padding and keep about 1 px.
		expect(label.clear[1], `${label.clear}`).toBeGreaterThanOrEqual(1);
		// A short level bar, not an upright one that reads as "I".
		expect(label.bar.w).toBeGreaterThan(2 * label.bar.h);
		// The failure line's text is trimmed too, not left to sit high in its row.
		expect(Math.abs(label.textTops[0] - label.textTops[1]), `${label.textTops}`).toBeLessThan(0.25);

		const id = await failing.getAttribute('data-id');
		const rate = `.rate-label[data-id="${id}"] > .text`;
		const fail = `.rate-label[data-id="${id}"] .fail .text`;
		for (const target of [rate, fail, '.badge', '.pill .trim']) {
			const m = await measure(target);
			expect(m.trim, target).toBe('trim-both');
			expect(m.edge, target).toBe('cap alphabetic');
			// The box holds the capitals and nothing above or below them.
			expect(Math.abs(m.content - m.cap), `${target}: ${m.content} against ${m.cap}`).toBeLessThan(
				0.75
			);
			expect(m.padTop, target).toBe(m.padBottom);
		}
		// The pill centres its trimmed text.
		const pillGap = await page.evaluate(() => {
			const p = document.querySelector('.pill')!.getBoundingClientRect();
			const t = document.querySelector('.pill .trim')!.getBoundingClientRect();
			return { top: t.top - p.top, bottom: p.bottom - t.bottom };
		});
		expect(Math.abs(pillGap.top - pillGap.bottom)).toBeLessThan(0.75);
	});

	test('labels hide below zoom 0.6 and the legend says why', async ({ page }) => {
		await demo(page);
		const note = page.locator('.legend .note');
		const labels = page.locator('.rate-labels');
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		await expect(page.locator('.rate-label').first()).toBeVisible();
		expect(await zoomOf(page)).toBeGreaterThanOrEqual(0.6);
		await expect(note).toHaveText('Thicker lines carry more traffic');
		// Each unit has its own width scale, and the note says so to the pointer and screen readers.
		const widths =
			'Line widths compare only within one unit: derivations per minute, or bytes per second.';
		await expect(note).toHaveAttribute('title', widths);
		await expect(note).toHaveAttribute('aria-description', widths);

		const zoomOut = page.getByRole('button', { name: 'Zoom out' });
		while ((await zoomOf(page)) >= 0.6) {
			await zoomOut.click();
			await page.waitForTimeout(350);
		}
		await expect(labels).toBeHidden();
		await expect(note).toHaveText('Zoom in to read rates on lines');
		await expect(note).not.toHaveAttribute('title');
		await expect(note).not.toHaveAttribute('aria-description');
		// Hidden labels cost nothing: no label elements, and nothing in the
		// overlay changes while the numbers move on.
		await expect(page.locator('.rate-label')).toHaveCount(0);
		const writes = await labels.evaluate(
			(el) =>
				new Promise<number>((done) => {
					let n = 0;
					const obs = new MutationObserver((records) => (n += records.length));
					obs.observe(el, {
						subtree: true,
						childList: true,
						characterData: true,
						attributes: true
					});
					setTimeout(() => {
						obs.disconnect();
						done(n);
					}, 2500);
				})
		);
		expect(writes).toBe(0);
		// Without labels there is nothing to zoom in for.
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		await expect(note).toHaveText('Thicker lines carry more traffic');
		await page.getByRole('button', { name: 'Rates on lines' }).click();

		await page.getByRole('button', { name: 'Fit the whole farm' }).click();
		await expect.poll(() => zoomOf(page)).toBeGreaterThanOrEqual(0.6);
		await expect(page.locator('.rate-label').first()).toBeVisible();
		await expect(note).toHaveText('Thicker lines carry more traffic');
	});

	test('labels mount or drop for the zoom only when a gesture ends', async ({ page }) => {
		await demo(page);
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		await expect(page.locator('.rate-label').first()).toBeVisible();
		await viewSettled(page);
		expect(await zoomOf(page)).toBeGreaterThanOrEqual(0.6);
		// Every frame of one wheel gesture that crosses 0.6: whether the map
		// holds, the zoom, and how many labels there are.
		const p = await emptyPanePoint(page);
		await page.mouse.move(p.x, p.y);
		const seen = await wheelGesture(page, p, { steps: 40, deltaY: 30, until: 0.5 });
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		const below = seen.filter((f) => f.moving && f.zoom < 0.6);
		expect(below.length).toBeGreaterThan(3);
		// Mid-gesture, below 0.6, the labels stay as they were.
		expect(below.filter((f) => f.labels === 0)).toEqual([]);
		// Once the gesture ends, they go.
		await expect(page.locator('.rate-label')).toHaveCount(0);
	});

	test('hovering a line shows its readout', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		const readout = page.locator('.line-readout');
		await expect(page.getByRole('button', { name: 'Rates on lines' })).toHaveAttribute(
			'aria-pressed',
			'false'
		);
		await expect(readout).toHaveCount(0);

		// The view refits as client groups come and go, which hides the
		// readout, so each check moves to a freshly measured point.
		const hover = async (edge: string, at: number, ...texts: (string | RegExp)[]) =>
			expect(async () => {
				const p = await pointOn(page, edge, at);
				await page.mouse.move(p.x, p.y - 1);
				await page.mouse.move(p.x, p.y);
				for (const text of texts) await expect(readout).toContainText(text, { timeout: 1000 });
				// A stroke of the line's color keys the name, and a red bar leads the failed share.
				await expect(readout.locator('.title .line-key.flow-assign')).toHaveCount(1, {
					timeout: 1000
				});
				const failed = (await readout.locator('.numbers').textContent())?.includes('failed');
				await expect(readout.locator('.numbers .fail-bar')).toHaveCount(failed ? 1 : 0, {
					timeout: 1000
				});
			}).toPass();

		// The builder's own stretch, between its trunk and its card.
		// The numbers lead, and the name follows.
		await hover(`assign:${addr}`, -20, /^\S+ assigned\/min/, `Assignments to ${addr}`);
		await expect(page.locator('.farm-map')).toHaveClass(/hovering/);

		// The stub out of the scheduler carries every assignment line. 5% of
		// builds fail, so with 12 lines the share shows within seconds. Line
		// counts start when the page went live, so the readout says "since"
		// while the header totals, from the farm's history, cover the window
		// and need no caption.
		await expect(page.locator('.totals .caption')).toHaveCount(0);
		await hover(
			`assign:${addr}`,
			20,
			// A no-break space keeps the "·" off the start of a line.
			/^\S+ assigned\/min\s·\s(<1|\d+)% failed \(since [^)]+\)\s*Assignments to 12 builders$/
		);

		// Over a card, the readout goes.
		await node(page, id).hover();
		await expect(readout).toHaveCount(0);
		await expect(page.locator('.farm-map')).not.toHaveClass(/hovering/);
	});

	test('a held pan or zoom holds the labels, and hover waits', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		const readout = page.locator('.line-readout');
		const moving = page.locator('.farm-map.moving');
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		await expect(page.locator('.rate-label').first()).toBeVisible();
		await viewSettled(page);
		// Counts every change inside the label overlay from now on.
		const count = await page.evaluateHandle(() => {
			const box = { n: 0 };
			new MutationObserver((records) => (box.n += records.length)).observe(
				document.querySelector('.rate-labels')!,
				{ subtree: true, childList: true, characterData: true, attributes: true }
			);
			return box;
		});
		const changes = () => count.evaluate((box) => box.n);
		// The labels read numbers once a second, so they change while the view rests.
		await expect.poll(changes, { timeout: 10_000 }).toBeGreaterThan(0);

		// Zoom with the wheel over a line whose readout shows, for 2 s, and
		// move the pointer between steps: no readout, no hit test, and the
		// labels keep their numbers.
		await expect(async () => {
			const p = await pointOn(page, `assign:${addr}`, -20);
			await page.mouse.move(p.x, p.y - 1);
			await page.mouse.move(p.x, p.y);
			await expect(readout).toBeVisible({ timeout: 1000 });
		}).toPass();
		const p = await pointOn(page, `assign:${addr}`, -20);
		await page.mouse.wheel(0, -20);
		await expect(moving).toHaveCount(1);
		await expect(readout).toHaveCount(0);
		const atStart = await changes();
		// Every frame of the zoom: whether the map holds, and whether a readout shows.
		const zoom = await wheelGesture(page, p, { steps: 30, deltaY: -8, wiggle: true });
		expect(zoom.length).toBeGreaterThan(30);
		expect(zoom.filter((f) => !f.moving)).toEqual([]);
		expect(zoom.filter((f) => f.readout)).toEqual([]);
		expect(await changes()).toBe(atStart);
		await expect(moving).toHaveCount(0);

		// During a drag held for 2.5 s, the labels hold too.
		const start = await emptyPanePoint(page);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 30, start.y + 10, { steps: 3 });
		await expect(moving).toHaveCount(1);
		const held = await changes();
		for (let i = 0; i < 5; i++) {
			await page.mouse.move(start.x + 30 + i, start.y + 10);
			await page.waitForTimeout(500);
		}
		expect(await changes()).toBe(held);
		await expect(readout).toHaveCount(0);
		await page.mouse.up();
		await expect(moving).toHaveCount(0);
		// When the view rests, the numbers catch up.
		await expect.poll(changes, { timeout: 10_000 }).toBeGreaterThan(held);
	});

	test('clicking a node keeps its lines bright', async ({ page }) => {
		await demo(page);
		const ids = await builderIds(page);
		const addr = ids[6].slice('worker:'.length);
		const other = ids[0].slice('worker:'.length);
		const map = page.locator('.farm-map');
		await expect(map).not.toHaveClass(/focusing/);

		await node(page, ids[6]).click();
		await expect(map).toHaveClass(/focusing/);
		for (const kind of ['assign', 'publish', 'fetch'])
			await expect.poll(() => opacity(page, `${kind}:${addr}`)).toBe(1);
		await expect.poll(() => opacity(page, `assign:${other}`)).toBe(0.2);
		await expect.poll(() => opacity(page, 'cached:scheduler')).toBe(0.2);
		// A faded node's text turns to --fg-muted; the bright one keeps its own.
		const muted = await page.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--fg-muted)';
			document.querySelector('.svelte-flow')!.append(probe);
			const c = getComputedStyle(probe).color;
			probe.remove();
			return c;
		});
		await expect(node(page, ids[0]).locator('.title')).toHaveCSS('color', muted);
		await expect(node(page, ids[6]).locator('.title')).not.toHaveCSS('color', muted);
		await expect(node(page, 'scheduler').locator('.title')).not.toHaveCSS('color', muted);

		// Focus never moves the view, and Escape ends it with the panel.
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(map).not.toHaveClass(/focusing/);
		await expect.poll(() => opacity(page, `assign:${other}`)).toBe(1);
	});

	test("a builder picked from a pool lights the pool's lines", async ({ page }) => {
		await demo(page, 'builders=30');
		const pool = node(page, 'pool:x86_64-linux');
		await pool.locator('[data-addr]').nth(3).click();
		await expect(page.locator('.farm-map')).toHaveClass(/focusing/);
		await expect.poll(() => opacity(page, 'assign:pool:x86_64-linux')).toBe(1);
		await expect.poll(() => opacity(page, 'cached:scheduler')).toBe(0.2);
	});

	test('focus fades the other lines, and they brighten when it ends', async ({ page }) => {
		// lineLayer.test.ts checks that faded dots keep their course and nothing
		// restarts; this checks the clicks and Escape reach the canvas.
		await demo(page);
		const ids = await builderIds(page);
		const addr = ids[6].slice('worker:'.length);
		const map = page.locator('.farm-map');
		await viewSettled(page);
		const fades = async (bright: (id: string) => boolean) => {
			await expect
				.poll(async () =>
					(await lineReport(page)).every((l) => l.fade === (bright(l.id) ? 1 : 0.2))
				)
				.toBe(true);
		};
		const ends = async () => {
			await page.keyboard.press('Escape');
			await expect(map).not.toHaveClass(/focusing/);
			await fades(() => true);
		};

		// For a node, its three lines stay bright.
		await node(page, ids[6]).click();
		await expect(map).toHaveClass(/focusing/);
		const mine = new Set(['assign', 'publish', 'fetch'].map((k) => `${k}:${addr}`));
		await fades((id) => mine.has(id));
		await ends();

		// For a bundle, the stub out of the scheduler lights every assignment line.
		await clickLine(page, `assign:${addr}`, 20);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(
			/^Assignments to \d+ builders$/
		);
		await fades((id) => id.startsWith('assign:'));
		await ends();
	});

	test('faded nodes keep AA', async ({ page }) => {
		for (const scheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			await demo(page);
			const ids = await builderIds(page);
			await node(page, ids[6]).click();
			await expect(page.locator('.farm-map')).toHaveClass(/focusing/);
			const report = await page.evaluate(() => {
				const rgb = (c: string) =>
					c
						.match(/[\d.]+/g)!
						.slice(0, 3)
						.map(Number);
				const lum = (c: string) => {
					const [r, g, b] = rgb(c).map((v) => {
						const s = v / 255;
						return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
					});
					return 0.2126 * r + 0.7152 * g + 0.0722 * b;
				};
				const ratio = (a: string, b: string) => {
					const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
					return (x + 0.05) / (y + 0.05);
				};
				const probe = document.createElement('span');
				probe.style.color = 'var(--fg-muted)';
				document.querySelector('.svelte-flow')!.append(probe);
				const muted = getComputedStyle(probe).color;
				probe.remove();
				const faded = [...document.querySelectorAll<HTMLElement>('.farm-live')].filter(
					(w) => getComputedStyle(w).getPropertyValue('--chrome').trim() === '0.35'
				);
				const wrong: string[] = [];
				let checked = 0;
				let lowest = Infinity;
				for (const w of faded) {
					const bg = getComputedStyle(w.querySelector('.farm-node')!).backgroundColor;
					for (const el of w.querySelectorAll<HTMLElement>('.farm-node *')) {
						if (el.closest('[aria-hidden="true"]')) continue;
						const text = [...el.childNodes].some(
							(n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()
						);
						if (!text || el.getClientRects().length === 0) continue;
						checked++;
						const c = getComputedStyle(el).color;
						if (c !== muted) wrong.push(`${el.className}: ${c}`);
						lowest = Math.min(lowest, ratio(c, bg));
					}
				}
				return { faded: faded.length, checked, wrong, lowest };
			});
			expect(report.faded).toBeGreaterThan(10);
			expect(report.checked).toBeGreaterThan(50);
			expect(report.wrong).toEqual([]);
			expect(report.lowest).toBeGreaterThanOrEqual(5.1);
		}
	});

	test('keyboard: node panel Lines rows open the line panel', async ({ page }) => {
		await demo(page);
		// Lines are not tab stops, so Tab goes from node to node.
		for (let i = 0; i < 20; i++) {
			await page.keyboard.press('Tab');
			const onLine = await page.evaluate(
				() => !!document.activeElement?.closest('.svelte-flow__edges, canvas')
			);
			expect(onLine).toBe(false);
		}
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		const b = node(page, id);
		await b.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#panel-title')).toHaveText(addr);
		await expect(page.locator('#panel-title')).toBeFocused();

		// The first stop after the heading is the Assignments row.
		await page.keyboard.press('Tab');
		const row = panel(page).getByRole('button', { name: /^Assignments from the scheduler, / });
		await expect(row).toBeFocused();
		await expect(row).toHaveAccessibleName(/assigned per minute/);
		await expect(row.locator('.name')).toHaveText('Assignments');
		await page.keyboard.press('Enter');
		const title = `Assignments to ${addr}`;
		await expect(page.locator('#panel-title')).toHaveAccessibleName(title);
		await expect(page.locator('#panel-title')).toBeFocused();
		// The canvas keeps that line bright, and the builder's other lines fade.
		await expect(page.locator('.farm-map')).toHaveClass(/focusing/);
		await expect.poll(() => opacity(page, `assign:${addr}`)).toBe(1);
		await expect.poll(() => opacity(page, `publish:${addr}`)).toBe(0.2);
		await expect(
			panel(page).getByRole('button', { name: addr, exact: true }).first()
		).toBeVisible();

		// Escape goes back to the builder panel, then closes and returns focus.
		await page.keyboard.press('Escape');
		await expect(page.locator('#panel-title')).toHaveText(addr);
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(b).toBeFocused();
	});

	test('a line panel links to the nodes at its ends', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		await node(page, id).click();
		await panel(page)
			.getByRole('button', { name: /^Publishes to the cache, / })
			.click();
		await expect(page.locator('#panel-title')).toHaveAccessibleName(`Publishes from ${addr}`);
		await expect(page.locator('#panel-title')).toHaveText(addr);
		// Back names the builder panel under it.
		const back = panel(page).locator('button.back');
		await expect(back).toHaveText(addr);
		await panel(page).getByRole('button', { name: 'Binary cache' }).click();
		await expect(page.locator('#panel-title')).toHaveText('Binary cache');
		// A node link starts over, so the panel has no way back.
		await expect(back).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
	});

	test('clicking a line focuses it and opens its panel', async ({ page }) => {
		await demo(page, 'fail=0.3');
		const ids = await builderIds(page);
		const addr = ids[6].slice('worker:'.length);
		const other = ids[0].slice('worker:'.length);
		const map = page.locator('.farm-map');
		const title = `Assignments to ${addr}`;
		// The builder's own stretch, between its trunk and its card.
		await clickLine(page, `assign:${addr}`, -10);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(title);
		// Seen: the kind in the kicker, after a dot in the line's color, and the address.
		await expect(page.locator('#panel-title')).toHaveText(addr);
		await expect(panel(page).locator('.kicker')).toHaveText('Assignments');
		const legendBlue = await page
			.locator('.legend .swatch.flow-assign')
			.first()
			.evaluate((el) => getComputedStyle(el).backgroundColor);
		await expect(panel(page).locator('.kicker .kind-dot')).toHaveCSS(
			'background-color',
			legendBlue
		);
		await expect(map).toHaveClass(/focusing/);
		await expect.poll(() => opacity(page, `assign:${addr}`)).toBe(1);
		await expect.poll(() => opacity(page, `publish:${addr}`)).toBe(0.2);
		await expect.poll(() => opacity(page, `assign:${other}`)).toBe(0.2);

		const fact = (name: RegExp) =>
			panel(page)
				.locator('.p-facts > div')
				.filter({ has: page.locator('dt', { hasText: name }) })
				.locator('dd');
		await expect(fact(/^Now$/)).toHaveText(/assigned\/min$/);
		await expect(panel(page).getByRole('img', { name: /^Assignments per minute/ })).toBeVisible();
		// 30% of builds fail, so the share shows soon.
		await expect(fact(/^Failed$/)).toHaveText(/^[\d,.k]+ of [\d,.k]+, (<1|\d+)%$/, {
			timeout: 20_000
		});

		// An item opens its build, and Back returns to the line.
		const items = panel(page).getByRole('list', { name: 'Derivations on this line' });
		const item = items.getByRole('button').first();
		await expect(item).toBeVisible();
		const name = await item.locator('.name').textContent();
		await item.click();
		await expect(panel(page).getByText('Derivation', { exact: true })).toBeVisible();
		await expect(page.locator('#panel-title')).toHaveText(name ?? '');
		// The line stays in focus under its build.
		await expect(map).toHaveClass(/focusing/);
		await expect(panel(page).locator('button.back')).toHaveText(title);
		await panel(page).locator('button.back').click();
		await expect(page.locator('#panel-title')).toHaveAccessibleName(title);
	});

	test('clicking the scheduler bus focuses the bundle, and a row narrows it', async ({ page }) => {
		await demo(page, 'builders=6');
		const addrs = (await builderIds(page)).map((id) => id.slice('worker:'.length));
		expect(addrs).toHaveLength(6);
		// Between the scheduler and the spread onto the tracks, every assignment line runs together.
		await clickLine(page, `assign:${addrs[0]}`, 20);
		const bundle = 'Assignments to 6 builders';
		await expect(page.locator('#panel-title')).toHaveAccessibleName(bundle);
		await expect(page.locator('#panel-title')).toHaveText('6 builders');
		await expect(panel(page).locator('.kicker')).toHaveText('Assignments');
		const rows = panel(page)
			.getByRole('list', { name: 'Lines in this bundle' })
			.getByRole('button');
		await expect(rows).toHaveCount(6);
		await expect(page.locator('.farm-map')).toHaveClass(/focusing/);
		for (const a of addrs) {
			await expect.poll(() => opacity(page, `assign:${a}`)).toBe(1);
			await expect.poll(() => opacity(page, `publish:${a}`)).toBe(0.2);
		}

		// A row narrows the focus to its line.
		const name = (await rows.first().locator('.member-name').textContent())?.trim() ?? '';
		expect(addrs).toContain(name);
		await rows.first().click();
		await expect(page.locator('#panel-title')).toHaveAccessibleName(`Assignments to ${name}`);
		await expect(panel(page).locator('button.back')).toHaveText(bundle);
		await expect.poll(() => opacity(page, `assign:${name}`)).toBe(1);
		const other = addrs.find((a) => a !== name)!;
		await expect.poll(() => opacity(page, `assign:${other}`)).toBe(0.2);
		await panel(page).locator('button.back').click();
		await expect(page.locator('#panel-title')).toHaveAccessibleName(bundle);
		await expect.poll(() => opacity(page, `assign:${other}`)).toBe(1);
	});

	test('a click on a label focuses its line', async ({ page }) => {
		await demo(page);
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		// A publish label sits beside its line, not on it, and may cross trunks
		// of other lines. A click there goes to the label.
		const label = page.locator('.rate-label[data-id^="publish:"]').first();
		await expect(label).toBeVisible();
		await viewSettled(page, {});
		const id = (await label.getAttribute('data-id')) ?? '';
		const box = (await label.boundingBox())!;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(
			`Publishes from ${id.slice('publish:'.length)}`
		);
		await expect(page.locator('.farm-map')).toHaveClass(/focusing/);
		await expect.poll(() => opacity(page, id)).toBe(1);
	});

	test('Escape and the empty map end focus', async ({ page }) => {
		await demo(page);
		const map = page.locator('.farm-map');
		const addr = (await builderIds(page))[0].slice('worker:'.length);
		await clickLine(page, `assign:${addr}`, -10);
		await expect(panel(page)).toBeVisible();
		await expect(map).toHaveClass(/focusing/);
		// No node panel was open under it, so one Escape closes.
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		await expect(map).not.toHaveClass(/focusing/);

		await clickLine(page, `assign:${addr}`, -10);
		await expect(panel(page)).toBeVisible();
		await expect(map).toHaveClass(/focusing/);
		await viewSettled(page, {});
		const pane = (await page.locator('.svelte-flow__pane').boundingBox())!;
		await page.mouse.click(pane.x + 12, pane.y + 12);
		await expect(panel(page)).toBeHidden();
		await expect(map).not.toHaveClass(/focusing/);
	});

	test('closing a line panel never moves the view', async ({ page }) => {
		await demo(page, 'builders=12');
		// The top builder of the right-hand column, whose line runs up that column's trunk.
		const boxes = await page.locator('[data-node-button^="worker:"]').evaluateAll((els) =>
			els.map((e) => {
				const r = e.getBoundingClientRect();
				return { id: e.getAttribute('data-node-button')!, x: r.x, y: r.y };
			})
		);
		const right = Math.max(...boxes.map((b) => b.x));
		const top = boxes.filter((b) => b.x === right).sort((a, b) => a.y - b.y)[0];
		const edge = `assign:${top.id.slice('worker:'.length)}`;
		// About 240 px up the trunk from the group's track, where rows 0 to 2 run together.
		const along = await page.evaluate((edge) => {
			const probe = (window as unknown as ProbeWindow).__lines;
			const x = (s: number) => probe.flow(edge, s)!.x;
			// Back from the card along its stub and round the corner to the
			// trunk, then down the trunk to where it leaves the track.
			let at = probe.length(edge)!;
			while (at > 2 && Math.abs(x(at - 2) - x(at)) > 0.01) at -= 2;
			while (at > 2 && Math.abs(x(at - 2) - x(at)) <= 0.01) at -= 2;
			return at + 240;
		}, edge);

		await viewSettled(page, {});
		const scheduler = node(page, 'scheduler');
		const pane = page.locator('.svelte-flow');
		const offScreen = async () => {
			const s = (await scheduler.boundingBox())!;
			const p = (await pane.boundingBox())!;
			return s.x + s.width < p.x;
		};
		for (let i = 0; i < 20 && !(await offScreen()); i++) {
			const p = await pointOn(page, edge, along);
			// Zoom about a point just right of the trunk. At zoom 2 the trunk
			// itself sits only 446 flow px right of the scheduler's edge, so the
			// scheduler would stay a few px on screen.
			await page.mouse.move(p.x + 12, p.y);
			await page.mouse.wheel(0, -240);
			await page.waitForTimeout(100);
		}
		expect(await offScreen()).toBe(true);
		await viewSettled(page, {});
		const fit = page.getByRole('button', { name: 'Fit the whole farm' });
		const fitClass = await fit.getAttribute('class');
		const before = await viewport(page);

		await clickLine(page, edge, along);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(
			/^Assignments to \d+ builders$/
		);
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();
		// The bundle's opener, the scheduler, is off screen, so focus stays on the map.
		await expect(page.locator('section.map')).toBeFocused();
		await page.waitForTimeout(400);
		expect(await viewport(page)).toBe(before);
		expect(await fit.getAttribute('class')).toBe(fitClass);
	});

	test('clicking the focused line while its build detail is open goes back to the line panel', async ({
		page
	}) => {
		await demo(page);
		const addr = (await builderIds(page))[6].slice('worker:'.length);
		const title = `Assignments to ${addr}`;
		await clickLine(page, `assign:${addr}`, -10);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(title);
		const items = panel(page).getByRole('list', { name: 'Derivations on this line' });
		await items.getByRole('button').first().click();
		await expect(panel(page).getByText('Derivation', { exact: true })).toBeVisible();

		await clickLine(page, `assign:${addr}`, -10);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(title);
		await expect(panel(page).locator('.kicker')).toHaveText('Assignments');
		// Once more closes it, as a second click on a node does.
		await clickLine(page, `assign:${addr}`, -10);
		await expect(panel(page)).toBeHidden();
		await expect(page.locator('.farm-map')).not.toHaveClass(/focusing/);
	});

	test("a pool's assignment line opens a row per builder", async ({ page }) => {
		await demo(page, 'builders=30&systems=x86_64-linux&failing=1');
		await expect(node(page, 'pool:x86_64-linux')).toBeVisible();
		// The pool's own stretch, into its input.
		await clickLine(page, 'assign:pool:x86_64-linux', -10);
		await expect(page.locator('#panel-title')).toHaveAccessibleName(
			'Assignments to the x86_64-linux pool'
		);
		await expect(page.locator('#panel-title')).toHaveText('x86_64-linux pool');
		await expect(page.locator('.farm-map')).toHaveClass(/focusing/);
		await expect.poll(() => opacity(page, 'assign:pool:x86_64-linux')).toBe(1);
		const list = panel(page).getByRole('list', { name: 'Builders on this line' });
		await expect(list).toBeVisible();
		await expect(panel(page).locator('.p-list-cap').first()).toContainText('30 builders');
		// The pool's line carries the failure share.
		await expect
			.poll(async () => (await lineOf(page, 'assign:pool:x86_64-linux'))?.fails ?? 0, {
				timeout: 20_000
			})
			.toBeGreaterThan(0);
		// Builders fail too, one of them 80% of the time, so a row gives its share after a red bar.
		await expect(list.getByRole('button', { name: /, (<1|\d+)% failed$/ }).first()).toBeVisible({
			timeout: 20_000
		});
		await expect(list.locator('.fail-bar').first()).toBeVisible();
		// A row narrows to that builder's line, which the pool carries on the map.
		const row = list.getByRole('button').first();
		const name = (await row.locator('.member-name').textContent())?.trim() ?? '';
		await row.click();
		await expect(page.locator('#panel-title')).toHaveAccessibleName(`Assignments to ${name}`);
		await expect(panel(page)).toContainText('so the map shows the pool');
		await expect.poll(() => opacity(page, 'assign:pool:x86_64-linux')).toBe(1);
	});
});

test.describe('captions and titles', () => {
	test('a line panel names its kind in the kicker, and keeps it beside Back', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		await node(page, id).click();
		await panel(page)
			.getByRole('button', { name: /^Assignments from the scheduler, / })
			.click();
		const title = page.locator('#panel-title');
		const kicker = panel(page).locator('.kicker');
		// Seen: "● Assignments" over the address, with Back to the builder above.
		await expect(title).toHaveText(addr);
		await expect(title).toHaveAccessibleName(`Assignments to ${addr}`);
		await expect(panel(page)).toHaveAccessibleName(`Assignments to ${addr}`);
		await expect(kicker).toHaveText('Assignments');
		await expect(kicker.locator('.kind-dot')).toBeVisible();
		const back = panel(page).locator('button.back');
		await expect(back).toHaveText(addr);
		// The kicker sits between Back and the title.
		const [b, k, t] = await Promise.all([back, kicker, title].map((l) => l.boundingBox()));
		expect(k!.y).toBeGreaterThan(b!.y + b!.height - 1);
		expect(t!.y).toBeGreaterThan(k!.y);
		// Facts sit under one time caption, with bare labels.
		await expect(panel(page).locator('.p-facts dt')).toHaveText(['Now', 'Assigned', 'Failed']);
		// From a derivation on the line, Back names the line in full, not the bare address.
		await panel(page)
			.getByRole('list', { name: 'Derivations on this line' })
			.getByRole('button')
			.first()
			.click();
		await expect(back).toHaveText(`Assignments to ${addr}`);
		await back.click();
		await expect(title).toHaveText(addr);
		await expect(kicker).toHaveText('Assignments');
		// The cache hits line has no varying end, so the title names both.
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await node(page, 'scheduler').click();
		await panel(page)
			.getByRole('button', { name: /^Cache hits, / })
			.click();
		await expect(title).toHaveText('Scheduler to cache');
		await expect(kicker).toHaveText('Cache hits');
	});

	test('captions say "Since" while a window fills, and why', async ({ page }) => {
		// The scheduler started 5 minutes ago, so the header's 15m window fills.
		await demo(page, 'uptime=5');
		const caption = page.locator('.totals .caption .when');
		await expect(caption).toContainText(/^Since \d/);
		await expect(caption).toHaveAttribute(
			'title',
			/^Counting since the scheduler restarted at [^:]+:\d\d[^:]*: \dm of the 15m window$/
		);
		// A 5m window is full and gets no caption, as the selected segment names it.
		const picker = page.getByRole('radiogroup', { name: 'Time window' });
		await picker.getByRole('radio', { name: '5 minutes', exact: true }).click();
		await expect(page.locator('.totals .caption')).toHaveCount(0);
		await picker.getByRole('radio', { name: '15 minutes', exact: true }).click();

		// Lines count from when this page opened, so a line panel says so,
		// and its chart hatches the start of the window it did not see.
		const [id] = await builderIds(page);
		await node(page, id).click();
		await panel(page)
			.getByRole('button', { name: /^Assignments from the scheduler, / })
			.click();
		const when = panel(page).locator('.when').first();
		await expect(when).toContainText(/^Since \d/);
		await expect(when).toHaveAttribute(
			'title',
			/^Counting since this page opened at .+: \d+[sm] of the 15m window$/
		);
		await expect(panel(page).locator('svg[role="img"] .uncovered title')).toHaveText(
			'Before this page opened'
		);
		await expect(panel(page)).not.toContainText(/so far/i);
		// Durations in the picker's style; a derivation in progress says "elapsed".
		await expect(
			panel(page)
				.getByRole('list', { name: 'Derivations on this line' })
				.getByRole('button')
				.first()
		).toContainText(/\d+[smh] (elapsed|ago)/);
	});

	test('a derivation in progress reads "Assigned, 3m 20s elapsed"', async ({ page }) => {
		await demo(page);
		const [id] = await builderIds(page);
		await node(page, id).click();
		const item = panel(page)
			.getByRole('list', { name: 'Derivations on this builder' })
			.getByRole('button', { name: /^Assigned / })
			.first();
		await expect(item).toHaveAccessibleName(/ \d+ seconds? elapsed /);
		await item.click();
		const phase = panel(page).locator('.phase');
		await expect(phase).toContainText(/^Assigned\s*,?\s*\d+s elapsed/);
		await expect(panel(page)).not.toContainText(/so far/i);
	});
});

test.describe('queued count on the group heading', () => {
	test('one number on the heading, none on the cards', async ({ page }) => {
		await demo(page);
		await expect(page.locator('[data-node-button^="worker:"]', { hasText: /queued/ })).toHaveCount(
			0
		);
		for (const system of ['x86_64-linux', 'aarch64-linux']) {
			const heading = poolToggle(page, system);
			await expect(heading).toContainText(/\d+ builders · [\d,.k]+ queued/);
			await expect(heading.locator('.queued')).toHaveAttribute(
				'title',
				'Queued derivations that at least one of these builders can take'
			);
		}
	});

	test('a collapsed group leaves the count to its pool card, and shows it once expanded', async ({
		page
	}) => {
		await demo(page, 'builders=60');
		const heading = poolToggle(page, 'x86_64-linux');
		const pool = node(page, 'pool:x86_64-linux');
		await expect(pool).toContainText(/[\d,.k]+ queued/);
		await expect(heading).not.toContainText('queued');
		await heading.click();
		await expect(pool).toHaveCount(0);
		await expect(heading).toContainText(/\d+ builders · [\d,.k]+ queued/);
		await expect(page.locator('[data-node-button^="worker:"]', { hasText: /queued/ })).toHaveCount(
			0
		);
	});
});

test.describe('queue rows, chart readout and hit ratio', () => {
	test('the scheduler card folds unplaceable rows into one, then the largest queues', async ({
		page
	}) => {
		await demo(page);
		const card = node(page, 'scheduler');
		// The demo's stuck CUDA and riscv64 derivations never find a builder.
		const stuck = card.locator('.qrow.warn');
		await expect(stuck).toHaveCount(1);
		await expect(card.locator('.qrow').first()).toHaveClass(/\bwarn\b/);
		await expect(stuck).toContainText('Unplaceable');
		await expect(stuck.locator('svg')).toBeVisible();
		await expect(stuck.locator('.qbar')).toHaveCount(0);
		await expect(stuck).toHaveAttribute(
			'title',
			/^No connected builder offers what these need: \S/
		);
		// Its count is the card's Unplaceable figure.
		await expect
			.poll(async () => {
				const figure = await card.locator('.stats .value').nth(2).textContent();
				return figure === (await stuck.locator('.qn').textContent());
			})
			.toBe(true);
		// The other rows have bars, largest first, and the card has 4 rows at most.
		const counts = (await card.locator('.qrow:not(.warn) .qn').allTextContents()).map(parseCount);
		expect(counts.length).toBeLessThanOrEqual(3);
		expect(counts).toEqual([...counts].sort((a, b) => b - a));
		await expect(card.locator('.qrow:not(.stuck) .qbar')).toHaveCount(counts.length);
	});

	test('the line chart reads out the bucket under the pointer or the keys', async ({ page }) => {
		await demo(page);
		await page
			.getByRole('radiogroup', { name: 'Time window' })
			.getByRole('radio', { name: '5 minutes', exact: true })
			.click();
		const [id] = await builderIds(page);
		await node(page, id).click();
		await panel(page)
			.getByRole('button', { name: /^Assignments from the scheduler, / })
			.click();
		const chart = panel(page).locator('.chart');
		const slider = chart.getByRole('slider', { name: 'Assignments per minute' });
		const readout = chart.locator('.readout');
		await expect(slider).toBeVisible();
		await expect(readout).toHaveCount(0);

		// The pointer at the right end reads the bucket still filling.
		await slider.scrollIntoViewIfNeeded();
		const box = (await slider.boundingBox())!;
		await page.mouse.move(box.x + box.width - 3, box.y + 10);
		await expect(readout).toBeVisible();
		await expect(readout).toContainText(/^\s*Now\b.*\/min/);
		await expect(chart.locator('line.hair')).toHaveCount(1);
		await page.mouse.move(0, 0);
		await expect(readout).toHaveCount(0);

		// The keys move the same readout, and screen readers hear it as the value.
		const max = (await slider.getAttribute('aria-valuemax'))!;
		await slider.focus();
		await expect(readout).toBeVisible();
		await expect(slider).toHaveAttribute('aria-valuenow', max);
		await page.keyboard.press('Home');
		await expect(slider).toHaveAttribute('aria-valuenow', '0');
		// The page opened seconds ago, so the window starts before it.
		await expect(readout).toContainText('Before this page opened');
		await expect(slider).toHaveAttribute('aria-valuetext', /, before this page opened$/);
		await page.keyboard.press('ArrowRight');
		await expect(slider).toHaveAttribute('aria-valuenow', '1');
		await expect(readout).toContainText(/ to /);
		await page.keyboard.press('End');
		await expect(slider).toHaveAttribute('aria-valuetext', /^Now, /);
		await slider.blur();
		await expect(readout).toHaveCount(0);

		// A bar is narrower than its slot, also at 5m where slots are wide, so bars never touch.
		const fit = () =>
			chart.evaluate((el) => {
				const scrub = el.querySelector<HTMLElement>('.scrub')!;
				const slot = scrub.getBoundingClientRect().width / (Number(scrub.ariaValueMax) + 1);
				const widths = [...el.querySelectorAll('svg .bar, svg .live .body')].map(
					(b) => b.getBoundingClientRect().width
				);
				return { slot, widths };
			});
		await expect.poll(async () => (await fit()).widths.length).toBeGreaterThan(0);
		const { slot, widths } = await fit();
		for (const w of widths) expect(w).toBeLessThan(slot);
	});

	test('the cache card shows its hit ratio as a meter', async ({ page }) => {
		await demo(page);
		const cache = node(page, 'cache');
		await expect(cache.locator('.donut')).toHaveCount(0);
		const meter = cache.locator('.meter');
		await expect(meter).toHaveCount(1);
		await expect(meter).toHaveAttribute('aria-hidden', 'true');
		// The fill is the share the card prints.
		await expect
			.poll(async () => {
				const share = parseFloat((await cache.locator('.big').textContent()) ?? '');
				const fill = await meter
					.locator('span')
					.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
				return Math.abs(fill * 100 - share) <= 1;
			})
			.toBe(true);
	});
});

test.describe('map limits', () => {
	/** Cards and pools at least partly on the map. */
	const onScreen = (page: Page) =>
		page.evaluate(() => {
			const pane = document.querySelector('.svelte-flow')!.getBoundingClientRect();
			let n = 0;
			for (const el of document.querySelectorAll('[data-node-button]')) {
				const r = el.getBoundingClientRect();
				if (
					r.right > pane.left &&
					r.left < pane.right &&
					r.bottom > pane.top &&
					r.top < pane.bottom
				)
					n++;
			}
			return n;
		});

	test('a long drag or many wheel steps out cannot lose the farm', async ({ page }) => {
		await demo(page);
		await viewSettled(page);
		const fit = await zoomOf(page);
		const p = await emptyPanePoint(page);
		// Drag far to the bottom right, then far to the top left, in long strokes.
		for (const [dx, dy] of [
			[900, 600],
			[-900, -600]
		])
			for (let i = 0; i < 4; i++) {
				await page.mouse.move(p.x, p.y);
				await page.mouse.down();
				await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 });
				await page.mouse.up();
				await page.waitForTimeout(100);
				expect(await onScreen(page)).toBeGreaterThan(2);
			}
		// Wheel far out. It stops a little past the zoom that fits the farm.
		await page.mouse.move(p.x, p.y);
		for (let i = 0; i < 30; i++) {
			await page.mouse.wheel(0, 300);
			await page.waitForTimeout(20);
		}
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		expect(await zoomOf(page)).toBeGreaterThanOrEqual(fit * 0.75 - 0.005);
		expect(await zoomOf(page)).toBeLessThan(fit);
		// Zoomed all the way in, a drag still keeps cards on the map.
		for (let i = 0; i < 30; i++) {
			await page.mouse.wheel(0, -300);
			await page.waitForTimeout(20);
		}
		await expect.poll(() => zoomOf(page)).toBe(2);
		for (let i = 0; i < 6; i++) {
			await page.mouse.move(p.x, p.y);
			await page.mouse.down();
			await page.mouse.move(p.x - 900, p.y - 600, { steps: 8 });
			await page.mouse.up();
		}
		await page.waitForTimeout(200);
		expect(await onScreen(page)).toBeGreaterThan(0);
		// Fit still frames the whole farm.
		await page.getByRole('button', { name: 'Fit the whole farm' }).click();
		await expect.poll(() => zoomOf(page)).toBeCloseTo(fit, 3);
		await expect.poll(() => onScreen(page)).toBe(await page.locator('[data-node-button]').count());
	});

	test('the limits follow the farm as it grows, and refits still show it all', async ({ page }) => {
		await demo(page, 'builders=6&churn=60');
		await viewSettled(page, { intervals: [400], timeout: 20_000 });
		const before = await page.locator('[data-node-button]').count();
		// Cloud builders join. The farm grows, and the refit fits it, out of the old floor.
		await expect
			.poll(() => page.locator('[data-node-button]').count(), { timeout: 30_000 })
			.toBeGreaterThan(before + 2);
		await viewSettled(page, { intervals: [400], timeout: 20_000 });
		const fit = await zoomOf(page);
		await expect.poll(() => onScreen(page)).toBe(await page.locator('[data-node-button]').count());
		// Zooming out stops a little past the new fit.
		const p = await emptyPanePoint(page);
		await page.mouse.move(p.x, p.y);
		for (let i = 0; i < 30; i++) {
			await page.mouse.wheel(0, 300);
			await page.waitForTimeout(20);
		}
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		expect(await zoomOf(page)).toBeGreaterThanOrEqual(fit * 0.75 - 0.01);
	});

	test('focusing a card off screen still pans to it', async ({ page }) => {
		await demo(page);
		await viewSettled(page);
		const zoomIn = page.getByRole('button', { name: 'Zoom in' });
		for (let i = 0; i < 5; i++) {
			await zoomIn.click();
			await page.waitForTimeout(350);
		}
		const ids = await builderIds(page);
		const last = node(page, ids[ids.length - 1]);
		const inPane = async () => {
			const pane = (await page.locator('.svelte-flow').boundingBox())!;
			const r = (await last.boundingBox())!;
			return (
				r.x >= pane.x - 1 &&
				r.y >= pane.y - 1 &&
				r.x + r.width <= pane.x + pane.width + 1 &&
				r.y + r.height <= pane.y + pane.height + 1
			);
		};
		expect(await inPane()).toBe(false);
		// Keyboard focus moves there, and the map follows within its limits.
		await node(page, ids[ids.length - 2]).focus();
		await page.keyboard.press('Tab');
		await expect(last).toBeFocused();
		await expect.poll(inPane).toBe(true);
	});
});

test.describe('insights', () => {
	test('the upstream card and its lines', async ({ page }) => {
		await demo(page, 'builders=12&upstream=3');
		await expect(page.locator('.lane').filter({ hasText: /^Caches$/ })).toHaveCount(1);
		const card = node(page, 'upstream');
		await expect(card).toContainText('Substituters');
		await expect(card.locator('.host').first()).toHaveText('cache.nixos.org');
		await expect(card).toContainText(/cache\.farm\.example\s*farm cache/);
		await expect(card).toContainText('On the binary cache card');
		// One substitute line per builder, and every one is drawn.
		const addrs = (await builderIds(page)).map((id) => id.slice('worker:'.length));
		expect(addrs).toHaveLength(12);
		const drawn = (await lineReport(page)).filter((l) => l.id.startsWith('substitute:'));
		expect(drawn.map((l) => l.id).sort()).toEqual(addrs.map((a) => `substitute:${a}`).sort());
		// Next to the card every line runs on one stub, so a click opens them all.
		await clickLine(page, `substitute:${addrs[0]}`, 20);
		await expect(page.locator('#panel-title')).toHaveAccessibleName('Substitutions to 12 builders');
		await expect(panel(page).locator('.kicker')).toHaveText('Substitutions');
		await expect(
			panel(page).getByRole('list', { name: 'Lines in this bundle' }).getByRole('button')
		).toHaveCount(12);
		await expect(page.locator('.legend')).toContainText('Substitutions');
	});

	test('the upstream panel', async ({ page }) => {
		await demo(page, 'builders=30&upstream=3');
		// Tab order: the cache, then the card.
		await node(page, 'cache').focus();
		await page.keyboard.press('Tab');
		await expect(node(page, 'upstream')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.locator('#panel-title')).toHaveText('Substituters');
		await expect(panel(page).locator('.kicker')).toHaveText('Upstream');
		await expect(panel(page).locator('.subs .url').first()).toHaveText('https://cache.nixos.org');
		await expect(panel(page).getByRole('heading', { name: 'Farm cache' })).toBeVisible();
		await expect(panel(page)).toContainText('https://cache.farm.example');
		// Every builder with a line, those in the x86_64-linux pool included.
		const list = panel(page).getByRole('list', { name: 'Builders with substituters' });
		await expect(list.getByRole('listitem').first()).toBeVisible();
		expect(Number(await list.getByRole('listitem').first().getAttribute('aria-setsize'))).toBe(30);
		const first = (await list.locator('.addr').first().textContent())!.trim();
		await list.getByRole('button').first().click();
		await expect(page.locator('#panel-title')).toHaveText(first);
		await expect(panel(page).getByRole('heading', { name: 'Substituters' })).toBeVisible();
		await expect(
			panel(page).getByRole('list', { name: "Substituters in the builder's order" })
		).toContainText('cache.nixos.org');
		// Back to the upstream panel.
		await expect(panel(page).locator('button.back')).toHaveText('Substituters');
	});

	test('a substitute line lists no builds and says why', async ({ page }) => {
		await demo(page, 'builders=12&upstream=3');
		const [id] = await builderIds(page);
		const addr = id.slice('worker:'.length);
		await node(page, id).click();
		await panel(page)
			.getByRole('button', { name: /^Substitutions from substituters/ })
			.click();
		await expect(page.locator('#panel-title')).toHaveAccessibleName(`Substitutions to ${addr}`);
		await expect(panel(page)).toContainText(
			'Builders report how much they take from each substituter, not which build it was for, so this line lists no builds.'
		);
		await expect(panel(page).getByRole('heading', { name: 'Latest on this line' })).toHaveCount(0);
	});

	test('the map without upstream substituters has no card, line or legend item', async ({
		page
	}) => {
		await demo(page, 'builders=12');
		await expect(node(page, 'upstream')).toHaveCount(0);
		await expect(page.locator('.lane').filter({ hasText: /^Cache$/ })).toHaveCount(1);
		expect((await lineReport(page)).some((l) => l.id.startsWith('substitute:'))).toBe(false);
		await expect(page.locator('.legend')).not.toContainText('Substitutions');
		// Nor a substitute handle on any card.
		await expect(page.locator('.svelte-flow__handle[data-handleid="substitute"]')).toHaveCount(0);
	});

	for (const [shape, builders] of [
		['cards', 12],
		['pools', 60]
	] as const) {
		test(`with upstream substituters, ${shape} have a substitute handle`, async ({ page }) => {
			await demo(page, `builders=${builders}&upstream=3`);
			const cards = page.locator(`.svelte-flow__node-${shape === 'cards' ? 'builder' : 'pool'}`);
			await expect(cards.first()).toBeVisible();
			const n = await cards.count();
			await expect(cards.locator('.svelte-flow__handle[data-handleid="substitute"]')).toHaveCount(
				n
			);
		});
	}

	test('a low-disk builder says so', async ({ page }) => {
		await demo(page, 'builders=6&lowdisk=1');
		const card = page.locator('[data-node-button^="worker:"]').filter({ hasText: 'Low disk' });
		await expect(card).toHaveCount(1);
		await expect(card.locator('.badge')).toHaveAttribute(
			'title',
			/^Low on disk: 3\.1 GiB free is below its --min-free of 10 GiB\./
		);
		await expect(card.locator('.foot')).toContainText(/\d GiB free$/);
		await card.click();
		const facts = panel(page).locator('.p-facts').first();
		await expect(facts).toContainText('Draining (low disk)');
		await expect(facts).toContainText(/Free disk\s*3\.1 GiB\s*of 200 GiB/);
		await expect(facts).toContainText(/Drains below\s*10 GiB/);
		await expect(panel(page)).toContainText('Its builds keep running');
	});

	test('a failed build says why', async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await demo(page, 'builders=6&fail=0&failing=1');
		// The first builder the demo creates crashes on 80% of its builds.
		await node(page, 'worker:10.0.0.10:50051').click();
		await expect(panel(page)).toContainText(/Recent failures: \d+ builds? failed/);
		// Recent results follow what is assigned, so walk up from the last row to a failed one.
		const rows = panel(page).getByRole('list', { name: 'Derivations on this builder' });
		await rows.getByRole('button').first().focus();
		await page.keyboard.press('End');
		const focused = rows.locator('button:focus');
		for (let i = 0; i < 40; i++) {
			if (/Build failed · /.test((await focused.textContent()) ?? '')) break;
			await page.keyboard.press('ArrowUp');
		}
		await expect(focused.locator('.line2')).toHaveText(/^Build failed · x86_64-linux/);
		await page.keyboard.press('Enter');
		await expect(panel(page).getByRole('note')).toContainText('Build failed');
		await expect(panel(page).getByRole('note')).toContainText('The build exited with an error.');
		// Nix calls a flaky test's failure permanent too, so the note promises nothing about a rebuild.
		await expect(panel(page).getByRole('note')).not.toContainText('again');
		const log = panel(page).locator('pre.p-log');
		await expect(log).toContainText('Illegal instruction (core dumped)');
		await expect(log).toContainText("Cannot build '/nix/store/");
		// No escape codes reach the page.
		expect(await log.textContent()).not.toContain('\x1b');
		await panel(page).getByRole('button', { name: 'Copy log lines' }).click();
		await expect(panel(page).getByRole('button', { name: 'Copied' })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await log.textContent());
	});
});

test.describe('tabs', () => {
	const tabs = (page: Page) => page.getByRole('navigation', { name: 'Views' });

	test('tabs are links with aria-current', async ({ page, context }) => {
		await demo(page, 'builders=6');
		const overview = tabs(page).getByRole('link', { name: 'Overview' });
		const logs = tabs(page).getByRole('link', { name: 'Logs' });
		await expect(overview).toHaveAttribute('aria-current', 'page');
		await expect(logs).not.toHaveAttribute('aria-current');
		await expect(logs).toHaveAttribute('href', /logs\/\?demo&builders=6&upstream=0$/);
		// Middle-click opens the tab in a new page, as any link does.
		const opened = context.waitForEvent('page');
		await logs.click({ button: 'middle' });
		const other = await opened;
		await other.waitForURL(/\/logs\//);
		expect(new URL(other.url()).pathname).toBe('/logs/');
		await expect(other.getByRole('link', { name: 'Logs', exact: true })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await other.close();
		await logs.click();
		await expect(page).toHaveURL(/\/logs\/\?demo&builders=6&upstream=0$/);
		await expect(logs).toHaveAttribute('aria-current', 'page');
		await expect(page).toHaveTitle('Logs · Demo farm');
		// The same session: no new snapshot, the pill stays live.
		await expect(pill(page)).toHaveText('Live');
		await overview.click();
		await expect(page).toHaveURL(/\/\?demo&builders=6&upstream=0$/);
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(6);
	});

	test('a tab switch keeps the Overview', async ({ page }) => {
		await demo(page, 'builders=24');
		await viewSettled(page);
		// A builder panel with a derivation on top, a pool shown as cards, rates
		// on lines and a moved view.
		await poolToggle(page, 'x86_64-linux').click();
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		const builder = page.locator('[data-node-button^="worker:"]').first();
		await builder.click();
		await expect(panel(page)).toBeVisible();
		const row = panel(page).locator('.p-row.item').first();
		await expect(row).toBeVisible();
		await row.click();
		const titles = () => panel(page).locator('h2').allTextContents();
		await expect.poll(async () => (await titles()).length).toBeGreaterThan(0);
		const pane = await emptyPanePoint(page);
		await page.mouse.move(pane.x, pane.y);
		await page.mouse.down();
		await page.mouse.move(pane.x + 80, pane.y + 40, { steps: 5 });
		await page.mouse.up();
		await viewSettled(page);
		const before = {
			titles: await titles(),
			transform: await page
				.locator('.svelte-flow__viewport')
				.evaluate((el) => (el as HTMLElement).style.transform),
			cards: await page.locator('.svelte-flow__node-builder').count(),
			rates: await page.getByRole('button', { name: 'Rates on lines' }).getAttribute('aria-pressed')
		};
		expect(before.rates).toBe('true');
		const now = async () => ({
			titles: await titles(),
			transform: await page
				.locator('.svelte-flow__viewport')
				.evaluate((el) => (el as HTMLElement).style.transform),
			cards: await page.locator('.svelte-flow__node-builder').count(),
			rates: await page.getByRole('button', { name: 'Rates on lines' }).getAttribute('aria-pressed')
		});
		// By the tab, then by Back.
		await tabs(page).getByRole('link', { name: 'Logs' }).click();
		await expect(page.locator('.svelte-flow')).toHaveCount(0);
		await tabs(page).getByRole('link', { name: 'Overview' }).click();
		await expect(panel(page)).toBeVisible();
		await expect.poll(now).toEqual(before);
		await tabs(page).getByRole('link', { name: 'Logs' }).click();
		await expect(page.locator('.svelte-flow')).toHaveCount(0);
		await page.goBack();
		await expect(panel(page)).toBeVisible();
		await expect.poll(now).toEqual(before);
	});

	test('the header fits', async ({ page }) => {
		await demo(page, 'builders=6');
		for (const width of [1000, 1279, 1280, 1440, 1920]) {
			await page.setViewportSize({ width, height: 900 });
			const box = await page.evaluate(() => {
				const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
				const header = r('.header');
				const parts = ['.farm', '.totals', '.actions', 'nav[aria-label="Views"]'].map((s) => {
					const el = document.querySelector<HTMLElement>(s)!;
					const b = el.getBoundingClientRect();
					return { s, left: b.left, right: b.right, overflow: el.scrollWidth > el.clientWidth + 1 };
				});
				const totals = r('.totals');
				return {
					header: { left: header.left, right: header.right },
					parts,
					center: (totals.left + totals.right) / 2,
					mid: (header.left + header.right) / 2
				};
			});
			for (const p of box.parts) {
				expect(p.overflow, `${p.s} at ${width}`).toBe(false);
				expect(p.left, `${p.s} at ${width}`).toBeGreaterThanOrEqual(box.header.left);
				expect(p.right, `${p.s} at ${width}`).toBeLessThanOrEqual(box.header.right);
			}
			// The parts do not overlap.
			const [farm, totals, actions] = box.parts;
			expect(farm.right, `at ${width}`).toBeLessThanOrEqual(totals.left);
			expect(totals.right, `at ${width}`).toBeLessThanOrEqual(actions.left);
			if (width >= 1440) expect(Math.abs(box.center - box.mid), `at ${width}`).toBeLessThan(2);
			await expect(tabs(page).getByRole('link')).toHaveText(['Overview', 'Logs']);
		}
	});
});

test.describe('logs', () => {
	const LOGS = 'builders=12&speed=4&history=300&upstream=0';
	const list = (page: Page) => page.getByRole('list', { name: 'Builds' });
	const rows = (page: Page) => list(page).locator('a.item');
	const viewer = (page: Page) => page.locator('section.viewer');
	const HELLO = `${'h'.repeat(32)}-hello-2.12.1.drv`;

	async function openLogs(page: Page, query = LOGS) {
		await page.goto(`./logs/?demo&${query}`);
		await expect(pill(page)).toHaveText('Live');
		await expect(rows(page).first()).toBeVisible();
	}

	/** Open the first row whose text matches. */
	async function openRow(page: Page, re: RegExp) {
		const row = rows(page).filter({ hasText: re }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });
		await row.click();
		await expect(viewer(page)).toBeVisible();
		return row;
	}

	test('the list puts failures first and filters', async ({ page }) => {
		await openLogs(page);
		const heads = list(page).locator('.head-row');
		await expect(heads.first()).toHaveText('Failed');
		await expect(rows(page).first().locator('.chip')).toHaveText('Failed');
		const chips = page.getByRole('group', { name: 'Build states' });
		const failed = chips.getByRole('button', { name: /^Failed/ });
		await failed.click();
		await expect(failed).toHaveAttribute('aria-pressed', 'true');
		await expect(page).toHaveURL(/status=failed/);
		const n = Number((await failed.locator('.num').textContent())!.replace(/,/g, ''));
		expect(n).toBeGreaterThan(0);
		await expect
			.poll(async () =>
				(await rows(page).locator('.chip').allTextContents()).every((t) => t === 'Failed')
			)
			.toBe(true);
		// A hash prefix finds its build.
		const href = (await rows(page).first().getAttribute('href'))!;
		const drv = new URL(href, page.url()).searchParams.get('drv')!;
		await failed.click();
		await page
			.getByRole('searchbox', { name: 'Search builds by name or hash' })
			.fill(drv.slice(0, 8));
		await expect(rows(page).first()).toHaveAttribute('href', new RegExp(drv));
	});

	test("the state chips carry the rows' dots", async ({ page }) => {
		await openLogs(page);
		const chips = page.getByRole('group', { name: 'Build states' });
		for (const label of ['Failed', 'Assigned', 'Built']) {
			// The dot is only drawn, so the chip's name stays its state and count.
			const chip = chips.getByRole('button', { name: new RegExp(`^${label} [\\d,]+$`) });
			const dot = chip.locator('.dot');
			await expect(dot).toHaveAttribute('aria-hidden', 'true');
			const color = await dot.evaluate((e) => getComputedStyle(e).backgroundColor);
			await chip.click();
			await expect(chip).toHaveAttribute('aria-pressed', 'true');
			// The first row's state and dot, read together, since rows move on as builds end.
			await expect
				.poll(() =>
					page.evaluate(() => {
						const row = document.querySelector('.build-list a.item');
						const dot = row?.querySelector('.dot');
						return dot
							? [
									row!.querySelector('.chip')!.textContent!.trim(),
									getComputedStyle(dot).backgroundColor
								]
							: null;
					})
				)
				.toEqual([label, color]);
			await chip.click();
			await expect(chip).toHaveAttribute('aria-pressed', 'false');
		}
		// Other gathers cancelled and dropped builds and has no dot.
		await expect(chips.getByRole('button', { name: /^Other/ }).locator('.dot')).toHaveCount(0);
	});

	test('rows arriving above keep the view still', async ({ page }) => {
		test.setTimeout(60_000);
		await openLogs(page, `${LOGS}&sort=newest&status=built,failed`);
		const scroller = list(page);
		// Scroll down 20 rows, then leave the list, so its order does not hold still.
		await scroller.hover();
		await page.mouse.wheel(0, 20 * 52);
		await page.mouse.move(1300, 300);
		// A row stands for its build, which is its derivation and assignment. The
		// query asks for finished builds only, since a running row moves to the
		// top when it ends.
		/** The first row whose top is in the list's view: its build and its offset from the top. */
		const firstShown = () =>
			page.evaluate(() => {
				const box = document.querySelector('.build-list .rows')!.getBoundingClientRect();
				for (const a of document.querySelectorAll<HTMLAnchorElement>('.build-list a.item')) {
					const r = a.getBoundingClientRect();
					const q = new URL(a.href).searchParams;
					if (r.top >= box.top - 1)
						return { build: `${q.get('drv')}#${q.get('a')}`, top: r.top - box.top };
				}
				return null;
			});
		await expect.poll(async () => (await firstShown())?.top ?? -1).toBeGreaterThanOrEqual(0);
		const before = (await firstShown())!;
		// New builds finish above it. The pill counts them, and the row stays where it was.
		await expect(page.getByRole('button', { name: / new ↑$/ })).toBeVisible({ timeout: 30_000 });
		const top = await page.evaluate((build) => {
			const box = document.querySelector('.build-list .rows')!.getBoundingClientRect();
			for (const a of document.querySelectorAll<HTMLAnchorElement>('.build-list a.item')) {
				const q = new URL(a.href).searchParams;
				if (`${q.get('drv')}#${q.get('a')}` === build)
					return a.getBoundingClientRect().top - box.top;
			}
			return null;
		}, before.build);
		expect(top).not.toBeNull();
		expect(Math.abs(top! - before.top)).toBeLessThanOrEqual(1);
		// The pill scrolls to the top.
		await page.getByRole('button', { name: / new ↑$/ }).click();
		await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
	});

	test('arrow keys open nothing', async ({ page }) => {
		await openLogs(page);
		await rows(page).first().focus();
		for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
		await expect(viewer(page)).toHaveCount(0);
		await expect(page).not.toHaveURL(/drv=/);
		await page.keyboard.press('Enter');
		await expect(viewer(page)).toBeVisible();
		await expect(page).toHaveURL(/drv=/);
	});

	test('a failed build opens at its first error', async ({ page }) => {
		await openLogs(page, `${LOGS}&status=failed`);
		await openRow(page, /Build failed · (src\/foo\.c|FAIL:)/);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const err = viewer(page).locator('.scroller .row.error').first();
		await expect(err).toBeVisible({ timeout: 15_000 });
		// Seven lines of context above it.
		const line = Number(await err.locator('.gutter').textContent());
		await expect(
			viewer(page).locator('.scroller .gutter a', { hasText: new RegExp(`^${line - 7}$`) })
		).toBeInViewport();
		await expect(err.locator('.gutter')).toHaveCSS('border-left-color', /rgb/);
		// Nix's message, folded below the last line.
		await viewer(page).focus();
		await page.keyboard.press('End');
		const nix = viewer(page).locator('.nix summary');
		await expect(nix).toContainText(/^Nix reported: .+·Show$/);
		await expect(viewer(page).locator('.nix pre')).toBeHidden();
		await nix.click();
		await expect(nix).toContainText(/·Hide$/);
		await expect(viewer(page).locator('.nix pre')).toBeInViewport();
	});

	test('follow, stop and resume', async ({ page }) => {
		// A build that just started, at a quarter of the speed, runs on through the test.
		await openLogs(page, 'builders=12&speed=0.25&history=0&upstream=0&status=assigned&sort=newest');
		await openRow(page, /configurePhase · /);
		const follow = viewer(page).getByRole('checkbox', { name: 'Follow' });
		await expect(follow).toBeChecked();
		await expect(viewer(page).locator('.status')).toContainText('Following');
		// A wheel up stops following; the pill counts what arrives meanwhile.
		await viewer(page).locator('.scroller').hover();
		await page.mouse.wheel(0, -300);
		await expect(follow).not.toBeChecked();
		await expect(viewer(page).getByRole('button', { name: /^Not following · / })).toBeVisible();
		await viewer(page).focus();
		await page.keyboard.press('End');
		await expect(follow).toBeChecked();
	});

	test('groups fold like GitHub Actions', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const heads = viewer(page).locator('.scroller .row.header button.head');
		await expect(heads.first()).toBeVisible();
		const names = await heads.locator('.name').allTextContents();
		expect(names.slice(0, 3)).toEqual(['unpackPhase', 'patchPhase', 'configurePhase']);
		// Folded: only headers, with numbers that jump past each group.
		for (const h of await heads.all()) await expect(h).toHaveAttribute('aria-expanded', 'false');
		const nums = (await viewer(page).locator('.scroller .row .gutter').allTextContents()).map((t) =>
			Number(t.replace(/,/g, ''))
		);
		expect(nums[0]).toBe(1);
		expect(nums[1]).toBeGreaterThan(2);
		// A click opens one, Enter on a focused header folds it again.
		const configure = heads.filter({ hasText: 'configurePhase' });
		await configure.click();
		await expect(configure).toHaveAttribute('aria-expanded', 'true');
		await configure.focus();
		await page.keyboard.press('Enter');
		await expect(configure).toHaveAttribute('aria-expanded', 'false');
		// ] and [ move between headers.
		await page.keyboard.press(']');
		await expect(heads.filter({ hasText: 'buildPhase' })).toBeFocused();
		await page.keyboard.press('[');
		await expect(configure).toBeFocused();
		// Expand all shows every line; Collapse all leaves only headers.
		await viewer(page).getByRole('button', { name: 'Expand all' }).click();
		await expect
			.poll(async () => viewer(page).locator('.scroller .row.line').count())
			.toBeGreaterThan(10);
		await viewer(page).getByRole('button', { name: 'Collapse all' }).click();
		await expect(viewer(page).locator('.scroller .row.line')).toHaveCount(0);
	});

	test('a click on a sticky header folds it and brings its header to the top', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const configure = viewer(page).locator('.scroller .row.header button.head', {
			hasText: 'configurePhase'
		});
		// Every group open, so buildPhase's lines after it leave room to scroll its header up.
		await viewer(page).getByRole('button', { name: 'Expand all' }).click();
		await viewer(page).focus();
		await page.keyboard.press('Home');
		// ] walks the headers down to configurePhase.
		const focused = () =>
			page.evaluate(() => document.activeElement?.querySelector('.name')?.textContent ?? '');
		// Each press waits for the worker's answer, so give each one a moment under load.
		for (let i = 0; i < 12 && (await focused()) !== 'configurePhase'; i++) {
			await page.keyboard.press(']');
			await page.waitForTimeout(150);
		}
		await expect(configure).toBeFocused();
		await expect(configure).toHaveAttribute('aria-expanded', 'true');
		// Scroll into the phase, and its header sticks at the top.
		await viewer(page).locator('.scroller').hover();
		for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 400);
		const stuck = viewer(page).locator('.sticky button.head', { hasText: 'configurePhase' });
		await expect(stuck).toBeVisible();
		await stuck.click();
		await expect(configure).toHaveAttribute('aria-expanded', 'false');
		await expect(viewer(page).locator('.sticky')).toHaveCount(0);
		// Its header row is the top row of the view.
		await expect
			.poll(async () => {
				const top = (await viewer(page).locator('.scroller').boundingBox())!.y;
				const row = (await configure.boundingBox())!.y;
				return Math.abs(row - top) < 4;
			})
			.toBe(true);
	});

	test("a NixOS test folds by the driver's blocks, with its subtests inside", async ({ page }) => {
		await openLogs(page, `${LOGS}&status=failed`);
		await page.getByRole('searchbox', { name: 'Search builds by name or hash' }).fill('vm-test');
		await openRow(page, /!!! Test/);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		// The test script and its failing subtest are open, with their ✕ and the !!! lines
		// counted, though the driver's cleanup came after them, and the view is at the failure.
		const script = viewer(page)
			.locator('button.head.failed')
			.filter({ hasText: 'run the VM test script' })
			.first();
		await expect(script).toHaveAttribute('aria-expanded', 'true');
		const failedHead = viewer(page).locator('button.head.failed').last();
		await expect(failedHead).toHaveAttribute('aria-expanded', 'true');
		await expect(failedHead).toContainText('✕');
		await expect(failedHead.locator('.name')).toHaveText(/^subtest: /);
		await expect(failedHead).toContainText(/\d+ errors?/);
		await expect(viewer(page).locator('.row.error').first()).toContainText('!!! Test "');
		// The driver's blocks at the top level, the line before them plain, and no phase rows.
		await viewer(page).getByRole('button', { name: 'Collapse all' }).click();
		await expect(viewer(page).getByRole('button', { name: 'Collapse all' })).toBeDisabled();
		await viewer(page).focus();
		await page.keyboard.press('Home');
		const names = viewer(page).locator('.scroller button.head .name');
		await expect(names).toHaveText(['start all VLans', 'run the VM test script', 'cleanup']);
		await expect(viewer(page).locator('.scroller .row[data-row="0"] .text')).toHaveText(
			'Machine state will be reset. To keep it, pass --keep-machine-state'
		);
		// Inside the test script: the VMs' start, then, below the boot, the subtests one level in.
		await viewer(page)
			.locator('.scroller button.head', { hasText: 'run the VM test script' })
			.click();
		await expect(names.nth(2)).toHaveText('start all VMs');
		const focused = viewer(page).locator('button.head:focus');
		await page.keyboard.press(']');
		await expect(focused.locator('.name')).toHaveText('start all VMs');
		await page.keyboard.press(']');
		await expect(focused.locator('.name')).toHaveText(/^subtest: /);
		await expect(focused).toHaveAttribute('style', /--depth: 1/);
	});

	test('nixoslog shows a real NixOS test log, its subtests inside the test script', async ({
		page
	}) => {
		await openLogs(page, `${LOGS}&status=built&nixoslog=openbao`);
		await page.getByRole('searchbox', { name: 'Search builds by name or hash' }).fill('vm-test');
		await openRow(page, /vm-test/);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await expect(viewer(page).locator('.status')).toContainText('1,298 lines');
		// A built test opens no group: the driver's three blocks, and its first line plain above them.
		const names = viewer(page).locator('.scroller button.head .name');
		await expect(names).toHaveText(['start all VLans', 'run the VM test script', 'cleanup']);
		await expect(viewer(page).locator('.scroller .row[data-row="0"] .text')).toHaveText(
			'Machine state will be reset. To keep it, pass --keep-machine-state'
		);
		const head = (name: string) =>
			viewer(page)
				.locator('.scroller button.head')
				.filter({ has: page.getByText(name, { exact: true }) });
		await expect(head('run the VM test script')).toHaveAttribute(
			'aria-label',
			'run the VM test script, 27 seconds, 1,286 lines'
		);
		await head('run the VM test script').click();
		// One level in: the VMs' start, then the 16 subtests with the durations the driver printed.
		await expect(names).toHaveCount(3 + 17);
		const sub = head('subtest: Wait for OpenBao to start up');
		await expect(sub).toHaveAttribute('aria-expanded', 'false');
		await expect(sub).toHaveAttribute('style', /--depth: 1/);
		await expect(sub).toHaveAttribute(
			'aria-label',
			/^subtest: Wait for OpenBao to start up, 12 seconds, [\d,]+ lines$/
		);
		await expect(names.nth(2)).toHaveText('start all VMs');
		await expect(names.last()).toHaveText('cleanup');
	});

	test('nixoslog: a failed real log opens the test script and the failed subtest', async ({
		page
	}) => {
		await openLogs(page, `${LOGS}&status=failed&nixoslog=openbao`);
		await page.getByRole('searchbox', { name: 'Search builds by name or hash' }).fill('vm-test');
		await openRow(page, /!!! Test/);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		// The failure cuts into the last subtest, and the driver's cleanup follows it.
		const failed = viewer(page).locator('.scroller button.head.failed, .sticky button.head.failed');
		await expect(failed.filter({ hasText: 'run the VM test script' }).first()).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		const sub = failed.filter({ hasText: 'subtest: Read a secret from cubbyhole' }).first();
		await expect(sub).toHaveAttribute('aria-expanded', 'true');
		await expect(viewer(page).locator('.row.error').first()).toContainText(
			'!!! Test "Read a secret from cubbyhole" failed'
		);
		// The cleanup after the failure is a block of its own at the top level, folded.
		const cleanup = viewer(page).locator('.scroller button.head').filter({ hasText: 'cleanup' });
		await expect(cleanup).toHaveAttribute('aria-expanded', 'false');
		await expect(cleanup).toHaveAttribute('style', /--depth: 0/);
	});

	test('following keeps every group open', async ({ page }) => {
		test.setTimeout(120_000);
		await openLogs(page, 'builders=12&speed=1&history=0&upstream=0&status=assigned&sort=newest');
		await openRow(page, /(configure|build)Phase · /);
		await expect(viewer(page).getByRole('checkbox', { name: 'Follow' })).toBeChecked();
		const head = (name: string) =>
			viewer(page)
				.locator('.scroller button.head')
				.filter({ has: page.getByText(name, { exact: true }) });
		// The current phase has a dot and "elapsed"; its header sticks at the top.
		const current = viewer(page)
			.locator('button.head', { has: page.locator('.dot') })
			.first();
		await expect(current).toBeVisible();
		await expect(current).toContainText('elapsed', { timeout: 15_000 });
		const first = (await current.locator('.name').textContent())!;
		// Earlier phases are open too, so following shows all the build printed:
		// nothing to expand, and the user can still fold one.
		await expect(viewer(page).getByRole('button', { name: 'Expand all' })).toBeDisabled();
		await viewer(page).focus();
		await page.keyboard.press('Home');
		const earlier = head('unpackPhase');
		await expect(earlier).toHaveAttribute('aria-expanded', 'true');
		await earlier.click();
		await expect(earlier).toHaveAttribute('aria-expanded', 'false');
		await expect(viewer(page).getByRole('button', { name: 'Expand all' })).toBeEnabled();
		await viewer(page).focus();
		await page.keyboard.press('End');
		// The next phase starts. The one before stays open, and the folded one stays folded.
		await expect
			.poll(async () => (await current.locator('.name').textContent()) ?? first, {
				timeout: 90_000
			})
			.not.toBe(first);
		await page.keyboard.press('Home');
		await expect(head(first)).toHaveAttribute('aria-expanded', 'true');
		await expect(earlier).toHaveAttribute('aria-expanded', 'false');
	});

	test('search, errors and links open folds', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const head = (name: string) =>
			viewer(page)
				.locator('.scroller button.head')
				.filter({ has: page.getByText(name, { exact: true }) });
		// With everything folded, a hit inside configurePhase counts, and reaching it opens the phase.
		await expect(head('configurePhase')).toHaveAttribute('aria-expanded', 'false');
		const find = viewer(page).getByRole('searchbox', { name: 'Find in log' });
		await find.fill('checking for');
		await expect(viewer(page).locator('.count')).toHaveText(/^\d+ matches$/);
		await find.press('Enter');
		await expect(viewer(page).locator('mark.cur')).toBeVisible();
		await expect(head('configurePhase')).toHaveAttribute('aria-expanded', 'true');
		// It stays open after the search moves on.
		await find.fill('');
		await expect(head('configurePhase')).toHaveAttribute('aria-expanded', 'true');
		// Collapse all, then Copy lines over a folded range copies every line.
		await viewer(page).getByRole('button', { name: 'Collapse all' }).click();
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}#L3-L12`);
		await page.reload();
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await viewer(page).getByRole('button', { name: 'Collapse all' }).click();
		await viewer(page).getByRole('button', { name: 'Copy lines' }).click();
		await expect(viewer(page).getByRole('button', { name: 'Copied' })).toBeVisible();
		const text = await page.evaluate(() => navigator.clipboard.readText());
		expect(text.split('\n')).toHaveLength(10);
		// A link to a folded line opens its group on load.
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}#L200`);
		await page.reload();
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const sel = viewer(page).locator('.row.sel');
		await expect(sel.first()).toBeVisible();
		await expect(sel.first().locator('.gutter')).toHaveText('200');
	});

	test("e opens the next error's group", async ({ page }) => {
		await openLogs(page, `${LOGS}&status=failed`);
		await openRow(page, /Build failed · src\/foo\.c/);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await viewer(page).getByRole('button', { name: 'Collapse all' }).click();
		await expect(viewer(page).locator('.scroller .row.line')).toHaveCount(0);
		await viewer(page).focus();
		await page.keyboard.press('e');
		const err = viewer(page).locator('.scroller .row.error').first();
		await expect(err).toBeVisible();
		await expect(err).toContainText('error:');
		await expect(viewer(page).locator('button.head.failed').first()).toHaveAttribute(
			'aria-expanded',
			'true'
		);
	});

	test('keyboard only', async ({ page }) => {
		await openLogs(page, `${LOGS}&status=failed`);
		// From the tab link into the list, to a row, and into its log.
		await page
			.getByRole('navigation', { name: 'Views' })
			.getByRole('link', { name: 'Logs' })
			.focus();
		await page.keyboard.press('Tab');
		for (let i = 0; i < 40; i++) {
			const inList = await page.evaluate(
				() =>
					!!document.activeElement?.closest('.build-list') &&
					document.activeElement?.matches('a.item')
			);
			if (inList) break;
			await page.keyboard.press('Tab');
		}
		await expect(rows(page).first()).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(viewer(page)).toBeVisible();
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		// Into the viewer, through find, and back with Escape.
		for (let i = 0; i < 40; i++) {
			if (await page.evaluate(() => document.activeElement?.matches('section.viewer[tabindex]')))
				break;
			await page.keyboard.press('Tab');
		}
		await expect(viewer(page)).toBeFocused();
		await page.keyboard.press('Control+f');
		const find = viewer(page).getByRole('searchbox', { name: 'Find in log' });
		await expect(find).toBeFocused();
		await page.keyboard.type('e');
		// A count of hits, not the empty search's "No matches".
		await expect(viewer(page).locator('.count')).toHaveText(/^[\d,]+\+? matches$/);
		await page.keyboard.press('Enter');
		await expect(viewer(page).locator('.count')).toHaveText(/^1 of /);
		await page.keyboard.press('Escape');
		await expect(find).toHaveValue('');
		await viewer(page).focus();
		await page.keyboard.press('Escape');
		await expect(page.locator('.build-list :focus')).toHaveCount(1);
	});

	test('time words', async ({ page }) => {
		await openLogs(page, `${LOGS}&sort=newest`);
		const assigned = rows(page)
			.filter({ has: page.locator('.chip', { hasText: 'Assigned' }) })
			.first();
		await expect(assigned.locator('.ago')).toHaveText(/elapsed$/);
		const built = rows(page)
			.filter({ has: page.locator('.chip', { hasText: 'Built' }) })
			.first();
		await expect(built.locator('.ago')).toHaveText(/^(<1s|\d+[smhd])$/);
		await built.click();
		await expect(viewer(page).locator('.facts')).toContainText(/^Took /);
		await expect(page.locator('main.logs')).not.toContainText('so far');
	});

	test('find, errors and wrap', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const find = viewer(page).getByRole('searchbox', { name: 'Find in log' });
		await find.fill('checking');
		await expect(viewer(page).locator('.count')).toHaveText(/matches$/);
		await find.press('Enter');
		await expect(viewer(page).locator('.count')).toHaveText(/^1 of \d/);
		await expect(viewer(page).locator('mark.cur')).toBeVisible();
		await find.press('Enter');
		await expect(viewer(page).locator('.count')).toHaveText(/^2 of \d/);
		const lines = await viewer(page).locator('.status').textContent();
		await viewer(page).focus();
		await page.keyboard.press('w');
		await expect(viewer(page).getByRole('checkbox', { name: 'Wrap' })).not.toBeChecked();
		expect(await viewer(page).locator('.status').textContent()).toBe(lines);
		// Only matching lines: the matches under their headers, whatever is folded.
		await viewer(page).getByRole('checkbox', { name: 'Only matching lines' }).check();
		await expect
			.poll(async () =>
				(await viewer(page).locator('.scroller .row.line .text').allTextContents()).every((t) =>
					/checking/i.test(t)
				)
			)
			.toBe(true);
	});

	test('line links', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await viewer(page).getByRole('button', { name: 'Expand all' }).click();
		await viewer(page).locator('.gutter a', { hasText: /^5$/ }).click();
		await expect(page).toHaveURL(/#L5$/);
		await viewer(page)
			.locator('.gutter a', { hasText: /^9$/ })
			.click({ modifiers: ['Shift'] });
		await expect(page).toHaveURL(/#L5-L9$/);
		await expect(viewer(page).locator('.row.sel')).toHaveCount(5);
	});

	test('a deep link opens a build', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}&on=10.0.0.10:50051#L120`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		const sel = viewer(page).locator('.row.sel');
		await expect(sel.first()).toBeVisible();
		await expect(sel.first().locator('.gutter')).toHaveText('120');
	});

	test('download and open as text', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&drv=${HELLO}`);
		await expect(viewer(page).locator('.status')).toContainText('loaded');
		await viewer(page).getByRole('button', { name: 'Raw log' }).click();
		const dl = page.waitForEvent('download');
		await viewer(page).getByRole('menuitem', { name: 'Save log' }).click();
		const file = await dl;
		expect(file.suggestedFilename()).toBe(`${HELLO.replace(/\.drv$/, '')}.log`);
		const path = await file.path();
		const { statSync, readFileSync } = await import('node:fs');
		const kib = /([\d.]+) KiB/.exec((await viewer(page).locator('.status').textContent())!)![1];
		expect(Math.abs(statSync(path).size / 1024 - Number(kib))).toBeLessThan(1);
		expect(readFileSync(path, 'utf8')).toContain('Running phase: buildPhase');
		await viewer(page).getByRole('button', { name: 'Raw log' }).click();
		const popup = page.waitForEvent('popup');
		await viewer(page).getByRole('menuitem', { name: 'Open as text' }).click();
		const text = await popup;
		await text.waitForLoadState();
		const body = await text.evaluate(() => document.body.innerText);
		expect(body).toContain('Running phase: buildPhase');
		expect(body).not.toContain('\x1b');
	});

	test('keys work only on focus', async ({ page }) => {
		await openLogs(page);
		await page
			.getByRole('navigation', { name: 'Views' })
			.getByRole('link', { name: 'Logs', exact: true })
			.focus();
		await page.keyboard.press('/');
		const search = page.getByRole('searchbox', { name: 'Search builds by name or hash' });
		await expect(search).not.toBeFocused();
		await page.keyboard.press('[');
		await expect(search).toBeVisible();
		await rows(page).first().focus();
		await page.keyboard.press('/');
		await expect(search).toBeFocused();
		await rows(page).first().focus();
		await page.keyboard.press('[');
		await expect(search).toBeHidden();
	});

	test('the list folds while a build is open, until the reader shows it', async ({ page }) => {
		await openLogs(page);
		const search = page.getByRole('searchbox', { name: 'Search builds by name or hash' });
		await rows(page).first().click();
		await expect(viewer(page)).toBeVisible();
		await expect(search).toBeHidden();
		// Escape goes back to the list, at the open build.
		await viewer(page).focus();
		await page.keyboard.press('Escape');
		await expect(search).toBeVisible();
		await expect(list(page).locator('a.item:focus')).toHaveAttribute('aria-current', 'page');
		// The reader showed it, so it stays for the next build.
		const before = page.url();
		await list(page).locator('a.item:not([aria-current])').first().click();
		await expect(page).not.toHaveURL(before);
		await expect(search).toBeVisible();
	});

	test('logs=0 says the farm serves no logs', async ({ page }) => {
		await page.goto(`./logs/?demo&${LOGS}&logs=0&drv=${HELLO}&on=10.0.0.10:50051`);
		await expect(viewer(page)).toContainText('10.0.0.10:50051 serves no build logs.');
	});

	test('builders that report no starts say Assigned', async ({ page }) => {
		await openLogs(page, `${LOGS}&progress=0&status=assigned`);
		const lines2 = await rows(page).locator('.line2').allTextContents();
		expect(lines2.length).toBeGreaterThan(0);
		for (const l of lines2) expect(l).toMatch(/^Assigned · /);
		await rows(page).first().click();
		await expect(viewer(page).locator('.facts')).toContainText(/^(Assigned, .* elapsed|Took )/);
	});

	test('DrvDetail links the log', async ({ page }) => {
		await demo(page, 'builders=6&speed=0.5');
		await node(page, (await builderIds(page))[0]).click();
		const rowsOnBuilder = panel(page).getByRole('list', { name: 'Derivations on this builder' });
		await rowsOnBuilder.getByRole('button').filter({ hasText: 'Assigned' }).first().click();
		const link = panel(page).getByRole('link', { name: 'Follow the log' });
		await expect(link).toBeVisible();
		await link.click();
		await expect(page).toHaveURL(/\/logs\/\?demo.*drv=/);
		await expect(viewer(page).getByRole('checkbox', { name: 'Follow' })).toBeChecked();
	});

	test('L on a DrvList row opens its log, and the row has one tab stop', async ({ page }) => {
		await demo(page, 'builders=6');
		await node(page, (await builderIds(page))[0]).click();
		const list = panel(page).getByRole('list', { name: 'Derivations on this builder' });
		const row = list.getByRole('button').first();
		await expect(row).toBeVisible();
		await expect(row).toHaveAttribute('aria-keyshortcuts', 'L');
		await expect(list.locator('a.log-link').first()).toHaveAttribute('tabindex', '-1');
		await row.focus();
		await page.keyboard.press('l');
		await expect(page).toHaveURL(/\/logs\/\?.*drv=/);
		await expect(viewer(page)).toBeVisible();
	});

	test('panel links filter the list', async ({ page }) => {
		await demo(page, 'builders=6');
		const id = (await builderIds(page))[0];
		await node(page, id).click();
		await panel(page).getByRole('link', { name: 'Recent failures' }).click();
		const addr = id.slice('worker:'.length);
		await expect(page).toHaveURL(
			new RegExp(
				`builder=${encodeURIComponent(addr).replace(/\./g, '\\.')}.*status=failed|status=failed.*builder=`
			)
		);
		await expect(
			page.getByRole('group', { name: 'Build states' }).getByRole('button', { name: /^Failed/ })
		).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByRole('combobox', { name: 'Builder' })).toHaveValue(addr);
	});

	test('Show on map comes back to the builder and derivation panels', async ({ page }) => {
		await openLogs(page, `${LOGS}&status=built`);
		const row = rows(page).first();
		const name = (await row.locator('.name').textContent())!;
		await row.click();
		await viewer(page).getByRole('button', { name: 'Show on map' }).click();
		await expect(page).toHaveURL(/\/\?demo/);
		await expect(panel(page)).toBeVisible();
		await expect(page.locator('#panel-title')).toHaveText(name);
		await page.keyboard.press('Escape');
		await expect(page.locator('#panel-title')).toHaveText(/:\d+$/);
	});

	test('the Failed total opens failures in the header window', async ({ page }) => {
		await demo(page, 'builders=6');
		await page
			.getByRole('radiogroup', { name: 'Time window' })
			.getByRole('radio', { name: '30 minutes' })
			.click();
		await expect(page.locator('.totals a')).toHaveAttribute('href', /since=30$/);
		await page.locator('.totals a').click();
		await expect(page).toHaveURL(/\/logs\/\?demo.*status=failed&since=30/);
		await expect(page.getByRole('combobox', { name: 'Finished within' })).toHaveValue('30');
	});
});
