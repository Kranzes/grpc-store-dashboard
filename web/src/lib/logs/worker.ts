// The log worker, one per open viewer. Bytes go in, zstd from a builder or
// the demo's generated log, and rows, groups, errors and search come out.
// Progress and the group tree go to the viewer at most 10 times a second.

import {
	finalLog,
	planLog,
	runningLog,
	type LogEnding,
	type LogLines,
	type LogPlan
} from '#lib/source/mock-log.ts';
import type { DemoLogPlan } from '#lib/source/mock.ts';
import { LogEngine } from './engine.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

const engine = new LogEngine();
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotify = 0;
let groupsVersion = -1;
let errorsSent = -1;
let searching = false;

/** Apply what arrived. When the ring moved group ids, the viewer hears how, and gets the tree whole. */
function settle() {
	const moved = engine.settle();
	if (!moved) return;
	groupsVersion = -1;
	errorsSent = -1;
	post({ t: 'moved', ...moved });
}

/** Tell the viewer what changed, at most every 100 ms. */
function notify(now = false) {
	if (notifyTimer !== null) {
		if (!now) return;
		clearTimeout(notifyTimer);
		notifyTimer = null;
	}
	const wait = now ? 0 : Math.max(0, 100 - (performance.now() - lastNotify));
	notifyTimer = setTimeout(flush, wait);
}

/**
 * Tell the viewer now. A call's end flushes before the viewer's next
 * question, so the progress it reads after the call is the call's last.
 */
function flush() {
	if (notifyTimer !== null) clearTimeout(notifyTimer);
	notifyTimer = null;
	lastNotify = performance.now();
	settle();
	const t = engine.tree;
	if (t.version !== groupsVersion) {
		groupsVersion = t.version;
		post({
			t: 'groups',
			groups: t.groups.map((g) => ({
				...g,
				line: engine.store.lineOf(g.headerSlot) ?? null,
				lastLine: engine.store.lineOf(g.lastSlot) ?? null
			})),
			open: t.open.map((g) => g.id),
			failed: t.failedGroup()?.id ?? null
		});
	}
	if (t.errorSlots.length + t.makeSlots.length !== errorsSent) {
		errorsSent = t.errorSlots.length + t.makeSlots.length;
		post({ t: 'errors', e: engine.errors() });
	}
	// Progress last, so "loaded" comes after the groups and errors it covers.
	const p = engine.progress();
	const demoIdle = !demo || (demo.ready && demo.sent >= demo.view.count);
	post({ t: 'progress', p: { ...p, idle: p.idle && demoIdle } });
	if (engine.search.pending()) runSearch();
}

/**
 * Search in slices, so rows and folds are answered in between. Each slice
 * goes on with the search as it is then: a new query, or one a rebuild
 * started over, continues in the slices already running.
 */
function runSearch() {
	if (searching) return;
	searching = true;
	const step = () => {
		settle();
		const more = engine.searchStep(12);
		post({ t: 'search', s: engine.searchInfo() });
		if (more) setTimeout(step, 0);
		else searching = false;
	};
	step();
}

// ------------------------------------------------------------------ demo

/** The demo's build, generated here in pieces so rows come between them. */
type Demo = {
	plan: DemoLogPlan;
	log: LogPlan;
	/** Lines pushed so far. */
	sent: number;
	/** What the build shows now. */
	view: LogLines;
	ended: LogEnding | null;
	gen: number;
	/** The demo's clock at the last tick, browser ms. */
	nowMs: number;
	/** False while a real log for the nixoslog option loads. */
	ready: boolean;
};
let demo: Demo | null = null;
let demoGen = 0;

const PIECE = 1 << 20;
const encoder = new TextEncoder();

function demoPump() {
	const d = demo;
	if (!d) return;
	const gen = d.gen;
	const step = () => {
		if (!demo || demo.gen !== gen || !demo.ready) return;
		const v = demo.view;
		if (demo.sent >= v.count) {
			notify(true);
			return;
		}
		// About 1 MiB of lines a piece.
		const parts: string[] = [];
		let to = demo.sent;
		let size = 0;
		while (to < v.count && size < PIECE) {
			const line = v.line(to++);
			parts.push(line, '\n');
			size += line.length + 1;
		}
		engine.push(encoder.encode(parts.join('')));
		demo.sent = to;
		notify(demo.sent === v.count);
		setTimeout(step, 0);
	};
	step();
}

/** Move the demo's clock to `nowMs`, and push what its log holds by then. */
function advance(d: Demo, nowMs = d.nowMs) {
	d.nowMs = nowMs;
	demoView(d);
	demoPump();
}

function demoView(d: Demo) {
	if (d.ended) {
		d.view = finalLog(d.log, d.ended);
		return;
	}
	const started = d.plan.startedMs;
	if (started === null) {
		d.view = { count: 0, line: () => '' };
		return;
	}
	const sim = (d.nowMs - started) * d.plan.speed;
	const running = runningLog(d.log, sim);
	// A build that then fails never showed the footer of its failed phase.
	d.view = { count: Math.min(running.count, d.log.failAt), line: running.line };
}

function startDemo(plan: DemoLogPlan) {
	const log = planLog(plan);
	// The demo's log comes whole, as in one call, so past 16 MiB the store keeps a ring.
	engine.store.ring = true;
	const d: Demo = {
		plan,
		log,
		sent: 0,
		view: { count: 0, line: () => '' },
		ended: plan.ending,
		gen: ++demoGen,
		nowMs: plan.nowMs,
		ready: true
	};
	demo = d;
	// A real NixOS test log in place of the generated one, in dev and test builds only.
	const real = plan.nixoslog;
	if (import.meta.env.DEV && real && log.profile === 'nixos-test') {
		d.ready = false;
		void import('#lib/source/nixos-logs.ts')
			.then(async (m) => m.nixosLogPlan(log, await m.nixosLogLines(real)))
			.catch((e: unknown) => {
				console.warn('nixoslog:', e);
				return log;
			})
			.then((p) => {
				if (demo !== d) return;
				d.log = p;
				d.ready = true;
				advance(d);
			});
		return;
	}
	advance(d);
}

// ---------------------------------------------------------------- messages

self.onmessage = (ev: MessageEvent<ToWorker>) => {
	const m = ev.data;
	switch (m.t) {
		case 'call':
			engine.beginCall(m.call, m.part, m.info, m);
			notify();
			break;
		case 'zstd':
			engine.zstd(m.call, m.data);
			notify();
			break;
		case 'end': {
			const moved = engine.endCall(m.call, m.complete);
			if (moved) {
				// The tree was built again, so the viewer gets it whole.
				groupsVersion = -1;
				errorsSent = -1;
				post({ t: 'moved', ...moved });
			}
			flush();
			break;
		}
		case 'decoded':
			post({
				t: 'decoded',
				req: m.req,
				bytes: engine.decodedBy(m.call),
				headComplete: engine.headComplete
			});
			break;
		case 'restart':
			engine.restart();
			groupsVersion = -1;
			errorsSent = -1;
			notify(true);
			break;
		case 'demo':
			startDemo(m.plan);
			break;
		case 'demo-tick':
			if (demo && !demo.ended) advance(demo, m.nowMs);
			break;
		case 'demo-started':
			if (demo) demo.plan = { ...demo.plan, startedMs: m.startedMs };
			break;
		case 'demo-ended':
			if (demo) {
				demo.ended = m.ending;
				advance(demo, m.nowMs);
			}
			break;
		case 'layout':
			settle();
			engine.setLayout(m.cols, m.wrap);
			notify(true);
			break;
		case 'rows':
			settle();
			post({ t: 'rows', req: m.req, rows: engine.render(m.from, m.to), total: engine.rows.total });
			break;
		case 'fold': {
			settle();
			const anchorRow = engine.fold(m.ids, m.open, m.anchor);
			post({
				t: 'folded',
				req: m.req,
				total: engine.rows.total,
				anchorRow,
				folded: [...engine.rows.folded]
			});
			break;
		}
		case 'foldAll': {
			settle();
			const anchorRow = engine.foldAll(m.open, m.anchor);
			post({
				t: 'folded',
				req: m.req,
				total: engine.rows.total,
				anchorRow,
				folded: [...engine.rows.folded]
			});
			break;
		}
		case 'reveal': {
			settle();
			const r = engine.reveal(m.line);
			post({
				t: 'revealed',
				req: m.req,
				row: typeof r === 'number' ? r : null,
				gap: r === 'gap',
				total: engine.rows.total,
				folded: [...engine.rows.folded]
			});
			break;
		}
		case 'search':
			settle();
			engine.setSearch(m.text, m.caseSensitive, m.onlyMatching);
			post({ t: 'search', s: engine.searchInfo() });
			if (engine.search.state.query) runSearch();
			break;
		case 'hit': {
			const r = engine.gotoHit(m.index);
			post({
				t: 'hit',
				req: m.req,
				row: r.row,
				line: r.line,
				total: engine.rows.total,
				folded: [...engine.rows.folded]
			});
			post({ t: 'search', s: engine.searchInfo() });
			break;
		}
		case 'range':
			post({ t: 'range', req: m.req, text: engine.range(m.from, m.to) });
			break;
		case 'blob':
			post({ t: 'blob', req: m.req, blob: engine.blob(m.kind) });
			break;
		case 'line':
			post({ t: 'line', req: m.req, text: engine.lineText(m.slot) });
			break;
	}
};
