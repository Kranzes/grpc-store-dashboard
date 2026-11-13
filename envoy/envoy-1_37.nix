# The oldest Envoy the dashboard runs on, when a server of your own serves its
# files. The file server needs 1.40.
{
  envoy-bin,
  fetchurl,
  stdenv,
}:

let
  version = "1.37.6";
  plat =
    {
      x86_64-linux = {
        arch = "x86_64";
        hash = "sha256-gQWRigH5aMbPx9EIk4xQgEYuKRMyrxeB0NEUtqBk+U8=";
      };
      aarch64-linux = {
        arch = "aarch_64";
        hash = "sha256-dX/hh6gIPwNF6x7q5pS3+09b54sAVCxCy4SfWhaMSBg=";
      };
    }
    .${stdenv.hostPlatform.system};
in
envoy-bin.overrideAttrs {
  inherit version;
  src = fetchurl {
    url = "https://github.com/envoyproxy/envoy/releases/download/v${version}/envoy-${version}-linux-${plat.arch}";
    inherit (plat) hash;
  };
}
