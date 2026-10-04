/**
 * The §7 Proof graduation scenario on the mainnet-binary local validator (D-001).
 *
 *   proof-setup    config (fee_claimer = leftover_receiver = partner_auth PDA), pool, creator → creator_auth
 *   proof-buy      buys to the threshold, overshooting ~3% once (Q15); negative checks before migration
 *
 * Later phases (migrate, post) live in proof-migrate.ts / proof-post.ts.
 */
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { dumpAccount, payer, send, writeEvidence, fundPda } from "../env";
import { PROOF, WSOL } from "../config";
import { createConfigIx, dbc } from "../dbc";
import { buy, buyPartialFill, createPool, rawData, virtualPool } from "../flow";
import { PdaKind, pda, proxyIx } from "../proxy";
import { loadState, need, saveState } from "../state";
import { ata, funded, resetKeys, tokenBalance, wallet } from "../wallets";

const pk = (s: string) => new PublicKey(s);

export async function proofSetup(): Promise<void> {
  resetKeys("proof.");
  const creator = await funded("proof.creator", 5);

  const { ix, created } = await createConfigIx(PROOF, payer.publicKey);
  const cfgTx = await send("proof: create_config", [ix], [created.config]);
  const config = created.config.publicKey;
  const partner = created.partner!;

  const { pool, baseMint, landed: poolTx } = await createPool(config, creator, "proof");
  const creatorAuth = pda(PdaKind.creatorAuth, pool);

  // Q12 (VirtualPool layout): raw bytes + SDK decode of a fresh pool, before any trade.
  writeEvidence("Q12/virtual-pool-account.json", await dumpAccount(pool));
  writeEvidence("Q12/virtual-pool-sdk-decode.json", (await virtualPool(pool)).poolState);

  // §1 correction 3: the pool-creator role moves to the creator_auth PDA before trade 1.
  const transfer = await dbc.methods
    .transferPoolCreator()
    .accountsPartial({ virtualPool: pool, config, creator: creator.publicKey, newCreator: creatorAuth.address })
    .instruction();
  const transferTx = await send("proof: transfer_pool_creator → creator_auth PDA", [transfer], [creator]);
  const after = (await virtualPool(pool)).poolState as Record<string, unknown>;

  // PDAs pay for nothing in DBC, but DLMM orders and ATAs they open later need lamports.
  await fundPda(partner.address, 2_000_000_000);
  await fundPda(creatorAuth.address, 500_000_000);

  saveState({
    "proof.config": config.toBase58(),
    "proof.partner": partner.address.toBase58(),
    "proof.pool": pool.toBase58(),
    "proof.baseMint": baseMint.publicKey.toBase58(),
    "proof.creatorAuth": creatorAuth.address.toBase58(),
    "proof.creatorWallet": creator.publicKey.toBase58(),
  });
  writeEvidence("proof/setup.json", {
    config: config.toBase58(),
    createConfig: cfgTx.signature,
    partnerAuth: partner.address.toBase58(),
    pool: pool.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
    createPool: poolTx.signature,
    createPoolCu: poolTx.cu,
    creatorWallet: creator.publicKey.toBase58(),
    creatorAuth: creatorAuth.address.toBase58(),
    transferPoolCreator: transferTx.signature,
    poolCreatorAfterTransfer: after.creator,
    creatorTransferredBeforeTrade1: after.creator === creatorAuth.address.toBase58() && after.hasSwap === 0,
  });
  console.log({ config: config.toBase58(), pool: pool.toBase58(), creatorAfter: after.creator, creatorAuth: creatorAuth.address.toBase58() });
}

/** Snapshot of the fee/reserve fields every swap is reconciled against (Q13, Q15). */
async function snap(pool: PublicKey) {
  const s = (await virtualPool(pool)).poolState as Record<string, unknown>;
  const m = s.metrics as Record<string, string>;
  return {
    quoteReserve: BigInt(s.quoteReserve as string),
    baseReserve: BigInt(s.baseReserve as string),
    partnerQuoteFee: BigInt(s.partnerQuoteFee as string),
    creatorQuoteFee: BigInt(s.creatorQuoteFee as string),
    protocolQuoteFee: BigInt(s.protocolQuoteFee as string),
    totalTradingQuoteFee: BigInt(m.totalTradingQuoteFee),
    totalProtocolQuoteFee: BigInt(m.totalProtocolQuoteFee),
    sqrtPrice: s.sqrtPrice as string,
    isMigrated: s.isMigrated,
    migrationProgress: s.migrationProgress,
  };
}

export async function proofBuy(): Promise<void> {
  const pool = pk(need("proof.pool"));
  const baseMint = pk(need("proof.baseMint"));
  const threshold = PROOF.threshold;
  const buyers = [await funded("proof.buyer0", 20), await funded("proof.buyer1", 20), await funded("proof.buyer2", 20)];
  const plan = [1_000_000_000n, 1_500_000_000n, 2_000_000_000n, 1_000_000_000n, 1_500_000_000n, 1_200_000_000n];

  const swaps: Record<string, unknown>[] = [];
  const doBuy = async (i: number, amountIn: bigint, label: string) => {
    const b = buyers[i % buyers.length];
    const before = await snap(pool);
    const baseBefore = await tokenBalance(ata(baseMint, b.publicKey));
    const t = await buy(label, b, pool, amountIn);
    const after = await snap(pool);
    const baseOut = (await tokenBalance(ata(baseMint, b.publicKey))) - baseBefore;
    const rec = {
      label,
      signature: t.signature,
      buyer: b.publicKey.toBase58(),
      amountIn: amountIn.toString(),
      baseOut: baseOut.toString(),
      dQuoteReserve: (after.quoteReserve - before.quoteReserve).toString(),
      dPartnerQuoteFee: (after.partnerQuoteFee - before.partnerQuoteFee).toString(),
      dCreatorQuoteFee: (after.creatorQuoteFee - before.creatorQuoteFee).toString(),
      dProtocolQuoteFee: (after.protocolQuoteFee - before.protocolQuoteFee).toString(),
      dTotalTradingQuoteFee: (after.totalTradingQuoteFee - before.totalTradingQuoteFee).toString(),
      dTotalProtocolQuoteFee: (after.totalProtocolQuoteFee - before.totalProtocolQuoteFee).toString(),
      quoteReserveAfter: after.quoteReserve.toString(),
      sqrtPriceAfter: after.sqrtPrice,
      cu: t.cu,
    };
    swaps.push(rec);
    return { rec, after };
  };

  for (let i = 0; i < plan.length; i++) await doBuy(i, plan[i], `proof: buy ${i}`);
  // Q15: an ExactIn buy sized to land the quote reserve ≈ 3% above the threshold:
  // (1.03·T − R) / (1 − 1%). §7's curve ends at the migration price, so this is expected to revert.
  const r = (await snap(pool)).quoteReserve;
  const target = (threshold * 103n) / 100n;
  const overshootIn = ((target - r) * 100n + 98n) / 99n;
  const overshootTry = await buy("Q15: ExactIn buy overshooting ~3% (expect refusal)", buyers[0], pool, overshootIn).then(
    (t) => ({ refused: false, signature: t.signature }),
    (e: Error) => ({ refused: true, error: e.message.split("\n")[0], errorLog: e.message.split("\n").filter((l) => l.includes("AnchorError")) }),
  );
  // Complete with swap2 PartialFill carrying the same oversized amount: DBC fills what the curve can take.
  const b0 = buyers[1];
  const before = await snap(pool);
  const pf = await buyPartialFill("Q15: swap2 PartialFill completing buy (same oversized amount)", b0, pool, overshootIn);
  const done = await snap(pool);
  const partialFill = {
    signature: pf.signature,
    amountInOffered: overshootIn.toString(),
    // The SDK unwraps the buyer's WSOL afterwards, so the unconsumed input comes back as SOL; what
    // DBC took is exactly the reserve increase plus every fee bucket it credited.
    consumed: (
      done.quoteReserve - before.quoteReserve +
      (done.partnerQuoteFee - before.partnerQuoteFee) +
      (done.creatorQuoteFee - before.creatorQuoteFee) +
      (done.protocolQuoteFee - before.protocolQuoteFee)
    ).toString(),
    refundedToBuyer: (
      overshootIn -
      (done.quoteReserve - before.quoteReserve) -
      (done.partnerQuoteFee - before.partnerQuoteFee) -
      (done.creatorQuoteFee - before.creatorQuoteFee) -
      (done.protocolQuoteFee - before.protocolQuoteFee)
    ).toString(),
    dQuoteReserve: (done.quoteReserve - before.quoteReserve).toString(),
    dTotalTradingQuoteFee: (done.totalTradingQuoteFee - before.totalTradingQuoteFee).toString(),
    dPartnerQuoteFee: (done.partnerQuoteFee - before.partnerQuoteFee).toString(),
    dCreatorQuoteFee: (done.creatorQuoteFee - before.creatorQuoteFee).toString(),
    dProtocolQuoteFee: (done.protocolQuoteFee - before.protocolQuoteFee).toString(),
    cu: pf.cu,
  };
  swaps.push({ label: "Q15: swap2 PartialFill completing buy", ...partialFill, amountIn: overshootIn.toString() });

  // Q15: a buy after completion must be refused.
  const late = await buy("proof: buy after completion (expect refusal)", buyers[0], pool, 100_000_000n).catch(
    (e: Error) => ({ refused: true, error: e.message.split("\n")[0] }),
  );

  const result = {
    question: "Q15 — overshoot at completion; late buy; (setup for Q13)",
    threshold: threshold.toString(),
    quoteReserveAtCompletion: done.quoteReserve.toString(),
    overshootLamports: (done.quoteReserve - threshold).toString(),
    overshootPct: Number(((done.quoteReserve - threshold) * 1_000_000n) / threshold) / 10_000,
    isMigrated: done.isMigrated,
    migrationProgress: done.migrationProgress,
    exactInOvershootAttempt: { amountIn: overshootIn.toString(), ...overshootTry },
    partialFillCompletion: partialFill,
    lateBuy: "refused" in (late as object) ? late : { refused: false, signature: (late as { signature: string }).signature },
  };
  writeEvidence("Q13/dbc-swaps.json", swaps);
  writeEvidence("Q15/result.json", result);
  console.log(JSON.stringify(result, null, 2));
  void loadState;
  void wallet;
  void proxyIx;
  void rawData;
  void WSOL;
  void BN;
}

/** Q16 negative half: before migration, withdraw_leftover from a third wallet must fail. */
export async function proofPreMigration(): Promise<void> {
  const pool = pk(need("proof.pool"));
  const baseMint = pk(need("proof.baseMint"));
  // Q16 (before migration): withdraw_leftover from a third wallet must not be possible yet.
  const third = await funded("proof.third", 1);
  const config = pk(need("proof.config"));
  const partner = pk(need("proof.partner"));
  const leftoverIx = await dbc.methods
    .withdrawLeftover()
    .accountsPartial({
      tokenBaseProgram: TOKEN_PROGRAM_ID,
      config,
      virtualPool: pool,
      tokenBaseAccount: ata(baseMint, partner),
      baseVault: pk((await virtualPool(pool)).poolState["baseVault" as never] as string),
      baseMint,
      leftoverReceiver: partner,
    })
    .instruction();
  const { ensureAtaIx } = await import("../wallets");
  await send("proof: create leftover_receiver base ATA", [ensureAtaIx(baseMint, partner)]);
  const earlyLeftover = await send("Q16: withdraw_leftover before migration (third wallet)", [leftoverIx], [third], {
    expectFail: true,
    feePayer: third,
  });

  const result = {
    question: "Q16 (before migration) — withdraw_leftover from a third wallet",
    signature: earlyLeftover.signature,
    refused: earlyLeftover.err !== null,
    err: earlyLeftover.err,
    errorLog: earlyLeftover.logs.filter((l) => l.includes("Error")),
  };
  writeEvidence("Q16/before-migration.json", result);
  saveState({ "proof.thirdWallet": third.publicKey.toBase58() });
  console.log(JSON.stringify(result, null, 2));
}
