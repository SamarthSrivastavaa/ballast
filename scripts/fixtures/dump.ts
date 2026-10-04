/**
 * `pnpm fixtures:dump` — D-001, §17.
 *
 * Dumps every program and account in scripts/fixtures/manifest.json from mainnet into fixtures/
 * (gitignored) and records them in evidence/fixtures/mainnet-pins.json (committed): sha256, the
 * slot each program was last deployed in, its upgrade authority, and the slot the read happened at.
 *
 * Drift-safe: if a pin already exists and mainnet no longer matches it, NOTHING is written and the
 * command fails. D-001 says a hash change means re-running the affected gates, so the change must
 * be accepted deliberately with `--accept-drift`. With no drift, existing pins are kept as they
 * are (a fresh clone re-dumps without touching the committed file); only new manifest entries are
 * added.
 *
 * Read-only against mainnet only (genesis hash asserted): no signer, no transaction, nothing spent (D-007).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  FIXTURES_DIR,
  MAINNET_GENESIS,
  PINS_PATH,
  REPO,
  RPC_URL,
  type AccountPin,
  type Pins,
  type ProgramPin,
  accountJson,
  assertMainnet,
  fetchProgram,
  getAccount,
  hostOf,
  loadManifest,
  sha256,
} from "./lib";

const acceptDrift = process.argv.includes("--accept-drift");
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

async function main(): Promise<void> {
  await assertMainnet(RPC_URL);
  const manifest = loadManifest();
  const old: Pins | null = existsSync(PINS_PATH) ? (JSON.parse(readFileSync(PINS_PATH, "utf8")) as Pins) : null;

  const files: { path: string; bytes: Buffer | string }[] = [];
  const programs: Record<string, ProgramPin> = {};
  const accounts: Record<string, AccountPin> = {};
  const drift: string[] = [];
  let added = 0;

  for (const p of manifest.programs) {
    const { pin, elf } = await fetchProgram(p.id);
    const soPath = resolve(FIXTURES_DIR, "programs", `${p.name}.so`);
    files.push({ path: soPath, bytes: elf });
    const fresh: ProgramPin = { label: p.label, soFile: relative(REPO, soPath), ...pin };
    const prev = old?.programs[p.name];
    if (!prev) {
      programs[p.name] = fresh;
      added++;
    } else {
      const diffs = (["id", "sha256", "lastDeploySlot", "upgradeAuthority"] as const).filter((k) => prev[k] !== fresh[k]);
      for (const k of diffs) drift.push(`${p.name}: ${k} pinned=${prev[k]} mainnet=${fresh[k]}`);
      programs[p.name] = diffs.length ? fresh : prev;
    }
    console.log(
      `${p.name.padEnd(15)} ${p.id}  deployed@${pin.lastDeploySlot}  ${pin.soBytes} B  sha256 ${pin.sha256.slice(0, 16)}…`,
    );
  }

  for (const a of manifest.accounts) {
    const acct = await getAccount(a.address);
    if (!acct) throw new Error(`${a.name} ${a.address}: account not found on mainnet`);
    const jsonPath = resolve(FIXTURES_DIR, "accounts", `${a.name}.json`);
    files.push({ path: jsonPath, bytes: accountJson(a.address, acct) });
    const fresh: AccountPin = {
      address: a.address,
      owner: acct.owner,
      lamports: acct.lamports,
      executable: acct.executable,
      dataBytes: acct.data.length,
      dataSha256: sha256(acct.data),
      readAtSlot: acct.slot,
      jsonFile: relative(REPO, jsonPath),
    };
    const prev = old?.accounts[a.name];
    if (!prev) {
      accounts[a.name] = fresh;
      added++;
    } else {
      // A system-owned account with no data (e.g. an Anchor __event_authority PDA holding dust)
      // can only change by lamports, which no program reads; only its owner/data/existence can drift.
      const lamportsOnly = fresh.owner === SYSTEM_PROGRAM && fresh.dataBytes === 0;
      const diffs = (["address", "owner", "lamports", "executable", "dataSha256"] as const).filter(
        (k) => prev[k] !== fresh[k] && !(k === "lamports" && lamportsOnly),
      );
      for (const k of diffs) drift.push(`${a.name}: ${k} pinned=${prev[k]} mainnet=${fresh[k]}`);
      accounts[a.name] = diffs.length ? fresh : prev;
    }
    console.log(`${a.name.padEnd(15)} ${a.address}  ${acct.data.length} B  owner ${acct.owner}`);
  }

  if (drift.length && !acceptDrift) {
    console.error("\nMAINNET DRIFT against evidence/fixtures/mainnet-pins.json — nothing written:");
    for (const d of drift) console.error(`  - ${d}`);
    console.error(
      "\nD-001: a hash change means re-running the affected gates. Re-run with --accept-drift to " +
        "re-pin deliberately, then re-run every gate that exercises the drifted programs.",
    );
    process.exit(1);
  }

  mkdirSync(resolve(FIXTURES_DIR, "programs"), { recursive: true });
  mkdirSync(resolve(FIXTURES_DIR, "accounts"), { recursive: true });
  for (const f of files) writeFileSync(f.path, f.bytes);

  const removed =
    old !== null &&
    (Object.keys(old.programs).some((k) => !(k in programs)) || Object.keys(old.accounts).some((k) => !(k in accounts)));
  if (old && !drift.length && !added && !removed && old.genesisHash === MAINNET_GENESIS) {
    console.log(`\nfixtures written; pins unchanged → ${relative(REPO, PINS_PATH)}`);
    return;
  }
  const pins: Pins = {
    schema: 1,
    cluster: "mainnet-beta",
    genesisHash: MAINNET_GENESIS,
    rpcHost: hostOf(RPC_URL),
    dumpedAt: new Date().toISOString(),
    programs,
    accounts,
  };
  mkdirSync(dirname(PINS_PATH), { recursive: true });
  writeFileSync(PINS_PATH, JSON.stringify(pins, null, 2) + "\n");
  if (drift.length) console.log(`\nDRIFT ACCEPTED (--accept-drift):\n  - ${drift.join("\n  - ")}`);
  console.log(`\npins → ${relative(REPO, PINS_PATH)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
