#!/bin/sh
# Installs the `ballast` verifier: a prebuilt binary from the latest GitHub Release into ./ballast.
#   curl -fsSL https://raw.githubusercontent.com/SamarthSrivastavaa/ballast/main/install.sh | sh
# No prebuilt binary for your machine? Build it instead:
#   cargo install --git https://github.com/SamarthSrivastavaa/ballast ballast-verifier --locked
set -eu
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=ballast-linux-x64 ;;
  Darwin-arm64) asset=ballast-macos-arm64 ;;
  *) echo "no prebuilt binary for $(uname -s) $(uname -m); use: cargo install --git https://github.com/SamarthSrivastavaa/ballast ballast-verifier --locked" >&2; exit 1 ;;
esac
url="https://github.com/SamarthSrivastavaa/ballast/releases/latest/download/$asset"
echo "downloading $url"
curl -fsSL "$url" -o ballast
chmod +x ballast
echo
echo "installed ./ballast — try it on any Meteora DAMM v2 pool on mainnet:"
echo "  ./ballast check <pool address> --cluster mainnet"
echo "or on a Ballast launch:"
echo "  ./ballast verify <mint> --cluster <mainnet|devnet|local>"
