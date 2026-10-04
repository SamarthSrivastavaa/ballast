#!/usr/bin/env bash
# Add one discovered mainnet account to the fixture manifest and pin it (D-001: found by execution,
# recorded with the transaction that needed it). Restart `pnpm localnet` afterwards.
#
#   bash tests/integration/p0/clone.sh <name> <address> "<why>" "<discoveredBy>"
set -euo pipefail
cd "$(dirname "$0")/../../.."
python3 - "$@" <<'EOF'
import json, pathlib, sys
name, address, why, by = sys.argv[1:5]
p = pathlib.Path("scripts/fixtures/manifest.json")
m = json.loads(p.read_text())
if any(a["address"] == address for a in m["accounts"]):
    print(f"already in manifest: {address}")
else:
    m["accounts"].append({"name": name, "address": address, "why": why,
                          "discoveredBy": by + " — evidence/p0/accounts/discovery.jsonl"})
    p.write_text(json.dumps(m, indent=2) + "\n")
    print(f"added {name} {address}")
EOF
pnpm -s fixtures:dump 2>&1 | grep -v bigint | tail -2
