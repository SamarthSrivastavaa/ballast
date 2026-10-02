#!/usr/bin/env bash
# Negative tests for the D-001 / D-007 guards in scripts/fixtures (STEP 2 audit hardening).
# Every test must FAIL CLOSED (non-zero exit, nothing written). Files tampered with are backed up
# first and restored on exit, whatever happens.
#
# Usage: source ~/.ballast-env && bash scripts/fixtures/negative-tests.sh
#   Needs network (mainnet + devnet read-only RPC). Tests g/g2/h need `pnpm localnet` running on
#   127.0.0.1:8899; they are skipped (and reported as skipped) if it is not.
set -uo pipefail
cd "$(dirname "$0")/../.."

P=evidence/fixtures/mainnet-pins.json
M=scripts/fixtures/manifest.json
TMP=$(mktemp -d)
cp "$P" "$TMP/pins" && cp "$M" "$TMP/manifest"
FAKE_PID=""
restore() {
  cp "$TMP/pins" "$P"; cp "$TMP/manifest" "$M"
  rm -f fixtures/accounts/negtest_wsol_mint.json
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap restore EXIT

edit() { python3 -c "import json,sys; f=sys.argv[1]; d=json.load(open(f)); exec(sys.argv[2]); json.dump(d,open(f,'w'),indent=2)" "$@"; }
quiet() { grep -v 'bigint: Failed' || true; }
FAILS=0
expect_fail() { # $1 = label, $2 = exit code
  if [ "$2" -ne 0 ]; then echo "  -> refused (exit $2): OK"; else echo "  -> NOT REFUSED: FAIL"; FAILS=$((FAILS+1)); fi
}
section() { echo; echo "## $1"; }
localnet_up() { curl -s -m 2 -X POST http://127.0.0.1:8899 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; }

echo "# Negative tests — scripts/fixtures guards ($(date -u +%FT%TZ))"

section "a. fixtures:dump refuses mainnet drift and writes nothing"
edit "$P" "d['programs']['dlmm']['lastDeploySlot']=1"
cp "$P" "$TMP/tampered"; so_before=$(sha256sum < fixtures/programs/dlmm.so)
pnpm -s fixtures:dump 2>&1 | quiet | grep -E 'DRIFT|dlmm:'; rc=${PIPESTATUS[0]}
expect_fail a "$rc"
cmp -s "$P" "$TMP/tampered" && echo "  pins file untouched: yes"
[ "$(sha256sum < fixtures/programs/dlmm.so)" = "$so_before" ] && echo "  dlmm.so untouched: yes"
cp "$TMP/pins" "$P"

section "b. fixtures:dump refuses a non-mainnet RPC (devnet genesis)"
MAINNET_RPC_URL=https://api.devnet.solana.com pnpm -s fixtures:dump 2>&1 | quiet | grep -oE 'genesis [^;]*; refusing'
expect_fail b "${PIPESTATUS[0]}"

section "c. fixtures:check rejects a manifest ID that differs from the SDK constant"
edit "$M" "d['programs'][2]['id']='LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ'"
pnpm -s fixtures:check --offline 2>&1 | quiet | grep -E 'SDK constant'
expect_fail c "${PIPESTATUS[0]}"
cp "$TMP/manifest" "$M"

section "d. account path: dump pins an account; check catches a tampered owner"
edit "$M" "d['accounts'].append({'name':'negtest_wsol_mint','address':'So11111111111111111111111111111111111111112','why':'negative test only','discoveredBy':'negative-tests.sh'})"
pnpm -s fixtures:dump 2>&1 | quiet | grep -E 'negtest|pins'
pnpm -s fixtures:check --offline 2>&1 | quiet | grep -E 'negtest|PASSED'
edit fixtures/accounts/negtest_wsol_mint.json "d['account']['owner']='11111111111111111111111111111111'"
pnpm -s fixtures:check --offline 2>&1 | quiet | grep -E 'negtest'
expect_fail d "${PIPESTATUS[0]}"
cp "$TMP/manifest" "$M"; cp "$TMP/pins" "$P"; rm -f fixtures/accounts/negtest_wsol_mint.json

section "e. pnpm localnet refuses flags that could load other bytes (before any check or boot)"
for f in "--bpf-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo /tmp/x.so" "--clone LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" "--rpc-port=8899"; do
  # shellcheck disable=SC2086
  pnpm -s localnet $f 2>&1 | head -1; expect_fail e "${PIPESTATUS[0]}"
done

section "f. fixtures:exec refuses a non-loopback RPC (it signs and sends)"
LOCALNET_RPC_URL=https://api.devnet.solana.com pnpm -s fixtures:exec 2>&1 | quiet | grep -oE 'refusing non-loopback RPC [^ ]+'
expect_fail f "${PIPESTATUS[0]}"

# A fake loopback RPC: answers getGenesisHash with mainnet's genesis, or with no result at all.
cat > "$TMP/fake.js" <<'JS'
const mode = process.argv[2];
require("http").createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const id = (JSON.parse(b || "{}").id) ?? 1;
    const body = mode === "mainnet"
      ? { jsonrpc: "2.0", id, result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }
      : { message: "method not allowed" };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
}).listen(18999, "127.0.0.1");
JS
section "f2. fixtures:exec refuses a loopback RPC whose genesis is mainnet's (e.g. a forwarding proxy)"
node "$TMP/fake.js" mainnet & FAKE_PID=$!; sleep 0.5
LOCALNET_RPC_URL=http://127.0.0.1:18999 pnpm -s fixtures:exec 2>&1 | quiet | grep -oE 'refusing: RPC genesis is mainnet-beta'
expect_fail f2 "${PIPESTATUS[0]}"; kill $FAKE_PID; wait $FAKE_PID 2>/dev/null; FAKE_PID=""

section "f3. fixtures:exec refuses a loopback RPC that returns no result (fail closed, not 'not mainnet')"
node "$TMP/fake.js" noresult & FAKE_PID=$!; sleep 0.5
LOCALNET_RPC_URL=http://127.0.0.1:18999 pnpm -s fixtures:exec 2>&1 | quiet | grep -oE 'getGenesisHash: reply has no result'
expect_fail f3 "${PIPESTATUS[0]}"; kill $FAKE_PID; wait $FAKE_PID 2>/dev/null; FAKE_PID=""

if localnet_up; then
  section "g. fixtures:exec refuses when the served bytes differ from a pin (jup_locker sha256 edited)"
  edit "$P" "d['programs']['jup_locker']['sha256']='00'*32"
  pnpm -s fixtures:exec 2>&1 | quiet | grep -E '^loaded|does not serve|served|pinned'
  expect_fail g "${PIPESTATUS[0]}"; cp "$TMP/pins" "$P"

  section "g2. fixtures:exec refuses when the served authority differs from a pin (dbc authority edited)"
  edit "$P" "d['programs']['dbc']['upgradeAuthority']='CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ'"
  pnpm -s fixtures:exec 2>&1 | quiet | grep -E 'does not serve|served|pinned'
  expect_fail g2 "${PIPESTATUS[0]}"; cp "$TMP/pins" "$P"

  section "h. fixtures:exec refuses when the pinned ID differs from the manifest ID (dlmm pin id → DBC id)"
  edit "$P" "d['programs']['dlmm']['id']='dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'"
  pnpm -s fixtures:exec 2>&1 | quiet | grep -E 'pinned id'
  expect_fail h "${PIPESTATUS[0]}"; cp "$TMP/pins" "$P"
else
  section "g, g2, h. SKIPPED — pnpm localnet is not running on 127.0.0.1:8899"
fi

echo; echo "negative tests: $FAILS not refused"
exit "$FAILS"
