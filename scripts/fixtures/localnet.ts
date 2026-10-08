/**
 * `pnpm localnet` — the mainnet-binary local validator (D-001).
 *
 * Boots solana-test-validator with every pinned mainnet program at its real program ID (as an
 * upgradeable program carrying its mainnet upgrade authority) and every pinned mainnet account.
 *
 * Refuses to start unless `fixtures:check` passes — ONLINE by default, so a mainnet upgrade since
 * the dump, or an edited pin, is caught before boot. `LOCALNET_OFFLINE=1` skips the mainnet half
 * (local integrity only) with a warning, for working without network.
 *
 * Only flags that cannot change what is loaded may be passed through (`--quiet`, `--log`,
 * `--rpc-port N`); anything that could add or override a program or account (`--bpf-program`,
 * `--clone*`, `--url`, `--account*`, `--ledger`, …) is rejected, so the validator can only ever
 * run the exact bytes recorded in evidence/fixtures/mainnet-pins.json.
 */
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { REPO, loadManifest, loadPins } from "./lib";

const PASSTHROUGH_FLAGS = new Set(["--quiet", "-q", "--log"]);
const PASSTHROUGH_WITH_VALUE = new Set(["--rpc-port"]);

const extra: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (PASSTHROUGH_FLAGS.has(argv[i])) {
    extra.push(argv[i]);
  } else if (PASSTHROUGH_WITH_VALUE.has(argv[i]) && /^\d+$/.test(argv[i + 1] ?? "")) {
    extra.push(argv[i], argv[i + 1]);
    i++;
  } else {
    console.error(
      `pnpm localnet: refusing "${argv[i]}" — only ${[...PASSTHROUGH_FLAGS, ...PASSTHROUGH_WITH_VALUE].join(", ")} ` +
        `may be passed; anything else could load bytes other than the pinned fixtures (D-001).`,
    );
    process.exit(2);
  }
}

const offline = process.env.LOCALNET_OFFLINE === "1";
if (offline) {
  console.warn("LOCALNET_OFFLINE=1: checking local fixture integrity only — mainnet drift NOT checked (D-001).");
}
execFileSync(
  "pnpm",
  ["-s", "exec", "tsx", resolve(__dirname, "check.ts"), ...(offline ? ["--offline"] : [])],
  { cwd: REPO, stdio: "inherit" },
);

const manifest = loadManifest();
const pins = loadPins();
// Transaction history: the default (10,000 shreds) keeps only ~200 slots, after which
// getSignaturesForAddress forgets a launch and `ballast verify` can no longer rebuild its history or
// check that the prediction preceded any third-party trade. Retention cannot change what is loaded.
const args = ["--reset", "--ledger", resolve(REPO, ".localnet/ledger"), "--limit-ledger-size", "50000000"];
for (const p of manifest.programs) {
  const pin = pins.programs[p.name];
  args.push("--upgradeable-program", pin.id, resolve(REPO, pin.soFile), pin.upgradeAuthority);
}
for (const a of manifest.accounts) {
  const pin = pins.accounts[a.name];
  args.push("--account", pin.address, resolve(REPO, pin.jsonFile));
}
args.push(...extra);

console.log(`solana-test-validator ${args.join(" ")}`);
const child = spawn("solana-test-validator", args, { cwd: REPO, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
