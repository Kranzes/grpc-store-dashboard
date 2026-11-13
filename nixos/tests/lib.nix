# What both VM tests share.
{ pkgs }:
{
  # The farm's CA and a "public" one that clients know from the system trust
  # store. `issues` runs `issue <file> <CN> <subjectAltName> <CA>`.
  certs =
    {
      name,
      lbHost,
      issues,
    }:
    pkgs.runCommand name { nativeBuildInputs = [ pkgs.openssl ]; } ''
      mkdir $out && cd $out
      openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout ca.key -out ca.pem -subj /CN=farm-ca
      openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout public-ca.key -out public-ca.pem -subj /CN=public-ca
      issue() {
        openssl req -newkey rsa:2048 -nodes -keyout $1.key -out $1.csr -subj /CN=$2
        openssl x509 -req -in $1.csr -days 3650 -CA $4.pem -CAkey $4.key -set_serial 0x$(openssl rand -hex 8) \
          -extfile <(printf "subjectAltName=$3\nextendedKeyUsage=serverAuth,clientAuth") -out $1.pem
      }
      issue lb lb "DNS:${lbHost}" public-ca
      issue lb-client lb-1 "DNS:lb" ca
      ${issues}
    '';

  lbTls = certs: {
    certFile = "${certs}/lb.pem";
    keyFile = "${certs}/lb.key";
    clientCaFile = "${certs}/ca.pem";
    upstream = {
      certFile = "${certs}/lb-client.pem";
      keyFile = "${certs}/lb-client.key";
      caFile = "${certs}/ca.pem";
    };
  };

  # The certificates and anonymous networks name these addresses, so fail
  # early if the framework hands out others.
  defaults =
    {
      certs,
      ip,
      ip6,
    }:
    { config, ... }:
    let
      node = config.virtualisation.test.nodeName;
    in
    {
      security.pki.certificateFiles = [ "${certs}/public-ca.pem" ];
      environment.systemPackages = [ pkgs.curl ];
      assertions = [
        {
          assertion = config.networking.primaryIPAddress == ip.${node};
          message = "${node} has ${config.networking.primaryIPAddress}, the test expects ${ip.${node}}";
        }
        {
          assertion = config.networking.primaryIPv6Address == ip6.${node};
          message = "${node} has ${config.networking.primaryIPv6Address}, the test expects ${ip6.${node}}";
        }
      ];
    };

  site =
    version:
    pkgs.runCommand "dashboard-standin-${version}" { } ''
      mkdir -p $out/_app/immutable $out/logs
      echo '<!doctype html><title>Test farm</title>stand-in ${version}' > $out/index.html
      echo '<!doctype html><title>Logs</title>logs page' > $out/logs/index.html
      head -c 10240 /dev/zero | tr '\0' a > $out/_app/immutable/a.js
      echo '<svg xmlns="http://www.w3.org/2000/svg"/>' > $out/favicon.svg
    '';
}
