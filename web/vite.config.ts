import process from 'node:process';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

// With FARM_URL, such as https://farm.example.com:8443, the dev server sends
// dashboard.json and the stream to that farm's dashboard listener, so the page
// watches it the way an anonymous network does. Sign-in cannot work this way,
// because the farm's auth proxy signs users in on the farm's own origin.
// Envoy's CSRF filter compares Origin with the host it serves, so the proxy
// sends the farm's.
const farm = process.env.FARM_URL ? new URL(process.env.FARM_URL).origin : null;
const toFarm = farm && {
	target: farm,
	changeOrigin: true,
	secure: true,
	headers: { origin: farm }
};

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Every page is a prerendered shell with relative asset paths, so one build works
			// under any origin and sub-path. Unknown URLs get the host's own 404.
			adapter: adapter(),
			paths: { relative: true },
			// The pages carry this, and an open page polls _app/version.json to notice a new
			// deploy. The default, the build time, makes no two builds alike, so
			// web/package.nix sets one from its source.
			version: { name: process.env.APP_VERSION || undefined }
		})
	],
	// The demo's real NixOS test logs (src/lib/source/nixos-logs.ts) keep the big one compressed.
	assetsInclude: ['**/*.zst'],
	// Fixed ports, which playwright.config.ts starts and expects.
	server: {
		port: 5173,
		strictPort: true,
		proxy: toFarm ? { '/dashboard.json': toFarm, '/nix.remote.Events/': toFarm } : undefined
	},
	preview: { port: 4173, strictPort: true },
	test: {
		expect: { requireAssertions: true },
		// Node 26 turns on localStorage and warns when code reads it without
		// --localstorage-file. The tests expect none, as on Node 24.
		execArgv: ['--no-experimental-webstorage'],
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					// Wall-clock budgets fail on a busy machine, so they run only with
					// PERF=1, like the perf project in the browser tests.
					exclude: [
						'src/**/*.svelte.{test,spec}.{js,ts}',
						...(process.env.PERF ? [] : ['src/**/*.perf.test.ts'])
					]
				}
			},
			{
				// Rune modules (*.svelte.ts) need Svelte's client runtime and the client
				// transform, so $effect and $derived run (see vitest-client-env.ts).
				extends: './vite.config.ts',
				resolve: { conditions: ['browser'] },
				test: {
					name: 'client',
					environment: './vitest-client-env.ts',
					include: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
