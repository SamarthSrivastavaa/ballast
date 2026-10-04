/**
 * Q12 — exact PoolConfig layout and enum encodings for the deployed DBC.
 *
 * Creates the §7 Proof config with fee_claimer = leftover_receiver = harness partner_auth PDA,
 * then: owner = DBC; discriminator = PoolConfig; SDK decode; every field we sent compared with
 * what DBC stored (enums included). The raw bytes go to evidence so the vendored meteora-types
 * decode (`cargo test -p meteora-types`) runs against the very same account.
 */
import { writeFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { conn, dumpAccount, evidencePath, payer, send, writeEvidence } from "../env";
import { PROOF } from "../config";
import { createConfigIx, dbc, DBC_ID, POOL_CONFIG_DISC } from "../dbc";
import { saveState } from "../state";

const norm = (v: unknown): unknown => {
  if (v === null || v === undefined) return v;
  if (typeof v === "object" && v !== null && "toBase58" in v) return (v as PublicKey).toBase58();
  if (typeof v === "object" && v !== null && "toString" in v && (v as { negative?: number }).negative !== undefined)
    return (v as { toString(): string }).toString();
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, norm(x)]));
  return v;
};

export async function q12(): Promise<void> {
  const { ix, created } = await createConfigIx(PROOF, payer.publicKey);
  const landed = await send("Q12 create_config (Proof)", [ix], [created.config]);
  const addr = created.config.publicKey;
  const acct = await dumpAccount(addr);
  if (!acct) throw new Error("config not found after creation");
  const data = Buffer.from(acct.dataBase64 as string, "base64");

  const decoded = norm(dbc.coder.accounts.decode("poolConfig", data)) as Record<string, unknown>;
  const sent = norm(created.params) as Record<string, unknown>;

  // Field-by-field: what we sent vs what DBC stored (names differ where DBC flattens/derives).
  const checks: { field: string; sent: unknown; stored: unknown; ok: boolean }[] = [];
  const cmp = (field: string, s: unknown, d: unknown) =>
    checks.push({ field, sent: s, stored: d, ok: JSON.stringify(s) === JSON.stringify(d) });
  cmp("quoteMint", "So11111111111111111111111111111111111111112", decoded.quoteMint);
  cmp("feeClaimer", created.feeClaimer.toBase58(), decoded.feeClaimer);
  cmp("leftoverReceiver", created.feeClaimer.toBase58(), decoded.leftoverReceiver);
  for (const f of [
    "collectFeeMode",
    "migrationOption",
    "activationType",
    "tokenDecimal",
    "partnerLiquidityPercentage",
    "partnerPermanentLockedLiquidityPercentage",
    "creatorLiquidityPercentage",
    "creatorPermanentLockedLiquidityPercentage",
    "migrationQuoteThreshold",
    "sqrtStartPrice",
    "migrationFeeOption",
    "creatorTradingFeePercentage",
    "tokenUpdateAuthority",
  ])
    cmp(f, sent[f], decoded[f]);
  // DBC stores the bool as u8 and the compounding bps under the migrated-pool name.
  cmp("enableFirstSwapWithMinFee (bool → u8)", sent.enableFirstSwapWithMinFee ? 1 : 0, decoded.enableFirstSwapWithMinFee);
  cmp("compoundingFeeBps → migratedCompoundingFeeBps", sent.compoundingFeeBps, decoded.migratedCompoundingFeeBps);
  cmp("tokenType", sent.tokenType, decoded.tokenType);
  cmp("migrationFeePercentage", (sent.migrationFee as { feePercentage: number }).feePercentage, decoded.migrationFeePercentage);
  cmp(
    "creatorMigrationFeePercentage",
    (sent.migrationFee as { creatorFeePercentage: number }).creatorFeePercentage,
    decoded.creatorMigrationFeePercentage,
  );
  const ts = sent.tokenSupply as Record<string, string>;
  cmp("preMigrationTokenSupply", ts.preMigrationTokenSupply, decoded.preMigrationTokenSupply);
  cmp("postMigrationTokenSupply", ts.postMigrationTokenSupply, decoded.postMigrationTokenSupply);
  const curveSent = sent.curve as { sqrtPrice: string; liquidity: string }[];
  const curveStored = decoded.curve as { sqrtPrice: string; liquidity: string }[];
  curveSent.forEach((p, i) => cmp(`curve[${i}]`, p, curveStored[i]));
  const tail = curveStored.slice(curveSent.length);
  checks.push({
    field: `curve[${curveSent.length}..${curveStored.length}] all zero`,
    sent: "zero",
    stored: tail.every((p) => p.sqrtPrice === "0" && p.liquidity === "0") ? "zero" : tail,
    ok: tail.every((p) => p.sqrtPrice === "0" && p.liquidity === "0"),
  });
  const mpf = sent.migratedPoolFee as Record<string, number>;
  for (const [k, v] of Object.entries(mpf)) {
    const key = `migratedPool${k[0].toUpperCase()}${k.slice(1)}`;
    if (key in decoded) cmp(key, v, decoded[key]);
  }
  const bf = (sent.poolFees as { baseFee: Record<string, string | number> }).baseFee;
  const storedBf = (decoded.poolFees as { baseFee: Record<string, unknown> }).baseFee;
  cmp("poolFees.baseFee.cliffFeeNumerator", bf.cliffFeeNumerator, storedBf.cliffFeeNumerator);
  cmp("poolFees.baseFee.baseFeeMode", bf.baseFeeMode, storedBf.baseFeeMode);

  const result = {
    question: "Q12 — exact PoolConfig layout and enum encodings for the deployed DBC",
    signature: landed.signature,
    slot: landed.slot,
    config: addr.toBase58(),
    owner: acct.owner,
    ownerIsDbc: acct.owner === DBC_ID.toBase58(),
    dataLen: acct.dataLen,
    discriminator: data.subarray(0, 8).toString("hex"),
    discriminatorIsPoolConfig: data.subarray(0, 8).equals(POOL_CONFIG_DISC),
    curveCapacity: curveStored.length,
    storedOnly: {
      version: decoded.version,
      quoteTokenFlag: decoded.quoteTokenFlag,
      fixedTokenSupplyFlag: decoded.fixedTokenSupplyFlag,
      migratedPoolBaseFeeMode: decoded.migratedPoolBaseFeeMode,
      poolCreationFee: decoded.poolCreationFee,
    },
    fieldChecks: checks,
    allFieldsMatch: checks.every((c) => c.ok),
    derivedByDbc: {
      migrationSqrtPrice: decoded.migrationSqrtPrice,
      migrationBaseThreshold: decoded.migrationBaseThreshold,
      swapBaseAmount: decoded.swapBaseAmount,
      migrationQuoteThreshold: decoded.migrationQuoteThreshold,
      lastCurvePoint: curveSent[curveSent.length - 1].sqrtPrice,
      migrationSqrtPriceEqualsLastCurvePoint: decoded.migrationSqrtPrice === curveSent[curveSent.length - 1].sqrtPrice,
      lastCurvePointMinusMigrationSqrtPrice: (
        BigInt(curveSent[curveSent.length - 1].sqrtPrice) - BigInt(decoded.migrationSqrtPrice as string)
      ).toString(),
      swapPlusMigrationBase: (
        BigInt(decoded.swapBaseAmount as string) + BigInt(decoded.migrationBaseThreshold as string)
      ).toString(),
    },
    cu: landed.cu,
  };
  writeEvidence("Q12/config-account.json", acct);
  writeEvidence("Q12/sdk-decode.json", decoded);
  writeEvidence("Q12/sent-params.json", sent);
  writeEvidence("Q12/result.json", result);
  writeFileSync(evidencePath("Q12/create_config.logs.txt"), landed.logs.join("\n") + "\n");
  saveState({ proofConfig: addr.toBase58(), proofPartner: created.partner?.address.toBase58() });

  console.log(JSON.stringify({ ...result, fieldChecks: undefined }, null, 2));
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) console.log("MISMATCHES:", JSON.stringify(bad, null, 2));
  console.log("decoded keys:", Object.keys(decoded).join(" "));
  void conn;
}
