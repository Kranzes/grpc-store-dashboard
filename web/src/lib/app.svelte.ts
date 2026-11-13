// What the root page shows (AppPhase) and the session behind it. The farm
// is the one that serves this page (dashboard.json). Whatever is in front of
// it signs users in, so the page never signs anyone in or out itself.
//
//   load --dashboard.json--> session (live) | no-farm | error
//   any --startDemo--> session (mock);  leaveDemo --> load
//   reload --> a full page load, through the farm's sign-in when it asks for one

import { loadFarm, type Farm } from '#lib/farm/farm.ts';
import {
	UserError,
	errorMessage,
	type AppError,
	type AppPhase,
	type FarmSession
} from '#lib/model/types.ts';
import { parseMockOptions, type MockOptions } from '#lib/source/mock.ts';
import { startLiveSession, startMockSession } from '#lib/source/session.ts';

export type AppDeps = {
	/** Default: <page base>dashboard.json. */
	loadFarm?: () => Promise<Farm | null>;
	startLive?: (farm: Farm) => FarmSession;
	startMock?: (options: MockOptions) => FarmSession;
	/** A full page load of this page. Default location.reload. */
	reload?: () => void;
};

export const DEMO_FARM_NAME = 'Demo farm';

/** Any thrown value as a plain-language AppError. */
export function toAppError(e: unknown): AppError {
	if (e instanceof UserError) return { title: e.title, detail: e.detail };
	return {
		title: 'Something went wrong',
		detail: errorMessage(e) || 'An unexpected error happened.'
	};
}

export class App {
	#phase = $state.raw<AppPhase>({ kind: 'loading' });
	readonly #deps: Required<AppDeps>;
	/** The farm that serves this page, once dashboard.json named it. */
	#farm: Farm | null = null;
	#session: FarmSession | null = null;
	// Bumped by every action, so a slow dashboard.json cannot overwrite a newer phase.
	#op = 0;

	constructor(deps: AppDeps = {}) {
		this.#deps = {
			loadFarm: deps.loadFarm ?? (() => loadFarm()),
			startLive: deps.startLive ?? startLiveSession,
			startMock: deps.startMock ?? startMockSession,
			reload: deps.reload ?? (() => location.reload())
		};
	}

	get phase(): AppPhase {
		return this.#phase;
	}

	/** Read dashboard.json and watch the farm that serves this page. */
	async load(): Promise<void> {
		const op = this.#begin();
		this.#phase = { kind: 'loading' };
		let farm: Farm | null;
		try {
			farm = await this.#deps.loadFarm();
		} catch (e) {
			if (op === this.#op) this.#fail(e);
			return;
		}
		if (op !== this.#op) return;
		if (!farm) {
			this.#phase = { kind: 'no-farm' };
			return;
		}
		this.#farm = farm;
		this.#watch(farm);
	}

	/** A new live session for the same farm, after the last one stopped. */
	reconnect(): void {
		const farm = this.#farm;
		if (farm) {
			this.#begin();
			this.#watch(farm);
		}
	}

	/**
	 * Load the page again, for when the auth proxy in front of the farm no
	 * longer lets the stream through. The browser goes through its sign-in.
	 */
	reload(): void {
		this.#deps.reload();
	}

	/** Back from the demo to the farm that serves this page, if any. */
	leaveDemo(): Promise<void> {
		return this.load();
	}

	/**
	 * Run the simulator with options from the page's query string, so
	 * /?demo&builders=50&seed=7 shows a big farm. See parseMockOptions.
	 */
	demo(): void {
		this.startDemo(typeof location === 'undefined' ? '' : location.search);
	}

	/** Run the simulator with options from a query string such as "?builders=50". */
	startDemo(search = ''): void {
		this.#begin();
		try {
			const session = this.#deps.startMock(parseMockOptions(search));
			this.#session = session;
			this.#phase = { kind: 'session', farm: null, farmName: DEMO_FARM_NAME, session };
		} catch (e) {
			this.#fail(e);
		}
	}

	/** Stops the current session; returns the new operation number. */
	#begin(): number {
		this.#session?.stop();
		this.#session = null;
		return ++this.#op;
	}

	#watch(farm: Farm) {
		try {
			const session = this.#deps.startLive(farm);
			this.#session = session;
			this.#phase = { kind: 'session', farm, farmName: farm.name, session };
		} catch (e) {
			this.#fail(e);
		}
	}

	#fail(e: unknown) {
		this.#phase = { kind: 'error', error: toAppError(e) };
	}
}

/** The app singleton for the routes. */
export const app = new App();
