/**
 * Proof scenario, after migration: Q3, Q2 (with Q4/Q6 position-fee claims by PDA), Q4 DBC claims
 * by PDA with destination tests, Q11, Q16 (after migration).
 */
import BN from "bn.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { derivePositionNftAccount } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, Landed, send, sendSdkTx, writeEvidence } from "../env";
import { Q128, WSOL } from "../config";
import { dbc } from "../dbc";
import { cpAmm, dammPool, dammPosition, virtualPool } from "../flow";
import { Pda, PdaKind, pda, proxyIx } from "../proxy";
import { need, saveState } from "../state";
import { ata, ensureAtaIx, funded, tokenBalance } from "../wallets";

const pk = (s: string) => new PublicKey(s);
const U64_MAX = new BN("18446744073709551615");

// ---------------------------------------------------------------------------------------------
// Q3 — the DAMM v2 L ↔ reserves mapping
// ---------------------------------------------------------------------------------------------

export async function q3Check(label: string, damm: PublicKey) {
  const p = (await dammPool(damm)) as Record<string, string>;
  const L = BigInt(p.liquidity);
  const s = BigInt(p.sqrtPrice);
  const sMin = BigInt(p.sqrtMinPrice);
  const sMax = BigInt(p.sqrtMaxPrice);
  const expA = (L * (sMax - s)) / (s * sMax);
  const expB = (L * (s - sMin)) / Q128;
  const vaultA = await tokenBalance(pk(p.tokenAVault));
  const vaultB = await tokenBalance(pk(p.tokenBVault));
  const tokA = BigInt(p.tokenAAmount);
  const tokB = BigInt(p.tokenBAmount);
  return {
    label,
    layoutVersion: p.layoutVersion,
    L: L.toString(),
    sqrtPrice: s.toString(),
    sqrtMinPrice: sMin.toString(),
    sqrtMaxPrice: sMax.toString(),
    expectedA: expA.toString(),
    expectedB: expB.toString(),
    tokenAAmount: tokA.toString(),
    tokenBAmount: tokB.toString(),
    vaultA: vaultA.toString(),
    vaultB: vaultB.toString(),
    protocolAFee: p.protocolAFee,
    protocolBFee: p.protocolBFee,
    diffA_tokenAmount: (tokA - expA).toString(),
    diffB_tokenAmount: (tokB - expB).toString(),
    withinTwoUnits: (tokA - expA) ** 2n <= 4n && (tokB - expB) ** 2n <= 4n,
  };
}

// ---------------------------------------------------------------------------------------------
// PDA-signed claims
// ---------------------------------------------------------------------------------------------

async function viaPda(label: string, ix: TransactionInstruction, signer: Pda, expectFail = false): Promise<Landed> {
  return send(label, [proxyIx([{ ix, signers: [signer] }])], [], { expectFail, cu: 600_000 });
}

function outcome(t: Landed, before: bigint, after: bigint) {
  return {
    signature: t.signature,
    succeeded: t.err === null,
    err: t.err,
    errorLog: t.logs.filter((l) => l.includes("Error")),
    received: (after - before).toString(),
    cu: t.cu,
  };
}

async function claimPositionFeeIx(owner: PublicKey, position: PublicKey, nftMint: PublicKey, damm: PublicKey) {
  const p = (await dammPool(damm)) as Record<string, string>;
  return cpAmm._program.methods
    .claimPositionFee()
    .accountsPartial({
      pool: damm,
      position,
      tokenAAccount: ata(pk(p.tokenAMint), owner),
      tokenBAccount: ata(pk(p.tokenBMint), owner),
      tokenAVault: pk(p.tokenAVault),
      tokenBVault: pk(p.tokenBVault),
      tokenAMint: pk(p.tokenAMint),
      tokenBMint: pk(p.tokenBMint),
      positionNftAccount: derivePositionNftAccount(nftMint),
      signer: owner,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function proofPost(): Promise<void> {
  const pool = pk(need("proof.pool"));
  const config = pk(need("proof.config"));
  const baseMint = pk(need("proof.baseMint"));
  const damm = pk(need("proof.damm"));
  const partner = pda(PdaKind.partnerAuth, config);
  const creatorAuth = pda(PdaKind.creatorAuth, pool);
  const vault = pda(PdaKind.vault, pool);
  const firstPos = pk(need("proof.firstPosition"));
  const secondPos = pk(need("proof.secondPosition"));
  const firstNft = pk(need("proof.firstNft"));
  const secondNft = pk(need("proof.secondNft"));

  // Which position belongs to whom (Q6 recorded the holders).
  const holderOf = async (nft: PublicKey) =>
    (await conn.getParsedAccountInfo(derivePositionNftAccount(nft))).value?.data as { parsed: { info: { owner: string } } };
  const firstHolder = (await holderOf(firstNft)).parsed.info.owner;
  const partnerPos = firstHolder === partner.address.toBase58() ? { pos: firstPos, nft: firstNft } : { pos: secondPos, nft: secondNft };
  const creatorPos = firstHolder === partner.address.toBase58() ? { pos: secondPos, nft: secondNft } : { pos: firstPos, nft: firstNft };

  for (const owner of [partner.address, creatorAuth.address, vault.address]) {
    await send(`ATAs for ${owner.toBase58().slice(0, 6)}`, [ensureAtaIx(WSOL, owner), ensureAtaIx(baseMint, owner)]);
  }

  // ---- Q3 right after migration -------------------------------------------------------------
  const q3AtMigration = await q3Check("right after migration", damm);

  // ---- Q2 snapshot before ------------------------------------------------------------------
  const snapshot = async () => {
    const p = (await dammPool(damm)) as Record<string, unknown>;
    const pf = p.poolFees as Record<string, unknown>;
    const pos = async (x: PublicKey) => {
      const s = (await dammPosition(x)) as Record<string, string>;
      return { unlocked: s.unlockedLiquidity, vested: s.vestedLiquidity, permanent: s.permanentLockedLiquidity, feeBPending: s.feeBPending, feeAPending: s.feeAPending };
    };
    return {
      liquidity: p.liquidity,
      permanentLockLiquidity: p.permanentLockLiquidity,
      sqrtMinPrice: p.sqrtMinPrice,
      sqrtMaxPrice: p.sqrtMaxPrice,
      collectFeeMode: p.collectFeeMode,
      compoundingFeeBps: pf.compoundingFeeBps,
      poolStatus: p.poolStatus,
      poolType: p.poolType,
      partnerPosition: await pos(partnerPos.pos),
      creatorPosition: await pos(creatorPos.pos),
    };
  };
  const before = await snapshot();

  // 20 swaps each way on DAMM v2 from a trader wallet, alternating B→A then A→B.
  const trader = await funded("proof.trader", 30);
  await send("trader ATAs", [ensureAtaIx(WSOL, trader.publicKey), ensureAtaIx(baseMint, trader.publicKey)]);
  const p0 = (await dammPool(damm)) as Record<string, string>;
  const swapParams = (input: PublicKey, output: PublicKey, amountIn: bigint) => ({
    payer: trader.publicKey,
    pool: damm,
    inputTokenMint: input,
    outputTokenMint: output,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(0),
    tokenAMint: pk(p0.tokenAMint),
    tokenBMint: pk(p0.tokenBMint),
    tokenAVault: pk(p0.tokenAVault),
    tokenBVault: pk(p0.tokenBVault),
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  });
  const swapSigs: string[] = [];
  for (let i = 0; i < 20; i++) {
    const buyTx = await cpAmm.swap(swapParams(WSOL, baseMint, 50_000_000n + BigInt(i) * 1_000_000n));
    swapSigs.push((await sendSdkTx(`Q2: DAMM swap B→A #${i}`, buyTx, [trader], { feePayer: trader })).signature);
    const bal = await tokenBalance(ata(baseMint, trader.publicKey));
    const sellTx = await cpAmm.swap(swapParams(baseMint, WSOL, bal / 2n));
    swapSigs.push((await sendSdkTx(`Q2: DAMM swap A→B #${i}`, sellTx, [trader], { feePayer: trader })).signature);
  }
  const afterSwaps = await snapshot();

  // Two fee claims (Q2), each by its PDA via CPI (Q4 claim_position_fee; Q6).
  const pB0 = await tokenBalance(ata(WSOL, partner.address));
  const c1 = await viaPda("Q4/Q6: claim_position_fee (partner position) via partner_auth CPI",
    await claimPositionFeeIx(partner.address, partnerPos.pos, partnerPos.nft, damm), partner);
  const pB1 = await tokenBalance(ata(WSOL, partner.address));
  const cB0 = await tokenBalance(ata(WSOL, creatorAuth.address));
  const c2 = await viaPda("Q2: claim_position_fee (creator position) via creator_auth CPI",
    await claimPositionFeeIx(creatorAuth.address, creatorPos.pos, creatorPos.nft, damm), creatorAuth);
  const cB1 = await tokenBalance(ata(WSOL, creatorAuth.address));
  const afterClaims = await snapshot();
  const q3AfterSwaps = await q3Check("after 40 swaps and 2 claims", damm);

  const unchanged = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    a.liquidity === b.liquidity &&
    a.permanentLockLiquidity === b.permanentLockLiquidity &&
    a.sqrtMinPrice === b.sqrtMinPrice &&
    a.sqrtMaxPrice === b.sqrtMaxPrice &&
    JSON.stringify([(a.partnerPosition as Record<string, string>).permanent, (a.creatorPosition as Record<string, string>).permanent]) ===
      JSON.stringify([(b.partnerPosition as Record<string, string>).permanent, (b.creatorPosition as Record<string, string>).permanent]);

  const q2 = {
    question: "Q2 — pool mode, range, constant L under swaps and fee claims",
    before,
    afterSwaps,
    afterClaims,
    swaps: swapSigs.length,
    swapSignatures: swapSigs,
    claims: {
      partner: outcome(c1, pB0, pB1),
      creator: outcome(c2, cB0, cB1),
    },
    collectFeeModeIsOnlyB: before.collectFeeMode === 1,
    compoundingZero: String(before.compoundingFeeBps) === "0",
    fullRange: {
      sqrtMinPrice: before.sqrtMinPrice,
      sqrtMaxPrice: before.sqrtMaxPrice,
      isMin: before.sqrtMinPrice === "4295048016",
      isMax: before.sqrtMaxPrice === "79226673521066979257578248091",
    },
    lUnchangedAfterSwaps: unchanged(before, afterSwaps),
    lUnchangedAfterClaims: unchanged(before, afterClaims),
  };
  writeEvidence("Q2/result.json", q2);
  writeEvidence("Q3/result.json", { question: "Q3 — DAMM v2 L ↔ reserves mapping", atMigration: q3AtMigration, afterSwaps: q3AfterSwaps });

  // ---- Q4: DBC claims by the partner PDA, with destination tests -----------------------------
  const vp = (await virtualPool(pool)).poolState as Record<string, string>;
  const claimTradingFeeIx = (destBase: PublicKey, destQuote: PublicKey) =>
    dbc.methods
      .claimTradingFee(U64_MAX, U64_MAX)
      .accountsPartial({
        config,
        pool,
        tokenAAccount: destBase,
        tokenBAccount: destQuote,
        baseVault: pk(vp.baseVault),
        quoteVault: pk(vp.quoteVault),
        baseMint,
        quoteMint: WSOL,
        feeClaimer: partner.address,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const vB0 = await tokenBalance(ata(WSOL, vault.address));
  const tf1 = await viaPda("Q4: claim_trading_fee via partner_auth → destination NOT owned by fee claimer (vault PDA)",
    await claimTradingFeeIx(ata(baseMint, vault.address), ata(WSOL, vault.address)), partner, true);
  const vB1 = await tokenBalance(ata(WSOL, vault.address));
  let tf2: ReturnType<typeof outcome> | null = null;
  if (tf1.err) {
    const b0 = await tokenBalance(ata(WSOL, partner.address));
    const t = await viaPda("Q4: claim_trading_fee via partner_auth → own ATA",
      await claimTradingFeeIx(ata(baseMint, partner.address), ata(WSOL, partner.address)), partner);
    tf2 = outcome(t, b0, await tokenBalance(ata(WSOL, partner.address)));
  }

  const surplusIx = (dest: PublicKey) =>
    dbc.methods
      .partnerWithdrawSurplus()
      .accountsPartial({
        config,
        virtualPool: pool,
        tokenQuoteAccount: dest,
        quoteVault: pk(vp.quoteVault),
        quoteMint: WSOL,
        feeClaimer: partner.address,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const s0 = await tokenBalance(ata(WSOL, vault.address));
  const sw1 = await viaPda("Q4: partner_withdraw_surplus via partner_auth → vault PDA ATA", await surplusIx(ata(WSOL, vault.address)), partner, true);
  const s1 = await tokenBalance(ata(WSOL, vault.address));
  let sw2: ReturnType<typeof outcome> | null = null;
  if (sw1.err) {
    const b0 = await tokenBalance(ata(WSOL, partner.address));
    const t = await viaPda("Q4: partner_withdraw_surplus via partner_auth → own ATA", await surplusIx(ata(WSOL, partner.address)), partner, true);
    sw2 = outcome(t, b0, await tokenBalance(ata(WSOL, partner.address)));
  }

  const q4 = {
    question: "Q4 — PDA as fee_claimer via CPI: withdraw_migration_fee, claim_trading_fee, partner_withdraw_surplus, claim_position_fee",
    withdrawMigrationFee: "see Q1/result.json withdrawMigrationFeeBeforeMigration (partner, flag 0)",
    claimTradingFee: {
      partnerQuoteFeeAccrued: vp.partnerQuoteFee,
      toForeignDestination: outcome(tf1, vB0, vB1),
      toOwnAta: tf2,
    },
    partnerWithdrawSurplus: {
      quoteReserve: vp.quoteReserve,
      toForeignDestination: outcome(sw1, s0, s1),
      toOwnAta: sw2,
    },
    claimPositionFee: q2.claims.partner,
  };
  writeEvidence("Q4/result.json", q4);

  // ---- Q11 -----------------------------------------------------------------------------------
  const mint = await getMint(conn, baseMint, "confirmed", TOKEN_PROGRAM_ID);
  const q11 = {
    question: "Q11 — DBC base mint freeze authority",
    baseMint: baseMint.toBase58(),
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    supply: mint.supply.toString(),
    decimals: mint.decimals,
    freezeAuthorityIsNone: mint.freezeAuthority === null,
    mintAuthorityIsNone: mint.mintAuthority === null,
  };
  writeEvidence("Q11/result.json", q11);

  // ---- Q16 after migration: third wallet, wrong destination then the leftover_receiver's ATA ----
  const third = await funded("proof.third", 1);
  await send("third wallet base ATA", [ensureAtaIx(baseMint, third.publicKey)]);
  const leftoverIx = (dest: PublicKey) =>
    dbc.methods
      .withdrawLeftover()
      .accountsPartial({
        config,
        virtualPool: pool,
        tokenBaseAccount: dest,
        baseVault: pk(vp.baseVault),
        baseMint,
        leftoverReceiver: partner.address,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  const wrongDest = await send("Q16: withdraw_leftover (third wallet) → third wallet's own ATA (expect refusal)",
    [await leftoverIx(ata(baseMint, third.publicKey))], [third], { expectFail: true, feePayer: third });
  const lB0 = await tokenBalance(ata(baseMint, partner.address));
  const rightDest = await send("Q16: withdraw_leftover (third wallet) → leftover_receiver ATA",
    [await leftoverIx(ata(baseMint, partner.address))], [third], { expectFail: true, feePayer: third });
  const lB1 = await tokenBalance(ata(baseMint, partner.address));
  const q16 = {
    question: "Q16 — withdraw_leftover permissionless, to leftover_receiver's token account, only after CreatedPool",
    caller: third.publicKey.toBase58(),
    leftoverReceiver: partner.address.toBase58(),
    toCallersOwnAta: outcome(wrongDest, 0n, 0n),
    toLeftoverReceiverAta: outcome(rightDest, lB0, lB1),
    beforeMigration: "see Q16/before-migration.json",
  };
  writeEvidence("Q16/result.json", q16);

  saveState({ "proof.partnerPosition": partnerPos.pos.toBase58(), "proof.creatorPosition": creatorPos.pos.toBase58() });
  console.log(JSON.stringify({
    q2: { ...q2, swapSignatures: undefined, before: undefined, afterSwaps: undefined, afterClaims: undefined },
    q3: { atMigration: q3AtMigration, afterSwaps: q3AfterSwaps },
    q4,
    q11,
    q16,
  }, null, 2));
  void TOKEN_2022_PROGRAM_ID;
}
