// A fake farm in front of `npm run dev`, for trying the live path by hand:
//
//   node e2e/run-fake-farm.ts [port] [--anonymous]
//
// It listens on port 5180 by default and serves the page from
// http://localhost:5173, or from SITE. Its auth proxy has signed everyone in.
// --anonymous watches without signing in. Node cannot load fake-farm.ts
// itself, since the generated code uses TypeScript enums, so Vite's module
// runner loads it.

import process from 'node:process';
import { runnerImport } from 'vite';

const { module } = await runnerImport<typeof import('./fake-farm.ts')>(
	new URL('fake-farm.ts', import.meta.url).pathname,
	{ configFile: false, logLevel: 'error' }
);
const args = process.argv.slice(2);
const site = process.env.SITE ?? 'http://localhost:5173';
const farm = await new module.FakeFarm({
	site,
	dashboardJson: { name: 'Fake farm', auth: args.includes('--anonymous') ? 'anonymous' : 'proxy' },
	mock: { builders: 12 }
}).start(Number(args.find((a) => /^\d+$/.test(a)) ?? 5180));
console.log(`fake farm at ${farm.url}, in front of ${site}`);
