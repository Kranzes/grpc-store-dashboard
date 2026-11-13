// A FarmSession is a store plus the source that feeds it.

import { farmUrls, type Farm } from '#lib/farm/farm.ts';
import { ReducerFarmStore } from '#lib/model/store.svelte.ts';
import type { FarmSession } from '#lib/model/types.ts';
import { createDashboardTransport, startLiveSource } from './live.ts';
import { startMockSource, type MockOptions } from './mock.ts';

export function startMockSession(options: MockOptions): FarmSession {
	const store = new ReducerFarmStore();
	const source = startMockSource(options, store.sink);
	store.attachHistory(source.recentBuilds);
	return {
		store,
		mode: 'mock',
		logs: source.logs ?? { kind: 'none' },
		stop() {
			source.stop();
			store.destroy();
		}
	};
}

/** The Watch stream of the farm that serves this page. */
export function startLiveSession(farm: Farm): FarmSession {
	const store = new ReducerFarmStore();
	const transport = createDashboardTransport(farmUrls(farm.base).watchBase);
	const source = startLiveSource({ transport, sink: store.sink });
	store.attachHistory(source.recentBuilds);
	return {
		store,
		mode: 'live',
		logs: source.logs,
		stop() {
			source.stop();
			store.destroy();
		},
		retryNow: () => source.retryNow()
	};
}
