# The dashboard listener on a balancer, in front of a node with the series:
# users an auth proxy names in a header, anonymous viewers by address, and
# the page from Envoy's file server.
{
  pkgs,
  modules,
  daemon,
  ngsTests,
  ...
}:

let
  testLib = import ./lib.nix { inherit pkgs; };

  # The framework numbers nodes in name order. curl prefers IPv6.
  ip = {
    lb = "192.168.1.1";
    node = "192.168.1.2";
    viewer = "192.168.1.3";
  };
  ip6 = {
    lb = "2001:db8:1::1";
    node = "2001:db8:1::2";
    viewer = "2001:db8:1::3";
  };
  host = "farm.test";
  base = "https://${host}:8443";

  certs = testLib.certs {
    name = "dashboard-lb-certs";
    lbHost = host;
    issues = ''issue node worker-node "DNS:node,IP:${ip.node}" ca'';
  };
in
pkgs.testers.runNixOSTest {
  name = "nix-grpc-dashboard-lb";
  globalTimeout = 900;

  defaults = {
    imports = [ (testLib.defaults { inherit certs ip ip6; }) ];
    networking.hosts = {
      ${ip.lb} = [ host ];
      ${ip6.lb} = [ host ];
    };
    environment.systemPackages = [ (import "${ngsTests}/lib/build-log.nix" { inherit pkgs; }) ];
  };

  nodes = {
    node = {
      imports = modules;
      virtualisation.memorySize = 1536;
      services.nix-grpc-daemon = {
        enable = true;
        package = daemon;
        listen = "[::]:50051";
        advertise = "${ip.node}:50051";
        idleTimeout = null;
        minFree = "0";
        tls = {
          certFile = "${certs}/node.pem";
          keyFile = "${certs}/node.key";
          clientCaFile = "${certs}/ca.pem";
        };
        trustedProxies = [ "lb-*" ];
        accessRules = [
          {
            cn = "dashboard-*";
            role = "watch";
          }
          {
            cn = "lb-*";
            role = "trusted";
          }
        ];
      };
      networking.firewall.allowedTCPPorts = [ 50051 ];
    };

    # lb also stands in for the auth proxy, the one trusted peer.
    lb =
      { lib, ... }:
      {
        imports = modules;
        services.nix-grpc-farm-lb = {
          enable = true;
          systems = [ pkgs.stdenv.hostPlatform.system ];
          scheduler = "${ip.node}:50051";
          healthCheckInterval = "1s";
          tls = testLib.lbTls certs;
          dashboard = {
            enable = true;
            package = testLib.site "v1";
            name = "Test farm";
            url = base;
            logSearchUrl = "https://logs.example/search";
            signOutUrl = "https://sso.example/logout";
            identity = {
              # Not lower case, as Envoy compares it.
              header = "X-Forwarded-User";
              trustedPeers = [
                "${ip.lb}/32"
                "${ip6.lb}/128"
              ];
            };
            anonymous.networks = [
              "${ip.viewer}/32"
              "${ip6.viewer}/128"
              # The same ranges again, spelled differently, and two
              # spellings of 192.168.1.4/30, which holds no node.
              "${ip.viewer}/32"
              "2001:DB8:1:0:0:0:0:3/128"
              "192.168.1.5/30"
              "192.168.1.6/30"
            ];
            # Two users' 8 streams each would pass 16.
            maxStreams = 10;
          };
        };
        networking.firewall.allowedTCPPorts = [ 8443 ];
        specialisation.v2.configuration.services.nix-grpc-farm-lb.dashboard.package = lib.mkForce (
          testLib.site "v2"
        );
      };

    viewer = { };
  };

  testScript = ''
    import datetime
    import json
    import re
    import shlex

    base = "${base}"
    origin = f"-H 'Origin: {base}'"
    grpc_web = "-H 'content-type: application/grpc-web+proto' -H 'x-grpc-web: 1'"
    settings = {"name": "Test farm", "logSearchUrl": "https://logs.example/search"}

    def user(value):
        """The identity header with `value`, as curl arguments."""
        return " -H " + shlex.quote(f"X-Forwarded-User: {value}" if value else "X-Forwarded-User;")

    alice = user("alice@example.com")

    def watch(machine, extra = origin, max_time = 2, path = "nix.remote.Events/Watch"):
        """A gRPC-web call with an empty request. Returns the status, headers and body size."""
        code = machine.succeed(
            "printf '\\0\\0\\0\\0\\0' | curl -s -o /tmp/call -D /tmp/call.h -w '%{http_code}' "
            f"--max-time {max_time} {grpc_web} {extra} --data-binary @- {base}/{path} || true"
        ).strip()
        headers = machine.succeed("tr -d '\\r' < /tmp/call.h").lower()
        return code, headers, int(machine.succeed("stat -c %s /tmp/call"))

    def streams(machine, extra = origin):
        """Asserts that Watch streams."""
        code, headers, size = watch(machine, extra)
        assert code == "200" and size > 0 and "grpc-status" not in headers, (code, headers, size)

    def hold(machine, unit, extra = origin):
        """A Watch stream that a transient unit keeps open, its body in /tmp/<unit>."""
        call = (
            f"printf '\\0\\0\\0\\0\\0' | ${pkgs.curl}/bin/curl -sN --max-time 300 -o /tmp/{unit} "
            f"{grpc_web} {extra} --data-binary @- {base}/nix.remote.Events/Watch"
        )
        machine.succeed(f"systemd-run --unit {unit} sh -c {shlex.quote(call)}")

    def build_log(machine, extra = ""):
        """GetBuildLog for a derivation no builder has, through the listener, as the page sends it."""
        text = machine.succeed(f"ngs-build-log {'0' * 32}-missing.drv --web --url {base} -H 'Origin: {base}' {extra}")
        return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)

    def opened(name):
        """Streams the scheduler opened for the caller `name`."""
        return int(node.succeed(f"journalctl -u nix-grpc-daemon -o cat | grep -c 'event=watch_stream_open cn={name} ' || true"))

    def opened_more(name, before):
        retry(lambda _: opened(name) > before)

    def head(machine, path, extra = ""):
        return machine.succeed(f"curl -sS -o /dev/null -D - {extra} {base}{path} | tr -d '\\r'").lower()

    def direct(name, path):
        """A gRPC call straight to the node, as the balancer forwards a viewer's."""
        return lb.succeed(
            "printf '\\0\\0\\0\\0\\0' | curl -s -o /dev/null -D - --max-time 5 --http2 "
            "--cert ${certs}/lb-client.pem --key ${certs}/lb-client.key --cacert ${certs}/ca.pem "
            "-H 'content-type: application/grpc' -H 'te: trailers' "
            f"-H 'x-forwarded-client-cert: Subject=\"CN={name}\"' --data-binary @- "
            f"https://${ip.node}:50051/{path} | tr -d '\\r' || true"
        ).lower()

    start_all()
    node.wait_for_unit("nix-grpc-daemon.service")
    node.wait_for_open_port(50051)
    lb.wait_for_unit("envoy.service")
    lb.wait_for_open_port(8443)
    anonymous = "dashboard-anon-${ip6.viewer}"

    with subtest("the scheduler's health check passes"):
        retry(lambda _: watch(viewer)[0] == "200", timeout = datetime.timedelta(minutes = 1))

    with subtest("from the trusted peer, the header names the user"):
        before = opened("dashboard-user-alice@example.com")
        streams(lb, origin + alice)
        opened_more("dashboard-user-alice@example.com", before)
        assert json.loads(lb.succeed(f"curl -sSf {alice} {base}/dashboard.json")) == settings | {
            "auth": "proxy",
            "signOutUrl": "https://sso.example/logout",
        }

    with subtest("from any other peer, the header changes nothing"):
        users = opened("dashboard-user-alice@example.com")
        before = opened(anonymous)
        streams(viewer, origin + alice)
        opened_more(anonymous, before)
        # Not even a value the trusted peer would get 403 for.
        before = opened(anonymous)
        streams(viewer, origin + user("a b"))
        opened_more(anonymous, before)
        assert opened("dashboard-user-alice@example.com") == users
        assert json.loads(viewer.succeed(f"curl -sSf {alice} {base}/dashboard.json")) == settings | {"auth": "anonymous"}
        # Over IPv4 the viewer has another address, and so another name.
        streams(viewer, origin + " --ipv4")
        opened_more("dashboard-anon-${ip.viewer}", 0)

    with subtest("a forwarded name a client sends never reaches the scheduler"):
        forged = " -H 'x-forwarded-client-cert: Subject=\"CN=lb-9\"' -H 'authorization: Bearer x'"
        before = opened("dashboard-user-alice@example.com")
        streams(lb, origin + alice + forged)
        opened_more("dashboard-user-alice@example.com", before)
        before = opened(anonymous)
        streams(viewer, origin + forged)
        streams(viewer, origin + " -H 'x-forwarded-client-cert: Subject=\"CN=dashboard-user-mallory\"'")
        opened_more(anonymous, before + 1)
        node.fail("journalctl -u nix-grpc-daemon -o cat | grep -E 'cn=(lb-9|dashboard-user-mallory)'")
        # Envoy would keep these from the trusted peer, and time the stream out.
        streams(lb, origin + alice + " -H 'x-envoy-upstream-rq-timeout-ms: 1'")

    with subtest("a header value outside the allowed characters gets 403"):
        for value in ["a b", "a,b", 'a"b', "a;b", "a=b", "a/b", "a" * 129, ""]:
            code, headers, _ = watch(lb, origin + user(value))
            assert code == "403" and "x-frame-options: deny" in headers, (value, code, headers)
            body = lb.succeed(f"curl -s {user(value)} {base}/dashboard.json -w ' %{{http_code}}'")
            # Unless Envoy drops an empty header, and the RBAC filter refuses.
            if value:
                # grpc_web turns the reply into a gRPC status.
                assert "grpc-message: invalid identity header" in headers, (value, headers)
                assert body == "Invalid identity header 403", (value, body)
            else:
                assert body.endswith(" 403"), body
        before = opened("dashboard-user-" + "a" * 128)
        streams(lb, origin + user("a" * 128))
        opened_more("dashboard-user-" + "a" * 128, before)

    with subtest("the trusted peer without the header gets 403, and other peers no connection"):
        code, headers, _ = watch(lb)
        assert code == "403" and "x-frame-options: deny" in headers, (code, headers)
        assert lb.succeed("cat /tmp/call") == "RBAC: access denied"
        for path in ["/", "/dashboard.json"]:
            h = head(lb, path)
            assert h.startswith("http/2 403"), (path, h)
        node.fail(f"curl -sS --max-time 5 {base}/dashboard.json")

    with subtest("files and dashboard.json"):
        assert json.loads(viewer.succeed(f"curl -sSf {base}/dashboard.json")) == settings | {"auth": "anonymous"}
        assert "stand-in v1" in viewer.succeed(f"curl -sSf {base}/")
        assert "stand-in v1" in lb.succeed(f"curl -sSf {alice} {base}/")
        h = head(viewer, "/")
        assert "content-type: text/html; charset=utf-8" in h and "cache-control: no-cache" in h, h
        h = viewer.succeed(f"curl -sSf -D - -o /tmp/a.js {base}/_app/immutable/a.js | tr -d '\\r'").lower()
        assert "content-type: text/javascript; charset=utf-8" in h, h
        assert "cache-control: public, max-age=31536000, immutable" in h, h
        viewer.succeed("test $(stat -c %s /tmp/a.js) = 10240")
        assert "content-encoding: br" in head(viewer, "/_app/immutable/a.js", "-H 'accept-encoding: br'")
        assert "content-type: image/svg+xml" in head(viewer, "/favicon.svg")
        for path in ["/foo/", "/foo.js", "/_app/immutable/b.js"]:
            h = head(viewer, path)
            assert h.startswith("http/2 404") and "x-frame-options: deny" in h, (path, h)

    with subtest("pages under a directory"):
        assert "logs page" in viewer.succeed(f"curl -sSf {base}/logs/?drv=x")
        h = head(viewer, "/logs?drv=x")
        assert h.startswith("http/2 302") and f"location: {base}/logs/?drv=x\n" in h, h

    with subtest("the CSRF filter wants an Origin, and the listener the host of url"):
        for machine, extra in [(viewer, ""), (lb, alice)]:
            code, headers, _ = watch(machine, extra)
            assert code == "403" and "x-frame-options: deny" in headers, (code, headers)
            assert machine.succeed("cat /tmp/call") == "Invalid origin"
            h = head(machine, "/", extra + " -H 'Host: elsewhere.test:8443'")
            assert h.startswith("http/2 404"), h

    with subtest("build logs go to the builder, other builder calls nowhere"):
        for machine, extra in [(viewer, ""), (lb, alice)]:
            answer = build_log(machine, extra)
            assert answer["http"] == "200" and answer["code"] == "5" and answer["node"] == "${ip.node}:50051", answer
            code, headers, _ = watch(machine, origin + extra, path = "nix.remote.NixRemote/FetchNars")
            assert code == "404", (code, headers)

    with subtest("the scheduler lets dashboard names call the Events RPCs and GetBuildLog only"):
        rpcs = []
        for proto in ["${../../proto/nix_remote.proto}", "${../../proto/events.proto}"]:
            service = None
            for line in open(proto):
                if m := re.match(r"service (\w+)", line):
                    service = m[1]
                elif m := re.match(r"\s*rpc (\w+)", line):
                    rpcs.append(f"nix.remote.{service}/{m[1]}")
        assert "nix.remote.Scheduler/WorkerSession" in rpcs and "nix.remote.Events/Watch" in rpcs, rpcs
        # Not alice, whose streams count below.
        for name in ["dashboard-user-dave@example.com", "dashboard-anon-192.0.2.1"]:
            # EDS goes by the direct certificate and ignores forwarded names.
            for rpc in rpcs:
                h = direct(name, rpc)
                if rpc.startswith("nix.remote.Events/") or rpc == "nix.remote.NixRemote/GetBuildLog":
                    assert "grpc-status: 7" not in h, (name, rpc, h)
                else:
                    assert "grpc-status: 7" in h, (name, rpc, h)
            assert "role 'watch' may not call" in direct(name, "nix.remote.NixRemote/FetchNars")

    with subtest("each user gets 8 streams, and all viewers share maxStreams"):
        for i in range(1, 9):
            hold(lb, f"alice{i}", origin + alice)
        lb.wait_until_succeeds(" && ".join(f"test -s /tmp/alice{i}" for i in range(1, 9)), timeout = datetime.timedelta(seconds = 30))
        code, headers, _ = watch(lb, origin + alice)
        assert code == "200" and "grpc-status: 8" in headers, (code, headers)
        # Another user has 8 of their own.
        hold(lb, "bob", origin + user("bob"))
        hold(viewer, "anon")
        lb.wait_until_succeeds("test -s /tmp/bob", timeout = datetime.timedelta(seconds = 30))
        viewer.wait_until_succeeds("test -s /tmp/anon", timeout = datetime.timedelta(seconds = 30))
        # 10 streams are open.
        for machine, extra in [(viewer, origin), (lb, origin + user("carol"))]:
            code, headers, _ = watch(machine, extra)
            assert code == "503" and "x-envoy-overloaded: true" in headers, (code, headers)

    with subtest("a new package reaches Envoy without a restart"):
        pid = lb.get_unit_property("envoy", "MainPID")
        lb.succeed("/run/booted-system/specialisation/v2/bin/switch-to-configuration test")
        viewer.wait_until_succeeds(f"curl -sSf {base}/ | grep -q 'stand-in v2'", timeout = datetime.timedelta(seconds = 30))
        assert lb.get_unit_property("envoy", "MainPID") == pid
        size = int(viewer.succeed("stat -c %s /tmp/anon"))
        viewer.require_unit_state("anon")
        # The streams go on, since Stats come once a second.
        viewer.wait_until_succeeds(f"test $(stat -c %s /tmp/anon) -gt {size}")
        lb.succeed("systemctl stop bob " + " ".join(f"alice{i}" for i in range(1, 9)))
        viewer.succeed("systemctl stop anon")

    with subtest("Envoy comes back after a crash"):
        assert lb.get_unit_property("envoy", "Restart") == "on-failure"
        pid = lb.get_unit_property("envoy", "MainPID")
        lb.succeed("systemctl kill --signal=KILL envoy")
        retry(lambda _: lb.get_unit_property("envoy", "MainPID") not in ("0", pid), timeout = datetime.timedelta(seconds = 30))
        lb.wait_for_unit("envoy.service")
        viewer.wait_until_succeeds(f"curl -sSf {base}/ | grep -q 'stand-in v2'", timeout = datetime.timedelta(seconds = 30))
  '';
}
