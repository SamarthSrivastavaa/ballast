/**
 * The D-011 atomic launch transaction, built from RAW instructions with every PDA derived
 * client-side — the pool does not exist until the transaction's own first instruction runs, so the
 * SDK builders that read on-chain state cannot be used for the buy or the pair.
 *
 *   1. DBC initialize_virtual_pool_with_spl_token
 *   2. the payer's dust first buy (ATA create + DBC swap)
 *   3. DLMM customizable LimitOrder pair, payer as funder, class bin step
 *   4. DBC transfer_pool_creator → creator_auth
 *   5. Ballast register_launch
 *
 * `LaunchOpts` injects exactly one defect per negative test.
 */
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveDbcPoolAddress, deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createProgram as createDlmmProgram, deriveCustomizablePermissionlessLbPair, deriveOracle, deriveReserve } from "@meteora-ag/dlmm";
import { conn, createAlt, Landed, payer, send } from "../../p0/src/env";
import { WSOL } from "../../../../compiler/src/canon";
import { dbc, dbcClient } from "../../p0/src/dbc";
import { ata } from "../../p0/src/wallets";
import { ballast, pdas } from "./client";

export const DLMM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const dlmm = createDlmmProgram(conn, { cluster: "mainnet-beta" });
const bn = (x: bigint | number) => new BN(x.toString());

export const CLASS_DUST = 1_000_000n; // CLASSES[0].dust_limit
export const CLASS_BIN_STEP = 10; // CLASSES[0].bid_bin_step

export interface LaunchOpts {
  dust?: bigint;
  extraSwap?: bigint;
  /** Who makes the dust buy and funds the pair (default: the payer). */
  swapper?: Keypair;
  pair?: { binStep?: number; baseFactor?: number; collectFeeMode?: number; onOff?: boolean; omit?: boolean };
  /** `null` omits the creator transfer; default creator_auth. */
  transferTo?: PublicKey | null;
  /** Signer passed to register_launch as `creator` (default: the pool creator). */
  registerCreator?: Keypair;
  /** DBC config the pool is created from (default: the class config). */
  poolConfig?: PublicKey;
  /** Insert an unexpected DBC instruction before register_launch. */
  extraDbcIx?: boolean;
  /** Create the pool in an EARLIER transaction (D-011 forbids it). */
  poolInEarlierTx?: boolean;
}

export interface Launch {
  baseMint: Keypair;
  pool: PublicKey;
  launch: PublicKey;
  creatorAuth: PublicKey;
  vault: PublicKey;
  lbPair: PublicKey;
  landed: Landed;
  txBytes: number;
}

function activeIdFor(sqrtPrice: bigint, binStep: number): number {
  const price = Number(sqrtPrice) ** 2 / 2 ** 128;
  return Math.floor(Math.log(price) / Math.log(1 + binStep / 10_000));
}

export async function launch(label: string, classConfig: PublicKey, creator: Keypair, sqrtStart: bigint, opts: LaunchOpts = {}): Promise<Launch> {
  const baseMint = Keypair.generate();
  const poolConfig = opts.poolConfig ?? classConfig;
  const pool = deriveDbcPoolAddress(WSOL, baseMint.publicKey, poolConfig);
  const launchPda = pdas.launch(baseMint.publicKey);
  const creatorAuth = pdas.creator(launchPda);
  const vault = pdas.vault(launchPda);
  const swapper = opts.swapper ?? payer;
  const signers = new Map<string, Keypair>([[payer.publicKey.toBase58(), payer], [creator.publicKey.toBase58(), creator], [baseMint.publicKey.toBase58(), baseMint]]);
  const sign = (k: Keypair) => signers.set(k.publicKey.toBase58(), k);
  sign(swapper);

  // 1. pool creation (the SDK only reads the config, which exists).
  const createPool = (
    await dbcClient.creator.createPool({
      name: "Ballast launch", symbol: "BLST", uri: "https://example.invalid/launch.json",
      payer: payer.publicKey, poolCreator: creator.publicKey, config: poolConfig, baseMint: baseMint.publicKey,
    })
  ).instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

  // 2. dust buy(s): raw DBC swap from the swapper's pre-funded WSOL ATA.
  const swapIx = (amount: bigint, who: Keypair) =>
    dbc.methods
      .swap({ amountIn: bn(amount), minimumAmountOut: bn(0) } as never)
      .accountsPartial({
        config: poolConfig, pool,
        inputTokenAccount: ata(WSOL, who.publicKey), outputTokenAccount: ata(baseMint.publicKey, who.publicKey),
        baseVault: deriveDbcTokenVaultAddress(pool, baseMint.publicKey), quoteVault: deriveDbcTokenVaultAddress(pool, WSOL),
        baseMint: baseMint.publicKey, quoteMint: WSOL, payer: who.publicKey,
        tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      })
      .instruction();
  const buy: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(baseMint.publicKey, swapper.publicKey), swapper.publicKey, baseMint.publicKey),
    await swapIx(opts.dust ?? CLASS_DUST, swapper),
  ];
  if (opts.extraSwap) buy.push(await swapIx(opts.extraSwap, swapper));

  // 3. DLMM pair, swapper as funder (it holds the base the pair requires, Q8).
  const binStep = opts.pair?.binStep ?? CLASS_BIN_STEP;
  const [lbPair] = deriveCustomizablePermissionlessLbPair(baseMint.publicKey, WSOL, DLMM_ID);
  const pair: TransactionInstruction[] = [];
  if (!opts.pair?.omit) {
    pair.push(
      await dlmm.methods
        .initializeCustomizablePermissionlessLbPair2({
          activeId: activeIdFor(sqrtStart, binStep), binStep, baseFactor: opts.pair?.baseFactor ?? 10_000 / binStep,
          activationType: 0, hasAlphaVault: false, activationPoint: null, creatorPoolOnOffControl: opts.pair?.onOff ?? false,
          baseFeePowerFactor: 0, concreteFunctionType: 0, collectFeeMode: opts.pair?.collectFeeMode ?? 1, padding: new Array(60).fill(0),
        } as never)
        .accountsPartial({
          lbPair, binArrayBitmapExtension: null, tokenMintX: baseMint.publicKey, tokenMintY: WSOL,
          reserveX: deriveReserve(baseMint.publicKey, lbPair, DLMM_ID)[0], reserveY: deriveReserve(WSOL, lbPair, DLMM_ID)[0],
          oracle: deriveOracle(lbPair, DLMM_ID)[0], userTokenX: ata(baseMint.publicKey, swapper.publicKey), funder: swapper.publicKey,
          tokenBadgeX: null, tokenBadgeY: null, tokenProgramX: TOKEN_PROGRAM_ID, tokenProgramY: TOKEN_PROGRAM_ID,
          userTokenY: ata(WSOL, swapper.publicKey),
        } as never)
        .instruction(),
    );
  }

  // 4. creator transfer.
  const transfer: TransactionInstruction[] = [];
  if (opts.transferTo !== null) {
    transfer.push(
      await dbc.methods.transferPoolCreator()
        .accountsPartial({ virtualPool: pool, config: poolConfig, creator: creator.publicKey, newCreator: opts.transferTo ?? creatorAuth })
        .instruction(),
    );
  }

  const extra: TransactionInstruction[] = [];
  if (opts.extraDbcIx) {
    const fc = Keypair.generate();
    sign(fc);
    const [pm] = PublicKey.findProgramAddressSync([Buffer.from("partner_metadata"), fc.publicKey.toBuffer()], dbc.programId);
    extra.push(await dbc.methods.createPartnerMetadata({ padding: new Array(96).fill(0), name: "x", website: "x", logo: "x" } as never)
      .accountsPartial({ partnerMetadata: pm, payer: payer.publicKey, feeClaimer: fc.publicKey }).instruction());
  }

  // 5. register_launch.
  const registerCreator = opts.registerCreator ?? creator;
  sign(registerCreator);
  const register = await ballast.methods
    .registerLaunch(creator.publicKey)
    .accountsPartial({
      class: pdas.class(classConfig), launch: launchPda, virtualPool: pool, baseMint: baseMint.publicKey,
      creatorAuth, partnerAuth: pdas.partner(classConfig), vault, quoteMint: WSOL, dlmmPair: lbPair,
      creator: registerCreator.publicKey, payer: payer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();

  let ixs = [...createPool, ...buy, ...pair, ...transfer, ...extra, register];
  if (opts.poolInEarlierTx) {
    await send(`${label}: pool created in an EARLIER transaction`, createPool, [creator, baseMint]);
    ixs = [...buy, ...pair, ...transfer, ...extra, register];
  }

  const signerKeys = new Set(signers.keys());
  const altKeys = [...new Map(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).filter((k) => !signerKeys.has(k.toBase58())).map((k) => [k.toBase58(), k])).values()];
  const alt = await createAlt(label, [...altKeys, ComputeBudgetProgram.programId]);
  const landed = await send(label, ixs, [...signers.values()], { alts: [alt], cu: 1_400_000, expectFail: true });

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message([alt]);
  const txBytes = new VersionedTransaction(msg).serialize().length;
  return { baseMint, pool, launch: launchPda, creatorAuth, vault, lbPair, landed, txBytes };
}
