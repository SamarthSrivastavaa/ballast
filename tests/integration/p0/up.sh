#!/usr/bin/env bash
# Bring the P0 harness environment up on a running `pnpm localnet` (mainnet-binary validator, D-001):
# wait for health, fund the localnet payer, deploy p0_harness at its program id.
#
#   source ~/.ballast-env && pnpm localnet --quiet &     # in another shell / background
#   bash tests/integration/p0/up.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."
KEY=.keys/devnet/localnet.json
for _ in $(seq 1 120); do
  curl -s -m 2 -X POST http://127.0.0.1:8899 -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"' && break
  sleep 1
done
solana -u l -k "$KEY" airdrop 500 >/dev/null
solana program deploy -u l -k "$KEY" \
  --program-id tests/integration/p0/target/deploy/p0_harness-keypair.json \
  tests/integration/p0/target/deploy/p0_harness.so | tail -1
echo "payer balance: $(solana -u l -k "$KEY" balance)"
