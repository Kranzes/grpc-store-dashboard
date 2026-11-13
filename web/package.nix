# The dashboard as static files, served by the farm balancer's Envoy
# (docs/operators.md). Any static host serves the demo.
#
# The pages use relative asset paths, so one build works under any origin and
# sub-path.
{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_26,
  buf,
}:

buildNpmPackage (finalAttrs: {
  pname = "nix-grpc-dashboard";
  version = (lib.importJSON ./package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      # Read by the check that src/lib/gen is up to date.
      ../proto/events.proto
      ../proto/nix_remote.proto
      ./e2e
      ./src
      ./static
      ./.gitignore
      ./.npmrc
      ./.oxfmtrc.json
      ./buf.gen.yaml
      ./eslint.config.js
      ./package-lock.json
      ./package.json
      ./playwright.config.ts
      ./tsconfig.json
      ./vite.config.ts
      ./vitest-client-env.ts
    ];
  };
  sourceRoot = "${finalAttrs.src.name}/web";

  nodejs = nodejs_26;
  # Fetches each package with the integrity hash in package-lock.json, so there
  # is no hash to update here.
  npmDeps = importNpmLock { npmRoot = ./.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  # .npmrc sets package-lock-only for the dev shell. The build needs node_modules.
  npmInstallFlags = [ "--package-lock-only=false" ];

  # SvelteKit's version name (vite.config.ts). The source's store hash changes
  # exactly when the source does, so a new deploy still gets a new version.
  env.APP_VERSION = "${finalAttrs.version}-${lib.substring 0 12 (baseNameOf finalAttrs.src)}";

  doCheck = true;
  nativeCheckInputs = [ buf ];
  # Lint is a flake check of its own. The Playwright tests need browsers and
  # servers, so they run only from the dev shell.
  checkPhase = ''
    runHook preCheck
    npm run check
    # CI: plain test output instead of redrawn progress lines.
    CI=true npm run test:unit -- --run
    # src/lib/gen must be what buf generates from proto/.
    npm run gen -- --output "$TMPDIR/gen"
    diff -r src/lib/gen "$TMPDIR/gen/src/lib/gen"
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    cp -r build $out
    runHook postInstall
  '';

  meta = {
    description = "Live dashboard for nix-grpc-store build farms, as static files";
    license = lib.licenses.mit;
  };
})
