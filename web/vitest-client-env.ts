// Vitest environment for rune modules (*.svelte.ts): Node globals, but
// compiled for Svelte's client runtime, so $effect and $derived run in tests.
import type { Environment } from 'vitest/runtime';

export default {
	name: 'svelte-client',
	viteEnvironment: 'client',
	setup() {
		return { teardown() {} };
	}
} satisfies Environment;
