import { describe, expect, it } from 'vitest';
import { problemSentence } from './LogEmpty.svelte';

// fake-farm.e2e.ts checks the damaged and unreadable sentences over the wire.
describe('problemSentence', () => {
	it("says a stopped build's log ends early", () => {
		expect(problemSentence({ kind: 'ended-early' }, '10.0.0.13', false)).toBe(
			'The log ends early: the build was stopped.'
		);
	});

	it('names the builder it lost the connection to', () => {
		expect(problemSentence({ kind: 'lost', retryAtMs: 0 }, '10.0.0.13', false)).toBe(
			'Lost the connection to 10.0.0.13.'
		);
	});
});
