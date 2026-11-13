import { defineConfig, devices } from '@playwright/test';

// Projects:
// - dev: the dev server at the root path.
// - build: the production build served by a plain static server under /dash/,
//   to prove one build works under any sub-path.
// - perf (PERF=1) and shots (SHOTS=1): measurements and screenshots, run on demand.
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
const extra = [
	process.env.PERF && {
		name: 'perf',
		testMatch: '**/perf.e2e.ts',
		use: { ...desktop, baseURL: 'http://localhost:4173/dash/' }
	},
	process.env.SHOTS && {
		name: 'shots',
		testMatch: '**/shots.e2e.ts',
		use: { ...desktop, baseURL: 'http://localhost:5173/' }
	}
].filter((p) => !!p);

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	fullyParallel: true,
	// Pages run farm simulations; more workers starve each other.
	workers: process.env.PERF ? 1 : 6,
	reporter: process.env.CI ? 'line' : 'list',
	use: { trace: 'retain-on-failure' },
	webServer: [
		{ command: 'npm run dev', port: 5173, reuseExistingServer: !process.env.CI },
		{
			command: 'npm run build && node e2e/static-server.ts 4173 /dash/',
			url: 'http://localhost:4173/dash/',
			reuseExistingServer: !process.env.CI,
			timeout: 180_000
		}
	],
	projects: [
		{
			name: 'dev',
			testIgnore: ['**/build.e2e.ts', '**/perf.e2e.ts', '**/shots.e2e.ts'],
			use: { ...desktop, baseURL: 'http://localhost:5173/' }
		},
		{
			name: 'build',
			testMatch: '**/build.e2e.ts',
			use: { ...desktop, baseURL: 'http://localhost:4173/dash/' }
		},
		...extra
	]
});
