# nix-grpc-store patches

The dashboard needs changes to nix-grpc-store that upstream does not have yet. Upstream merged
#267 and has its own version of #268, so the pinned commit below includes both. #269 stands on its
own and is open upstream, so `flake.nix` fetches it from the pull request by commit.
`nix-grpc-store/` holds the rest as a `git format-patch` series, numbered from 0004: an events API
on the scheduler, builder reports, and build logs for the Logs tab. A farm runs nix-grpc-store with
all of them applied. The dashboard's Envoy setup
lives in this repository's NixOS module (`nixosModules.default`).

| Patch | What it does |
| --- | --- |
| [#269](https://github.com/Mic92/nix-grpc-store/pull/269) | `--build-log-store` uploads every build log, failed ones included, to a Nix store. |
| 0004 | The `watch` role, below `read-only`. |
| 0005 | The scheduler's state and every change to it, as the `Events.Watch` stream. |
| 0006 | Counters and a `Stats` event once a second, and streams that end when their token expires. |
| 0007 | `nix-grpc-daemon watch --json`. |
| 0008 | Builders report why a build failed, why they drain (stopping, low disk or no local nix-daemon), their free disk and their substituter traffic, and the scheduler sends it as events. |
| 0009 | `GetBuildLog` follows a running build and resumes at an offset. |
| 0010 | Builders report each running build's phase. |
| 0011 | `Events.RecentBuilds`: the last 10,000 builds and 2,000 failures. |
| 0012 | `GetBuildLog` reads from the log store and the binary cache when a node has no log. |

Each commit message explains its change. Each commit builds and passes nix-grpc-store's tests on
its own.

## Applying them

The series applies to nix-grpc-store commit
[`f9d3adb7`](https://github.com/Mic92/nix-grpc-store/commit/f9d3adb7baad4f15d5c5260c4fb8b53078d1094e),
the commit this repository's `flake.nix` pins:

```console
$ git clone https://github.com/Mic92/nix-grpc-store
$ cd nix-grpc-store
$ git checkout -b dashboard f9d3adb7baad4f15d5c5260c4fb8b53078d1094e
$ curl -sL https://github.com/Mic92/nix-grpc-store/commit/fe79b92efbbeb8cd61f2eb0a36f827e21dec7160.patch | git am
$ git am /path/to/grpc-store-dashboard/patches/nix-grpc-store/*.patch
```

The first commit is the head of #269 that `flake.nix` fetches. `nix flake check` tests this. Its
`patches` check applies the same commit and series to the pinned source. When #269 changes,
update its commit and hash in `flake.nix`. After moving the pin, drop what it now includes, and
rebase the series if the check fails.

To change the series, edit the commits on that branch and export the nine after #269 again,
numbered from 4:

```console
$ rm /path/to/grpc-store-dashboard/patches/nix-grpc-store/*.patch
$ git format-patch --start-number 4 -o /path/to/grpc-store-dashboard/patches/nix-grpc-store HEAD~9
```

## The proto

`proto/events.proto` at the root of this repository is the file the series adds. Patch 0005 adds
it, and 0006, 0007, 0008, 0010 and 0011 change it. `proto/nix_remote.proto` is upstream's file
as the series leaves it, after 0008, 0009, 0010 and 0012 change it. `npm run gen` generates
`web/src/lib/gen/` from both. `nix flake check` fails when a root copy and the series differ, or
when the generated code is out of date. After changing the proto, change the commit that owns
that part of it, export the series again and run `npm run gen` in `web/`.
