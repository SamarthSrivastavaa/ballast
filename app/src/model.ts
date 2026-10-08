/**
 * The token page's data (§21), read from chain state for one launch. Nothing here computes a floor:
 * F comes from the program's `floor()` view (the floor crate on-chain) and is recomputed from the
 * same live accounts by the floor crate compiled to WebAssembly; the page shows F only when the two
 * agree. Bin prices and the DLMM fee come from Meteora's DLMM SDK; pool and position state from
 * Meteora's cp-amm SDK. Every price is labelled as one of §9's six.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import DLMM from "@meteora-ag/dlmm";
import { BallastClient, binPriceQ64, floorBin, LAUNCH_STATE, WSOL } from "../../sdk/typescript/src/client";
import type { Floor } from "../../sdk/typescript/src/floor";
import { S_MAX_DAMM_V2 } from "../../sdk/typescript/src/floor";

/** §10: redemption pays F less 0.5%. */
export const REDEEM_FEE_BPS = 50;
/** DAMM v2 migrated pool fee (§7: 100 bps). */
export const DAMM_FEE_BPS = 100;
const Q64 = 2 ** 64;

/** Lamports per base unit → SOL per token (9 and 6 decimals). Display only. */
export const solPerToken = (lamportsPerBaseUnit: number) => lamportsPerBaseUnit * 1e-3;
/** F in SOL per token from s = ⌊√F·2^64⌋. Display only. */
export const fFromS = (s: bigint) => solPerToken((Number(s) / Q64) ** 2);

export interface Model {
  launch: PublicKey;
  state: number;
  baseMint: PublicKey;
  /** §9's six prices, SOL per token (display). `bidBin` and `bidNet` are null when no bid rests. */
  prices: { F: number; bidBin: number | null; bidNet: number | null; damm: number; dammSellNet: number; redemption: number };
  s: bigint;
  /** The program's `floor()` view and the floor crate (WASM) on the same live accounts agree. */
  floorMatches: boolean;
  maxLossIfBuyNow: number;
  /** Share of outstanding supply each leg absorbs at F (§21 "floor composition"). */
  composition: { lockedPool: number; vaultBid: number };
  bid: { binId: number; restingSol: number; capped: boolean; suspended: boolean; dlmmFeeBps: number };
  inputs: { v: bigint; sSupply: bigint; l: bigint };
  proof: { predictionTx: string | null; openTx: string | null; addresses: Record<string, string> };
  predictedF: number;
}

/** Oldest signature touching `addr` (the launch's first transaction is its registration). */
async function oldestSignature(conn: Connection, addr: PublicKey): Promise<string | null> {
  let before: string | undefined;
  let last: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page = await conn.getSignaturesForAddress(addr, { before, limit: 1000 }, "confirmed");
    if (!page.length) break;
    last = page[page.length - 1].signature;
    before = last;
    if (page.length < 1000) break;
  }
  return last;
}

async function signatureAtSlot(conn: Connection, addr: PublicKey, slot: number): Promise<string | null> {
  const page = await conn.getSignaturesForAddress(addr, { limit: 1000 }, "confirmed");
  return page.find((x) => x.slot === slot && !x.err)?.signature ?? null;
}

export async function loadModel(conn: Connection, idl: { address: string }, launch: PublicKey, floor: Floor): Promise<Model> {
  const client = new BallastClient(conn, idl);
  const v = await client.view(launch);
  const rec = v.launch;
  if (rec.state !== LAUNCH_STATE.open) throw new Error(`launch is not Open yet (state ${rec.state})`);

  // F, twice: the program's view (simulated; partner_auth pays the simulated fee — it is a funded
  // system account) and the floor crate on the live accounts.
  const report = await client.readFloor(v, v.partnerAuth);
  const cp = new CpAmm(conn);
  const [pool, pp, cpos] = await Promise.all([
    cp.fetchPoolState(v.dammPool),
    cp.fetchPositionState(v.partnerPosition!),
    cp.fetchPositionState(v.creatorPosition!),
  ]);
  const l = BigInt(pp.permanentLockedLiquidity.toString()) + BigInt(cpos.permanentLockedLiquidity.toString());
  const vault = BigInt((await conn.getTokenAccountBalance(v.vault, "confirmed")).value.amount);
  const supply = (await getMint(conn, v.baseMint, "confirmed")).supply;
  const staging = await conn.getTokenAccountBalance(v.stagingBase, "confirmed").then((b) => BigInt(b.value.amount), () => 0n);
  const vTotal = vault + BigInt(rec.bidQuoteCommitted.toString());
  const sSupply = supply - staging;
  // Every Ballast pool is full range (enforced at `open`, §8), so s_max is DAMM v2's MAX.
  const s = floor.s({ v: vTotal, s: sSupply, l, sMax: S_MAX_DAMM_V2 });
  const floorMatches = s !== null && s === report.s;
  const sUsed = report.s;

  // Prices (§9).
  const F = fFromS(sUsed);
  const sqrtPrice = BigInt(pool.sqrtPrice.toString());
  const damm = solPerToken((Number(sqrtPrice) / Q64) ** 2);
  const pair = await DLMM.create(conn, v.lbPair, { cluster: "mainnet-beta" });
  const dlmmFeeBps = Number(pair.getFeeInfo().baseFeeRatePercentage.toString()) * 100;
  const resting = BigInt(rec.bidQuoteCommitted.toString());
  const binId: number = rec.bidBinId;
  const bidBin = resting > 0n ? solPerToken(Number(binPriceQ64(binId, v.binStep)) / Q64) : null;
  // Redemption per token, from the floor crate's payout on 1M tokens (one token pays only ~7 lamports,
  // which flooring would distort).
  const redemptionPerToken = Number(floor.payout(1_000_000_000_000n, sUsed, REDEEM_FEE_BPS)) / 1e9 / 1e6;

  // Composition at F: locked pool absorbs L·(1/s − 1/s_max) base units; the vault V/F (§4).
  const lockedBase = (Number(l) * (Number(S_MAX_DAMM_V2) - Number(sUsed))) / (Number(sUsed) * Number(S_MAX_DAMM_V2));
  const vaultBase = (Number(vTotal) * 2 ** 128) / Number(sUsed) ** 2;

  const addresses: Record<string, string> = {
    launch: launch.toBase58(), "base mint": v.baseMint.toBase58(), "DBC pool": v.dbcPool.toBase58(),
    "DAMM v2 pool": v.dammPool.toBase58(), "DLMM pair": v.lbPair.toBase58(), vault: v.vault.toBase58(),
    "partner position": v.partnerPosition!.toBase58(), "creator position": v.creatorPosition!.toBase58(),
  };
  return {
    launch, state: rec.state, baseMint: v.baseMint,
    prices: {
      F, bidBin, bidNet: bidBin === null ? null : bidBin * (1 - dlmmFeeBps / 10_000),
      damm, dammSellNet: damm * (1 - DAMM_FEE_BPS / 10_000), redemption: redemptionPerToken,
    },
    s: sUsed, floorMatches,
    maxLossIfBuyNow: Math.max(0, 1 - F / damm),
    composition: { lockedPool: lockedBase / Number(sSupply), vaultBid: vaultBase / Number(sSupply) },
    bid: { binId, restingSol: Number(resting) / 1e9, capped: !!rec.bidCapped, suspended: !!rec.bidSuspended, dlmmFeeBps },
    inputs: { v: vTotal, sSupply, l },
    proof: {
      predictionTx: await oldestSignature(conn, launch),
      openTx: await signatureAtSlot(conn, launch, Number(rec.openSlot.toString())),
      addresses,
    },
    predictedF: fFromS(BigInt(rec.predictedS.toString())),
  };
}

/** Solana Explorer link for the page's cluster (custom RPC for the local validator). */
export function explorerUrl(rpc: string, kind: "tx" | "address", id: string): string {
  const cluster = rpc.includes("devnet") ? "?cluster=devnet" : rpc.includes("mainnet") ? "" : `?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  return `https://explorer.solana.com/${kind}/${id}${cluster}`;
}

/**
 * The holder's atomic redemption (§10): a fresh order keypair (the bid is re-placed under it) and the
 * holder sign. Bin arrays: the resting bid's, F's bin and the next (the bid rises with F), and the
 * DLMM active bin's — `redeem` chooses its bin on-chain. A wallet cannot use the keeper's lookup
 * table, so the transaction must fit 1,232 bytes on its own; `size` is checked before signing.
 */
export async function buildRedeemTx(
  conn: Connection, idl: { address: string }, launch: PublicKey, holder: PublicKey, amount: bigint, minOut: bigint,
): Promise<{ tx: VersionedTransaction; order: Keypair; size: number }> {
  const client = new BallastClient(conn, idl, holder);
  const v = await client.view(launch);
  const report = await client.readFloor(v, v.partnerAuth);
  const fBin = floorBin(report.s, v.binStep);
  const order = Keypair.generate();
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })];
  const holderQuote = getAssociatedTokenAddressSync(WSOL, holder, true);
  if (!(await conn.getAccountInfo(holderQuote))) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(holder, holderQuote, holder, WSOL));
  }
  ixs.push(await client.redeemIx(v, order.publicKey, holder, amount, minOut, [v.launch.bidBinId, fBin, fBin + 1, v.activeBin]));
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: holder, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const size = tx.serialize().length;
  if (size > 1232) throw new Error(`redeem transaction is ${size} bytes (limit 1,232)`);
  return { tx, order, size };
}
