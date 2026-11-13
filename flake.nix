{
  inputs = {
    # For its nixpkgs, so the dashboard builds with the pin nix-grpc-store builds
    # with, and for the checks, which apply the patch series to this commit.
    nix-grpc-store.url = "github:Mic92/nix-grpc-store/f9d3adb7baad4f15d5c5260c4fb8b53078d1094e";
    nixpkgs.follows = "nix-grpc-store/nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-grpc-store,
    }:
    let
      inherit (nixpkgs) lib;
      # The site builds wherever Node does. nixpkgs has Playwright's browsers
      # for these three, so the dev shell runs the browser tests on each.
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      packages = lib.genAttrs systems (system: {
        default = self.packages.${system}.nix-grpc-dashboard;
        nix-grpc-dashboard = nixpkgs.legacyPackages.${system}.callPackage ./web/package.nix { };
      });

      # Import it next to nix-grpc-store's modules, from a source with the patch
      # series applied. It adds the dashboard listener to the balancer's Envoy.
      nixosModules.default = lib.modules.importApply ./nixos/dashboard.nix { inherit self; };

      checks = lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # The series starts with these open upstream PRs. Drop each one once the
          # pin above includes it.
          fetchPr =
            {
              pr,
              title,
              rev,
              hash,
            }:
            pkgs.fetchpatch2 {
              name = lib.strings.sanitizeDerivationName "nix-grpc-store-${toString pr}-${title}.patch";
              url = "https://github.com/Mic92/nix-grpc-store/commit/${rev}.patch";
              inherit hash;
            };
          upstreamPrs = map fetchPr [
            {
              pr = 269;
              title = "daemon: upload build logs to a log store";
              rev = "fe79b92efbbeb8cd61f2eb0a36f827e21dec7160";
              hash = "sha256-xXd9Vlhfx2G4ICq5XZUSIj24KUJInchNn1o96rQcMJk=";
            }
          ];
          envoy-1_37 = pkgs.callPackage ./envoy/envoy-1_37.nix { };
          # The pinned nix-grpc-store with the PRs and then patches/nix-grpc-store
          # applied, as patches/README.md says. No fuzz, so a patch that no longer
          # fits fails instead of landing in the wrong place.
          patched = pkgs.applyPatches {
            name = "nix-grpc-store-patched";
            src = nix-grpc-store;
            patches = upstreamPrs ++ lib.filesystem.listFilesRecursive ./patches/nix-grpc-store;
            patchFlags = [
              "-p1"
              "-F0"
              "--no-backup-if-mismatch"
            ];
          };
        in
        {
          # Its checkPhase runs npm run check, vitest and the src/lib/gen check.
          inherit (self.packages.${system}) nix-grpc-dashboard;
          # oxfmt and ESLint on the package's source. It runs apart from the package,
          # so a style slip fails this check but no build.
          lint = self.packages.${system}.nix-grpc-dashboard.overrideAttrs {
            pname = "nix-grpc-dashboard-lint";
            buildPhase = ''
              runHook preBuild
              npm run lint
              runHook postBuild
            '';
            doCheck = false;
            installPhase = "touch $out";
          };
          # The patch series applies to the pinned nix-grpc-store commit.
          patches = patched;
          # proto/ holds the files the series leaves in nix-grpc-store.
          proto = pkgs.runCommand "dashboard-proto" { } ''
            cmp ${patched}/proto/events.proto ${./proto/events.proto}
            cmp ${patched}/proto/nix_remote.proto ${./proto/nix_remote.proto}
            touch $out
          '';
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # envoy/listener.yaml and the module's Envoy config, against this build.
          envoy = pkgs.callPackage ./envoy/check.nix {
            dashboard = self.packages.${system}.default;
            inherit envoy-1_37;
            # The series leaves lb.nix as upstream has it, so this takes the
            # pin's and imports from no derivation.
            balancer =
              module:
              (lib.nixosSystem {
                inherit system;
                modules = [
                  "${nix-grpc-store}/nixos/lb.nix"
                  self.nixosModules.default
                  module
                ];
              }).config;
          };
        }
        // lib.optionalAttrs (system == "x86_64-linux") (
          let
            testArgs = {
              inherit pkgs;
              # The series' NixOS modules, as farms import them until upstream has
              # the series, and this flake's. This imports from a derivation, so
              # evaluating these tests builds `patched` first.
              modules =
                map (name: "${patched}/nixos/${name}.nix") [
                  "server"
                  "client"
                  "lb"
                ]
                ++ [ self.nixosModules.default ];
              # nix-grpc-store with the series, for the daemons and the plugin, built
              # against nixpkgs' Nix as nix-grpc-store's module builds it on a farm.
              # Its check phase runs the series' C++ tests.
              daemon =
                (nix-grpc-store.packages.${system}.default.override {
                  inherit (pkgs.nix.libs) nix-store nix-util;
                }).overrideAttrs
                  { src = patched; };
              # The series' tests/, for its helpers in tests/lib.
              ngsTests = "${patched}/tests";
              inherit (nix-grpc-store.inputs) niks3;
              inherit envoy-1_37;
            };
          in
          {
            # nixosModules.default on a balancer, in front of a node with the series.
            dashboard-lb = import ./nixos/tests/dashboard-lb.nix testArgs;
            # The same on a farm of two builders: build logs by builder, also
            # from a draining one.
            dashboard-farm = import ./nixos/tests/dashboard-farm.nix testArgs;
          }
        )
      );

      devShells = lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_26
              pkgs.buf
              pkgs.importNpmLock.hooks.linkNodeModulesHook
            ];
            npmDeps = pkgs.importNpmLock.buildNodeModules {
              npmRoot = ./web;
              nodejs = pkgs.nodejs_26;
            };
            # @playwright/test in web/package.json is pinned to this version.
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          };
        }
      );
    };
}
