import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import DerivationDetail from './DerivationDetail.svelte';
import DerivationList from './DerivationList.svelte';
import { drvView, fakeStore } from './fake-store.ts';
import { failureSummary, statusTitle } from './status.ts';
import type { WorkerView } from '#lib/model/types.ts';

describe('DerivationList', () => {
	it('the line context names system, builder and clients, after the note', () => {
		const items = [
			drvView('hello', {
				workerAddr: '10.0.0.13:50051',
				identities: ['ci'],
				outputBytes: 12 << 20
			}),
			drvView('world', { workerAddr: '10.0.0.14:50051' })
		];
		const { body } = render(DerivationList, {
			props: {
				items,
				label: 'Latest on this line',
				context: 'line',
				note: (d) => (d.outputBytes > 0 ? `Published 12 MiB` : null),
				limit: 50,
				empty: 'Nothing yet.',
				onselect: () => {}
			}
		});
		expect(body).toContain('Published 12 MiB · x86_64-linux · 10.0.0.13:50051 · ci');
		expect(body).toContain('>x86_64-linux · 10.0.0.14:50051<');
	});

	it('the builder context leaves the builder out', () => {
		const { body } = render(DerivationList, {
			props: {
				items: [drvView('hello', { workerAddr: '10.0.0.13:50051' })],
				label: 'Derivations on this builder',
				context: 'builder',
				limit: 50,
				empty: 'Nothing yet.',
				onselect: () => {}
			}
		});
		expect(body).toContain('>x86_64-linux<');
	});
});

describe('DerivationDetail', () => {
	it('asks for the derivation through the line it came from', () => {
		const d = drvView('hello');
		const store = fakeStore({ drvs: [d] });
		const { body } = render(DerivationDetail, {
			props: { store, drvPath: d.drvPath, via: 'assign:10.0.0.13:50051', onopennode: () => {} }
		});
		expect(store.calls).toContain(`drv ${d.drvPath} assign:10.0.0.13:50051`);
		expect(body).toContain('Timings');
	});
});

describe('failure reasons', () => {
	const failed = drvView('hello', {
		phase: 'failed',
		status: 'timed-out',
		workerAddr: '10.0.0.13:50051',
		identities: ['ci']
	});
	const list = (context: 'builder' | 'queue' | 'cache' | 'clients' | 'line') =>
		render(DerivationList, {
			props: {
				items: [failed],
				label: 'List',
				context,
				note: () => (context === 'line' ? 'A note' : null),
				limit: 50,
				empty: 'Nothing yet.',
				onselect: () => {}
			}
		}).body;

	it('a failed row starts its second line with the short label, in every context', () => {
		expect(list('builder')).toContain('>Timed out · x86_64-linux · ci<');
		expect(list('queue')).toContain('>Timed out · x86_64-linux · 10.0.0.13:50051 · ci<');
		expect(list('cache')).toContain('>Timed out · x86_64-linux · ci<');
		expect(list('clients')).toContain('>Timed out · x86_64-linux · 10.0.0.13:50051<');
		expect(list('line')).toContain('>Timed out · A note · x86_64-linux · 10.0.0.13:50051 · ci<');
	});

	it('a row without a status, or one that did not fail, has no label', () => {
		const { body } = render(DerivationList, {
			props: {
				items: [
					drvView('a', { phase: 'failed' }),
					drvView('b', { phase: 'built', status: 'built' })
				],
				label: 'List',
				context: 'builder',
				limit: 50,
				empty: 'Nothing yet.',
				onselect: () => {}
			}
		});
		expect(body.match(/>x86_64-linux</g)).toHaveLength(2);
	});

	it('failureSummary counts failed builds by status, most common first', () => {
		const f = (status: 'timed-out' | 'build-failed' | null) =>
			drvView('x', { phase: 'failed', status });
		expect(
			failureSummary([
				f('build-failed'),
				f('timed-out'),
				f(null),
				f('timed-out'),
				drvView('ok', { phase: 'built', status: 'built' })
			])
		).toBe('2 timed out, 1 build failed');
		expect(failureSummary([drvView('ok', { phase: 'built', status: 'built' })])).toBe('');
	});

	it('failureSummary puts a count above 1 before a plural', () => {
		const f = (status: 'build-failed' | 'worker-error' | 'transient' | 'timed-out') =>
			drvView('x', { phase: 'failed', status });
		const times = <T>(n: number, x: () => T) => Array.from({ length: n }, x);
		expect(
			failureSummary([
				...times(4, () => f('build-failed')),
				...times(3, () => f('transient')),
				...times(2, () => f('worker-error')),
				...times(2, () => f('timed-out'))
			])
		).toBe('4 builds failed, 3 transient failures, 2 builder errors, 2 timed out');
		expect(failureSummary([f('worker-error'), f('transient')])).toBe(
			'1 builder error, 1 transient failure'
		);
	});

	it('the callout title names the status', () => {
		expect(statusTitle('timed-out')).toBe('Build failed: timed out');
		expect(statusTitle('build-failed')).toBe('Build failed');
		expect(statusTitle('worker-error')).toBe('Builder error');
	});

	const CAPTIONS = [
		'does not say why builds fail',
		'sent no log lines',
		'newest 256 failed builds'
	];
	const builder = (version: string): WorkerView => ({
		addr: '10.0.0.13:50051',
		systems: ['x86_64-linux'],
		features: [],
		maxJobs: 4,
		running: 0,
		up: true,
		draining: false,
		retired: false,
		goneAt: null,
		drainReason: null,
		diskFree: null,
		diskTotal: null,
		minFree: 0,
		version,
		substituters: [],
		builtPerMin: 0,
		failedPerMin: 0,
		queuedCanTake: 0
	});
	function detail(over: Parameters<typeof drvView>[1], versions: string[] = ['1.0']) {
		const d = drvView('hello', { phase: 'failed', workerAddr: '10.0.0.13:50051', ...over });
		const workers = new Map(
			versions.map((v, i) => {
				const w = builder(v);
				return [i === 0 ? w.addr : `other-${i}`, { ...w, addr: i === 0 ? w.addr : `other-${i}` }];
			})
		);
		return render(DerivationDetail, {
			props: { store: fakeStore({ drvs: [d], workers }), drvPath: d.drvPath, onopennode: () => {} }
		}).body;
	}
	const shown = (body: string) => CAPTIONS.filter((c) => body.includes(c));

	it('shows the callout and the log block', () => {
		const body = detail({
			status: 'timed-out',
			errorSent: true,
			errorText: "Cannot build 'x'.\n> make: *** Error 2"
		});
		expect(body).toContain('Build failed: timed out');
		expect(body).toContain('The build ran past its timeout');
		expect(body).toContain('Last log lines');
		expect(body).toContain("Cannot build 'x'.");
		expect(body).toMatch(/<dt>Result<\/dt>\s*<dd[^>]*>Timed out<\/dd>/);
		expect(shown(body)).toEqual([]);
	});

	it('shows exactly one caption when there is no text', () => {
		// No status from an older builder, while others report a version.
		let body = detail({}, ['', '1.0']);
		expect(body).toContain('This builder does not say why builds fail.');
		expect(body).not.toContain('Build failed');
		expect(shown(body)).toHaveLength(1);
		// No builder reports a version, as with an older scheduler.
		body = detail({}, ['']);
		expect(body).toContain('This farm does not say why builds fail.');
		expect(shown(body)).toHaveLength(1);
		// A status, no text.
		body = detail({ status: 'build-failed' });
		expect(body).toContain('The builder sent no log lines for this build.');
		expect(body).toContain('Build failed');
		expect(shown(body)).toHaveLength(1);
		// Text the dashboard no longer keeps.
		body = detail({ status: 'build-failed', errorSent: true });
		expect(body).toContain(
			'The dashboard keeps the log lines of the newest 256 failed builds only.'
		);
		expect(shown(body)).toHaveLength(1);
		expect(body).not.toContain('Last log lines');
	});

	it('a built derivation gets a Result fact, and no failure parts', () => {
		const d = drvView('hello', { phase: 'built', status: 'already-valid' });
		const { body } = render(DerivationDetail, {
			props: { store: fakeStore({ drvs: [d] }), drvPath: d.drvPath, onopennode: () => {} }
		});
		expect(body).toMatch(/<dd title="The builder already had the output.">Already valid<\/dd>/);
		expect(shown(body)).toEqual([]);
		expect(body).not.toContain('Last log lines');
	});
});
