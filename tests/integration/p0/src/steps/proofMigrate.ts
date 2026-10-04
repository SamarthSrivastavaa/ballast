/**
 * Proof scenario, migration phase (Q1, Q6; Q4 timing of withdraw_migration_fee).
 *
 * 1. Before migration, try withdraw_migration_fee (partner, flag 0) through the harness proxy with
 *    the partner_auth PDA as `sender` (§10's ledger assumes the fee is withdrawn before migration).
 * 2. Migrate top-level via the SDK (DBC → DAMM v2, Customizable fee option).
 * 3. Immediately read both positions, both NFT token accounts, the pool and the migration tx's
 *    inner instructions — Q1 (atomic, fully permanent) and Q6 (who holds each NFT).
 */
import { PublicKey } from "@solana/web3.js";
import { getAccount as getTokenAccount, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { derivePositionAddress, derivePositionNftAccount } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, dumpAccount, send, writeEvidence } from "../env";
import { WSOL } from "../config";
import { dbc } from "../dbc";
import { dammPool, dammPosition, innerInstructions, migrate, virtualPool } from "../flow";
import { PdaKind, pda, proxyIx } from "../proxy";
import { need, saveState } from "../state";
import { ata, ensureAtaIx, tokenBalance } from "../wallets";

const pk = (s: string) => new PublicKey(s);

export async function withdrawMigrationFeeIx(pool: PublicKey, config: PublicKey, sender: PublicKey, dest: PublicKey, flag: 0 | 1) {
  const vp = (await virtualPool(pool)).poolState as Record<string, string>;
  return dbc.methods
    .withdrawMigrationFee(flag)
    .accountsPartial({
      config,
      virtualPool: pool,
      tokenQuoteAccount: dest,
      quoteVault: pk(vp.quoteVault),
      quoteMint: WSOL,
      sender,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

async function nftHolder(nftMint: PublicKey) {
  const account = derivePositionNftAccount(nftMint);
  const t = await getTokenAccount(conn, account, "confirmed", TOKEN_2022_PROGRAM_ID);
  return { nftMint: nftMint.toBase58(), nftAccount: account.toBase58(), holder: t.owner.toBase58(), amount: t.amount.toString() };
}

export async function proofMigrate(): Promise<void> {
  const pool = pk(need("proof.pool"));
  const config = pk(need("proof.config"));
  const partner = pda(PdaKind.partnerAuth, config);
  const creatorAuth = pk(need("proof.creatorAuth"));

  // (1) withdraw_migration_fee BEFORE migration, PDA via CPI, into the PDA's own WSOL ATA.
  await send("create partner_auth WSOL ATA", [ensureAtaIx(WSOL, partner.address)]);
  const preIx = await withdrawMigrationFeeIx(pool, config, partner.address, ata(WSOL, partner.address), 0);
  const pre = await send("Q4: withdraw_migration_fee (partner) via PDA CPI, BEFORE migration", [proxyIx([{ ix: preIx, signers: [partner] }])], [], {
    expectFail: true,
    cu: 400_000,
  });
  const preResult = {
    signature: pre.signature,
    succeeded: pre.err === null,
    err: pre.err,
    errorLog: pre.logs.filter((l) => l.includes("Error")),
    partnerWsolAfter: (await tokenBalance(ata(WSOL, partner.address))).toString(),
  };
  const vpBefore = (await virtualPool(pool)).poolState;

  // (2) migrate.
  const { landed, firstNft, secondNft } = await migrate("Q1: migration_damm_v2 (top-level, SDK)", pool);

  // (3) read everything right after, in one RPC call where possible.
  const vpAfter = (await virtualPool(pool)).poolState as Record<string, string>;
  const { deriveDammV2PoolAddress } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { MIGRATION_DAMM_CONFIG } = await import("../flow");
  const baseMint = pk(need("proof.baseMint"));
  const damm = deriveDammV2PoolAddress(MIGRATION_DAMM_CONFIG, baseMint, WSOL);
  const firstPos = derivePositionAddress(firstNft);
  const secondPos = derivePositionAddress(secondNft);
  const ctx = await conn.getMultipleAccountsInfoAndContext([damm, firstPos, secondPos], "confirmed");
  const readSlot = ctx.context.slot;

  const positions = {
    first: { position: firstPos.toBase58(), ...(await nftHolder(firstNft)), state: await dammPosition(firstPos) },
    second: { position: secondPos.toBase58(), ...(await nftHolder(secondNft)), state: await dammPosition(secondPos) },
  };
  const pool2 = await dammPool(damm);
  const inner = await innerInstructions(landed.signature);

  const view = (p: typeof positions.first) => {
    const s = p.state as Record<string, string>;
    return {
      position: p.position,
      nftHolder: p.holder,
      pool: s.pool,
      unlockedLiquidity: s.unlockedLiquidity,
      vestedLiquidity: s.vestedLiquidity,
      permanentLockedLiquidity: s.permanentLockedLiquidity,
      innerVesting: s.innerVesting,
    };
  };
  const first = view(positions.first);
  const second = view(positions.second);
  const holders = [first.nftHolder, second.nftHolder];
  const allPermanent = [first, second].every(
    (p) => p.unlockedLiquidity === "0" && p.vestedLiquidity === "0" && BigInt(p.permanentLockedLiquidity) > 0n && p.pool === damm.toBase58(),
  );
  const result = {
    question: "Q1 — one migration_damm_v2 leaves partner and creator positions fully permanent; Q6 — NFT holders",
    migrationSignature: landed.signature,
    migrationSlot: landed.slot,
    readAtSlot: readSlot,
    sameSlot: readSlot === landed.slot,
    migrationCu: landed.cu,
    dammPool: damm.toBase58(),
    positions: { first, second },
    q1AllLiquidityPermanent: allPermanent,
    q6Holders: {
      partnerAuthHoldsAnNft: holders.includes(partner.address.toBase58()),
      creatorAuthHoldsAnNft: holders.includes(creatorAuth.toBase58()),
      partnerAuth: partner.address.toBase58(),
      creatorAuth: creatorAuth.toBase58(),
    },
    poolLiquidity: pool2.liquidity,
    poolPermanentLockLiquidity: pool2.permanentLockLiquidity,
    sumPositionPermanent: (BigInt(first.permanentLockedLiquidity) + BigInt(second.permanentLockedLiquidity)).toString(),
    migrationProgressBefore: (vpBefore as Record<string, unknown>).migrationProgress,
    migrationProgressAfter: vpAfter.migrationProgress,
    innerInstructions: inner,
    withdrawMigrationFeeBeforeMigration: preResult,
  };
  writeEvidence("Q1/result.json", result);
  writeEvidence("Q1/positions-raw.json", {
    first: await dumpAccount(firstPos),
    second: await dumpAccount(secondPos),
    dammPool: await dumpAccount(damm),
  });
  writeEvidence("Q1/positions-sdk-decode.json", positions);
  writeEvidence("Q2/pool-after-migration.json", pool2);
  writeEvidence("Q14/virtual-pool-before-migration.json", vpBefore);
  writeEvidence("Q14/virtual-pool-after-migration.json", vpAfter);
  saveState({
    "proof.damm": damm.toBase58(),
    "proof.firstPosition": firstPos.toBase58(),
    "proof.secondPosition": secondPos.toBase58(),
    "proof.firstNft": firstNft.toBase58(),
    "proof.secondNft": secondNft.toBase58(),
    "proof.migrationSignature": landed.signature,
  });
  console.log(JSON.stringify({ ...result, innerInstructions: inner.map((i) => `${i.program.slice(0, 6)} ${i.name ?? "?"}`) }, null, 2));
}
