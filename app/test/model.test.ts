/**
 * The token page's numbers against independent sources, on the local proof ledger (mainnet binaries):
 * F against `ballast verify --json`, the redemption payout against §10's formula, the bid bin price
 * against the price DLMM stores in the bin, the executable bid net against a DLMM sell quote, and
 * the proof transactions against their own logs.
 *
 *   source ~/.ballast-env && pnpm localnet --quiet & ... && pnpm proof:local   # a launch to read
 *   pnpm -F app test
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import DLMM, { binIdToBinArrayIndex, deriveBinArray } from "@meteora-ag/dlmm";
import { BallastClient, binPriceQ64, LAUNCH_STATE } from "../../sdk/typescript/src/client";
import { loadFloor } from "../../sdk/typescript/src/floor";
import { buildRedeemTx, fFromS, loadModel, REDEEM_FEE_BPS } from "../src/model";

const REPO = resolve(__dirname, "../..");
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";

async function main(): Promise<void> {
  const conn = new Connection(RPC, "confirmed");
  const idl = JSON.parse(readFileSync(resolve(REPO, "target/idl/ballast.json"), "utf8"));
  const floor = await loadFloor(readFileSync(resolve(REPO, "target/wasm32-unknown-unknown/release/floor_wasm.wasm")));
  const client = new BallastClient(conn, idl);

  // The newest Open launch on the ledger (the proof launch after `pnpm proof:local`).
  const all = (await (client.program.account as never as { launch: { all(): Promise<{ publicKey: PublicKey; account: { state: number; registeredSlot: BN } }[]> } }).launch.all())
    .filter((x) => x.account.state === LAUNCH_STATE.open)
    .sort((a, b) => Number(b.account.registeredSlot.toString()) - Number(a.account.registeredSlot.toString()));
  const launch = process.env.LAUNCH ? new PublicKey(process.env.LAUNCH) : all[0]?.publicKey;
  if (!launch) throw new Error("no Open launch on this ledger — run pnpm proof:local first");

  const m = await loadModel(conn, idl, launch, floor);
  const verify = JSON.parse(execFileSync(resolve(REPO, "target/release/ballast"), ["verify", launch.toBase58(), "--rpc", RPC, "--json"], { maxBuffer: 64 << 20 }).toString());
  const sVerifier = BigInt(String(verify.s_now));

  const amount = 10_000_000_000_000n; // 10M tokens
  const payout = floor.payout(amount, m.s, REDEEM_FEE_BPS);
  const formula = (amount * m.s * m.s * BigInt(10_000 - REDEEM_FEE_BPS)) / ((1n << 128n) * 10_000n);

  const v = await client.view(launch);
  let storedBinPrice: bigint | null = null;
  // "You receive at least" against a real DLMM quote: sell a twentieth of what the bid can absorb
  // (so the whole sell fills in the bid's bin) and compare lamports per base unit, within 1 ppm.
  let bidQuote: { sold: string; out: string; pageNet: number; quoteNet: number } | null = null;
  if (m.bid.restingSol > 0) {
    const pair = await DLMM.create(conn, v.lbPair, { cluster: "mainnet-beta" });
    if (pair.lbPair.activeId === m.bid.binId && m.prices.bidNet !== null) {
      const sold = new BN(Math.floor((m.bid.restingSol * 1e9) / (m.prices.bidBin! * 1e3) / 20));
      const q = pair.swapQuote(sold, true, new BN(0), await pair.getBinArrayForSwap(true, 6));
      bidQuote = { sold: sold.toString(), out: q.outAmount.toString(), pageNet: m.prices.bidNet, quoteNet: (Number(q.outAmount.toString()) / Number(sold.toString())) * 1e-3 };
    }
    const arr = deriveBinArray(v.lbPair, binIdToBinArrayIndex(new BN(m.bid.binId)), pair.program.programId)[0];
    const binArr = (await pair.program.account.binArray.fetch(arr)) as { bins: { price: BN }[] };
    const lower = Number(binIdToBinArrayIndex(new BN(m.bid.binId)).toString()) * 70;
    storedBinPrice = BigInt(binArr.bins[m.bid.binId - lower].price.toString());
  }
  const logs = async (sig: string | null) => (sig ? (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [] : []);
  const shareSum = m.composition.lockedPool + m.composition.vaultBid;
  // A wallet sends the redemption without a lookup table: it must fit on its own.
  const redeemTx = await buildRedeemTx(conn, idl, launch, v.partnerAuth, amount, 0n);

  const checks: Record<string, boolean> = {
    floorViewEqualsFloorCrate: m.floorMatches,
    fEqualsVerifier: m.s === sVerifier,
    fDisplayFromS: m.prices.F === fFromS(sVerifier),
    payoutEqualsFormula: payout === formula,
    redemptionBelowF: m.prices.redemption < m.prices.F,
    bidBinPriceEqualsDlmm: storedBinPrice === null || storedBinPrice === binPriceQ64(m.bid.binId, v.binStep),
    bidAtOrBelowF: m.prices.bidBin === null || m.prices.bidBin <= m.prices.F,
    bidNetEqualsDlmmQuote: bidQuote === null || Math.abs(bidQuote.quoteNet / bidQuote.pageNet - 1) < 1e-6,
    compositionCoversSupply: shareSum >= 0.999999 && shareSum < 1.001,
    predictionTxIsRegistration: (await logs(m.proof.predictionTx)).some((l) => l.includes("Instruction: RegisterLaunch")),
    openTxIsOpen: (await logs(m.proof.openTx)).some((l) => l.includes("Instruction: Open")),
    realisedAtLeastPredicted: m.prices.F >= m.predictedF,
    tokenNamedFromMetadata: m.token !== null && m.token.name.length > 0 && m.token.symbol.length > 0,
    redeemTxFitsWithoutLookupTable: redeemTx.size <= 1232,
  };
  console.log(JSON.stringify({ launch: launch.toBase58(), token: m.token, redeemTxBytes: redeemTx.size, F: m.prices.F, s: m.s.toString(), prices: m.prices, composition: m.composition, bid: m.bid, bidQuote, checks }, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) {
    console.error(`FAIL: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`PASS: ${Object.keys(checks).length} checks`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
