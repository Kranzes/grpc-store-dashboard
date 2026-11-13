// Shared Playwright helpers.

import { expect, test as base, type Page } from '@playwright/test';
import type { LineProbe } from '../src/lib/flow/probe.ts';
import { FakeFarm, type FakeFarmOptions } from './fake-farm.ts';

export { expect };

export const test = base.extend<{
	/**
	 * Start a fake farm in front of this project's page server; stopped when
	 * the test ends. The page then loads from farm.url.
	 */
	fakeFarm: (options?: FakeFarmOptions) => Promise<FakeFarm>;
}>({
	// The line canvas has no elements to inspect; its test hook reports what
	// it draws (flow/probe.ts). It only reads, so the page behaves the same.
	page: async ({ page }, use) => {
		await page.addInitScript(() => {
			(globalThis as Record<string, unknown>).__lineProbe = true;
		});
		await use(page);
	},
	fakeFarm: async ({ baseURL }, use) => {
		const farms: FakeFarm[] = [];
		await use(async (options) => {
			const f = await new FakeFarm({ site: baseURL, ...options }).start();
			farms.push(f);
			return f;
		});
		await Promise.all(farms.map((f) => f.stop()));
	}
});

/** What a fake farm's dashboard.json says for a network that watches without signing in. */
export const ANONYMOUS = { dashboardJson: { name: 'Test farm', auth: 'anonymous' } };

export const node = (page: Page, id: string) => page.locator(`[data-node-button="${id}"]`);
export const panel = (page: Page) => page.getByRole('dialog');
export const pill = (page: Page) => page.locator('.pill');

/**
 * Open the demo and wait until it is live and its builders, as cards or
 * pools, are drawn. Without `upstream` in the query the demo has no upstream
 * substituters, so the map is the one the tests were written for.
 */
export async function demo(page: Page, query = '') {
	const q = /(^|&)upstream=/.test(query) ? query : query ? `${query}&upstream=0` : 'upstream=0';
	await page.goto(`./?demo&${q}`);
	await expect(pill(page)).toHaveText('Live');
	// "Live" can paint a frame before the canvas has its nodes.
	await expect(
		page.locator('[data-node-button^="worker:"], [data-node-button^="pool:"]').first()
	).toBeVisible();
}

/** The toggle on a builder group's heading. */
export const poolToggle = (page: Page, system: string) =>
	page.locator(`[data-pool-toggle="${system}"]`);

/** Open a farm: its auth proxy signed this browser in, or its network watches without signing in. */
export async function openFarm(page: Page, farm: { readonly url: string }) {
	await page.goto(farm.url);
}

/** Starts recording every distinct "text | tooltip" the status pill shows. Returns a reader. */
export async function recordPill(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as { __pill: string[] };
		w.__pill = [];
		const pill = document.querySelector('.pill')!;
		const note = () => {
			const t = `${pill.textContent?.trim()} | ${pill.getAttribute('title') ?? ''}`;
			if (w.__pill.at(-1) !== t) w.__pill.push(t);
		};
		note();
		new MutationObserver(note).observe(pill, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true
		});
	});
	return () => page.evaluate(() => (window as unknown as { __pill: string[] }).__pill);
}

/** Builder node ids in DOM order, which is also tab order. */
export async function builderIds(page: Page): Promise<string[]> {
	return page
		.locator('[data-node-button^="worker:"]')
		.evaluateAll((els) => els.map((e) => e.getAttribute('data-node-button') ?? ''));
}

/** The line canvas's test hook, as the page has it. */
export type ProbeWindow = { __lines: LineProbe };
export type LineReport = ReturnType<LineProbe['report']>[number];

/** Every drawn line in paint order, bottom first, with its dots in flow px. */
export const lineReport = (page: Page) =>
	page.evaluate(() => (window as unknown as ProbeWindow).__lines.report());

/** Wait until the dots travel on more than `moreThan` lines of the canvas. */
export const dotsMove = (page: Page, moreThan = 0) =>
	expect
		.poll(async () => (await lineReport(page)).filter((l) => l.dots.length > 0).length)
		.toBeGreaterThan(moreThan);

/**
 * Wait until no animation moves the view, such as a refit or a zoom: until
 * two reads of the viewport's transform match. `poll` is expect.poll's
 * options, by default reads 400 ms apart; {} takes expect.poll's own.
 */
export async function viewSettled(
	page: Page,
	poll: { intervals?: number[]; timeout?: number } = { intervals: [400] }
) {
	const viewport = page.locator('.svelte-flow__viewport');
	let last = '';
	await expect
		.poll(async () => {
			const now = await viewport.evaluate((el) => (el as HTMLElement).style.transform);
			const same = now === last;
			last = now;
			return same;
		}, poll)
		.toBe(true);
}

/** The view's zoom, from the viewport's transform. */
export const zoomOf = (page: Page) =>
	page
		.locator('.svelte-flow__viewport')
		.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

/** One line as the canvas draws it now, or undefined when it is not drawn. */
export const lineOf = (page: Page, id: string) =>
	page.evaluate(
		(id) => (window as unknown as ProbeWindow).__lines.report().find((l) => l.id === id),
		id
	);

/** The canvas clock without pauses, in ms. It stands still while the dots do. */
export const travel = (page: Page) =>
	page.evaluate(() => (window as unknown as ProbeWindow).__lines.travel());

/** Draws of the line canvas so far. */
export const draws = (page: Page) =>
	page.evaluate(() => (window as unknown as ProbeWindow).__lines.draws().count);

/**
 * A point on a line, in page px, `at` flow px from its start, or from its end
 * when negative, as the canvas draws it. Clicks taken from here also check that
 * the hit test meets what the canvas draws.
 */
export async function pointOn(page: Page, edge: string, at: number) {
	const p = await page.evaluate(
		([edge, at]) => (window as unknown as ProbeWindow).__lines.client(edge, at),
		[edge, at] as const
	);
	expect(p, `${edge} is drawn`).not.toBeNull();
	return p!;
}

/** A line's opacity on the canvas: 1 when bright or with nothing in focus, 0.2 when faded. */
export const opacity = async (page: Page, edge: string) => (await lineOf(page, edge))?.fade;
