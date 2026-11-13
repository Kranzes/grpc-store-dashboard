import { expect, it } from 'vitest';
import {
	DrvGone_Outcome,
	DrvState_Cause,
	DrvState_Phase,
	type WatchEvent
} from '#lib/gen/events_pb.ts';
import { MockFarm, mockOptions } from '#lib/source/mock.ts';
import { E, Stream, T0, type Ev } from './fixtures.ts';
import { FarmReducer } from './reducer.ts';

/** The fastest of `runs` calls, in ms: other work on the machine only ever slows a call down. */
function best<T>(runs: number, fn: () => T): { ms: number; value: T } {
	let ms = Infinity;
	let value = fn();
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		value = fn();
		ms = Math.min(ms, performance.now() - start);
	}
	return { ms, value };
}

it('applies 200k events at scale well under a second', { timeout: 120_000 }, () => {
	// Real traffic from the simulator at 50 builders, about 3000 drvs in flight.
	const farm = new MockFarm(mockOptions({ builders: 50, seed: 11 }), T0);
	const batches: { t: number; events: WatchEvent[] }[] = [{ t: T0, events: farm.snapshot() }];
	let n = batches[0].events.length;
	let t = T0;
	while (n < 200_000) {
		t += 100;
		const events = farm.advance(t);
		batches.push({ t, events });
		n += events.length;
	}

	// Best of three fresh runs: other work on the machine only ever slows a run down.
	let r = new FarmReducer();
	let applyMs = Infinity;
	for (let run = 0; run < 3; run++) {
		r = new FarmReducer();
		r.beginStream();
		const start = performance.now();
		for (const b of batches) {
			const res = r.apply(b.events, b.t);
			if (!res.ok) throw new Error(res.error);
		}
		applyMs = Math.min(applyMs, performance.now() - start);
	}

	// The store calls views() at most 30 times a second.
	const viewsStart = performance.now();
	const calls = 300;
	for (let i = 0; i < calls; i++) r.views(t + i * 33, 15);
	const viewMs = (performance.now() - viewsStart) / calls;

	const q = performance.now();
	const queued = r.drvsQueued(100);
	const queryMs = performance.now() - q;

	// A line panel asks once a second, here for the bundle of every assignment line.
	const assignIds = r.views(t, 15).topology.workers.map((a) => `assign:${a}`);
	const detail = best(5, () => r.edgeDetail(assignIds, t, 15));

	console.info(
		`reducer: ${n} events in ${applyMs.toFixed(0)} ms ` +
			`(${((applyMs * 1000) / n).toFixed(2)} µs/event), ${r.counts().drvs} in flight; ` +
			`views() ${viewMs.toFixed(3)} ms; drvsQueued(100) over ${r.counts().queued} in ${queryMs.toFixed(2)} ms; ` +
			`edgeDetail over ${assignIds.length} assign lines in ${detail.ms.toFixed(2)} ms`
	);
	expect(queued).toHaveLength(100);
	expect(r.counts().drvs).toBeGreaterThan(2500);
	expect(applyMs).toBeLessThan(1000);
	expect(viewMs).toBeLessThan(2);
	expect(detail.value!.rows).toHaveLength(assignIds.length);
	expect(detail.value!.items).toHaveLength(50);
	expect(detail.ms).toBeLessThan(5);
});

it(
	'answers a line detail query over 1000 busy builders in under 10 ms',
	{ timeout: 60_000 },
	() => {
		// 1000 builders with 16 slots each, all assigned, and 32 finished builds
		// each: about 48k drvs for the items of the bundle of every assignment line.
		const addrs = Array.from({ length: 1000 }, (_, i) => `10.${i >> 8}.0.${i & 255}:50051`);
		const path = (tag: string, i: number, j: number) =>
			`/nix/store/${String(i * 100 + j).padStart(32, '0')}-${tag}.drv`;
		const r = new FarmReducer();
		const s = new Stream();
		r.beginStream();
		const body: Ev[] = addrs.map((a) => E.worker(a, { maxJobs: 16 }));
		addrs.forEach((a, i) => {
			for (let j = 0; j < 16; j++)
				body.push(
					E.drv(path('run', i, j), {
						phase: DrvState_Phase.ASSIGNED,
						workerAddr: a,
						assignedMs: BigInt(T0 - (i * 16 + j) * 10)
					})
				);
		});
		expect(r.apply(s.snapshot(E.reset(), ...body), T0).ok).toBe(true);
		addrs.forEach((a, i) => {
			const done: Ev[] = [];
			for (let j = 0; j < 32; j++) {
				const p = path('done', i, j);
				done.push(
					E.drv(p, {
						cause: DrvState_Cause.ASSIGNED,
						phase: DrvState_Phase.ASSIGNED,
						workerAddr: a,
						assignedMs: BigInt(T0 + i * 32 + j)
					}),
					E.gone(p, DrvGone_Outcome.BUILT, { workerAddr: a })
				);
			}
			expect(r.apply(s.next(...done), T0 + 1000).ok).toBe(true);
		});
		const now = T0 + 2000;
		r.views(now, 15);
		expect(r.counts().assigned).toBe(16_000);

		const ids = addrs.map((a) => `assign:${a}`);
		const detail = best(5, () => r.edgeDetail(ids, now, 15));
		console.info(`edgeDetail over 1000 assign lines and 48k drvs in ${detail.ms.toFixed(2)} ms`);
		expect(detail.value).toMatchObject({ count: 1000, total: 32_000, finished: 32_000 });
		expect(detail.value!.rows).toHaveLength(1000);
		expect(detail.value!.items).toHaveLength(50);
		expect(detail.ms).toBeLessThan(10);
	}
);

/** A minute of a farm with upstream substituters, applied best of three: the reducer and its cost per event. */
function upstreamMinute(builders: number) {
	const farm = new MockFarm(mockOptions({ builders, seed: 7, upstream: 3 }), T0);
	const batches: { t: number; events: WatchEvent[] }[] = [{ t: T0, events: farm.snapshot() }];
	let n = batches[0].events.length;
	let reports = 0;
	let t = T0;
	for (; t < T0 + 60_000;) {
		t += 100;
		const events = farm.advance(t);
		for (const e of events) if (e.event.case === 'worker') reports++;
		batches.push({ t, events });
		n += events.length;
	}
	let r = new FarmReducer();
	let applyMs = Infinity;
	for (let run = 0; run < 3; run++) {
		r = new FarmReducer();
		r.beginStream();
		const start = performance.now();
		for (const b of batches) {
			const res = r.apply(b.events, b.t);
			if (!res.ok) throw new Error(res.error);
		}
		applyMs = Math.min(applyMs, performance.now() - start);
	}
	return { r, t, n, reports, applyMs, usPerEvent: (applyMs * 1000) / n };
}

it(
	'keeps apply and views() within budget with upstream substituters at 1000 builders',
	{
		timeout: 180_000
	},
	() => {
		const small = upstreamMinute(50);
		const { r, t, n, reports, applyMs, usPerEvent } = upstreamMinute(1000);
		const views = best(30, () => r.views(t, 15));
		console.info(
			`upstream at 1000 builders: ${n} events (${reports} WorkerStates) in ${applyMs.toFixed(0)} ms ` +
				`(${usPerEvent.toFixed(2)} µs/event, ${small.usPerEvent.toFixed(2)} at 50); views() ${views.ms.toFixed(2)} ms`
		);
		expect(views.value.upstream!.builders).toBeGreaterThan(900);
		expect(views.value.topology.upstreamWorkers.length).toBeGreaterThan(900);
		// An event costs about what it costs at 50 builders, on any machine.
		expect(usPerEvent / small.usPerEvent).toBeLessThan(2);
		// views() 30 times a second fits a frame.
		expect(views.ms).toBeLessThan(16);
	}
);
