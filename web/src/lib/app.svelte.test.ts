import { describe, expect, it, vi, type Mock } from 'vitest';
import { App, toAppError, type AppDeps } from './app.svelte.ts';
import type { Farm } from './farm/farm.ts';
import {
	UserError,
	type ConnectionStatus,
	type FarmSession,
	type FarmStore
} from './model/types.ts';
import type { MockOptions } from './source/mock.ts';

const farm: Farm = { name: 'Example farm', auth: 'proxy', base: 'https://farm.example.com/' };

type FakeSession = FarmSession & { stop: Mock<() => void> };

function fakeSession(mode: 'live' | 'mock'): FakeSession {
	const store = { status: { kind: 'connecting', attempt: 1 } } as { status: ConnectionStatus };
	return {
		store: store as unknown as FarmStore,
		mode,
		logs: { kind: 'none' },
		stop: vi.fn<() => void>()
	};
}

function setup(over: Partial<AppDeps> = {}) {
	const sessions: FakeSession[] = [];
	const mockCalls: MockOptions[] = [];
	const reload = vi.fn<() => void>();
	const deps = {
		loadFarm: vi.fn(async (): Promise<Farm | null> => farm),
		startLive: vi.fn<(farm: Farm) => FakeSession>(() => {
			const s = fakeSession('live');
			sessions.push(s);
			return s;
		}),
		startMock: (o: MockOptions) => {
			mockCalls.push(o);
			const s = fakeSession('mock');
			sessions.push(s);
			return s;
		},
		reload,
		...over
	} satisfies AppDeps;
	return { app: new App(deps), deps, reload, sessions, mockCalls };
}

describe('App', () => {
	it('dashboard.json starts a live session named after the farm', async () => {
		const t = setup();
		const done = t.app.load();
		expect(t.app.phase).toEqual({ kind: 'loading' });
		await done;
		expect(t.app.phase).toEqual({
			kind: 'session',
			farm,
			farmName: 'Example farm',
			session: t.sessions[0]
		});
		expect(t.deps.startLive).toHaveBeenCalledWith(farm);
	});

	it('a slow dashboard.json is ignored once the demo started', async () => {
		let resolve!: (f: Farm) => void;
		const t = setup({ loadFarm: () => new Promise<Farm>((r) => (resolve = r)) });
		const done = t.app.load();
		t.app.startDemo();
		resolve(farm);
		await done;
		expect(t.app.phase).toMatchObject({ kind: 'session', farmName: 'Demo farm', farm: null });
		expect(t.deps.startLive).not.toHaveBeenCalled();
	});

	it('reload loads the page again', async () => {
		const t = setup();
		await t.app.load();
		t.app.reload();
		expect(t.reload).toHaveBeenCalledOnce();
	});

	it('leaving the demo loads the farm', async () => {
		const t = setup();
		t.app.startDemo('?builders=3');
		await t.app.leaveDemo();
		expect(t.sessions[0].stop).toHaveBeenCalledOnce();
		expect(t.app.phase).toMatchObject({ kind: 'session', farm, session: t.sessions[1] });
	});

	it('reconnect starts a new session for the same farm', async () => {
		const t = setup();
		await t.app.load();
		t.app.reconnect();
		expect(t.sessions[0].stop).toHaveBeenCalledOnce();
		expect(t.deps.loadFarm).toHaveBeenCalledOnce();
		expect(t.deps.startLive).toHaveBeenCalledTimes(2);
		expect(t.app.phase).toMatchObject({ kind: 'session', session: t.sessions[1] });
	});

	it('runs the demo with options from the query string', () => {
		const t = setup();
		t.app.startDemo('?builders=50&seed=9');
		expect(t.mockCalls[0]).toMatchObject({ builders: 50, seed: 9 });
		expect(t.app.phase).toMatchObject({ kind: 'session', farm: null, farmName: 'Demo farm' });
		t.app.startDemo('builders=3');
		expect(t.sessions[0].stop).toHaveBeenCalledOnce();
		expect(t.mockCalls[1].builders).toBe(3);
	});
});

describe('toAppError', () => {
	it('keeps titles from our errors and wraps the rest', () => {
		expect(toAppError(new UserError('T', 'D'))).toEqual({ title: 'T', detail: 'D' });
		expect(toAppError(new Error('boom'))).toEqual({
			title: 'Something went wrong',
			detail: 'boom'
		});
		expect(toAppError('x')).toEqual({ title: 'Something went wrong', detail: 'x' });
	});
});
