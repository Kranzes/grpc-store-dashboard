# The dashboard listener on a farm like nix-grpc-store's tests/farm.nix:
# build logs from the builder that x-nix-worker names, also while it drains,
# on Envoy 1.37 with the page from a server of its own.
{
  pkgs,
  modules,
  daemon,
  ngsTests,
  niks3,
  envoy-1_37,
  ...
}:

let
  inherit (pkgs) lib;
  system = pkgs.stdenv.hostPlatform.system;
  testLib = import ./lib.nix { inherit pkgs; };
  apiToken = "farm-token-that-is-at-least-36-characters-long";
  tokenFile = pkgs.writeText "niks3-token" apiToken;
  signingPublicKey = "farm-test-1:RkClDwvfixdOwourBI4UD9hudE3xfU5EBQcMFUVuRV8=";
  niks3Url = "http://lb:5751";
  buildLog = import "${ngsTests}/lib/build-log.nix" { inherit pkgs; };

  # The framework numbers nodes in name order.
  ip = {
    client = "192.168.1.1";
    lb = "192.168.1.2";
    worker1 = "192.168.1.3";
    worker2 = "192.168.1.4";
  };
  ip6 = {
    client = "2001:db8:1::1";
    lb = "2001:db8:1::2";
    worker1 = "2001:db8:1::3";
    worker2 = "2001:db8:1::4";
  };

  certs = testLib.certs {
    name = "dashboard-farm-certs";
    lbHost = "lb";
    issues = ''
      issue worker1 worker-1 "DNS:worker1,DNS:lb,IP:${ip.worker1}" ca
      issue worker2 worker-2 "DNS:worker2,DNS:lb,IP:${ip.worker2}" ca
      issue ci ci-1 "DNS:client" ca
    '';
  };

  # The nodes that load the plugin, which is built against their Nix.
  pluginUser = {
    nix.settings.experimental-features = [ "nix-command" ];
    programs.nix-grpc-store = {
      enable = true;
      # Not the module's default, which builds a plugin for every Nix release.
      package = daemon;
    };
  };

  worker = name: {
    imports = [ pluginUser ];
    services.nix-grpc-daemon = {
      enable = true;
      package = daemon;
      listen = "[::]:50051";
      advertise = "${ip.${name}}:50051";
      # Through the balancer, so builders follow the active scheduler.
      scheduler = "lb:50051";
      logLevel = "debug";
      idleTimeout = null;
      metricsListen = "127.0.0.1:9464";
      tls = {
        certFile = "${certs}/${name}.pem";
        keyFile = "${certs}/${name}.key";
        clientCaFile = "${certs}/ca.pem";
      };
      trustedProxies = [ "lb-*" ];
      accessRules = [
        {
          cn = "dashboard-*";
          role = "watch";
        }
        {
          cn = "ci-*";
          role = "trusted";
        }
        {
          # Envoy reads the builder list with its own certificate.
          cn = "lb-*";
          role = "trusted";
        }
        {
          # Each node's WorkerSession.
          cn = "worker-*";
          role = "trusted";
        }
      ];
      minFree = "200M";
      niks3 = {
        package = niks3.packages.${system}.niks3;
        url = niks3Url;
        tokenFile = toString tokenFile;
        cacheUrl = niks3Url;
        publicKeys = [ signingPublicKey ];
      };
    };
    networking.firewall.allowedTCPPorts = [ 50051 ];
  };

  # A build pinned to worker1 that prints `lines` lines, one a second.
  logExpr = pkgs.writeText "log.nix" ''
    { tag, lines ? 0 }:
    derivation {
      name = "logged-''${tag}";
      system = builtins.currentSystem;
      requiredSystemFeatures = [ "vip" ];
      builder = "/bin/sh";
      args = [ "-c" "i=0; while [ $i -lt ''${toString lines} ]; do echo line-$i-''${tag} >&2; read -t 1 x < /dev/zero; i=$((i+1)); done; echo done-''${tag} >&2; echo ''${tag} > $out" ];
    }
  '';
in
pkgs.testers.runNixOSTest {
  name = "nix-grpc-dashboard-farm";
  globalTimeout = 900;

  defaults = {
    imports = modules ++ [ (testLib.defaults { inherit certs ip ip6; }) ];
    virtualisation.memorySize = 1536;
  };

  nodes = {
    worker1 = {
      imports = [ (worker "worker1") ];
      nix.settings.system-features = [ "vip" ];
    };
    worker2 = worker "worker2";

    lb = {
      imports = [
        (import "${ngsTests}/lib/niks3-node.nix" {
          inherit pkgs niks3 apiToken;
          listenHost = "lb";
        })
      ];
      services.nix-grpc-farm-lb = {
        enable = true;
        systems = [ system ];
        scheduler = [
          "${ip.worker1}:50051"
          "${ip.worker2}:50051"
        ];
        healthCheckInterval = "1s";
        dashboard = {
          enable = true;
          files.upstream = "http://[::1]:8080";
          anonymous.networks = [
            "${ip.client}/32"
            "${ip6.client}/128"
          ];
        };
        tls = testLib.lbTls certs;
      };
      services.envoy.package = envoy-1_37;
      services.static-web-server = {
        enable = true;
        listen = "[::1]:8080";
        root = toString (testLib.site "v1");
        # So the br below is Envoy's.
        configuration.general.compression = false;
      };
      networking.firewall.allowedTCPPorts = [
        8443
        50051
      ];
    };

    client = {
      imports = [ pluginUser ];
      nix.settings.substituters = lib.mkForce [ ];
    };
  };

  testScript = ''
    import datetime

    start_all()
    lb.wait_for_unit("niks3.service")
    lb.wait_for_open_port(5751)
    lb.wait_for_unit("envoy.service")
    lb.wait_for_open_port(50051)
    lb.wait_for_open_port(8443)
    for w in [worker1, worker2]:
        w.systemctl("start nix-grpc-daemon.service")
    for w in ["${ip.worker1}", "${ip.worker2}"]:
        lb.wait_until_succeeds(f"curl -sSf localhost:9901/clusters | grep -qF '${system}::{w}:50051::'", timeout = datetime.timedelta(minutes = 2))

    dash = "https://lb:8443"

    with subtest("the page through Envoy 1.37 from its files server"):
        assert "version: " in lb.succeed("envoy --version | grep -F /1.37.")
        assert "stand-in v1" in client.succeed(f"curl -sSf {dash}/")
        assert "logs page" in client.succeed(f"curl -sSf {dash}/logs/")
        h = client.succeed(f"curl -sS -o /dev/null -D - {dash}/logs | tr -d '\\r'").lower()
        assert h.startswith("http/2 302") and f"location: {dash}/logs/\n" in h, h
        h = client.succeed(f"curl -sSf -o /dev/null -D - -H 'accept-encoding: br' {dash}/_app/immutable/a.js | tr -d '\\r'").lower()
        assert "cache-control: public, max-age=31536000, immutable" in h and "content-encoding: br" in h, h
        assert "x-frame-options: deny" in h, h
        h = client.succeed(f"curl -sS -o /dev/null -D - {dash}/missing.js | tr -d '\\r'").lower()
        assert h.startswith("http/2 404"), h

    with subtest("build logs through the dashboard, also from a draining builder"):
        store = "grpc://lb:50051?client-cert=${certs}/ci.pem&client-key=${certs}/ci.key"
        w1 = "${ip.worker1}:50051"
        w2 = "${ip.worker2}:50051"

        def drv(tag, lines):
            return client.succeed(
                f"nix-instantiate ${logExpr} --argstr tag {tag} --arg lines {lines}"
            ).strip().rsplit("/", 1)[1]

        def build_log(base, worker):
            """ngs-build-log for `base` as gRPC-web through the dashboard listener, as the page sends it."""
            return (
                f"${buildLog}/bin/ngs-build-log {base} --web --url {dash} -H 'Origin: {dash}' "
                f"-H 'x-nix-worker: {worker}' -H 'x-nix-system: ${system}'"
            )

        def log_call(base, worker, out = "/dev/null"):
            text = client.succeed(f"{build_log(base, worker)} --out {out}")
            return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)

        def follow_in_background(unit, base, worker, assign):
            client.succeed(
                f"systemd-run --unit {unit} -p StandardOutput=file:/tmp/{unit}.out "
                f"{build_log(base, worker)} --follow --assign-id {assign} --out /tmp/{unit}.log"
            )

        def lines(unit):
            return int(client.succeed(f"grep -c ^line- /tmp/{unit}.log || true").strip())

        a = drv("dash-a", 0)
        b = drv("dash-b", 30)
        client.succeed(f"nix build --eval-store auto --store '{store}' -f ${logExpr} --argstr tag dash-a --arg lines 0 --no-link")
        client.succeed(
            f"systemd-run --unit build-b -E HOME=/root $(command -v nix) build --eval-store auto --store '{store}' -f ${logExpr} --argstr tag dash-b --arg lines 30 --no-link"
        )
        # The page asks the builder of the assignment the scheduler named.
        live = {}
        def running(_):
            live.update(log_call(b, w1))
            return live.get("code") == "0" and live.get("source") == "live"
        retry(running, timeout = datetime.timedelta(minutes = 2))
        assert live["node"] == w1, live
        follow_in_background("follow-1", b, w1, live["assign_id"])
        client.wait_until_succeeds("test $(grep -c ^line- /tmp/follow-1.log) -ge 3", timeout = datetime.timedelta(minutes = 1))

        # SIGTERM drains worker1 with B still running. The active scheduler,
        # on either node, logs the drain, and EDS marks worker1 DRAINING with it.
        worker1.succeed("systemctl kill -s TERM --kill-whom=main nix-grpc-daemon.service")
        def drained(_):
            return any(
                w.execute(f"journalctl -u nix-grpc-daemon -o cat | grep worker_load | grep 'addr={w1}' | grep -q 'draining=1'")[0] == 0
                for w in [worker1, worker2]
            )
        retry(drained, timeout = datetime.timedelta(minutes = 1))
        # The farm's worker cluster still finds worker1 for calls that name it.
        before = lines("follow-1")
        follow_in_background("follow-2", b, w1, live["assign_id"])
        client.wait_until_succeeds("test $(grep -c ^line- /tmp/follow-2.log) -ge 1", timeout = datetime.timedelta(minutes = 1))
        client.wait_until_succeeds(f"test $(grep -c ^line- /tmp/follow-1.log) -gt {before}", timeout = datetime.timedelta(seconds = 30))
        kept = log_call(a, w1, out = "/tmp/a.log")
        assert kept["code"] == "0" and kept["source"] == "kept" and kept["node"] == w1, kept
        client.succeed("grep -q done-dash-a /tmp/a.log")

        # Both end with `ended` when B finishes. The daemon then exits, and
        # systemd starts it again.
        for unit in ["follow-1", "follow-2"]:
            client.wait_until_succeeds(f"grep -q '^ended=1$' /tmp/{unit}.out", timeout = datetime.timedelta(minutes = 2))
            out = client.succeed(f"cat /tmp/{unit}.out")
            assert "code=0" in out and f"node={w1}" in out, out
        assert lines("follow-1") == 30, client.succeed("cat /tmp/follow-1.log")
        retry(lambda _: client.get_unit_property("build-b", "ActiveState") != "active", timeout = datetime.timedelta(minutes = 1))

        # Back in EDS, worker1 answers from the file Nix kept.
        finished = {}
        def kept_again(_):
            finished.update(log_call(b, w1, out = "/tmp/b.log"))
            return finished.get("code") == "0" and finished.get("source") == "kept" and finished.get("node") == w1
        retry(kept_again, timeout = datetime.timedelta(minutes = 3))
        want = worker1.succeed(f"nix log /nix/store/{b} | sha256sum").split()[0]
        got = client.succeed("sha256sum < /tmp/b.log").split()[0]
        assert want == got, (want, got)

        # Another builder kept no log of it. It says who answered, and has
        # nothing, or the farm cache's copy where it reads the cache.
        other = log_call(b, w2)
        assert other["node"] == w2 and (other["code"] == "5" or other["source"] == "cache"), other

        # Viewers share their access rule's series, whatever their address.
        rpcs = worker2.succeed(
            "curl -sS 127.0.0.1:9464/metrics | grep '^nix_grpc_rpcs_total{.*cn=\"dashboard-' || true"
        )
        assert rpcs.count("\n") == 1 and 'cn="dashboard-*",method="GetBuildLog"' in rpcs, rpcs
  '';
}
