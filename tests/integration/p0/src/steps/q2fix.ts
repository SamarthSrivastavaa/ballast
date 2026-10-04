/**
 * Q2 characterization (NOT an adopted change): §7 sets DBC `migrated_pool_fee.collect_fee_mode = 1`
 * expecting DAMM OnlyB, but DBC's enum is {0 QuoteToken, 1 OutputToken, 2 Compounding} while DAMM's
 * is {0 BothToken, 1 OnlyB, 2 Compounding}; the §7 value produced a BothToken pool (Q2/result.json).
 *
 * This runs the identical Proof config with DBC value 0 (QuoteToken) to test whether it yields a
 * DAMM OnlyB pool with constant L, so the proposed correction carries evidence.
 */
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { payer, send, sendSdkTx, writeEvidence } from "../env";
import { PROOF, WSOL } from "../config";
import { createConfigIx } from "../dbc";
import { buy, buyPartialFill, cpAmm, createPool, dammPool, migrate, virtualPool } from "../flow";
import { ensureAtaIx, funded, tokenBalance, ata } from "../wallets";

const pk = (s: string) => new PublicKey(s);

export async function q2fix(): Promise<void> {
  const spec = { ...PROOF, name: "proof-quote-fee-mode", migratedCollectFeeMode: 0 };
  const creator = await funded("q2fix.creator", 5);
  const { ix, created } = await createConfigIx(spec, payer.publicKey);
  const cfg = await send("Q2-fix: create_config with DBC migrated collect_fee_mode = 0", [ix], [created.config]);
  const { pool, baseMint } = await createPool(created.config.publicKey, creator, "q2fix");
  const buyer = await funded("q2fix.buyer", 30);
  for (const amt of [3_000_000_000n, 3_000_000_000n, 2_000_000_000n]) await buy("Q2-fix: buy", buyer, pool, amt);
  await buyPartialFill("Q2-fix: completing PartialFill buy", buyer, pool, 3_000_000_000n);
  const vp = (await virtualPool(pool)).poolState as Record<string, unknown>;
  const { landed } = await migrate("Q2-fix: migration_damm_v2", pool);
  const { deriveDammV2PoolAddress } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { MIGRATION_DAMM_CONFIG } = await import("../flow");
  const damm = deriveDammV2PoolAddress(MIGRATION_DAMM_CONFIG, baseMint.publicKey, WSOL);
  const before = (await dammPool(damm)) as Record<string, string>;

  // A few swaps each way, then check which token the fees landed in and that L did not move.
  const trader = await funded("q2fix.trader", 10);
  await send("Q2-fix: trader ATAs", [ensureAtaIx(WSOL, trader.publicKey), ensureAtaIx(baseMint.publicKey, trader.publicKey)]);
  const params = (input: PublicKey, output: PublicKey, amountIn: bigint) => ({
    payer: trader.publicKey, pool: damm, inputTokenMint: input, outputTokenMint: output,
    amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(0),
    tokenAMint: pk(before.tokenAMint), tokenBMint: pk(before.tokenBMint),
    tokenAVault: pk(before.tokenAVault), tokenBVault: pk(before.tokenBVault),
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  });
  for (let i = 0; i < 5; i++) {
    await sendSdkTx("Q2-fix: DAMM swap B→A", await cpAmm.swap(params(WSOL, baseMint.publicKey, 100_000_000n)), [trader], { feePayer: trader });
    const bal = await tokenBalance(ata(baseMint.publicKey, trader.publicKey));
    await sendSdkTx("Q2-fix: DAMM swap A→B", await cpAmm.swap(params(baseMint.publicKey, WSOL, bal / 2n)), [trader], { feePayer: trader });
  }
  const after = (await dammPool(damm)) as Record<string, string>;
  const result = {
    question: "Q2 characterization — DBC migrated collect_fee_mode = 0 (QuoteToken) → which DAMM mode?",
    createConfig: cfg.signature,
    migration: landed.signature,
    dbcConfigMigratedCollectFeeMode: 0,
    dammPool: damm.toBase58(),
    dammCollectFeeMode: before.collectFeeMode,
    isOnlyB: String(before.collectFeeMode) === "1",
    protocolAFeeAfterSwaps: after.protocolAFee,
    protocolBFeeAfterSwaps: after.protocolBFee,
    feesOnlyInQuote: after.protocolAFee === "0" && after.protocolBFee !== "0",
    liquidityBefore: before.liquidity,
    liquidityAfter: after.liquidity,
    lUnchanged: before.liquidity === after.liquidity,
    sqrtMinPrice: after.sqrtMinPrice,
    sqrtMaxPrice: after.sqrtMaxPrice,
    quoteReserveAtCompletion: vp.quoteReserve,
  };
  writeEvidence("Q2/characterization-quote-fee-mode.json", result);
  console.log(JSON.stringify(result, null, 2));
}
