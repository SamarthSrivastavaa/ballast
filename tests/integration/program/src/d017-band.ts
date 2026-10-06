/**
 * D-017 measurement — how far below the last curve point does DBC put `migration_sqrt_price`?
 *
 * Creates the canonical Proof and Public configs (compiler/src/canon.ts, exactly the bytes a class
 * is pinned to) on the mainnet DBC binary and reads back the `migration_sqrt_price` DBC derives.
 * D-017 sets the §7 rule-4 tolerance to the maximum shortfall observed here + 2 units.
 *
 *   pnpm exec tsx tests/integration/program/src/d017-band.ts
 *
 * Writes evidence/program/d017/band.json.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { assertLocal, conn, payer, REPO, send } from "../../p0/src/env";
import { configParameters, PROOF, PUBLIC, WSOL, type ClassSpec } from "../../../../compiler/src/canon";
import { dbc } from "../../p0/src/dbc";
import { pdas } from "./client";

const OUT = resolve(REPO, "evidence/program/d017/band.json");

async function measure(spec: ClassSpec) {
  const config = Keypair.generate();
  const ix = await dbc.methods
    .createConfig(configParameters(spec) as never)
    .accountsPartial({
      config: config.publicKey,
      feeClaimer: pdas.partner(config.publicKey),
      leftoverReceiver: pdas.partner(config.publicKey),
      quoteMint: WSOL,
      payer: payer.publicKey,
    })
    .instruction();
  const t = await send(`D-017: create_config ${spec.name}`, [ix], [config]);
  const cfg = await dbc.account.poolConfig.fetch(config.publicKey);
  const curve = (cfg.curve as { sqrtPrice: { toString(): string } }[]).map((p) => BigInt(p.sqrtPrice.toString())).filter((s) => s > 0n);
  const last = curve[curve.length - 1];
  const mig = BigInt(cfg.migrationSqrtPrice.toString());
  return {
    class: spec.name,
    config: config.publicKey.toBase58(),
    signature: t.signature,
    slot: t.slot,
    lastCurvePoint: last.toString(),
    migrationSqrtPrice: mig.toString(),
    shortfall: (last - mig).toString(),
    relative: Number(last - mig) / Number(last),
  };
}

async function main() {
  await assertLocal();
  if ((await conn.getBalance(payer.publicKey)) < 1e9) {
    await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100e9), "confirmed");
  }
  const rows = [];
  for (const spec of [PROOF, PUBLIC]) rows.push(await measure(spec));
  const max = rows.reduce((m, r) => (BigInt(r.shortfall) > m ? BigInt(r.shortfall) : m), 0n);
  const out = {
    what: "D-017: DBC's derived migration_sqrt_price vs the last curve point, canonical classes, mainnet DBC binary (D-001)",
    rows,
    maxShortfall: max.toString(),
    anyAboveLastPoint: rows.some((r) => BigInt(r.shortfall) < 0n),
    tolerance: (max + 2n).toString(),
    toleranceRule: "max observed shortfall + 2 units of rounding margin (D-017)",
  };
  mkdirSync(resolve(OUT, ".."), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
