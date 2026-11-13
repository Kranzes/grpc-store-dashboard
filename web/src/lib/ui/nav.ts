// The page's two tabs and their URLs. Each tab has its own path. The query
// holds the session's options, which are the demo's, and the tab's own state:
//
//   /?demo&builders=12                         the Overview
//   /logs/?demo&drv=<base name>&on=<builder>&a=<assign id>&t=<finished ms>#L120-L140
//
// A link to the other tab keeps the session's options and drops this tab's.

import type { BuildStateFilter, DrvView } from '#lib/model/types.ts';
import { WINDOW_MINUTES } from './format.ts';

/** Query keys of the session: the demo and its options (parseMockOptions). */
const SESSION_KEYS: ReadonlySet<string> = new Set([
	'demo',
	'builders',
	'systems',
	'inflight',
	'rate',
	'speed',
	'seed',
	'gaps',
	'cache',
	'churn',
	'fail',
	'failing',
	'uptime',
	'lowdisk',
	'upstream',
	'logs',
	'logsize',
	'nixoslog',
	'history',
	'progress'
]);

export type { BuildStateFilter };
const BUILD_STATE_FILTERS: readonly BuildStateFilter[] = ['failed', 'assigned', 'built', 'other'];
export type LogsSort = 'failures' | 'newest' | 'longest';
const SORTS: readonly LogsSort[] = ['failures', 'newest', 'longest'];
/** Finished within, in minutes, as the header's windows, so its Failed link keeps its window. */
export const SINCE_MINUTES: readonly number[] = WINDOW_MINUTES;

/** What these functions read of a URL; page.url and URL both have it. */
export type UrlParts = Readonly<{ pathname: string; search: string; hash: string }>;

/** Lines, 1-based and inclusive, with from <= to. */
export type LineRange = Readonly<{ from: number; to: number }>;

export type LogsParams = Readonly<{
	/** A derivation's base name, "<hash>-<name>.drv". */
	drv?: string;
	/** The builder that ran or runs it, as host:port. */
	on?: string;
	/** Its assignment, DrvState.assign_id. */
	a?: number;
	/** When it finished, on the scheduler's clock, ms. Finished builds only. */
	t?: number;
	status?: readonly BuildStateFilter[];
	system?: string;
	builder?: string;
	pool?: string;
	client?: string;
	q?: string;
	/** Finished within this many minutes. */
	since?: number;
	sort?: LogsSort;
	range?: LineRange;
}>;

const DRV = /^[0-9a-z]{32}-[^/\s]+\.drv$/;
/** host:port, IPv4, a name or a bracketed IPv6 address. */
const ADDR = /^(\[[0-9a-fA-F:.]+\]|[\w.-]+):\d{1,5}$/;
const SYSTEM = /^[\w.-]+$/;

function positiveInt(v: string | null): number | undefined {
	if (v === null || !/^\d{1,16}$/.test(v)) return undefined;
	const n = Number(v);
	return n > 0 && Number.isSafeInteger(n) ? n : undefined;
}

/** "120", "120-140", "L120-L140" or "L120-140". */
export function parseRange(text: string): LineRange | undefined {
	const m = /^L?(\d{1,9})(?:-L?(\d{1,9}))?$/.exec(text);
	if (!m) return undefined;
	const a = Number(m[1]);
	const b = m[2] === undefined ? a : Number(m[2]);
	if (a < 1 || b < 1) return undefined;
	return { from: Math.min(a, b), to: Math.max(a, b) };
}

export function rangeFragment(r: LineRange): string {
	return r.from === r.to ? `#L${r.from}` : `#L${r.from}-L${r.to}`;
}

/** The Logs tab's state in a URL. Unknown or malformed values are dropped. */
export function parseLogsParams(url: UrlParts): LogsParams {
	const q = new URLSearchParams(url.search);
	const out: { -readonly [K in keyof LogsParams]: LogsParams[K] } = {};
	const drv = q.get('drv');
	if (drv && DRV.test(drv)) out.drv = drv;
	const on = q.get('on');
	if (on && ADDR.test(on)) out.on = on;
	const a = positiveInt(q.get('a'));
	if (a !== undefined) out.a = a;
	const t = positiveInt(q.get('t'));
	if (t !== undefined) out.t = t;
	const status = (q.get('status') ?? '')
		.split(',')
		.filter((s): s is BuildStateFilter => (BUILD_STATE_FILTERS as string[]).includes(s));
	if (status.length) out.status = [...new Set(status)];
	const system = q.get('system');
	if (system && SYSTEM.test(system)) out.system = system;
	const builder = q.get('builder');
	if (builder && ADDR.test(builder)) out.builder = builder;
	const pool = q.get('pool');
	if (pool && SYSTEM.test(pool)) out.pool = pool;
	const client = q.get('client');
	if (client && client.length <= 512) out.client = client;
	const search = q.get('q');
	if (search && search.length <= 512) out.q = search;
	const since = positiveInt(q.get('since'));
	if (since !== undefined && SINCE_MINUTES.includes(since)) out.since = since;
	const sort = q.get('sort');
	if (sort && (SORTS as string[]).includes(sort)) out.sort = sort as LogsSort;
	const range = url.hash.startsWith('#') ? parseRange(url.hash.slice(1)) : undefined;
	if (range) out.range = range;
	return out;
}

/** The session's own query parameters of `url`, in their order. */
function sessionQuery(url: UrlParts): URLSearchParams {
	const out = new URLSearchParams();
	for (const [k, v] of new URLSearchParams(url.search)) if (SESSION_KEYS.has(k)) out.append(k, v);
	return out;
}

/** "?demo&builders=12": keys without values stay bare, as people type them. */
function queryString(q: URLSearchParams): string {
	const parts: string[] = [];
	for (const [k, v] of q)
		parts.push(
			v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
		);
	return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * The query of a Logs URL: the session's options of `from`, then `params`.
 * The line range goes in the fragment.
 */
export function logsSearch(from: UrlParts, params: LogsParams = {}): string {
	const q = sessionQuery(from);
	const set = (k: string, v: string | number | undefined) => {
		if (v !== undefined && v !== '') q.set(k, String(v));
	};
	set('drv', params.drv);
	set('on', params.on);
	set('a', params.a);
	set('t', params.t);
	if (params.status?.length) q.set('status', params.status.join(','));
	set('system', params.system);
	set('builder', params.builder);
	set('pool', params.pool);
	set('client', params.client);
	set('q', params.q);
	set('since', params.since);
	if (params.sort && params.sort !== 'failures') q.set('sort', params.sort);
	return queryString(q) + (params.range ? rangeFragment(params.range) : '');
}

/** The Logs tab for `params`, under `base`, which is basePath() with its trailing slash. */
export function logsHref(base: string, from: UrlParts, params: LogsParams = {}): string {
	return `${base}logs/${logsSearch(from, params)}`;
}

/** The Logs tab params for a derivation that ran on a builder, or null. */
export function drvLogParams(d: DrvView): LogsParams | null {
	if (!d.workerAddr || d.phase === 'cached' || d.phase === 'queued' || d.phase === 'unplaceable')
		return null;
	return {
		drv: d.drvPath.slice(d.drvPath.lastIndexOf('/') + 1),
		on: d.workerAddr,
		a: d.assignId || undefined,
		t: d.phase === 'assigned' ? undefined : (d.finishedServerMs ?? undefined)
	};
}

/** The Overview, with the session's options of `from`. */
export function overviewHref(base: string, from: UrlParts): string {
	return `${base}${queryString(sessionQuery(from))}`;
}

/** The page's URL in the browser; the root elsewhere, as in tests that render a panel. */
export function hereUrl(): UrlParts {
	return typeof location === 'undefined' ? { pathname: '/', search: '', hash: '' } : location;
}
