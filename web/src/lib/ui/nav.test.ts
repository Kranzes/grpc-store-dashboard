import { describe, expect, it } from 'vitest';
import { logsHref, overviewHref, parseLogsParams, parseRange } from './nav.ts';

const DRV = `${'a'.repeat(32)}-hello-2.12.1.drv`;
const url = (s: string) => new URL(s, 'https://farm.example');

describe('nav', () => {
	it("tab links keep the demo options and drop the other tab's", () => {
		const overview = url('/?demo&builders=12&seed=7&upstream=0');
		expect(logsHref('/', overview)).toBe('/logs/?demo&builders=12&seed=7&upstream=0');
		const logs = url(`/dash/logs/?demo&speed=4&drv=${DRV}&on=10.0.0.13:50051&status=failed#L12`);
		expect(overviewHref('/dash/', logs)).toBe('/dash/?demo&speed=4');
		// A new Logs link replaces the Logs state of the page it starts from.
		expect(logsHref('/dash/', logs, { status: ['failed'], since: 15 })).toBe(
			'/dash/logs/?demo&speed=4&status=failed&since=15'
		);
		expect(overviewHref('/', url('/logs/'))).toBe('/');
		expect(
			logsHref('/', url('/'), { drv: DRV, on: '10.0.0.13:50051', a: 7, range: { from: 3, to: 3 } })
		).toBe(`/logs/?drv=${DRV}&on=10.0.0.13%3A50051&a=7#L3`);
	});

	it('parseLogsParams drops malformed values', () => {
		expect(
			parseLogsParams(
				url(
					'/logs/?drv=../../etc&on=bad host&a=-3&t=x&status=failed,bogus,built,failed' +
						'&system=x86_64-linux&builder=10.0.0.1:1&since=7&sort=sideways&q=hello'
				)
			)
		).toEqual({
			status: ['failed', 'built'],
			system: 'x86_64-linux',
			builder: '10.0.0.1:1',
			q: 'hello'
		});
		expect(
			parseLogsParams(
				url(`/logs/?drv=${DRV}&on=10.0.0.13:50051&a=7&t=1800000000000&since=60&sort=longest`)
			)
		).toEqual({
			drv: DRV,
			on: '10.0.0.13:50051',
			a: 7,
			t: 1_800_000_000_000,
			since: 60,
			sort: 'longest'
		});
		expect(parseLogsParams(url('/logs/?on=[fd00::1]:50051')).on).toBe('[fd00::1]:50051');
	});

	it('the #L range parses one line and a range', () => {
		expect(parseLogsParams(url('/logs/#L120')).range).toEqual({ from: 120, to: 120 });
		expect(parseLogsParams(url('/logs/#L140-L120')).range).toEqual({ from: 120, to: 140 });
		expect(parseRange('L5-9')).toEqual({ from: 5, to: 9 });
		expect(parseRange('L0')).toBeUndefined();
		expect(parseRange('Lx')).toBeUndefined();
		expect(parseLogsParams(url('/logs/#nope')).range).toBeUndefined();
	});
});
