/**
 * D-021 time-boxed experiment (mainnet DLMM binary, D-001): does a dust bid placed in the D-011 launch
 * transaction stop a third party from pinning the pair's active bin far below F before `open`?
 *
 *   X1  the owner's spec: a dust bid at the predicted floor's bin. At launch the active bin is p0's,
 *       below that bin, and DLMM refuses a bid above the active bin (6105) — expected refused.
 *   X2  the only placement that can block a downward pin: a dust bid one bin below the launch's active
 *       bin. go_to_a_bin to the pair's minimum bin (−35,163 at bin step 10; dlmm-bin-range.json) must
 *       then cross it (expected 6056).
 *   X3  the griefer sells a few base units into that dust bid (anyone can buy base on the curve),
 *       filling it, and retries the move.
 *
 * Ownership does not enter DLMM's range check, so a wallet stands in for partner_auth here; if the
 * dust bid blocked the pin, Ballast would place it from partner_auth by CPI in register_launch.
 *
 *   pnpm exec tsx tests/integration/program/tools/d021-dust-experiment.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import DLMM, { binIdToBinArrayIndex, deriveBinArray } from "@meteora-ag/dlmm";
import { conn, Landed, payer, REPO, send } from "../../p0/src/env";
import { PROOF, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { buy } from "../../p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceStrict, wallet, wrapIxs } from "../../p0/src/wallets";
import { ballast, errorName, pdas } from "../src/client";
import { DLMM_ID, launch } from "../src/launch";
import { dbcConfig } from "../src/part3";

const OPT = { cluster: "mainnet-beta" as const };
const noCb = (ixs: TransactionInstruction[]) => ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
const code = (t: Landed) => (t.err ? errorName(t.logs) ?? t.logs.find((l) => /custom program error|Error Code/.test(l)) ?? JSON.stringify(t.err) : "succeeded");
const arrayOf = (pair: PublicKey, id: number) => deriveBinArray(pair, binIdToBinArrayIndex(new BN(id)), DLMM_ID)[0];
const extOf = (pair: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bitmap"), pair.toBuffer()], DLMM_ID)[0];

async function main(): Promise<void> {
  const admin = wallet("program.admin");
  const creator = await funded("program.x.creator", 5);
  const bidder = await funded("program.x.bidder", 5);
  const griefer = await funded("program.x.griefer", 5);
  await send("x: WSOL", [...wrapIxs(payer, 20_000_000n)], []);
  await send("x: bidder WSOL", wrapIxs(bidder, 100_000_000n), [bidder]);
  await send("x: griefer WSOL", wrapIxs(griefer, 500_000_000n), [griefer]);
  const classConfig = await dbcConfig("x class");
  await send("x: create_class", [
    await ballast.methods.createClass(0).accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig }).instruction(),
  ], [admin]);
  const l = await launch("x launch", classConfig, creator, sqrtPriceQ64(PROOF.p0));
  if (l.landed.err) throw new Error(`launch: ${errorName(l.landed.logs)}`);
  const pair = await DLMM.create(conn, l.lbPair, OPT);
  const active0 = pair.lbPair.activeId;
  // The deepest reachable bin: the pair's min_bin_id (−35,163 at bin step 10; dlmm-bin-range.json).
  const PIN = (pair.lbPair.parameters as unknown as { minBinId: number }).minBinId;
  const floorBin = -11_920; // §27 Proof prediction's bin at 10 bps (floor_ix::tests)
  const out: Record<string, unknown> = { lbPair: l.lbPair.toBase58(), activeAtLaunch: active0, predictedFloorBin: floorBin, pin: PIN };

  const init = async (ids: number[], who: Keypair) => {
    const p = await DLMM.create(conn, l.lbPair, OPT);
    const idx = [...new Set(ids.map((i) => binIdToBinArrayIndex(new BN(i)).toString()))].map((s) => new BN(s));
    for (const ix of noCb(await p.initializeBinArrays(idx, who.publicKey))) await send("x: init bin array", [ix], [who], { feePayer: who, cu: 400_000 });
  };
  const bid = async (label: string, id: number, amount: bigint) => {
    await init([id], bidder);
    const p = await DLMM.create(conn, l.lbPair, OPT);
    const order = Keypair.generate();
    const tx = await p.placeLimitOrder({
      owner: bidder.publicKey, payer: bidder.publicKey, sender: bidder.publicKey, limitOrder: order.publicKey,
      params: { isAskSide: false, relativeBin: null, bins: [{ id, amount: new BN(amount.toString()) }] } as never,
    });
    const t = await send(`x: ${label}`, tx.instructions.filter((ix) => ix.programId.equals(DLMM_ID)), [bidder, order], { feePayer: bidder, cu: 400_000, expectFail: true });
    return { label, bin: id, amount: amount.toString(), result: code(t), signature: t.signature };
  };
  const goTo = async (label: string, to: number) => {
    const p = await DLMM.create(conn, l.lbPair, OPT);
    const from = p.lbPair.activeId;
    const opt = async (id: number) => ((await conn.getAccountInfo(arrayOf(l.lbPair, id))) ? arrayOf(l.lbPair, id) : null);
    const ix = await p.program.methods.goToABin(to)
      .accountsPartial({ lbPair: l.lbPair, binArrayBitmapExtension: null, fromBinArray: await opt(from), toBinArray: await opt(to) } as never)
      .instruction();
    const t = await send(`x: ${label}`, [ix], [griefer], { feePayer: griefer, cu: 400_000, expectFail: true });
    await p.refetchStates();
    return { label, from, to, result: code(t), signature: t.signature, activeAfter: (await DLMM.create(conn, l.lbPair, OPT)).lbPair.activeId };
  };

  out.x1_bidAtPredictedFloorBin = await bid("X1 dust bid at the predicted floor's bin", floorBin, 1_000n);
  out.x2_dustBidBelowActive = await bid("X2 dust bid one bin below the launch's active bin", active0 - 1, 1_000n);
  await init([PIN], griefer);
  out.x2_pinAcrossDust = await goTo("X2 go_to_a_bin(min bin) across the dust bid", PIN);

  // X3: the griefer buys a little base on the live curve, sells it into the dust bid, retries.
  await send("x: griefer base ATA", [ensureAtaIx(l.baseMint.publicKey, griefer.publicKey)]); // the payer funds and signs
  await buy("x: griefer buys base on the curve", griefer, l.pool, 10_000_000n);
  const base0 = await tokenBalanceStrict(ata(l.baseMint.publicKey, griefer.publicKey));
  // A swap that searches past the internal bitmap needs the pair's bitmap extension (6036 without
  // it); a griefer creates it permissionlessly, as for the deep pin.
  const p3 = await DLMM.create(conn, l.lbPair, OPT);
  if (!(await conn.getAccountInfo(extOf(l.lbPair)))) {
    await send("x: griefer creates the bitmap extension", [
      await p3.program.methods.initializeBinArrayBitmapExtension()
        .accountsPartial({ lbPair: l.lbPair, binArrayBitmapExtension: extOf(l.lbPair), funder: griefer.publicKey, rent: SYSVAR_RENT_PUBKEY } as never).instruction(),
    ], [griefer], { feePayer: griefer });
  }
  const p4 = await DLMM.create(conn, l.lbPair, OPT);
  // Sell exactly what the dust bid absorbs (partial-fill quote → consumed input).
  const arrs = await p4.getBinArrayForSwap(true);
  const q = p4.swapQuote(new BN(1_000_000_000), true, new BN(10_000), arrs, true);
  const sell = BigInt(q.consumedInAmount.toString());
  const sw = await p4.swap({ inToken: l.baseMint.publicKey, outToken: WSOL, inAmount: new BN(sell.toString()), minOutAmount: new BN(0), lbPair: l.lbPair, user: griefer.publicKey, binArraysPubkey: q.binArraysPubkey });
  const st = await send("x: griefer sells into the dust bid", noCb(sw.instructions), [griefer], { feePayer: griefer, cu: 400_000, expectFail: true });
  out.x3_fillDust = { result: code(st), signature: st.signature, baseSold: (base0 - (await tokenBalanceStrict(ata(l.baseMint.publicKey, griefer.publicKey)))).toString() };
  out.x3_pinAfterFill = await goTo("X3 go_to_a_bin(min bin) after filling the dust bid", PIN);

  const filled = (out.x3_fillDust as { result: string }).result === "succeeded";
  const blocked = (out.x3_pinAfterFill as { result: string }).result !== "succeeded";
  out.conclusion = !filled
    ? "INCONCLUSIVE: the griefer's fill of the dust bid did not execute, so whether a filled dust order still blocks the pin is untested"
    : blocked
    ? "the dust bid blocks the pin even after a griefer fills it — keep it (record in D-021)"
    : "a dust bid does not stop the pin: at the predicted floor's bin DLMM refuses it outright (above the active bin); below the active bin anyone fills it with a few base units and then moves the active bin freely. Dropped; D-021's cap/suspend rule carries the guarantee.";
  void SystemProgram; void TOKEN_PROGRAM_ID;
  const path = resolve(REPO, "evidence/program/part2/d021-dust-experiment.json");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
