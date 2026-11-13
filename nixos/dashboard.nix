# The web dashboard on the farm's balancer: a second Envoy listener, next to
# the one nix-grpc-store's lb.nix sets up, that serves the page and sends its
# gRPC-web calls to the active scheduler and, for build logs, to the builders.
# An auth proxy in front of it names each user in a header, and networks you
# trust can watch without signing in.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.nix-grpc-farm-lb;
  dash = cfg.dashboard;
  up = cfg.tls.upstream;
  # Without lb.nix, cfg holds only `dashboard`.
  lbEnabled = cfg.enable or false;
  inherit (dash) identity;
  hasIdentity = identity != null;
  hasAnonymous = dash.anonymous.networks != [ ];
  fileServer = dash.files.upstream == null;
  # Envoy compares header names in lower case.
  idHeader = lib.toLower identity.header;

  typed = type: attrs: { "@type" = "type.googleapis.com/${type}"; } // attrs;
  ext = name: type: attrs: {
    inherit name;
    typed_config = typed type attrs;
  };
  tlsSocket =
    side:
    ext "envoy.transport_sockets.tls" "envoy.extensions.transport_sockets.tls.v3.${side}TlsContext";
  file = path: { filename = toString path; };
  headerMatch = name: string_match: { inherit name string_match; };
  grpcWebBody = headerMatch "content-type" { prefix = "application/grpc-web"; };
  header = key: value: {
    header = { inherit key value; };
    append_action = "OVERWRITE_IF_EXISTS_OR_ADD";
  };
  hostPort =
    addr:
    let
      m = builtins.match "\\[?([^]]*)]?:([0-9]+)" addr;
    in
    {
      address = builtins.elemAt m 0;
      port_value = lib.toInt (builtins.elemAt m 1);
      ipv4_compat = builtins.elemAt m 0 == "::";
    };
  cidr =
    network:
    let
      parts = lib.splitString "/" network;
    in
    {
      address_prefix = lib.head parts;
      prefix_len = lib.toInt (lib.last parts);
    };
  endpoints = addrs: [ { lb_endpoints = map (a: { endpoint.address.socket_address = a; }) addrs; } ];
  getOrHead = [ (headerMatch ":method" { safe_regex.regex = "GET|HEAD"; }) ];
  # For filters that answer some requests themselves, off on the routes they
  # must leave alone.
  off = name: {
    "envoy.filters.http.${name}" = typed "envoy.config.route.v3.FilterConfig" { disabled = true; };
  };

  # Filesystem SDS, so Envoy reloads certificates renewed in place.
  sds = name: watched: body: {
    inherit name;
    sds_config = {
      resource_api_version = "V3";
      path_config_source = {
        path = toString (
          (pkgs.formats.json { }).generate "envoy-sds-${name}.json" {
            resources = [
              (typed "envoy.extensions.transport_sockets.tls.v3.Secret" ({ inherit name; } // body))
            ];
          }
        );
        watched_directory.path = dirOf (toString watched);
      };
    };
  };
  certSds =
    name: cert: key:
    sds name cert {
      tls_certificate = {
        certificate_chain = file cert;
        private_key = file key;
      };
    };

  # The balancer's client certificate, so the nodes accept the names it
  # forwards.
  upstreamTls = lib.optionalAttrs (up.certFile != null) {
    transport_socket = tlsSocket "Upstream" (
      {
        common_tls_context = {
          alpn_protocols = [ "h2" ];
          combined_validation_context = {
            default_validation_context.match_typed_subject_alt_names = lib.optional (up.sni != null) {
              san_type = "DNS";
              matcher.exact = up.sni;
            };
            validation_context_sds_secret_config = sds "ca" up.caFile {
              validation_context.trusted_ca = file up.caFile;
            };
          };
          tls_certificate_sds_secret_configs = [ (certSds "lb" up.certFile up.keyFile) ];
        };
      }
      // lib.optionalAttrs (up.sni != null) { inherit (up) sni; }
    );
  };

  # Streams last hours, and Envoy's default of 1024 would refuse the next one.
  streamLimits = {
    max_connections = 1000000;
    max_pending_requests = 1000000;
    max_requests = 1000000;
  };

  # The active scheduler, as the farm's sched cluster reaches it, with one cap
  # on the streams all viewers hold open.
  schedCluster = upstreamTls // {
    name = "dashboard";
    type = "STRICT_DNS";
    circuit_breakers.thresholds = [ (streamLimits // { max_requests = dash.maxStreams; }) ];
    typed_extension_protocol_options."envoy.extensions.upstreams.http.v3.HttpProtocolOptions" =
      typed "envoy.extensions.upstreams.http.v3.HttpProtocolOptions"
        {
          explicit_http_config.http2_protocol_options = {
            max_concurrent_streams = cfg.maxStreams;
            connection_keepalive = {
              interval = "30s";
              timeout = "10s";
            };
          };
        };
    health_checks = [
      {
        timeout = "2s";
        interval = cfg.healthCheckInterval;
        no_traffic_interval = cfg.healthCheckInterval;
        # A standby that just took over gets traffic within a second.
        unhealthy_interval = "1s";
        unhealthy_edge_interval = "1s";
        unhealthy_threshold = 2;
        healthy_threshold = 1;
        grpc_health_check.service_name = "nix.scheduler";
      }
    ];
    # Only one node is ever SERVING, so never enter panic mode.
    common_lb_config.healthy_panic_threshold.value = 0;
    load_assignment = {
      cluster_name = "dashboard";
      endpoints = endpoints (map hostPort (lib.toList cfg.scheduler));
    };
  };

  urlParts =
    url:
    let
      m = builtins.match "(https?)://([^/:]+|\\[[^]/]+])(:([0-9]+))?(/.*)?" url;
      scheme = builtins.elemAt m 0;
      port = builtins.elemAt m 3;
    in
    {
      inherit scheme;
      host = builtins.elemAt m 1;
      port =
        if port != null then
          lib.toInt port
        else if scheme == "https" then
          443
        else
          80;
      authority = builtins.elemAt m 1 + lib.optionalString (port != null) ":${port}";
      path = lib.removeSuffix "/" (lib.defaultTo "" (builtins.elemAt m 4));
    };
  origin = urlParts dash.url;
  files = urlParts dash.files.upstream;

  # The page's files from an HTTP server of your own, in place of the file
  # server.
  filesCluster = {
    name = "dashboard-files";
    type = "LOGICAL_DNS";
    # Envoy's default uses only the IPv6 address when there is one, which
    # fails on a balancer without an IPv6 route to the server.
    dns_lookup_family = "ALL";
    load_assignment = {
      cluster_name = "dashboard-files";
      endpoints = endpoints [
        {
          address = lib.removeSuffix "]" (lib.removePrefix "[" files.host);
          port_value = files.port;
        }
      ];
    };
  }
  // lib.optionalAttrs (files.scheme == "https") {
    transport_socket = tlsSocket "Upstream" {
      sni = files.host;
      common_tls_context.validation_context = {
        trusted_ca = file config.security.pki.caBundle;
        match_typed_subject_alt_names = [
          {
            san_type = "DNS";
            matcher.exact = files.host;
          }
        ];
      };
    };
  };

  # Who is calling, per request. A trusted peer's header names a user. On an
  # anonymous network, the peer address names the viewer. The prefixes keep
  # the two apart, whatever the header says.
  validId = headerMatch idHeader { safe_regex.regex = "[A-Za-z0-9._@+-]{1,128}"; };
  viewers =
    lib.optional hasIdentity {
      auth = "proxy";
      headers = [ validId ];
      name = "dashboard-user-%REQ(${idHeader})%";
    }
    ++ lib.optional hasAnonymous {
      auth = "anonymous";
      headers = lib.optional hasIdentity {
        name = idHeader;
        present_match = false;
      };
      name = "dashboard-anon-%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%";
    };

  # POST with a gRPC-web body only, so another site's preflight gets 404. No
  # grpc match: Envoy picks the route before grpc_web rewrites the type.
  upstreamRoute = viewer: match: cluster: {
    match = match // {
      headers = [
        (headerMatch ":method" { exact = "POST"; })
        grpcWebBody
      ]
      ++ match.headers or [ ]
      ++ viewer.headers;
    };
    route = {
      inherit cluster;
      timeout = "0s";
      # A restarted node stays healthy for two probes. Try the next one.
      retry_policy = {
        retry_on = "connect-failure,refused-stream";
        num_retries = 2;
        retry_host_predicate = [
          (ext "envoy.retry_host_predicates.previous_hosts"
            "envoy.extensions.retry.host.previous_hosts.v3.PreviousHostsPredicate"
            { }
          )
        ];
        host_selection_retry_max_attempts = 3;
      };
    };
    request_headers_to_remove = [
      "authorization"
      "cookie"
    ];
    # The nodes accept this name from the balancer only. One name per user or
    # address, so the scheduler's cap of 8 streams per caller is per viewer.
    request_headers_to_add = [
      (header "x-forwarded-client-cert" ''Subject="CN=${viewer.name}"'')
    ];
  };

  viewerRoutes =
    viewer:
    [ (upstreamRoute viewer { prefix = "/nix.remote.Events/"; } "dashboard") ]
    # Build logs from the builder that ran the build, through the farm's
    # worker cluster of its system.
    ++ map (
      system:
      upstreamRoute viewer {
        path = "/nix.remote.NixRemote/GetBuildLog";
        headers = lib.optional (system != cfg.defaultSystem) (
          headerMatch "x-nix-system" { exact = system; }
        );
      } system
    ) (lib.filter (s: s != cfg.defaultSystem) cfg.systems ++ [ cfg.defaultSystem ])
    ++ [
      {
        match = {
          path = "/dashboard.json";
          headers = getOrHead ++ viewer.headers;
        };
        direct_response = {
          status = 200;
          body.inline_string = builtins.toJSON (
            {
              inherit (dash) name;
              inherit (viewer) auth;
            }
            // lib.optionalAttrs (dash.logSearchUrl != null) { inherit (dash) logSearchUrl; }
            // lib.optionalAttrs (viewer.auth == "proxy" && dash.signOutUrl != null) {
              inherit (dash) signOutUrl;
            }
          );
        };
        response_headers_to_add = [
          (header "content-type" "application/json")
          (header "cache-control" "no-cache")
        ];
      }
    ];

  # The package's files, through a link a oneshot unit swaps, so a new package
  # needs no Envoy restart.
  siteDir = "nix-grpc-dashboard";
  site = "/run/${siteDir}/site";
  cached =
    cacheControl:
    typed "envoy.extensions.filters.http.header_mutation.v3.HeaderMutationPerRoute" {
      mutations.response_mutations = [ { append = header "cache-control" cacheControl; } ];
    };
  # GET and HEAD only, so other methods go on to the last route. A route's
  # response_headers_to_add does not reach the file server's replies, so
  # cache-control comes from the header_mutation filter.
  static =
    prefix: cacheControl:
    {
      match = {
        inherit prefix;
        headers = getOrHead;
      };
      typed_per_filter_config."envoy.filters.http.header_mutation" = cached cacheControl;
    }
    // (
      if fileServer then
        # The file server answers these, so their own 404 never goes out.
        { direct_response.status = 404; }
      else
        {
          route = {
            cluster = "dashboard-files";
            host_rewrite_literal = files.authority;
          }
          // lib.optionalAttrs (files.path != "") { prefix_rewrite = files.path + prefix; };
          request_headers_to_remove = [
            "authorization"
            "cookie"
          ]
          ++ lib.optional hasIdentity idHeader;
        }
    );
  noFiles = route: lib.recursiveUpdate route { typed_per_filter_config = off "file_server"; };
  routeConfig = {
    name = "dashboard";
    internal_only_headers = lib.optional hasIdentity idHeader;
    virtual_hosts = [
      {
        name = "dashboard";
        # Not another host, so a page under another name cannot read the
        # stream through a browser on an anonymous network. Any port, for the
        # proxy's and the listener's own.
        domains =
          if dash.url == null then
            [ "*" ]
          else
            [
              origin.host
              "${origin.host}:*"
            ];
        routes =
          map (if fileServer then noFiles else lib.id) (
            lib.optional hasIdentity {
              # A value outside these characters never reaches a subject.
              match = {
                prefix = "/";
                headers = [ (validId // { invert_match = true; }) ];
              };
              direct_response = {
                status = 403;
                body.inline_string = "Invalid identity header";
              };
            }
            ++ lib.concatMap viewerRoutes viewers
            ++ [
              {
                # /<dir> to /<dir>/, so the page's relative asset paths resolve. Not
                # 301, which browsers cache.
                match = {
                  safe_regex.regex = "/[^.]*[^/]";
                  headers = getOrHead;
                };
                redirect = {
                  regex_rewrite = {
                    pattern.regex = "^(.*)$";
                    substitution = "\\1/";
                  };
                  response_code = "FOUND";
                };
              }
            ]
          )
          ++ [
            (static "/_app/immutable/" "public, max-age=31536000, immutable")
            (static "/" "no-cache")
            ((if fileServer then noFiles else lib.id) {
              match.prefix = "/";
              direct_response.status = 404;
            })
          ];
        # Envoy removes it here after the routes' own headers, which read it
        # for the forwarded name.
        request_headers_to_remove = lib.optional hasIdentity idHeader;
      }
    ];
  };

  filter =
    name: type: ext "envoy.filters.http.${name}" "envoy.extensions.filters.http.${name}.v3.${type}";
  peerInput = ext "peer" "envoy.extensions.matching.common_inputs.network.v3.DirectSourceIPInput" { };
  filterChain = {
    name = "dashboard";
    filters = [
      (ext "envoy.filters.network.http_connection_manager"
        "envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager"
        {
          stat_prefix = "dashboard";
          codec_type = "AUTO";
          request_headers_timeout = "10s";
          use_remote_address = true;
          normalize_path = true;
          merge_slashes = true;
          path_with_escaped_slashes_action = "UNESCAPE_AND_REDIRECT";
          # Drops any x-forwarded-client-cert a client sends.
          forward_client_cert_details = "SANITIZE";
          route_config = routeConfig;
          # Envoy picks the route before any filter runs, so Envoy itself
          # removes the header from every peer but the trusted ones, as an
          # internal-only header.
          internal_address_config.cidr_ranges = lib.optionals hasIdentity (map cidr identity.trustedPeers);
          http_filters = [
            # Before the filters whose replies get these headers too.
            (filter "header_mutation" "HeaderMutation" {
              mutations = {
                # Envoy keeps the x-envoy-* headers of internal peers'
                # requests, which would let a user pick retries, timeouts and
                # stat names.
                request_mutations = [ { remove_on_match.key_matcher.prefix = "x-envoy-"; } ];
                response_mutations = map (append: { inherit append; }) [
                  (header "x-content-type-options" "nosniff")
                  (header "referrer-policy" "no-referrer")
                  (header "x-frame-options" "DENY")
                ];
              };
            })
            # Every request needs a viewer: a trusted peer's header, or a peer
            # on an anonymous network.
            (filter "rbac" "RBAC" {
              rules = {
                action = "ALLOW";
                policies.viewers = {
                  permissions = [ { any = true; } ];
                  principals =
                    map (network: { direct_remote_ip = cidr network; }) dash.anonymous.networks
                    ++ lib.optional hasIdentity {
                      header = {
                        name = idHeader;
                        present_match = true;
                      };
                    };
                };
              };
            })
            (filter "csrf" "CsrfPolicy" {
              filter_enabled.default_value = {
                numerator = 100;
                denominator = "HUNDRED";
              };
            })
            (filter "grpc_web" "GrpcWeb" { })
            (filter "compressor" "Compressor" {
              response_direction_config.common_config.content_type = [
                "text/html"
                "text/css"
                "text/javascript"
                "application/javascript"
                "text/plain"
                "application/json"
                "application/manifest+json"
                "image/svg+xml"
              ];
              compressor_library = ext "br" "envoy.extensions.compression.brotli.compressor.v3.Brotli" { };
            })
          ]
          ++ lib.optional fileServer (
            # After the compressor, so its files are compressed. Its API is
            # work-in-progress in Envoy 1.40.
            filter "file_server" "FileServerConfig" {
              manager_config.thread_pool = { };
              path_mappings = [
                {
                  request_path_prefix = "/";
                  file_path_prefix = site;
                }
              ];
              content_types = {
                html = "text/html; charset=utf-8";
                js = "text/javascript; charset=utf-8";
                css = "text/css; charset=utf-8";
                json = "application/json";
                svg = "image/svg+xml";
                txt = "text/plain; charset=utf-8";
                png = "image/png";
                woff2 = "font/woff2";
                webmanifest = "application/manifest+json";
              };
              default_content_type = "application/octet-stream";
              directory_behaviors = [ { default_file = "index.html"; } ];
            }
          )
          ++ [ (filter "router" "Router" { }) ];
        }
      )
    ];
  }
  // lib.optionalAttrs dash.tls.enable {
    # No validation context, so Envoy never asks a browser for a certificate.
    transport_socket = tlsSocket "Downstream" {
      common_tls_context = {
        alpn_protocols = [
          "h2"
          "http/1.1"
        ];
        tls_certificate_sds_secret_configs = [
          (certSds "dashboard" (lib.defaultTo cfg.tls.certFile dash.tls.certFile) (
            lib.defaultTo cfg.tls.keyFile dash.tls.keyFile
          ))
        ];
      };
    };
  };

  listener = {
    name = "dashboard";
    address.socket_address = hostPort dash.listen;
    filter_chains = [ filterChain ];
    # The TCP peer, which a client cannot forge. Envoy closes the connection
    # of a peer that is neither trusted nor on an anonymous network.
    filter_chain_matcher.matcher_tree = {
      input = peerInput;
      custom_match = ext "peers" "xds.type.matcher.v3.IPMatcher" {
        range_matchers = [
          {
            ranges = map cidr (lib.optionals hasIdentity identity.trustedPeers ++ dash.anonymous.networks);
            on_match.action = ext "dashboard" "google.protobuf.StringValue" { value = "dashboard"; };
          }
        ];
      };
    };
  };

  # Names whose meaning the listener or the nodes already fix.
  reservedHeaders = [
    "authorization"
    "cookie"
    "host"
    "origin"
    "content-type"
    "x-forwarded-client-cert"
    "x-forwarded-for"
    "x-nix-worker"
    "x-nix-system"
  ];
  check = assertion: message: {
    inherit assertion;
    message = "services.nix-grpc-farm-lb.dashboard: ${message}";
  };
  dashOption =
    path:
    [
      "services"
      "nix-grpc-farm-lb"
      "dashboard"
    ]
    ++ path;
in
{
  imports = [
    (lib.mkRemovedOptionModule (dashOption [ "signIn" ]) ''
      The dashboard no longer signs users in. Put your auth proxy in front of
      the listener and set `identity` (docs/operators.md).
    '')
    (lib.mkRenamedOptionModule (dashOption [
      "anonymous"
      "maxStreams"
    ]) (dashOption [ "maxStreams" ]))
  ];

  options.services.nix-grpc-farm-lb.dashboard =
    let
      inherit (lib) mkOption types;
      network = types.strMatching "[0-9a-fA-F.:]+/[0-9]{1,3}";
    in
    {
      enable = lib.mkEnableOption ''
        the web dashboard on a second listener of the balancer. Every node
        needs `trustedProxies` for the balancer and the access rule
        `{ cn = "dashboard-*"; role = "watch"; }`
      '';
      package =
        lib.mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "nix-grpc-dashboard"
          {
            pkgsText = "nix-grpc-dashboard.packages.\${pkgs.stdenv.hostPlatform.system}";
            extraDescription = ''
              Envoy's file server serves it, unless `files.upstream` is set. A new
              package reaches Envoy without a restart.
            '';
          };
      files.upstream = mkOption {
        type = types.nullOr (
          types.strMatching "(http://([^/:@]+|\\[[^]/@]+])|https://([A-Za-z0-9-]+[.])*[A-Za-z][A-Za-z0-9-]*)(:[0-9]+)?(/[^?#]*)?"
        );
        default = null;
        example = "http://127.0.0.1:8080";
        description = ''
          An HTTP server that serves the dashboard's files, such as a static
          file server, a sidecar or a CDN origin. Envoy sends `GET` and `HEAD`
          for the page's paths there, with the URL's path in front, and the
          page stays on the listener's origin. Without it, Envoy serves
          `package` with its file server, which needs Envoy 1.40 or newer.
          Over https, Envoy checks the server's certificate against the system's
          CAs and the URL's host.
        '';
      };
      listen = mkOption {
        type = types.str;
        default = "[::]:8443";
        description = "Address of the dashboard listener.";
      };
      name = mkOption {
        type = types.str;
        default = config.networking.fqdnOrHostName;
        defaultText = lib.literalExpression "config.networking.fqdnOrHostName";
        description = "The farm name the page shows.";
      };
      logSearchUrl = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Your log search, linked from the Logs tab.";
      };
      signOutUrl = mkOption {
        type = types.nullOr (types.strMatching "(https?://|/)[^[:space:]]*");
        default = null;
        example = "https://sso.example.com/logout";
        description = ''
          Your auth proxy's sign-out address, an absolute URL or a path on the
          page's origin. Users named by `identity` see a Sign out link to it.
        '';
      };
      url = mkOption {
        type = types.nullOr (types.strMatching "https?://([^/:@]+|\\[[^]/@]+])(:[0-9]+)?");
        default = null;
        description = ''
          The origin users open, such as `https://farm.example.com`. The
          listener then answers only its host, on any port, so the auth proxy
          must keep the `Host` header.
        '';
      };
      tls.enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          HTTPS on the listener. Turn it off only where the auth proxy
          terminates TLS and reaches the listener over a network nobody else
          shares, such as the loopback.
        '';
      };
      tls.certFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "The certificate browsers see. Defaults to `tls.certFile`.";
      };
      tls.keyFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "Defaults to `tls.keyFile`.";
      };
      identity = mkOption {
        default = null;
        description = ''
          Your auth proxy in front of the listener. A request from one of
          `trustedPeers` that has `header` comes from the user the header
          names, `dashboard-user-<value>` to the scheduler. Every other peer's
          requests lose the header.
        '';
        type = types.nullOr (
          types.submodule {
            options = {
              header = mkOption {
                type = types.strMatching "[A-Za-z0-9-]+";
                example = "x-forwarded-email";
                description = ''
                  The request header the proxy names the user in. A value outside
                  `[A-Za-z0-9._@+-]`, or longer than 128 bytes, gets 403.
                '';
              };
              trustedPeers = mkOption {
                type = types.nonEmptyListOf network;
                example = [
                  "127.0.0.1/32"
                  "::1/128"
                ];
                description = ''
                  The proxy's addresses as the listener sees them, as
                  `<address>/<length>`. Anything else that connects from them can
                  claim to be any user.
                '';
              };
            };
          }
        );
      };
      anonymous.networks = mkOption {
        type = types.listOf network;
        default = [ ];
        description = ''
          Peer ranges, as `<address>/<length>`, that watch without signing in,
          each viewer as `dashboard-anon-<address>`. Never list builders or CI
          runners.
        '';
      };
      maxStreams = mkOption {
        type = types.ints.between 1 64;
        default = 32;
        description = "Open streams of all viewers of this balancer together.";
      };
    };

  config = lib.mkIf dash.enable (
    lib.mkMerge [
      {
        assertions = [
          (check lbEnabled "needs nix-grpc-store's balancer module with services.nix-grpc-farm-lb.enable")
        ];
      }

      (lib.mkIf lbEnabled {
        assertions = [
          (check (hasIdentity || hasAnonymous) "set identity, anonymous.networks or both")
          (check
            (
              (dash.tls.certFile == null) == (dash.tls.keyFile == null)
              && (!dash.tls.enable || dash.tls.certFile != null || cfg.tls.certFile != null)
            )
            "needs a certificate: tls.certFile and tls.keyFile, here or the farm listener's, or tls.enable = false"
          )
          (check (
            up.certFile != null
          ) "needs tls.upstream, so the nodes accept the names the balancer forwards")
          (check (
            !hasIdentity || !lib.elem idHeader reservedHeaders && !lib.hasPrefix "x-envoy-" idHeader
          ) "identity.header must not be ${identity.header}, which the listener or the nodes already use")
          (
            if fileServer then
              check (lib.versionAtLeast config.services.envoy.package.version "1.40") "Envoy's file server needs Envoy 1.40 or newer. Set files.upstream to serve the files from elsewhere."
            else
              check (lib.versionAtLeast config.services.envoy.package.version "1.37") "needs Envoy 1.37 or newer"
          )
        ];

        # nixpkgs never restarts Envoy. Its filters now face browsers, so it
        # comes back after a crash, farm listener included.
        systemd.services.envoy.serviceConfig.Restart = lib.mkForce "on-failure";

        services.envoy.settings.static_resources = {
          listeners = [ listener ];
          clusters = [ schedCluster ] ++ lib.optional (!fileServer) filesCluster;
        };
      })

      (lib.mkIf (lbEnabled && hasIdentity) {
        # The identity check's {1,128} compiles to about 900 RE2 instructions,
        # and Envoy refuses a regex over 100 by default.
        services.envoy.settings.layered_runtime.layers = [
          {
            name = "dashboard";
            static_layer."re2.max_program_size.error_level" = 1000;
          }
        ];
      })

      (lib.mkIf (lbEnabled && fileServer) {
        # Renamed into place, so Envoy never sees the link missing.
        systemd.services.nix-grpc-dashboard-site = {
          wantedBy = [ "envoy.service" ];
          before = [ "envoy.service" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            RuntimeDirectory = siteDir;
            RuntimeDirectoryPreserve = "yes";
          };
          script = ''
            ln -sfn ${dash.package} "$RUNTIME_DIRECTORY/.site"
            mv -T "$RUNTIME_DIRECTORY/.site" "$RUNTIME_DIRECTORY/site"
          '';
        };
      })
    ]
  );
}
