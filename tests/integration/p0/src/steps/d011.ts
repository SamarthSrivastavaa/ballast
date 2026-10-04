/**
 * D-011 fit proof: does the atomic launch transaction fit in one Solana transaction (1,232 bytes)?
 *
 * D-011 makes a launch ONE transaction:
 *   1. DBC pool creation
 *   2. payer dust first buy (>= 1 base unit, <= the class dust limit)
 *   3. DLMM LimitOrder pair creation, payer as funder, class bin step
 *   4. transfer_pool_creator -> creator_auth
 *   5. register_launch
 *
 * Step 2 exists because of Q8: DLMM refuses to create the pair unless the funder already holds at
 * least 1 base unit (6060 MissingTokenAmountAsTokenLaunchProof). Step 3 must therefore follow a buy.
 *
 * Method. The five instructions are built exactly as they would appear in the launch transaction
 * and then *measured*, not sent. To build them the SDKs need a pool and mint that already exist, so
 * a throwaway "probe" pool is created first in its own transaction; the instructions built against
 * it have the same account counts and data lengths as the real ones, so the byte count is exact.
 *
 * `register_launch` does not exist yet, so it is represented by a synthetic instruction carrying
 * the §6 + D-011 account list (including the instructions sysvar for introspection) and a 40-byte
 * payload (8 discriminator + 32 creator_beneficiary). Its size is therefore real even though its
 * code is not.
 *
 * Reported for each variant: the serialised VersionedTransaction size against the 1,232-byte limit.
 */
import BN from "bn.js";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import DLMM from "@meteora-ag/dlmm";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, createAlt, payer, send, simulate, writeEvidence } from "../env";
import { PROOF, WSOL } from "../config";
import { dbc, dbcClient, createConfigIx } from "../dbc";
import { PdaKind, pda } from "../proxy";
import { funded } from "../wallets";

const TX_LIMIT = 1232;
const SIG_BYTES = 64;
/** §9 / the class bin step. Q8: the pair address carries no bin step, so this is fixed per class. */
const BIN_STEP = 10;
const BASE_FEE_BPS = 1;
/** D-011(b): the payer's first buy must be <= this. 0.001 SOL against a 10 SOL threshold. */
const DUST_LIMIT = 1_000_000n;
/** Stand-in for the not-yet-deployed Ballast program, so the account list has a real program key. */
const BALLAST_ID = new PublicKey("BaLLaSt1111111111111111111111111111111111111");

/** Bytes a compact-u16 (shortvec) length takes on the wire. */
function cu16(n: number): number {
  return n < 0x80 ? 1 : n < 0x4000 ? 2 : 3;
}

/**
 * Wire size of a v0 transaction, computed from the compiled message.
 *
 * `VersionedTransaction.serialize()` cannot be used for this: web3.js encodes into a fixed
 * 1,232-byte buffer and throws `RangeError: encoding overruns Uint8Array` when the message is too
 * big — which is precisely the case whose size we need to report. So the layout is counted
 * directly, and serialize() is used only as a cross-check when it happens to succeed.
 */
function sizeOf(
  ixs: TransactionInstruction[],
  signerCount: number,
  alts: AddressLookupTableAccount[],
  blockhash: string,
): { bytes: number; fits: boolean; overBy: number; staticAccounts: number; altLookups: number; crossCheck: number | null } {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);

  let n = 0;
  n += 1;                                                   // version prefix (0x80)
  n += 3;                                                   // header
  n += cu16(msg.staticAccountKeys.length) + 32 * msg.staticAccountKeys.length;
  n += 32;                                                  // recent blockhash
  n += cu16(msg.compiledInstructions.length);
  for (const ix of msg.compiledInstructions) {
    n += 1;                                                 // programIdIndex
    n += cu16(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length;
    n += cu16(ix.data.length) + ix.data.length;
  }
  n += cu16(msg.addressTableLookups.length);
  let lookups = 0;
  for (const l of msg.addressTableLookups) {
    n += 32;
    n += cu16(l.writableIndexes.length) + l.writableIndexes.length;
    n += cu16(l.readonlyIndexes.length) + l.readonlyIndexes.length;
    lookups += l.writableIndexes.length + l.readonlyIndexes.length;
  }
  const bytes = n + cu16(signerCount) + SIG_BYTES * signerCount;

  let crossCheck: number | null = null;
  try {
    // `VersionedTransaction` pre-allocates one zeroed signature PER REQUIRED SIGNER (from the
    // message header), not one in total, so serialize() already prices the signatures and its
    // length should equal `bytes` exactly. Throws when the message is oversized.
    crossCheck = new VersionedTransaction(msg).serialize().length;
  } catch {
    crossCheck = null;
  }

  return {
    bytes,
    fits: bytes <= TX_LIMIT,
    overBy: Math.max(0, bytes - TX_LIMIT),
    staticAccounts: msg.staticAccountKeys.length,
    altLookups: lookups,
    crossCheck,
    // Non-null and unequal means the analytic layout drifted from web3.js — do not trust `bytes`.
    crossCheckAgrees: crossCheck === null ? null : crossCheck === bytes,
  };
}

export async function d011Fit(): Promise<void> {
  const creator = await funded("d011.creator", 5);

  // ---- phase A: things a launch does NOT do in the atomic transaction ----
  // create_config is the admin's step (§19 step 4), once per class.
  const { ix: cfgIx, created } = await createConfigIx(PROOF, payer.publicKey);
  await send("D-011: create_config (admin, not part of the launch tx)", [cfgIx], [created.config]);
  const config = created.config.publicKey;

  // A throwaway pool so the SDK builders have state to read. Its instructions are structurally
  // identical to the ones the real launch would carry.
  const probeMint = Keypair.generate();
  const probeTx = await dbcClient.creator.createPool({
    name: "Ballast D011 probe",
    symbol: "BD11",
    uri: "https://example.invalid/d011.json",
    payer: payer.publicKey,
    poolCreator: creator.publicKey,
    config,
    baseMint: probeMint.publicKey,
  });
  const probePool = deriveDbcPoolAddress(WSOL, probeMint.publicKey, config);
  await send("D-011: probe pool (so builders have state)", probeTx.instructions, [creator, probeMint]);

  // ---- phase B: build the five instructions of the atomic launch ----
  const creatorAuth = pda(PdaKind.creatorAuth, probePool);
  const partnerAuth = pda(PdaKind.partnerAuth, config);

  // (1) DBC pool creation.
  const launchMint = Keypair.generate();
  const createPoolIxs = (
    await dbcClient.creator.createPool({
      name: "Ballast launch",
      symbol: "BLST",
      uri: "https://example.invalid/launch.json",
      payer: payer.publicKey,
      poolCreator: creator.publicKey,
      config,
      baseMint: launchMint.publicKey,
    })
  ).instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

  // (2) the payer's dust first buy, against the probe pool (same shape as against the real one).
  const buyIxs = (
    await dbcClient.pool.swap({
      owner: payer.publicKey,
      pool: probePool,
      amountIn: new BN(DUST_LIMIT.toString()),
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
      payer: payer.publicKey,
    })
  ).instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

  // (3) DLMM LimitOrder pair, payer as funder (option C), at the class bin step.
  const pairIxs = (
    await DLMM.createCustomizablePermissionlessLbPair2(
      conn,
      new BN(BIN_STEP),
      probeMint.publicKey,
      WSOL,
      new BN(-10_548),
      new BN(BASE_FEE_BPS),
      0,
      false,
      payer.publicKey,
      undefined,
      false,
      0 /* LimitOrder */,
      1 /* OnlyY */,
      { cluster: "mainnet-beta" as const },
    )
  ).instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

  // (4) transfer_pool_creator -> creator_auth.
  const transferIx = await dbc.methods
    .transferPoolCreator()
    .accountsPartial({
      virtualPool: probePool,
      config,
      creator: creator.publicKey,
      newCreator: creatorAuth.address,
    })
    .instruction();

  // (5) register_launch — synthetic, but with the real §6 + D-011 account list.
  const registerIx = new TransactionInstruction({
    programId: BALLAST_ID,
    data: Buffer.alloc(8 + 32), // discriminator + creator_beneficiary
    keys: [
      { pubkey: PublicKey.findProgramAddressSync([Buffer.from("class"), config.toBuffer()], BALLAST_ID)[0], isSigner: false, isWritable: false },
      { pubkey: PublicKey.findProgramAddressSync([Buffer.from("launch"), launchMint.publicKey.toBuffer()], BALLAST_ID)[0], isSigner: false, isWritable: true },
      { pubkey: probePool, isSigner: false, isWritable: false },
      { pubkey: launchMint.publicKey, isSigner: false, isWritable: false },
      { pubkey: creatorAuth.address, isSigner: false, isWritable: false },
      { pubkey: PublicKey.findProgramAddressSync([Buffer.from("vault"), probePool.toBuffer()], BALLAST_ID)[0], isSigner: false, isWritable: true },
      { pubkey: partnerAuth.address, isSigner: false, isWritable: false },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: creator.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: dbc.programId, isSigner: false, isWritable: false },
      // D-011: introspection over this transaction's own instruction list.
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_OR_RENT(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });

  const launchIxs = [...createPoolIxs, ...buyIxs, ...pairIxs, transferIx, registerIx];

  // ---- the ALT: every non-signer account the transaction touches ----
  const signers = new Set([payer.publicKey, launchMint.publicKey, creator.publicKey].map((k) => k.toBase58()));
  const altKeys = [
    ...new Map(
      launchIxs
        .flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)])
        .filter((k) => !signers.has(k.toBase58()))
        .map((k) => [k.toBase58(), k]),
    ).values(),
  ];
  const alt = await createAlt("D-011 launch", altKeys);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  // ---- measure ----
  const variants = {
    legacyNoAlt: sizeOf(launchIxs, 3, [], blockhash),
    v0WithAlt_creatorIsSeparate: sizeOf(launchIxs, 3, [alt], blockhash),
    // PROJECTION, not a measurement: the instructions were built with a separate creator, so the
    // compiled header still requires 3 signatures. This prices 2 to show what collapsing creator
    // and payer into one wallet would save (64 bytes). crossCheckAgrees is false by design here.
    v0WithAlt_creatorIsPayer_PROJECTED: sizeOf(launchIxs, 2, [alt], blockhash),
    v0WithAlt_plusComputeBudget: sizeOf(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...launchIxs],
      3,
      [alt],
      blockhash,
    ),
  };

  // Per-instruction-group contribution, for diagnosing an overflow.
  const groups: Record<string, TransactionInstruction[]> = {
    "1_createPool": createPoolIxs,
    "2_dustBuy": buyIxs,
    "3_dlmmPair": pairIxs,
    "4_transferPoolCreator": [transferIx],
    "5_registerLaunch": [registerIx],
  };
  const perGroup = Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [
      k,
      { instructions: v.length, accountMetas: v.reduce((n, ix) => n + ix.keys.length, 0), dataBytes: v.reduce((n, ix) => n + ix.data.length, 0) },
    ]),
  );

  // ---- CU: simulate the four real instructions (register_launch has no program yet) ----
  const real = [...createPoolIxs, ...buyIxs, ...pairIxs, transferIx];
  const sim = await simulate(
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...real],
    payer.publicKey,
    [alt],
  );

  const result = {
    question: "D-011 — does the atomic launch transaction fit in 1,232 bytes?",
    limit: TX_LIMIT,
    binStep: BIN_STEP,
    dustLimitLamports: DUST_LIMIT.toString(),
    altEntries: altKeys.length,
    instructionCount: launchIxs.length,
    variants,
    perGroup,
    simulationOfTheFourRealInstructions: {
      note: "register_launch is excluded: its program is not deployed yet. Its own cost is small (account reads, one init, instruction-sysvar introspection).",
      err: sim.err ?? null,
      customCode: sim.customCode,
      cu: sim.cu,
      lastError: sim.logs.filter((l) => l.includes("Error")).slice(-1)[0] ?? null,
    },
    verdict: variants.v0WithAlt_creatorIsSeparate.fits
      ? "FITS with an ALT"
      : `DOES NOT FIT — over by ${variants.v0WithAlt_creatorIsSeparate.overBy} bytes with a separate creator`,
  };

  writeEvidence("d011/fit.json", result);
  console.log(JSON.stringify(result, null, 2));
}

/** Rent sysvar, kept in a function so the import stays used if the account list changes. */
function SYSTEM_OR_RENT(): PublicKey {
  return SYSVAR_RENT_PUBKEY;
}
