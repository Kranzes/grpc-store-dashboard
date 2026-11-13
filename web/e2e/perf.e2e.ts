import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
	ANONYMOUS,
	demo,
	dotsMove,
	draws,
	expect,
	lineReport,
	node,
	panel,
	pointOn,
	poolToggle,
	test,
	travel,
	viewSettled,
	zoomOf,
	type ProbeWindow
} from './fixtures.ts';

// Frame times at the scale target of 50 builders and 3000+ derivations in
// flight. Run on demand against the production build:
//   PERF=1 npx playwright test --project perf
// Headless numbers are indicative only. PERF_OUT=<file> saves the results.

const SECONDS = 12;

type Summary = Record<string, number>;

function stats(xs: number[]): Summary {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
	const r = (v: number) => Math.round(v * 100) / 100;
	return {
		n: s.length,
		mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
		p50: r(q(0.5)),
		p95: r(q(0.95)),
		p99: r(q(0.99)),
		max: r(s.at(-1) ?? 0)
	};
}

async function measure(page: Page, label: string) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	const metrics = async () =>
		Object.fromEntries(
			(await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])
		);
	await page.evaluate(() => performance.clearMeasures());
	const before = await metrics();
	const raw = await page.evaluate(async (seconds) => {
		const frames: number[] = [];
		const longTasks: number[] = [];
		const obs = new PerformanceObserver((l) => {
			for (const e of l.getEntries()) longTasks.push(e.duration);
		});
		obs.observe({ type: 'longtask' });
		await new Promise<void>((done) => {
			let last = performance.now();
			const end = last + seconds * 1000;
			const step = (t: number) => {
				frames.push(t - last);
				last = t;
				if (t < end) requestAnimationFrame(step);
				else done();
			};
			requestAnimationFrame(step);
		});
		obs.disconnect();
		const m = (name: string) => performance.getEntriesByName(name).map((e) => e.duration);
		return {
			frames,
			longTasks,
			apply: m('farm:apply'),
			publish: m('farm:publish'),
			render: m('farm:render')
		};
	}, SECONDS);
	const after = await metrics();
	const busy = (k: string) => Math.round(((after[k] - before[k]) / SECONDS) * 1000) / 10;
	await cdp.detach();
	return {
		label,
		frameMs: stats(raw.frames.slice(1)),
		framesOver20ms: raw.frames.filter((f) => f > 20).length,
		longTasks: { count: raw.longTasks.length, ...stats(raw.longTasks) },
		applyMs: stats(raw.apply),
		publishMs: stats(raw.publish),
		renderMs: stats(raw.render),
		// Share of wall time on the main thread, in percent.
		mainThread: {
			task: busy('TaskDuration'),
			script: busy('ScriptDuration'),
			style: busy('RecalcStyleDuration'),
			layout: busy('LayoutDuration')
		}
	};
}

// Without upstream substituters, and with the demo's three, whose card and
// lines add one line per builder.
for (const upstream of [0, 3]) {
	test(`60 fps at 50 builders and thousands in flight${upstream ? ', upstream substituters' : ''}`, async ({
		page
	}) => {
		test.setTimeout(180_000);
		await page.addInitScript(() => {
			(globalThis as { __farmProfile?: boolean }).__farmProfile = true;
		});
		await demo(page, `builders=50&upstream=${upstream}`);
		// Groups this size start as pools; measure the cards, as the target says.
		for (const system of ['x86_64-linux', 'aarch64-linux']) await poolToggle(page, system).click();
		await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(50);
		// Let the view settle through the fit animation and the first measurements.
		await page.waitForTimeout(3000);
		const inFlight = await page.evaluate(() =>
			[...document.querySelectorAll('.totals .now dd')]
				.map((e) => Number(e.textContent?.replace(/[^\d]/g, '')))
				.reduce((a, b) => a + b, 0)
		);
		const edges = (await lineReport(page)).filter((l) => l.active).length;

		const results = [await measure(page, 'canvas only')];

		await node(page, 'scheduler').click();
		await expect(panel(page).getByRole('list', { name: 'Queued derivations' })).toBeVisible();
		results.push(await measure(page, 'scheduler panel open (queue list)'));
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();

		// Every assignment line in focus: a click on the bus 30 px out of the
		// scheduler, short of the first trunk 70 px out. Its first point lies on
		// the scheduler's border, and at this zoom 10 px is 3 on screen.
		await viewSettled(page, {});
		const firstAssign = (await lineReport(page)).find((l) => l.kind === 'assign')!.id;
		const bus = await pointOn(page, firstAssign, 30);
		await page.mouse.click(bus.x, bus.y);
		// The heading shows only the end that varies, such as "50 builders"; its name has the kind.
		await expect(page.locator('#panel-title')).toHaveAccessibleName(/^Assignments to /);
		await page.waitForTimeout(1000);
		results.push(await measure(page, 'assignment bus focused'));
		await page.keyboard.press('Escape');
		await expect(panel(page)).toBeHidden();

		// Rates on lines at zoom 1, where every label shows.
		await page.getByRole('button', { name: 'Rates on lines' }).click();
		for (let i = 0; i < 12 && (await zoomOf(page)) < 1; i++) {
			await page.getByRole('button', { name: 'Zoom in' }).click();
			await page.waitForTimeout(400);
		}
		await expect(page.locator('.rate-label').first()).toBeAttached();
		await page.waitForTimeout(1000);
		results.push(await measure(page, 'rates on lines, zoom 1'));

		const lines = (await lineReport(page)).length;
		const out = { upstream, inFlight, lines, animatedEdges: edges, seconds: SECONDS, results };
		console.log(JSON.stringify(out, null, 2));
		if (process.env.PERF_OUT)
			writeFileSync(
				upstream ? process.env.PERF_OUT.replace(/(\.json)?$/, '-upstream$1') : process.env.PERF_OUT,
				JSON.stringify(out, null, 2)
			);
		expect(inFlight).toBeGreaterThan(3000);
		for (const r of results) expect(r.frameMs.p95, r.label).toBeLessThanOrEqual(20);
	});
}

// Frames per second at three farm sizes across three systems, and at the largest
// under autoscaling: requestAnimationFrame callbacks counted over 2 s, after 3 s
// for the view to settle.
const FPS_SYSTEMS = 'x86_64-linux,aarch64-linux,aarch64-darwin';
for (const [builders, churn, upstream] of [
	[12, 0, 0],
	[200, 0, 0],
	[1000, 0, 0],
	[1000, 60, 0],
	[12, 0, 3],
	[200, 0, 3],
	[1000, 0, 3]
]) {
	const name = `fps at ${builders} builders${churn ? `, churn ${churn}` : ''}${upstream ? ', upstream substituters' : ''}`;
	test(name, async ({ page }) => {
		test.setTimeout(120_000);
		await demo(
			page,
			`builders=${builders}&systems=${FPS_SYSTEMS}&churn=${churn}&upstream=${upstream}`
		);
		await page.waitForTimeout(3000);
		const fps = await page.evaluate(
			() =>
				new Promise<number>((done) => {
					let frames = 0;
					let start = 0;
					const step = (t: number) => {
						if (!start) start = t;
						else frames++;
						if (t - start < 2000) requestAnimationFrame(step);
						else done((frames * 1000) / (t - start));
					};
					requestAnimationFrame(step);
				})
		);
		const nodes = await page.locator('.svelte-flow__node').count();
		console.log(
			JSON.stringify({
				builders,
				churn,
				upstream,
				fps: Math.round(fps * 10) / 10,
				nodes
			})
		);
		// The target is 60; the margin absorbs a busy machine. Before pools,
		// 1000 builders ran at about 11.
		expect(fps).toBeGreaterThan(50);
	});
}

// What the idle lines cost, counted rather than timed: on a 240 Hz screen the
// line canvas must still draw at most 60 times a second, and write nothing to
// the DOM. A tick per display frame, or per line, would draw far more often.
// The page gets a 240 Hz requestAnimationFrame, since headless Chromium draws
// at 60. The rate labels and focus must not add work per frame: labels change
// at most once a second, and focus only dims lines on the same canvas.
function fastFrames() {
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	let next = 0;
	window.requestAnimationFrame = (cb) => {
		const id = ++next;
		timers.set(
			id,
			setTimeout(() => {
				timers.delete(id);
				cb(performance.now());
			}, 1000 / 240)
		);
		return id;
	};
	window.cancelAnimationFrame = (id) => {
		clearTimeout(timers.get(id));
		timers.delete(id);
	};
}

for (const variant of ['labels off', 'labels on', 'labels on, builder focused'] as const) {
	test(`idle lines draw at most 60 times a second on a 240 Hz screen, ${variant}`, async ({
		page
	}) => {
		await page.addInitScript(fastFrames);
		await demo(page);
		await dotsMove(page, 5);
		if (variant !== 'labels off') {
			await page.getByRole('button', { name: 'Rates on lines' }).click();
			await expect(page.locator('.rate-label').first()).toBeVisible();
		}
		if (variant === 'labels on, builder focused') {
			await page.locator('[data-node-button^="worker:"]').nth(6).click();
			await expect(page.locator('.farm-map.focusing')).toHaveCount(1);
			// The panel's reveal may pan the view, which holds every line still.
			await page.waitForTimeout(1000);
		}
		// Wait until no refit moves the view. The first numbers resize the
		// cards, and each refit then draws the canvas on every display frame,
		// which at 240 Hz would count against the 60 a second below.
		await viewSettled(page, { intervals: [1000], timeout: 20_000 });
		await expect(page.locator('.farm-map.moving')).toHaveCount(0);
		const seconds = 2;
		const r = await page.evaluate(async (seconds) => {
			const probe = (window as unknown as ProbeWindow).__lines;
			const canvas = document.querySelector('canvas.line-canvas')!;
			const edges = document.querySelector('.svelte-flow__edges')!;
			// Writes to the DOM from the lines: the canvas element, and Svelte
			// Flow's edge container, which stays empty.
			let lineWrites = 0;
			const obs = new MutationObserver((records) => (lineWrites += records.length));
			obs.observe(canvas, { attributes: true });
			obs.observe(edges, { subtree: true, childList: true, attributes: true });
			// Batches of changes in the label overlay, if any.
			let labelBatches = 0;
			const labels = document.querySelector('.rate-labels');
			const labelObs = new MutationObserver(() => labelBatches++);
			if (labels)
				labelObs.observe(labels, {
					subtree: true,
					childList: true,
					characterData: true,
					attributes: true
				});
			const before = probe.draws();
			let frames = 0;
			const end = performance.now() + seconds * 1000;
			await new Promise<void>((done) => {
				const step = (t: number) => {
					frames++;
					if (t < end) requestAnimationFrame(step);
					else done();
				};
				requestAnimationFrame(step);
			});
			const after = probe.draws();
			obs.disconnect();
			labelObs.disconnect();
			return {
				frames,
				draws: after.count - before.count,
				msPerDraw: (after.ms - before.ms) / Math.max(1, after.count - before.count),
				lineWrites,
				labelBatches,
				// CSS animations or transitions running anywhere on the map's lines.
				animations: document.getAnimations().filter((a) => {
					const t = (a.effect as KeyframeEffect | null)?.target ?? null;
					return t === canvas || edges.contains(t);
				}).length
			};
		}, seconds);
		console.log(JSON.stringify({ variant, seconds, ...r }));
		// Check that the page ran faster than 60 Hz, so the cap below means something.
		expect(r.frames).toBeGreaterThan(seconds * 120);
		expect(r.animations).toBe(0);
		expect(r.lineWrites).toBe(0);
		expect(r.draws).toBeGreaterThan(seconds * 20);
		// 60 a second, with room for draws the view or a new look asks for.
		// A draw per display frame would be about 480.
		expect(r.draws).toBeLessThanOrEqual(seconds * 75);
		// Labels read numbers once a second, and a new layout may move them once more.
		expect(r.labelBatches).toBeLessThanOrEqual(seconds * 2);
	});
}

// What the line canvas asks of its 2D context, counted on the real one:
// strokes, dot arcs, and the most arcs any one fill took. A count, not a
// time: headless Chromium's software canvas draws everything, or one path of
// every dot, about as fast as it draws what is in view one dot at a time,
// while GPU Firefox drew one path of every dot 10 to 20 times slower.
type Paint = { strokes: number; arcs: number; arcsPerFill: number };
type PaintWindow = ProbeWindow & {
	__paint: Paint;
	__phase: Paint & { count: number; ms: number; frames: number; on: boolean };
};

function countPaint() {
	const paint: Paint = { strokes: 0, arcs: 0, arcsPerFill: 0 };
	(window as unknown as PaintWindow).__paint = paint;
	const proto = CanvasRenderingContext2D.prototype;
	let arcs = 0;
	const count = (name: 'beginPath' | 'arc' | 'fill' | 'stroke', note: () => void) => {
		const draw = proto[name] as (this: CanvasRenderingContext2D, ...args: unknown[]) => void;
		proto[name] = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
			if (this.canvas.classList.contains('line-canvas')) note();
			draw.apply(this, args);
		};
	};
	count('beginPath', () => (arcs = 0));
	count('arc', () => {
		paint.arcs++;
		arcs++;
	});
	count('fill', () => (paint.arcsPerFill = Math.max(paint.arcsPerFill, arcs)));
	count('stroke', () => paint.strokes++);
}

/** What the line canvas drew while `act` ran, per draw, and the display frames meanwhile. */
async function paintDuring(page: Page, act: () => Promise<unknown>) {
	await page.evaluate(() => {
		const w = window as unknown as PaintWindow;
		w.__paint.arcsPerFill = 0;
		w.__phase = { ...w.__paint, ...w.__lines.draws(), frames: 0, on: true };
		const step = () => {
			if (!w.__phase.on) return;
			w.__phase.frames++;
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
	await act();
	return page.evaluate(() => {
		const w = window as unknown as PaintWindow;
		const { __paint: now, __phase: then } = w;
		then.on = false;
		const d = w.__lines.draws();
		const draws = d.count - then.count;
		const per = (v: number) => Math.round((v / Math.max(1, draws)) * 10) / 10;
		return {
			draws,
			frames: then.frames,
			strokesPerDraw: per(now.strokes - then.strokes),
			arcsPerDraw: per(now.arcs - then.arcs),
			arcsPerFill: now.arcsPerFill,
			msPerDraw: Math.round(((d.ms - then.ms) / Math.max(1, draws)) * 100) / 100
		};
	});
}

test('panning at zoom 2 draws once per view move, and fast', async ({ page }) => {
	test.setTimeout(120_000);
	await page.addInitScript(countPaint);
	await demo(page, 'builders=50');
	for (const system of ['x86_64-linux', 'aarch64-linux']) await poolToggle(page, system).click();
	await expect(page.locator('.svelte-flow__node-builder')).toHaveCount(50);
	await dotsMove(page, 5);
	await page.waitForTimeout(3000);
	const lines = (await lineReport(page)).length;
	const fit = await paintDuring(page, () => page.waitForTimeout(2000));

	// Zoom 2 at the middle of the map, where the user pans.
	for (let i = 0; i < 20 && (await zoomOf(page)) < 2; i++) {
		await page.getByRole('button', { name: 'Zoom in' }).click();
		await page.waitForTimeout(400);
	}
	expect(await zoomOf(page)).toBeGreaterThanOrEqual(2);
	await expect(page.locator('.farm-map.moving')).toHaveCount(0);
	const rest = await paintDuring(page, () => page.waitForTimeout(2000));

	// A drag across the pane, with one view move per step and the dots held.
	const start = await page.evaluate(() => {
		const pane = document.querySelector('.svelte-flow__pane')!.getBoundingClientRect();
		for (let y = pane.top + 200; y < pane.bottom - 200; y += 20)
			for (let x = pane.left + 300; x < pane.right - 300; x += 20)
				if (document.elementFromPoint(x, y)?.classList.contains('svelte-flow__pane'))
					return { x, y };
		return null;
	});
	expect(start).not.toBeNull();
	await page.mouse.move(start!.x, start!.y);
	await page.mouse.down();
	const pan = await paintDuring(page, async () => {
		for (let i = 1; i <= 60; i++) await page.mouse.move(start!.x - 4 * i, start!.y - 2 * i);
	});
	await page.mouse.up();

	const out = { lines, fit, rest, pan };
	console.log(JSON.stringify(out));
	if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(out, null, 2));
	// lineLayer.test.ts checks one dot per fill and that a draw skips what is
	// out of view; this measures what only a browser can: draws per frame and time.
	// A pan draws once per view move, never more than once a frame on the whole.
	expect(pan.draws).toBeGreaterThan(30);
	expect(pan.draws).toBeLessThanOrEqual(pan.frames + 2);
	// Headless draws take 0.5 to 1 ms here, counting included; this catches
	// a draw that grows several times over.
	for (const r of [fit, rest, pan]) expect(r.msPerDraw).toBeLessThan(3);
});

test('a hidden tab draws nothing, and the dots go on from where they stopped', async ({ page }) => {
	await demo(page);
	await dotsMove(page, 5);
	// The canvas listens to the Page Visibility API. Headless Chromium keeps
	// every page visible, so the test tells the page it is hidden.
	const setHidden = (hidden: boolean) =>
		page.evaluate((hidden) => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => (hidden ? 'hidden' : 'visible')
			});
			Object.defineProperty(document, 'hidden', {
				configurable: true,
				get: () => hidden
			});
			document.dispatchEvent(new Event('visibilitychange'));
		}, hidden);
	await setHidden(true);
	const n = await draws(page);
	const held = await travel(page);
	await page.waitForTimeout(1500);
	expect(await draws(page)).toBe(n);
	expect(await travel(page)).toBe(held);
	const shown = await page.evaluate(() => performance.now());
	await setHidden(false);
	await expect.poll(() => draws(page)).toBeGreaterThan(n);
	await expect.poll(() => travel(page)).toBeGreaterThan(held);
	const [t, now] = await Promise.all([travel(page), page.evaluate(() => performance.now())]);
	expect(t - held).toBeLessThanOrEqual(now - shown + 20);
});

// The Logs tab. Times come from the page's own clock.
test.describe('logs', () => {
	const KERNEL = `${'k'.repeat(32)}-linux-6.12.21.drv`;
	const viewer = (page: Page) => page.locator('section.viewer');
	const results: Record<string, unknown> = {};
	test.afterAll(() => {
		console.log(JSON.stringify(results, null, 1));
		if (process.env.PERF_OUT)
			writeFileSync(`${process.env.PERF_OUT}.logs.json`, JSON.stringify(results, null, 1));
	});

	/** Click `selector` and time until `done` holds, in the page. */
	async function timeTo(
		page: Page,
		click: string,
		done: string,
		timeoutMs = 60_000
	): Promise<number> {
		return page.evaluate(
			async ([click, done, timeoutMs]) => {
				const t0 = performance.now();
				(document.querySelector(click as string) as HTMLElement).click();
				const check = new Function(`return (${done as string})`) as () => boolean;
				while (!check()) {
					if (performance.now() - t0 > (timeoutMs as number)) return -1;
					await new Promise((r) => requestAnimationFrame(r));
				}
				return Math.round(performance.now() - t0);
			},
			[click, done, timeoutMs] as const
		);
	}

	test('tab switch, 50 builders', async ({ page }) => {
		await demo(page, 'builders=50');
		const times = { toLogs: [] as number[], toOverview: [] as number[] };
		for (let i = 0; i < 5; i++) {
			times.toLogs.push(
				await timeTo(page, '[data-tab="logs"]', `!!document.querySelector('.build-list')`)
			);
			times.toOverview.push(
				await timeTo(
					page,
					'[data-tab="overview"]',
					`!!document.querySelector('.svelte-flow__node-pool, .svelte-flow__node-builder')`
				)
			);
		}
		results.tabSwitchMs = { toLogs: stats(times.toLogs), toOverview: stats(times.toOverview) };
		expect(Math.max(...times.toLogs, ...times.toOverview)).toBeGreaterThan(0);
	});

	test('a 50 MB demo log: first rows, find, scroll and folds', async ({ page }) => {
		test.setTimeout(180_000);
		await page.goto(`./logs/?demo&builders=12&upstream=0`);
		await expect(page.locator('.build-list a.item').first()).toBeVisible();
		await page.evaluate((drv) => {
			const a = document.createElement('a');
			a.id = 'perf-open';
			a.href = `${location.pathname}?demo&builders=12&upstream=0&drv=${drv}`;
			document.body.append(a);
		}, KERNEL);
		results.demo50mbFirstRowsMs = await timeTo(
			page,
			'#perf-open',
			`!!document.querySelector('section.viewer .scroller .row')`
		);
		const t0 = Date.now();
		await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 120_000 });
		results.demo50mbLoadedMs = Date.now() - t0;
		// Find: the first hit, and all of them counted.
		const find = viewer(page).getByRole('searchbox', { name: 'Find in log' });
		const found = await page.evaluate(async () => {
			const input = document.querySelector<HTMLInputElement>('section.viewer input[type=search]')!;
			const count = () => document.querySelector('section.viewer .count')?.textContent ?? '';
			const t0 = performance.now();
			input.value = 'fair_sched_group';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			let first = -1;
			for (;;) {
				const c = count();
				if (first < 0 && /\d/.test(c)) first = performance.now() - t0;
				if (/matches/.test(c) && !/Searching/.test(c) && first >= 0) {
					await new Promise((r) => setTimeout(r, 50));
					if (count() === c)
						return { firstMs: Math.round(first), allMs: Math.round(performance.now() - t0), c };
				}
				if (performance.now() - t0 > 30_000) return { firstMs: first, allMs: -1, c };
				await new Promise((r) => requestAnimationFrame(r));
			}
		});
		results.find50mb = found;
		await find.fill('');
		// Expand all, then scroll by wheel and measure frames.
		results.expandAllMs = await timeTo(
			page,
			'[data-fold="open"]',
			`document.querySelectorAll('section.viewer .scroller .row.line').length > 5`
		);
		await viewer(page).locator('.scroller').hover();
		const wheel = async (wrap: boolean) => {
			await page.evaluate(() => {
				(window as unknown as { __f: number[] }).__f = [];
				let last = performance.now();
				const step = (t: number) => {
					(window as unknown as { __f: number[] }).__f.push(t - last);
					last = t;
					if ((window as unknown as { __f: number[] }).__f.length < 400)
						requestAnimationFrame(step);
				};
				requestAnimationFrame(step);
			});
			for (let i = 0; i < 60; i++) {
				await page.mouse.wheel(0, 400);
				await page.waitForTimeout(16);
			}
			const f = await page.evaluate(() => (window as unknown as { __f: number[] }).__f.slice(1));
			return { wrap, ...stats(f) };
		};
		results.wheelWrapOn = await wheel(true);
		await viewer(page).focus();
		await page.keyboard.press('w');
		await viewer(page).locator('.scroller').hover();
		results.wheelWrapOff = await wheel(false);
		// Collapse all on 700,000 lines.
		results.collapseAllMs = await timeTo(
			page,
			'[data-fold="close"]',
			`document.querySelectorAll('section.viewer .scroller .row.line').length === 0`
		);
	});

	test('a 50 MB log over the fake farm, and a 300 MB one', async ({ page, fakeFarm }) => {
		test.setTimeout(240_000);
		for (const logsize of [1, 6]) {
			const farm = await fakeFarm({ ...ANONYMOUS, base: '/dash/', mock: { builders: 3, logsize } });
			const on = Object.keys(farm.mock.inspect().machines)[0];
			await page.goto(`${farm.url}logs/`);
			await expect(page.locator('.build-list')).toBeVisible();
			await page.evaluate(
				([drv, on]) => {
					const a = document.createElement('a');
					a.id = 'perf-open';
					a.href = `${location.pathname}?drv=${drv}&on=${encodeURIComponent(on)}`;
					document.body.append(a);
				},
				[KERNEL, on] as const
			);
			const first = await timeTo(
				page,
				'#perf-open',
				`!!document.querySelector('section.viewer .scroller .row')`,
				120_000
			);
			const t0 = Date.now();
			await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 200_000 });
			results[`fakeFarm${logsize === 1 ? '50' : '300'}mb`] = {
				firstRowsMs: first,
				loadedAfterFirstRowsMs: Date.now() - t0
			};
		}
	});

	test('a 300 MB failed log over the fake farm: its end and first error first', async ({
		page,
		fakeFarm
	}) => {
		test.setTimeout(240_000);
		// The scheduler keeps the kernel as failed.
		const farm = await fakeFarm({
			...ANONYMOUS,
			base: '/dash/',
			mock: { builders: 3, logsize: 6 },
			logs: { failed: [KERNEL] }
		});
		const on = Object.keys(farm.mock.inspect().machines)[0];
		await page.goto(`${farm.url}logs/`);
		await expect(page.locator('.build-list')).toBeVisible();
		const runs: Record<string, number>[] = [];
		for (let i = 0; i < 3; i++) {
			await page.evaluate(
				([drv, on, i]) => {
					const a = document.createElement('a');
					a.id = `perf-open-${i}`;
					a.href = `${location.pathname}?drv=${drv}&on=${encodeURIComponent(on)}&run=${i}`;
					document.body.append(a);
				},
				[KERNEL, on, i] as const
			);
			const make0 = farm.logMakeMs;
			// The last line and an error line in view, the gap row above them.
			const endMs = await timeTo(
				page,
				`#perf-open-${i}`,
				`(() => {
					const v = document.querySelector('section.viewer');
					if (!v || !/Failed/.test(v.textContent ?? '')) return false;
					const s = v.querySelector('.scroller');
					const box = s?.getBoundingClientRect();
					const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; };
					const err = [...v.querySelectorAll('.scroller .row.error')].some(inView);
					const nums = [...v.querySelectorAll('.scroller .gutter a')].filter(inView).map((a) => Number(a.textContent));
					const lines = Number((v.querySelector('.status')?.textContent ?? '').match(/([0-9,]+) lines/)?.[1].replaceAll(',', '') ?? NaN);
					return err && nums.length > 0 && Math.max(...nums) >= lines - 40;
				})()`,
				120_000
			);
			const t0 = Date.now();
			await expect(viewer(page).locator('.status')).toContainText('loaded', { timeout: 200_000 });
			runs.push({
				endAndFirstErrorMs: endMs,
				loadedAfterMs: Date.now() - t0,
				fakeFarmMakingMs: Math.round(farm.logMakeMs - make0)
			});
			// Back to the list, so the next open is a fresh viewer.
			await page.goto(`${farm.url}logs/`);
			await expect(page.locator('.build-list')).toBeVisible();
		}
		results.fakeFarm300mbFailed = runs;
		expect(runs.every((r) => r.endAndFirstErrorMs > 0)).toBe(true);
	});
});
