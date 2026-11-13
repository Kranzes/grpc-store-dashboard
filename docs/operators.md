# Serving the dashboard from your farm

The farm's balancer serves the dashboard. The Envoy that already balances the farm gets a second
listener for browsers. It serves the page's files, sends the page's stream to the active scheduler
and its build log calls to the builder that ran the build. It signs nobody in. Put your own auth
proxy in front of it. The proxy signs users in and names each one in a header, and Envoy passes
that name on to the scheduler. Networks you trust can also watch without signing in. The page
holds no token and sends requests only to its own origin.

```
browser ── https ──▶ your auth proxy ── the user in a header ──┐
browser on an anonymous network ───────────────────────────────┴─▶ balancer Envoy, listener "dashboard" ([::]:8443)
                       │  GET /, /_app/…, /favicon.svg, /robots.txt     the package's files, or files.upstream
                       │  GET /dashboard.json                           {"name": …, "auth": …}
                       │  POST /nix.remote.Events/*  ── grpc_web ──▶ cluster dashboard, capped ──▶ active scheduler
                       │  POST /nix.remote.NixRemote/GetBuildLog ──▶ the farm's worker cluster ──▶ the builder
```

## 1. What you need

- A scheduler that serves `Events.Watch`, which means nix-grpc-store with the patches in
  [patches/](../patches/README.md) applied.
- On NixOS, this repository's NixOS module next to nix-grpc-store's modules. It adds the
  `services.nix-grpc-farm-lb.dashboard` options to the balancer. See section 2. Without NixOS,
  configure Envoy by hand from this repository's [envoy/](../envoy) files. See section 6.
- Envoy 1.37 or newer. To serve the page's files itself, with its File Server filter, Envoy needs
  1.40 or newer, and that filter's API is still work-in-progress in 1.40. With `files.upstream`,
  any HTTP server serves them instead. nix-grpc-store's balancer module uses nixpkgs' `envoy-bin`,
  which is new enough for both.
- For users who sign in, an auth proxy that puts each user's name in a header. See section 3.
  For networks that may watch without signing in, their address ranges. See section 5. You need
  at least one of the two.
- A certificate for the listener, unless the proxy terminates TLS and reaches the listener over a
  network nobody else shares.
- The balancer's client certificate towards the nodes, `tls.upstream`, and `trustedProxies` on the
  nodes. [nix-grpc-store's docs/farm.md](https://github.com/Mic92/nix-grpc-store/blob/main/docs/farm.md)
  already sets up both for the farm's own clients.

## 2. NixOS

Every node imports two modules: nix-grpc-store's `nixosModules.default` and this repository's
`nixosModules.default`. Take nix-grpc-store from a source with the patch series applied until
upstream merges it: a branch of your fork made with `git am`, as
[patches/README.md](../patches/README.md) says. Once upstream has the series, point the input at
upstream. Nothing in this repository changes then.

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # nix-grpc-store with patches/nix-grpc-store applied.
    nix-grpc-store.url = "github:example/nix-grpc-store/dashboard";
    nix-grpc-dashboard.url = "github:Kranzes/grpc-store-dashboard";
  };

  outputs =
    { nixpkgs, nix-grpc-store, nix-grpc-dashboard, ... }:
    {
      # The balancer. Schedulers and builders import the same two modules.
      nixosConfigurations.lb = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          nix-grpc-store.nixosModules.default
          nix-grpc-dashboard.nixosModules.default
          ./balancer.nix
        ];
      };
    };
}
```

This repository's module declares the `services.nix-grpc-farm-lb.dashboard` options next to
nix-grpc-store's balancer options. With `dashboard.enable`, it adds the dashboard listener and its
clusters to the balancer's Envoy, next to the farm listener that nix-grpc-store's module sets up.
It uses nothing of this repository's own `nix-grpc-store` input, which only its checks use.

On the balancer, which already has `tls.upstream`, with an auth proxy on the same host:

```nix
services.nix-grpc-farm-lb.dashboard = {
  enable = true;
  url = "https://farm.example.com";
  name = "Example farm";
  # Your auth proxy, which names each user in this header.
  identity = {
    header = "X-Forwarded-Email";
    trustedPeers = [ "127.0.0.1/32" "::1/128" ];
  };
  signOutUrl = "https://sso.example.com/logout";
  # Optional: these networks watch without signing in. Never builders or CI runners.
  anonymous.networks = [ "10.20.0.0/16" "fd00:20::/48" ];
};
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enable` | `false` | The dashboard listener. |
| `package` | this repository's `nix-grpc-dashboard` package | The dashboard's static files, which Envoy's file server serves. |
| `files.upstream` | `null` | An `http://` or `https://` URL of a server with the dashboard's files: a static file server, a sidecar or a CDN origin. Envoy sends `GET` and `HEAD` for the page's paths there, with the URL's path in front, and the page stays on the listener's origin. Envoy then needs 1.37, not 1.40, and serves no files itself. |
| `listen` | `"[::]:8443"` | The listener's address. |
| `tls.enable` | `true` | HTTPS on the listener. Off only where the proxy terminates TLS and reaches the listener over a network nobody else shares, such as the loopback. |
| `tls.certFile`, `tls.keyFile` | the farm listener's | The listener's certificate, reloaded when it changes. |
| `identity.header` | none | The header your proxy names the user in. A value outside `[A-Za-z0-9._@+-]`, or longer than 128 bytes, gets 403. |
| `identity.trustedPeers` | none | Your proxy's addresses as the listener sees them, as `<address>/<length>`. Anything that connects from them can claim to be any user. |
| `anonymous.networks` | `[ ]` | Peers that watch without signing in, as `<address>/<length>`. Never builders or CI runners. |
| `maxStreams` | 32 | Open streams of all viewers of this balancer together, 1 to 64. |
| `name` | the host name | The farm name the page shows, from `/dashboard.json`. |
| `url` | `null` | The origin users open, without a path. The listener then answers only its host. |
| `signOutUrl` | `null` | Your proxy's sign-out address, an absolute URL or a path on the page's origin. The page shows users the proxy names a "Sign out" link to it. |
| `logSearchUrl` | `null` | Your log search, linked from the Logs tab when a search finds no build. Goes into `/dashboard.json`. |

Set `identity`, `anonymous.networks` or both. The module refuses to evaluate without either.

Envoy closes the connection of a peer that is neither in `identity.trustedPeers` nor in
`anonymous.networks`. For every request from the others:

- From a trusted peer with the header, the header names the user. The scheduler sees
  `dashboard-user-<value>`, such as `dashboard-user-alice@example.com`.
- From every other peer, Envoy removes the header first, so it changes nothing.
- Without the header, a peer on an anonymous network is named by its address, as
  `dashboard-anon-<address>`. A trusted peer that is not on one gets 403.

The two prefixes keep users and addresses apart, so no header value can take an anonymous
viewer's name or the other way round.

With the file server, a new dashboard package reaches Envoy without a restart, so it never cuts
the farm's open build streams. A oneshot unit points `/run/nix-grpc-dashboard/site` at the new
package, and Envoy serves the files from there. With `files.upstream`, you deploy the files to
that server. A change to the listener itself, such as `name`, the header, the peers or the
networks, restarts Envoy like any other change to the balancer. Envoy restarts on its own after a
crash, and `journalctl -u envoy` shows the restart.

### ACME

Envoy runs as a dynamic user, so it reads the certificate as a member of the certificate's group,
"acme" by default. If the certificate is missing, Envoy fails to start, farm listener included, so
make it wait for the ACME module:

```nix
{ config, ... }:
let
  cert = "farm.example.com";
  dir = config.security.acme.certs.${cert}.directory;
in
{
  services.nix-grpc-farm-lb.dashboard.tls = {
    certFile = "${dir}/fullchain.pem";
    keyFile = "${dir}/key.pem";
  };
  systemd.services.envoy = {
    wants = [ "acme-${cert}.service" ];
    after = [ "acme-${cert}.service" ];
    serviceConfig.SupplementaryGroups = [ config.security.acme.certs.${cert}.group ];
  };
}
```

### Host names

With `url`, the listener answers only the host of `url`, on any port, and gives every other host
404. A page under another name, such as one that a DNS rebinding attack points at the balancer,
then cannot read the stream through a browser on an anonymous network. The proxy must keep the
browser's `Host` header. The listener checks it against `url`, and its CSRF filter checks
`Origin` against it.

## 3. Your auth proxy

The dashboard has no sign-in of its own. Any proxy that can sign users in and pass the user on in
a request header works. It must:

- **Sign in every request it forwards**: the page, `dashboard.json` and the stream. A request
  without a session gets the proxy's sign-in, not the listener.
- **Set the header to the user's name**, and replace any copy the browser sent. Pick a claim that
  fits `[A-Za-z0-9._@+-]` and 128 bytes, such as an email address or a login name. A display name
  with spaces gets 403.
- **Be the only trusted peer.** Whatever connects from `identity.trustedPeers` can name itself any
  user. Run the proxy on the balancer and trust only the loopback, or make sure that nothing else
  reaches the listener from the proxy's addresses. Never trust a NAT gateway or a load balancer
  that other clients share.
- **Keep the `Host` header and pass `Origin` on.** See "Host names" in section 2.
- **Stream the response.** The page holds one POST open for hours and gets a message every
  second. A proxy that buffers responses or ends a request after a fixed time breaks it.
- **Decide who may watch.** Every name the proxy sends gets the `watch` role on the scheduler, so
  limit the users and groups at the proxy.

Set `signOutUrl` to the proxy's sign-out address, if it has one, and the page links to it. When
the proxy's session ends, it should answer the page's next stream request with a 401 or a
redirect. The page then stops and offers Reload, which goes through the proxy's sign-in.

The recipes below are examples. None of them is required.

### oauth2-proxy

oauth2-proxy on the balancer, in front of the listener, with `tls.enable = false` and
`listen = "127.0.0.1:8443"`:

```console
$ oauth2-proxy --upstream=http://127.0.0.1:8443 --api-route='^/nix\.remote\.' ...
```

- `identity.header = "X-Forwarded-Email"` and `identity.trustedPeers = [ "127.0.0.1/32" ]`.
  oauth2-proxy sends it by default, replaces a client's copy, and keeps the `Host` header.
- `--api-route`, in oauth2-proxy 7.4.0 and newer, makes the stream get 401 when the session has
  ended. Without it, the stream gets the sign-in page with 403, which the page shows as a
  refusal.
- `signOutUrl = "/oauth2/sign_out"`. That ends oauth2-proxy's session only. Add `?rd=` with your
  IdP's sign-out URL to end that one too.

### Tailscale

`tailscale serve` on the balancer, in front of the listener, with `tls.enable = false` and
`listen = "127.0.0.1:8443"`:

```console
$ tailscale serve --bg http://127.0.0.1:8443
```

- `identity.header = "Tailscale-User-Login"` and `identity.trustedPeers = [ "127.0.0.1/32" ]`.
  Tailscale replaces a client's copy and keeps the `Host` header.
- Tailscale names only the users of user-owned devices. Tagged devices and Funnel get no header,
  so they get 403.
- There is no session to end, so leave `signOutUrl` unset.

### Cloudflare Access

Cloudflare Access in front of the balancer, through cloudflared on the balancer:

- `identity.header = "Cf-Access-Authenticated-User-Email"` and `identity.trustedPeers` the address
  cloudflared connects from, such as the loopback.
- Leave cloudflared's `httpHostHeader` unset, so the `Host` header stays.
- Cloudflare documents the signed `Cf-Access-Jwt-Assertion` as the user's identity, and does not
  say that it replaces a `Cf-Access-Authenticated-User-Email` that a client sends. Check that it
  does, by sending one with another address, before you rely on it. Set `access.required` in
  cloudflared's ingress rule too, so it lets through only requests that Access signed.
- `signOutUrl = "/cdn-cgi/access/logout"`, which ends the Access session for all applications.

### A Kubernetes Gateway with SSO

Gateway API itself has no sign-in, so use your implementation's OIDC or external authorization.
It must set the header from a claim of the user's token on every route to the listener, and
replace a copy the client sent.

On Kubernetes, the proxy's pods have no fixed address, and builders run in the same pod CIDR.
Listing the pod CIDR in `trustedPeers` alone would let every build name itself any user. Set
`trustedPeers` to the pod CIDR, and let a NetworkPolicy enforce the trusted peer instead, so that
only the proxy's namespace reaches the dashboard listener. That needs a CNI that enforces
NetworkPolicy.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: dashboard-listener
  namespace: farm
spec:
  # The balancer's pods.
  podSelector:
    matchLabels: { app.kubernetes.io/component: lb }
  policyTypes: [Ingress]
  ingress:
  # The dashboard listener, from the proxy's namespace only.
  - ports: [{ port: 8443 }]
    from:
    - namespaceSelector:
        matchLabels: { kubernetes.io/metadata.name: gateway }
  # The farm listener stays open to the farm's clients.
  - ports: [{ port: 50051 }]
```

Don't list anonymous networks on such a balancer unless the NetworkPolicy also admits them by
`ipBlock`, and never the pod CIDR.

## 4. The scheduler

Set this on every node, schedulers and builders alike, next to the `trustedProxies` and `lb-*` rule
that the farm already has. Builders need it because build log calls reach them through the
balancer too:

```nix
services.nix-grpc-daemon = {
  trustedProxies = [ "lb-*" ];
  accessRules = [
    # Before any broader glob, such as { cn = "*"; ... }.
    { cn = "dashboard-*"; role = "watch"; }
    { cn = "lb-*"; role = "trusted"; }
    # ... the farm's other rules
  ];
};
```

- `watch` allows the Events RPCs and `GetBuildLog`, and nothing else. Callers with `watch` get
  `PERMISSION_DENIED` on every other RPC.
- The listener names every viewer in `x-forwarded-client-cert`, `dashboard-user-<value>` or
  `dashboard-anon-<address>`, and presents the balancer's client certificate. The scheduler
  accepts that header only from a trusted proxy, so the node needs `trustedProxies = [ "lb-*" ]`.
- The scheduler caps streams at 8 per caller name, so each user gets 8, and viewers behind one
  address share 8.
- The scheduler still refuses callers without a name on Watch, and still refuses
  `--allow-anonymous watch` at startup.

| Mistake | Result |
| --- | --- |
| No `trustedProxies` on a node | The farm's own clients already break, because the node sees every client behind the balancer as the balancer. Every viewer becomes `lb-1` with role `trusted` on the Events and log routes and they share one cap of 8 streams. |
| The `dashboard-*` rule after a broader glob | Viewers get that glob's role, such as `write`. The Events route only carries the stream today, but a later Events RPC that checks a role above `watch` would serve them. |
| The dashboard listener on a node with no access rules | Without rules every named caller gets `write`, the forwarded names included. The same risk applies as in the row above. |
| The `dashboard-*` rule added to a node with no other rules | A non-empty list denies every name without a rule, so builders and clients lose access. Add their rules first. |
| A farm client certificate whose CN starts with `dashboard-` | That client gets only `watch`. Name certificates otherwise. |

## 5. Anonymous viewing

Every TCP connection whose peer address is in `anonymous.networks`, as Envoy sees it, watches
without signing in. That is every host on those networks, and everything behind a NAT gateway or
proxy inside them, since they all share the gateway's address. The listener reads no PROXY
protocol, so listing the address of an L4 balancer in front of Envoy opens the dashboard to
everyone that balancer serves.

List each network's IPv4 and IPv6 ranges. Browsers prefer IPv6 when the host has an address for
it, and Envoy closes the connection of a peer outside the lists.

**Builders and CI runners must not be on these networks.** The CSRF filter stops browsers only.
Any other program on a listed network can send any `Origin` and watch, and that includes builds,
because fixed-output derivations have network access inside the Nix sandbox. A build there could
read every other tenant's failure text and build logs. The balancer cannot check this, since
builder addresses come from EDS. The same holds for `identity.trustedPeers`, where a build could
also name itself any user.

Viewers see the whole stream at role `watch`, signed in or not:

- builders: addresses, systems, features, slots, load and drain state;
- build clients, by the names the scheduler gives them, such as certificate CNs and
  `oidc:<provider>:<sub>`;
- derivations: store path names, systems, features, queue order, assignments, outputs and sizes;
- the cache URL and the farm's counters;
- why builds failed and the end of their error messages, and build logs once the dashboard shows
  them.

A build's output can hold secrets that the build printed. Anonymous networks see all of it, and so
does every user your proxy lets through.

They do not see other builder RPCs, uploads, EDS or NARs, since the listener routes only the
Events prefix and `/nix.remote.NixRemote/GetBuildLog`. They get no token either. The listener
removes `authorization`, `cookie` and the identity header from every request it forwards, and any
`x-forwarded-client-cert` a client sends.

All viewers of one balancer share `maxStreams`, 32 by default, so one user or one listed network
cannot take all of the scheduler's 64 streams. With several balancers the caps add up, so keep
`maxStreams` times the number of balancers below 64.

## 6. Other setups

Without NixOS, take [envoy/listener.yaml](../envoy/listener.yaml): the listener with its one
filter chain and its routes, the scheduler cluster and a cluster for the files server. It runs on
Envoy 1.37 or newer.

Replace:

- the identity header `x-forwarded-user`, in `internal_only_headers`, the routes, the virtual
  host and the RBAC policy;
- your proxy's address `10.0.0.5/32` and the anonymous networks, in the filter chain matcher,
  `internal_address_config` and the RBAC policy;
- the host, the scheduler addresses and the files server `127.0.0.1:8080`;
- `dashboard.json`'s `name` and `signOutUrl`.

Without a proxy, drop its routes, `internal_address_config`, `internal_only_headers` and the
header principal. Without anonymous networks, drop their routes and ranges.

Copy the `sched` cluster's health check and SAN match from the farm's config. The scheduler
cluster needs what the farm's `sched` cluster has: the gRPC health check on service
`nix.scheduler`, `healthy_panic_threshold: 0`, HTTP/2, TLS to the nodes and the balancer's client
certificate.

The log routes send `/nix.remote.NixRemote/GetBuildLog` to the builders of one system, through the
farm's EDS worker cluster of that system, `x86_64-linux` in the example. For each further system,
add a log route with an `x-nix-system` header match for each kind of viewer. `listener.yaml`
defines none of these clusters, so its routes set `validate_clusters: false`.

- Keep the `layered_runtime` block. The header check's `{1,128}` compiles to about 900 RE2
  instructions, and Envoy refuses a regex over 100 by default.
- The files server can be any HTTP server with the dashboard's build. For a CDN origin, add TLS
  and `host_rewrite_literal` to its cluster and routes. Make it send the right `content-type`, since
  the listener sends `x-content-type-options: nosniff`.
- On Envoy 1.40 or newer, the File Server filter can serve the build instead, as the NixOS module
  does by default. See `nixos/dashboard.nix`.
- This repository's `envoy` check validates `listener.yaml` and the module's config with Envoy
  1.37 and with nixpkgs' Envoy.

### dashboard.json

`GET /dashboard.json` tells the page which farm it is on and who is watching, per request:

```json
{ "name": "Example farm", "auth": "proxy", "signOutUrl": "https://sso.example.com/logout" }
```

| Field | Meaning |
| --- | --- |
| `name` | Shown in the header and the tab title. Defaults to the page's host. |
| `auth` | `proxy`: the request came from the proxy with a user. `anonymous`: it came from an anonymous network. |
| `signOutUrl` | Optional, for `proxy` only. An `http` or `https` URL, or a path on the page's origin. The header links to it as "Sign out". The module's `dashboard.signOutUrl` sets it. |
| `logSearchUrl` | Optional. Your search across build logs, such as Loki or Elastic, as an `http` or `https` URL. When a search in the Logs tab finds no build, the list links to it as "Search every build log". The module's `dashboard.logSearchUrl` sets it. |

The page ignores fields it does not know, and says "This farm needs a newer dashboard" for an
`auth` it does not know. A 404, or a 200 that is not JSON, means no farm serves this copy, and the
page offers the demo. A redirect is an error.

## 7. Things that look optional but are not

- **`timeout: 0s` on the Watch route.** The default route timeout of 15 s ends every stream after
  15 s. Keep the default `stream_idle_timeout` of 5 minutes. A live stream carries `Stats` every
  second, so only a dead one sits idle that long.
- **`request_headers_timeout: 10s`.** Envoy sets no limit by default, and this listener faces
  browsers and shares the Envoy process with the farm listener.
- **`codec_type: AUTO` and ALPN `h2,http/1.1`.** Browsers and proxies need both.
- **`forward_client_cert_details: SANITIZE`.** It drops any `x-forwarded-client-cert` a client
  sends. The routes to the nodes then set their own.
- **No client CA on this listener.** Envoy must never ask a browser for a certificate.
- **No `grpc: {}` on the Watch route.** Envoy picks the route before the grpc_web filter rewrites
  the content type, so a gRPC match never matches gRPC-web. The route matches POST with a
  `content-type` starting `application/grpc-web` instead.
- **`internal_address_config` with the trusted peers, and the identity header in
  `internal_only_headers`.** Envoy removes the header from every other peer's requests before it
  picks the route. A filter would come too late, since Envoy picks the route before any filter
  runs.
- **The removal of `x-envoy-*` request headers in the first filter.** Envoy keeps them on requests
  from internal addresses, the trusted peers, so a user could pick the stream's retries, timeouts
  and stat names through the proxy.
- **The RBAC filter.** It refuses a trusted peer's request without the header, which would
  otherwise go out under the proxy's own address.
- **The 403 route for a header outside the allowed characters, first among the routes.** The
  user routes also match only those characters, since their value goes into a certificate subject.
- **`present_match: false` on the anonymous routes**, so a request with the header never gets an
  address for a name.
- **The identity header in the virtual host's `request_headers_to_remove`**, not the routes'.
  Envoy applies a route's removals before its additions, which read the header.
- **The header_mutation filter before the RBAC and CSRF filters.** It puts the security headers on
  every reply, such as their 403.
- **The circuit breaker on `dashboard`**, so the viewers cannot take all of the scheduler's
  streams.
- **The compressor's `content_type` list.** Envoy 1.37 has no `content_type_matcher`.

For the file server:

- **It comes after the compressor**, so the files go out compressed.
- **It is off on every route but the two static ones**, through `typed_per_filter_config`, and
  those match only GET and HEAD. It answers every request it sees, with 404 for a missing file
  and 405 for other methods, so it would take `dashboard.json` and gRPC-web calls to other
  services.
- **A 302 from `/<dir>` to `/<dir>/`.** The file server serves `/logs` without the slash too, and
  the page's relative asset paths then break.
- **`cache-control` through the header_mutation filter's per-route config.** A route's
  `response_headers_to_add` does not reach the file server's replies.

## 8. Failure text and who sees it

When a build fails, the stream carries Nix's status and the end of its error text, which holds the
last lines of the build log. Every caller that can watch sees it: everyone with the `watch` role or
higher, every user your proxy lets through and every anonymous network. There is no separate
permission for it, as for build logs in CI.

- The text is whatever the build printed. Fixed-output fetchers print URLs, `curl -v` prints request
  headers, and test suites print their environment.
- The builder and the scheduler mask common secret shapes before the text leaves them: user and
  password in URLs, query values named like tokens, signatures, keys and passwords,
  `Authorization` headers, `Bearer` tokens, variables named like secrets, and private key blocks.
  That catches common shapes only.
- The scheduler never logs the text, and the dashboard keeps it in memory only.
- If your builds can print secrets, let only people who may read build output watch, the same rule
  as for logs.

Builders report this, their drain reason, their free disk and what they take from each
substituter only with the patches applied on the builders too. The dashboard says "does not
report" for a builder that runs an older nix-grpc-store.

## 9. Build logs

The Logs tab reads each build's log from the builder that ran it, with `GetBuildLog` through the
dashboard listener. The patch series adds this. The listener routes only that path to builders,
through the farm's worker cluster of the build's system, and `x-nix-worker` picks the builder.
Draining builders keep serving the logs of the builds they still run and of those they kept.

- Builders need the dashboard's access rule and `trustedProxies = [ "lb-*" ]`, as the scheduler
  has them. On NixOS every node shares these options, so one setting covers both.
- Anyone who can watch reads every build log. Each user gets 8 log calls per builder, and viewers
  behind one address share 8.
- Logs hold whatever builds print. The masking of section 8 covers only the failure excerpt in the
  stream, never the log one click away.
- A later build of the same derivation on the same builder replaces its log, on the builder and in
  the log store. The viewer says so when it can tell.
- Builders keep logs for `buildLogRetention`, 30 days by default. The list reaches back as far as
  the scheduler's rings, which hold the last 10,000 builds and 2,000 failures. Links to logs work as
  long as the builder or the log store keeps them.
- Without `buildLogStore`, no failed build's log outlives its builder. A farm with autoscaled
  builders should set it. A public niks3 cache already publishes the logs of builds that worked,
  until its next GC.
- When a search in the list finds no build, the list links to `dashboard.logSearchUrl`, if set, for
  a search across all logs. The dashboard has no such search of its own.
- `nix_grpc_rpcs_total` counts all viewers under their rule's pattern, `cn="dashboard-*"`, so they
  add no series each.

## 10. The farm cache among the substituters

Builders list the farm's own cache among their substituters. To tell it apart from upstream ones
such as cache.nixos.org, the scheduler needs `--niks3-cache-url`, the cache's URL as builders
substitute from it. The NixOS module passes it from `services.nix-grpc-daemon.niks3.cacheUrl`
whenever `niks3` is set, and the Helm chart from `niks3.cacheURL`. Without it, the upstream card
lists the farm cache as one more substituter, and the Upstream panel says so.

## 11. Checking it

On the balancer, from the loopback, as the proxy of section 2 asks:

```console
$ curl -s --resolve farm.example.com:8443:127.0.0.1 -H 'X-Forwarded-Email: alice@example.com' \
    https://farm.example.com:8443/dashboard.json
{"name":"Example farm","auth":"proxy","signOutUrl":"https://sso.example.com/logout"}

$ printf '\0\0\0\0\0' | curl -si --resolve farm.example.com:8443:127.0.0.1 \
    https://farm.example.com:8443/nix.remote.Events/Watch -H 'X-Forwarded-Email: alice@example.com' \
    -H 'content-type: application/grpc-web+proto' -H 'x-grpc-web: 1' \
    -H 'Origin: https://farm.example.com:8443' --data-binary @-
HTTP/2 200
```

The `Origin` must match the host and port of the URL, as a browser's does.

From an anonymous network, the same requests without the header answer with `"auth":"anonymous"`
and stream. `buf curl` needs the `Origin` header too, since the CSRF filter refuses requests
without it:

```console
$ buf curl --protocol grpcweb --schema proto/events.proto \
    -H 'Origin: https://farm.example.com:8443' https://farm.example.com:8443/nix.remote.Events/Watch
```

The HTTP status tells Envoy's answers from the scheduler's, which always come with HTTP 200:

| Answer | Meaning |
| --- | --- |
| Connection closed | The peer is neither a trusted peer nor on an anonymous network. |
| HTTP 403 `Invalid identity header`, on the stream as `grpc-message` | The header's value has a character outside `[A-Za-z0-9._@+-]` or is longer than 128 bytes. |
| HTTP 403 `RBAC: access denied` | A trusted peer sent no header, and is not on an anonymous network. |
| HTTP 403 `Invalid origin` | The CSRF filter refused a missing or foreign `Origin`, as behind a proxy that rewrites `Host`. |
| HTTP 503 with `x-envoy-overloaded: true` | `maxStreams` streams are open. The page says the farm is busy and retries. |
| HTTP 404 | No route matched the method, the content type, the path or the host. |
| 14 `no healthy upstream` | Envoy has no active scheduler in the cluster. Check `curl localhost:9901/clusters` on the balancer. |
| 12 UNIMPLEMENTED | The scheduler runs a nix-grpc-store without the patch series. |
| 16 UNAUTHENTICATED | The node does not trust the balancer as a proxy, so it ignores the forwarded name. |
| 7 PERMISSION_DENIED | No rule grants `watch`. "no access rule matches 'dashboard-…'" means the `dashboard-*` rule is missing. |
| 8 RESOURCE_EXHAUSTED | The scheduler already serves 64 streams, or 8 for this caller. |
| HTTP 200, no `grpc-status` | It works. The stream is open and binary frames keep coming. |

The scheduler logs each stream as `event=watch_stream_open cn=<name> peer=<peer>`, such as
`cn=dashboard-user-alice@example.com`, `cn=dashboard-anon-10.20.0.7` or
`cn=dashboard-anon-2001:db8::7`.
