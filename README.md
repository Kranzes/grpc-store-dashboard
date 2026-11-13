# nix-grpc-store dashboard

A live view of a [nix-grpc-store](https://github.com/Mic92/nix-grpc-store) build farm: client
requests, the scheduler, the builders and the binary cache, drawn as a map that moves as
derivations are queued, assigned and built. A Logs tab lists the builds that ran and shows each
build's log from the builder that ran it: live while it runs, folded by stdenv phase and by the
NixOS test driver's blocks and subtests, with search, colors and the raw log.

The dashboard is a static web page. The farm's Envoy serves it behind your own auth proxy, which
signs users in and names each one in a header, and can let trusted networks watch without signing
in. The page talks only to its own origin, where it holds a gRPC-web stream open to the active
scheduler, and never holds a token.

Upstream's scheduler does not serve that stream yet. [patches/](patches/README.md) holds the
nix-grpc-store patch series that adds it. The series is meant to go upstream. The NixOS module in
[nixos/](nixos/dashboard.nix) adds the dashboard's listener to the Envoy of nix-grpc-store's
balancer module, and runs the daemon with the series.

## Layout

| Path | What |
| --- | --- |
| `web/` | The dashboard, a SvelteKit SPA, with its tests and its Nix package (`package.nix`). |
| `proto/events.proto` | The stream API, the same file the patch series adds to nix-grpc-store. |
| `patches/nix-grpc-store/` | The patch series for the scheduler. |
| `nixos/` | The NixOS module, `nixosModules.default`, and its VM tests. |
| `envoy/` | A plain Envoy listener for the dashboard, for setups without NixOS. |
| `docs/` | What a farm needs to serve the dashboard. |
| `flake.nix` | The packages, the NixOS module, the checks and the dev shell. |

## Build and run

```console
$ nix build                       # the static site in result/, after its unit tests
$ nix flake check                 # the same, lint, the checks on the patch series and the module's VM tests
$ cd web
$ nix develop .. -c npm run dev   # http://localhost:5173/?demo shows a simulated farm
```

The dev shell links `web/node_modules` from the Nix store, so there is no install step. The farm's
balancer serves `result/` ([docs/operators.md](docs/operators.md)). On a static host only the demo
works. [web/README.md](web/README.md) has the commands and the demo's options.

## Docs

- [docs/operators.md](docs/operators.md): how to serve the dashboard from a farm, with the
  NixOS module and its options, your auth proxy, the scheduler rule, anonymous viewing and plain
  Envoy.
- [patches/README.md](patches/README.md): the nix-grpc-store patches and how to apply them.

## License

MIT, the same license as nix-grpc-store. See [LICENSE](LICENSE).
