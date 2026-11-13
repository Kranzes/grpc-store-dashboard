// The farm that serves this copy of the dashboard. The farm serves the page,
// dashboard.json and the Watch stream, all on the page's own origin
// (docs/operators.md). The path names live here and nowhere else in the page.

import { resolve } from '$app/paths';
import { UserError } from '#lib/model/types.ts';

/** proxy: the farm's auth proxy signed this user in. anonymous: this network watches without signing in. */
export type FarmAuth = 'proxy' | 'anonymous';

export type Farm = Readonly<{
	/** Display name, or the page's host when dashboard.json names none. */
	name: string;
	auth: FarmAuth;
	/** Absolute, with a trailing slash: https://farm.example.com:8443/ or http://localhost:4173/dash/. */
	base: string;
	/** The operator's search across build logs (http or https), when dashboard.json names one. */
	logSearchUrl?: string;
	/** The auth proxy's sign-out address (http or https). Proxy farms only, when dashboard.json names one. */
	signOutUrl?: string;
}>;

const AUTHS: readonly FarmAuth[] = ['proxy', 'anonymous'];
const TIMEOUT_MS = 10_000;

/** SvelteKit's base path with a trailing slash: "/" or "/dash/". */
export function basePath(): string {
	return resolve('/(app)');
}

/** This copy's base: the page's origin and SvelteKit's base path, with a trailing slash. */
export function pageBase(): string {
	return `${location.origin}${basePath()}`;
}

/** <base>nix.remote.Events/Watch comes from connect's createMethodUrl(base, ...). */
export function farmUrls(base: string): { watchBase: string } {
	return { watchBase: base };
}

/** Whether a content-type is JSON: application/json or a +json type. */
const isJson = (type: string | null) => !!type && /^application\/([\w.-]+\+)?json\b/i.test(type);

const invalid = (detail: string) => new UserError("The farm's dashboard.json is not valid", detail);

/**
 * Fetch <base>dashboard.json. null: no farm serves this copy, as on the dev
 * server or a static host. Throws UserError with plain words otherwise.
 */
export async function loadFarm(
	base: string = pageBase(),
	fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)
): Promise<Farm | null> {
	const url = `${base}dashboard.json`;
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
	let res: Response;
	let text: string;
	try {
		res = await fetch(url, {
			headers: { accept: 'application/json' },
			cache: 'no-store',
			redirect: 'manual',
			signal: ctl.signal
		});
		text = res.ok && isJson(res.headers.get('content-type')) ? await res.text() : '';
	} catch (e) {
		throw new UserError(
			'The farm did not answer',
			ctl.signal.aborted
				? `${url} gave no answer within ${TIMEOUT_MS / 1000}s. Try again later.`
				: `The browser could not load ${url}. Try again later.`,
			{ cause: e }
		);
	} finally {
		clearTimeout(timer);
	}
	if (res.type === 'opaqueredirect') {
		throw new UserError(
			'The farm redirects dashboard.json',
			"dashboard.json must answer on the page's own origin, without a redirect. The farm " +
				'operator has to fix that (docs/operators.md).'
		);
	}
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new UserError(
			'The farm did not answer',
			`${url} returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}. Try again later.`
		);
	}
	// A static host with a fallback page answers every path with HTML.
	if (!isJson(res.headers.get('content-type'))) return null;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		throw new UserError("The farm's dashboard.json is not valid", `${url} is not valid JSON.`, {
			cause: e
		});
	}
	if (!json || typeof json !== 'object' || Array.isArray(json))
		throw invalid(`${url} is not a JSON object.`);
	const d = json as Record<string, unknown>;
	if (typeof d.auth !== 'string' || !d.auth) throw invalid(`${url} does not say how to sign in.`);
	const auth = AUTHS.find((a) => a === d.auth);
	if (!auth) {
		throw new UserError(
			'This farm needs a newer dashboard',
			`The farm asks for sign-in "${d.auth}", which this dashboard does not know.`
		);
	}
	const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : new URL(base).host;
	const logSearchUrl = webUrl(d.logSearchUrl);
	// An absolute URL, or a path on the farm such as /sign-out.
	const signOutUrl = auth === 'proxy' ? webUrl(d.signOutUrl, base) : undefined;
	return Object.freeze({
		name,
		auth,
		base,
		...(logSearchUrl && { logSearchUrl }),
		...(signOutUrl && { signOutUrl })
	});
}

/**
 * An http or https URL, or undefined: a link the page may show. Absolute,
 * or resolved against `base` when one is given.
 */
function webUrl(v: unknown, base?: string): string | undefined {
	if (typeof v !== 'string' || !v.trim()) return undefined;
	try {
		const u = new URL(v.trim(), base);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
	} catch {
		return undefined;
	}
}
