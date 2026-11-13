# Checks that `envoy --mode validate` accepts listener.yaml and the NixOS
# module's config, without a VM or network: with Envoy 1.37, the oldest the
# dashboard runs on, when a server of your own serves the files, and with
# nixpkgs' Envoy when its file server does. It also checks that the file
# server knows every type of file in the build.
{
  lib,
  runCommand,
  formats,
  envoy-bin,
  jq,
  openssl,
  # The dashboard's static files.
  dashboard,
  envoy-1_37,
  # A balancer's NixOS config with nix-grpc-store's lb.nix, the dashboard
  # module and the given module.
  balancer,
}:

let
  # Made up, for the module's certificate paths.
  certs = runCommand "dashboard-envoy-certs" { nativeBuildInputs = [ openssl ]; } ''
    mkdir $out
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
      -subj /CN=farm.example.com -keyout $out/key.pem -out $out/cert.pem 2> /dev/null
  '';

  farm = {
    services.nix-grpc-farm-lb = {
      enable = true;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      scheduler = [
        "10.0.0.4:50051"
        "10.0.0.5:50051"
      ];
      tls = {
        certFile = "${certs}/cert.pem";
        keyFile = "${certs}/key.pem";
        clientCaFile = "${certs}/cert.pem";
        upstream = {
          certFile = "${certs}/cert.pem";
          keyFile = "${certs}/key.pem";
          caFile = "${certs}/cert.pem";
        };
      };
      dashboard = {
        enable = true;
        package = dashboard;
        name = "Example farm";
        url = "https://farm.example.com";
        logSearchUrl = "https://logs.example.com/search";
        signOutUrl = "/sign-out";
        identity = {
          header = "X-Forwarded-Email";
          trustedPeers = [
            "127.0.0.1/32"
            "::1/128"
          ];
        };
        anonymous.networks = [
          "10.20.0.0/16"
          "fd00:20::/48"
        ];
      };
    };
  };

  # The module's assertions that fail, by message.
  refusals =
    config:
    map (a: a.message) (
      lib.filter (
        a: !a.assertion && lib.hasPrefix "services.nix-grpc-farm-lb" a.message
      ) config.assertions
    );
  generate =
    name: envoy: module:
    let
      config = balancer {
        imports = [
          farm
          module
        ];
        services.envoy.package = lib.mkForce envoy;
      };
      failed = refusals config;
    in
    assert lib.assertMsg (failed == [ ]) "${name}: ${lib.concatStringsSep "; " failed}";
    {
      inherit envoy;
      json = (formats.json { }).generate "envoy-${name}.json" config.services.envoy.settings;
    };

  upstream = {
    services.nix-grpc-farm-lb.dashboard.files.upstream = "https://static.example.com/dash";
  };
  configs = {
    file-server = generate "file-server" envoy-bin { };
    upstream-1_37 = generate "upstream-1_37" envoy-1_37 upstream;
    upstream = generate "upstream" envoy-bin upstream;
    # Only a proxy, plain HTTP behind it, and a files server without TLS.
    proxy-only = generate "proxy-only" envoy-1_37 {
      services.nix-grpc-farm-lb.dashboard = {
        anonymous.networks = lib.mkForce [ ];
        tls.enable = false;
        files.upstream = "http://[::1]:8080";
      };
    };
  };
  withoutFileServer = [
    configs.upstream
    configs.upstream-1_37
    configs.proxy-only
  ];

  refuses =
    want: module:
    let
      got = refusals (balancer {
        imports = [
          farm
          module
        ];
      });
    in
    lib.assertMsg (lib.any (lib.hasInfix want) got) "wanted a refusal with \"${want}\", got ${builtins.toJSON got}";
in
# The module refuses what cannot work.
assert refuses "set identity, anonymous.networks or both" {
  services.nix-grpc-farm-lb.dashboard = {
    identity = lib.mkForce null;
    anonymous.networks = lib.mkForce [ ];
  };
};
assert refuses "file server needs Envoy 1.40" { services.envoy.package = lib.mkForce envoy-1_37; };
assert refuses "identity.header must not be Cookie" {
  services.nix-grpc-farm-lb.dashboard.identity.header = lib.mkForce "Cookie";
};
runCommand "dashboard-envoy"
  {
    nativeBuildInputs = [
      jq
      openssl
    ];
  }
  ''
    validate() {
      echo "$1 with Envoy $($2/bin/envoy --version | grep -o 'version: [^/]*/[0-9.]*')" >&2
      $2/bin/envoy --mode validate --disable-hot-restart -c "$1" --log-level error
    }

    ${lib.concatMapStrings (c: ''
      validate ${c.json} ${c.envoy}
    '') (lib.attrValues configs)}

    # The files server takes the file server's place, and every config uses
    # the compressor's content_type list.
    for config in ${lib.concatMapStringsSep " " (c: c.json) withoutFileServer}; do
      if grep -q file_server $config; then
        echo "$config: file_server without the file server" >&2
        exit 1
      fi
    done
    for config in ${lib.concatMapStringsSep " " (c: c.json) (lib.attrValues configs)}; do
      if grep -q content_type_matcher $config; then
        echo "$config: content_type_matcher, which Envoy 1.37 lacks" >&2
        exit 1
      fi
    done

    # A new file type would go out as application/octet-stream.
    jq -r '.static_resources.listeners[] | select(.name == "dashboard") | .filter_chains[].filters[].typed_config.http_filters[]
        | select(.name == "envoy.filters.http.file_server") | .typed_config.content_types | keys[]' \
      ${configs.file-server.json} > known
    (cd ${dashboard} && find . -type f | sed -n 's/.*\.//p' | sort -u) > types
    if unknown=$(grep -vxFf known types); then
      echo "no content type for: $unknown" >&2
      exit 1
    fi

    # listener.yaml, with its paths in the sandbox.
    mkdir -p etc/tls tls/ca tls/lb
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
      -subj /CN=farm.example.com -keyout etc/tls/key.pem -out etc/tls/cert.pem 2> /dev/null
    cp etc/tls/cert.pem tls/ca/ca.crt
    cp etc/tls/cert.pem tls/lb/tls.crt
    cp etc/tls/key.pem tls/lb/tls.key
    jq -n --arg dir "$PWD/etc/tls" '{ resources: [ {
      "@type": "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret",
      name: "dashboard",
      tls_certificate: {
        certificate_chain: { filename: "\($dir)/cert.pem" },
        private_key: { filename: "\($dir)/key.pem" } } } ] }' > etc/sds-cert.json
    sed -e "s|/etc/envoy/dashboard|$PWD/etc|g" -e "s|/etc/envoy/tls|$PWD/tls|g" \
      ${./listener.yaml} > envoy.yaml
    validate envoy.yaml ${envoy-1_37}
    validate envoy.yaml ${envoy-bin}
    if grep -n 'content_type_matcher\|file_server' ${./listener.yaml}; then
      echo "listener.yaml needs an Envoy newer than 1.37" >&2
      exit 1
    fi
    touch $out
  ''
