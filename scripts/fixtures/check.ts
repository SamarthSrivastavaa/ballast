/**
 * `pnpm fixtures:check` — D-001. Run at session start and before any mainnet action.
 *
 * 1. Local integrity: the pins came from mainnet-beta; every manifest program ID equals the ID
 *    Meteora's SDKs export; every manifest entry is pinned; every fixture file in fixtures/ matches
 *    its pin (program bytes by sha256; account pubkey, owner, lamports, executable and data).
 * 2. Mainnet drift (skipped with --offline): the RPC is mainnet-beta (genesis hash), and every
 *    program's live ELF, last-deployed slot and upgrade authority, and every account's data and
 *    owner, still equal the pin. **A drift means re-running the gates that exercise the drifted
 *    program (D-001).**
 *
 * Exit 0 only when everything matches; any mismatch or RPC failure exits non-zero. Read-only:
 * nothing is signed or spent (D-007).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAINNET_GENESIS,
  REPO,
  RPC_URL,
  assertMainnet,
  fetchProgram,
  getAccount,
  loadManifest,
  loadPins,
  sdkProgramIds,
  sha256,
} from "./lib";

const offline = process.argv.includes("--offline");

interface AccountFile {
  pubkey: string;
  account: { lamports: number; data: [string, string]; owner: string; executable: boolean };
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const pins = loadPins();
  const problems: string[] = [];
  const drifted: string[] = [];

  if (pins.genesisHash !== MAINNET_GENESIS) {
    problems.push(`pins genesisHash ${pins.genesisHash} is not mainnet-beta — re-dump from mainnet`);
  }
  const sdk = sdkProgramIds();
  if (!offline) await assertMainnet(RPC_URL);

  for (const p of manifest.programs) {
    const expected = sdk[p.name];
    if (!expected) {
      problems.push(`${p.name}: no SDK constant to cross-check its ID — extend sdkProgramIds()`);
    } else if (expected.some((id) => id !== p.id)) {
      problems.push(`${p.name}: manifest id ${p.id} ≠ SDK constant(s) ${expected.join(", ")}`);
    }
    const pin = pins.programs[p.name];
    if (!pin) {
      problems.push(`${p.name}: in manifest but not pinned — run pnpm fixtures:dump`);
      continue;
    }
    if (pin.id !== p.id) problems.push(`${p.name}: manifest id ${p.id} ≠ pinned id ${pin.id}`);
    const file = resolve(REPO, pin.soFile);
    if (!existsSync(file)) {
      problems.push(`${p.name}: ${pin.soFile} missing — run pnpm fixtures:dump`);
    } else if (sha256(readFileSync(file)) !== pin.sha256) {
      problems.push(`${p.name}: local ${pin.soFile} does not hash to its pin`);
    } else {
      console.log(`local   ok  ${p.name.padEnd(15)} sha256 ${pin.sha256.slice(0, 16)}…  id = SDK constant`);
    }

    if (offline) continue;
    const live = (await fetchProgram(p.id)).pin;
    const diffs = (["lastDeploySlot", "upgradeAuthority", "soBytes", "sha256"] as const).filter(
      (k) => live[k] !== pin[k],
    );
    if (diffs.length) {
      drifted.push(p.name);
      for (const k of diffs) problems.push(`${p.name}: MAINNET DRIFT ${k} pinned=${pin[k]} live=${live[k]}`);
    } else {
      console.log(`mainnet ok  ${p.name.padEnd(15)} deployed@${live.lastDeploySlot} (read @${live.readAtSlot})`);
    }
  }

  for (const a of manifest.accounts) {
    const pin = pins.accounts[a.name];
    if (!pin) {
      problems.push(`${a.name}: in manifest but not pinned — run pnpm fixtures:dump`);
      continue;
    }
    if (pin.address !== a.address) problems.push(`${a.name}: manifest address ${a.address} ≠ pinned ${pin.address}`);
    const file = resolve(REPO, pin.jsonFile);
    if (!existsSync(file)) {
      problems.push(`${a.name}: ${pin.jsonFile} missing — run pnpm fixtures:dump`);
    } else {
      const j = JSON.parse(readFileSync(file, "utf8")) as AccountFile;
      const bad: string[] = [];
      if (j.pubkey !== pin.address) bad.push(`pubkey ${j.pubkey}`);
      if (j.account.owner !== pin.owner) bad.push(`owner ${j.account.owner}`);
      if (j.account.lamports !== pin.lamports) bad.push(`lamports ${j.account.lamports}`);
      if (j.account.executable !== pin.executable) bad.push(`executable ${j.account.executable}`);
      if (sha256(Buffer.from(j.account.data[0], "base64")) !== pin.dataSha256) bad.push("data");
      if (bad.length) problems.push(`${a.name}: local ${pin.jsonFile} differs from its pin: ${bad.join(", ")}`);
      else console.log(`local   ok  ${a.name.padEnd(15)} ${pin.address}`);
    }

    if (offline) continue;
    const live = await getAccount(a.address);
    if (!live) {
      drifted.push(a.name);
      problems.push(`${a.name}: MAINNET DRIFT account no longer exists`);
    } else if (sha256(live.data) !== pin.dataSha256 || live.owner !== pin.owner) {
      drifted.push(a.name);
      problems.push(`${a.name}: MAINNET DRIFT data or owner changed`);
    } else {
      console.log(`mainnet ok  ${a.name.padEnd(15)} (read @${live.slot})`);
    }
  }

  if (problems.length) {
    console.error("\nFIXTURES CHECK FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    if (drifted.length) {
      console.error(
        `\nD-001: mainnet changed for [${drifted.join(", ")}]. Re-dump with --accept-drift, then ` +
          `re-run every gate that exercises them before trusting any earlier result.`,
      );
    }
    process.exit(1);
  }
  console.log(`\nfixtures check PASSED${offline ? " (offline: local integrity only)" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
