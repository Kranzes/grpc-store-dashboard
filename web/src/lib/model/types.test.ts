import { describe, expect, it } from 'vitest';
import {
	CACHE_ID,
	SCHEDULER_ID,
	UPSTREAM_ID,
	clientGroupNodeId,
	drvName,
	failShare,
	parseEdgeId,
	parseNodeId,
	poolNodeId,
	workerNodeId,
	type NodeRef
} from './types.ts';

describe('drvName', () => {
	it('strips the hash and .drv', () => {
		expect(drvName(`${'a'.repeat(32)}-hello-2.12.1.drv`)).toBe('hello-2.12.1');
		expect(drvName(`/nix/store/${'b'.repeat(32)}-x.drv`)).toBe('x');
		expect(drvName('short-name.drv')).toBe('short-name');
	});
});

describe('failShare', () => {
	it('is null when nothing finished, and failed over finished otherwise', () => {
		expect(failShare({ finished: 0, failed: 0 })).toBeNull();
		expect(failShare({ finished: 4, failed: 1 })).toBe(0.25);
	});
});

describe('parseEdgeId', () => {
	it('splits at the first colon', () => {
		expect(parseEdgeId('assign:10.0.0.1:50051')).toEqual({
			flow: 'assign',
			endpoint: '10.0.0.1:50051'
		});
		expect(parseEdgeId('assign:pool:x86_64-linux')).toEqual({
			flow: 'assign',
			endpoint: 'pool:x86_64-linux'
		});
		expect(parseEdgeId('cached:scheduler')).toEqual({ flow: 'cached', endpoint: 'scheduler' });
		expect(parseEdgeId('substitute:pool:x86_64-linux')).toEqual({
			flow: 'substitute',
			endpoint: 'pool:x86_64-linux'
		});
	});

	it('is null for an unknown kind or no colon', () => {
		expect(parseEdgeId('lane:builders')).toBeNull();
		expect(parseEdgeId('scheduler')).toBeNull();
	});
});

describe('parseNodeId', () => {
	it.each<[string, NodeRef | null]>([
		[SCHEDULER_ID, { kind: 'scheduler' }],
		[CACHE_ID, { kind: 'cache' }],
		[UPSTREAM_ID, { kind: 'upstream' }],
		[workerNodeId('10.0.0.1:50051'), { kind: 'builder', addr: '10.0.0.1:50051' }],
		[clientGroupNodeId('oidc:sso:alice'), { kind: 'clients', group: 'oidc:sso:alice' }],
		[poolNodeId('x86_64-linux'), { kind: 'pool', system: 'x86_64-linux' }],
		// Lane headings name no node.
		['lane:builders', null]
	])('reads %s', (id, ref) => {
		expect(parseNodeId(id)).toEqual(ref);
	});
});
