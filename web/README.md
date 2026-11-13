# Dashboard web app

A SvelteKit SPA, built as static files. [src/lib/model/types.ts](src/lib/model/types.ts) is the
contract between the data layer and the UI.

## Rules

- No backend, server code or SSR. Whatever is in front of the page signs users in.
- The page talks only to its own origin, and leaves it only for links the farm names, such as its
  sign-out. No analytics, web fonts or CDNs.
- The page never holds a token or sends an `Authorization` header.
- Nothing persists in browser storage.
- Only server-streaming RPCs, since gRPC-web cannot stream from the client.
- One build works under any origin and sub-path. Every path comes from `farm/farm.ts`.

## Commands

Run them in the dev shell, `nix develop ..`, which links `node_modules` from the Nix store.
`npm install` only updates `package-lock.json`; enter the shell again to link the new packages.

| Command                                     | What                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                               | Dev server, http://localhost:5173/?demo for the demo farm             |
| `node e2e/run-fake-farm.ts [--anonymous]`   | A fake farm's auth proxy and scheduler in front of the dev server     |
| `FARM_URL=<farm> npm run dev`               | The dev server in front of a real farm, from an anonymous network     |
| `npm run build`                             | Static site in `build/`                                               |
| `npm run check`                             | svelte-check and TypeScript                                           |
| `npm run lint`                              | oxfmt and ESLint                                                      |
| `npx vitest run`                            | Unit tests                                                            |
| `npx playwright test`                       | Browser tests against the dev server and the build served at `/dash/` |
| `PERF=1 npx playwright test --project perf` | Frame time budgets, on demand                                         |
| `npm run gen`                               | Regenerate `src/lib/gen/` from `../proto`                             |

## Demo farm

`/?demo` simulates a farm in the browser. Options go in the query string, as in
`/?demo&builders=24&churn=6&failing=1`.

| Key        | Default                      | Meaning                                                                        |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `builders` | 12                           | Builders, 1 to 1000                                                            |
| `systems`  | `x86_64-linux,aarch64-linux` | Native systems, each optionally `name:count`                                   |
| `inflight` | 64 per builder               | Derivations queued or assigned, at most 50,000                                 |
| `rate`     | 4.5 per builder              | Events per second                                                              |
| `speed`    | 1                            | Simulation speed                                                               |
| `seed`     | 1                            | Random seed                                                                    |
| `gaps`     | 0                            | Skip a sequence number every N seconds, to show reconnects                     |
| `cache`    | 1                            | `0` for no binary cache                                                        |
| `churn`    | 0                            | Cloud builders that join or leave per minute, with spot interruptions          |
| `fail`     | 0.05                         | Share of builds that fail                                                      |
| `failing`  | 0                            | The first N builders fail 80% of their builds                                  |
| `uptime`   | 0                            | Minutes the scheduler has served. 0 for 3 to 4 hours                           |
| `upstream` | 3                            | Upstream substituters, 0 to 3                                                  |
| `lowdisk`  | 0                            | The last N builders start low on disk and drain                                |
| `logs`     | 1                            | `0` for builders that serve no build logs                                      |
| `logsize`  | 1                            | Scales every build log's length, 0.01 to 100                                   |
| `nixoslog` | none                         | `openbao`, `nat` or `openssh`: NixOS tests show that real log. Dev builds only |
| `history`  | 300                          | Builds that finished before the page opened, 0 to 2000                         |
| `progress` | 1                            | `0` for builders that do not report a build's start and phase                  |
