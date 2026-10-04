/**
 * Q8 + Q9 (pair) and Q5 + Q9 (orders) on the mainnet DLMM binary (D-001), for the Proof scenario's
 * graduated token (base = token X, WSOL = token Y, §9).
 *
 *   dlmm-pair   Q9 scans (bin step, base fee, funder with zero base balance) by simulation; the real
 *               LimitOrder pair created by the partner_auth PDA via CPI (Q8); uniqueness; creator powers
 *   dlmm-order  Q9 order limits by simulation; Q5: PDA places a one-bin bid far below the active bin,
 *               a seller fills part of it, a buyer tries to take the filled base back (fills persist?),
 *               the PDA cancels; balances reconciled against the order's own accounting
 */
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createSyncNativeInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import DLMM, { binIdToBinArrayIndex, deriveBinArrayBitmapExtension, deriveCustomizablePermissionlessLbPair, isOverflowDefaultBinArrayBitmap } from "@meteora-ag/dlmm";
import { conn, dumpAccount, payer, send, sendSdkTx, writeEvidence } from "../env";
import { WSOL } from "../config";
import { dammPool, norm } from "../flow";
import { PdaKind, pda } from "../proxy";
import { sendWithPdas, sendWithPdasAlt, simulateWithPdas } from "../pdasend";
import { need, saveState } from "../state";
import { ata, ensureAtaIx, funded, tokenBalance, wallet } from "../wallets";

const pk = (s: string) => new PublicKey(s);
/** T7: the SDK's "localhost" program id is NOT mainnet DLMM; always pin mainnet-beta. */
const OPT = { cluster: "mainnet-beta" as const };
const DLMM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const BID_BIN = -11_920; // §27 Proof bid bin (10 bps)

function activeIdFromDamm(sqrtPrice: bigint, binStep: number): number {
  const price = Number(sqrtPrice) ** 2 / 2 ** 128; // lamports per base unit
  return Math.floor(Math.log(price) / Math.log(1 + binStep / 10_000));
}

async function pairTx(binStep: number, feeBps: number, activeId: number, creator: PublicKey, baseMint: PublicKey, onOff = false) {
  return DLMM.createCustomizablePermissionlessLbPair2(
    conn, new BN(binStep), baseMint, WSOL, new BN(activeId), new BN(feeBps),
    0, false, creator, undefined, onOff, 0 /* LimitOrder */, 1 /* OnlyY */, OPT,
  );
}

export async function dlmmPair(): Promise<void> {
  const config = pk(need("proof.config"));
  const baseMint = pk(need("proof.baseMint"));
  const damm = pk(need("proof.damm"));
  const partner = pda(PdaKind.partnerAuth, config);
  const sqrt = BigInt((await dammPool(damm)).sqrtPrice as string);

  // ---- Q9 by simulation: a throwaway funder with a ZERO base balance (can a pair be created
  //      before anyone holds the token, i.e. in the same tx as the DBC pool? §9) ----
  const scout = wallet("dlmm.scout");
  await funded("dlmm.scout", 5);
  await send("dlmm scout ATAs (base ATA left empty)", [ensureAtaIx(baseMint, scout.publicKey), ensureAtaIx(WSOL, scout.publicKey)]);
  const scan = async (binStep: number, feeBps: number) => {
    try {
      const tx = await pairTx(binStep, feeBps, activeIdFromDamm(sqrt, binStep), scout.publicKey, baseMint);
      const r = await simulateWithPdas(tx, []);
      return { binStep, feeBps, ok: r.err === null, code: r.customCode, error: r.logs.filter((l) => l.includes("Error")).slice(-1)[0] ?? null };
    } catch (e) {
      return { binStep, feeBps, ok: false, code: null, error: `SDK: ${(e as Error).message ?? e}` };
    }
  };
  // Q8/§9: the funder must hold the base token ("token launch proof", 6060 with a zero balance).
  // Find the smallest balance accepted by topping the scout up from a buyer wallet.
  const zeroBalance = await scan(10, 10);
  const donor = wallet("proof.buyer0");
  const { createTransferInstruction } = await import("@solana/spl-token");
  const proof: Record<string, unknown>[] = [{ balance: "0", ...zeroBalance }];
  let held = 0n;
  for (const target of [1n, 1_000_000n, 1_000_000_000n, 1_000_000_000_000n, 10_000_000_000_000n, 100_000_000_000_000n]) {
    await send(`dlmm scout: top up base to ${target}`, [
      createTransferInstruction(ata(baseMint, donor.publicKey), ata(baseMint, scout.publicKey), donor.publicKey, target - held),
    ], [donor]);
    held = target;
    const r = await scan(10, 10);
    proof.push({ balance: target.toString(), ...r });
    if (r.ok || r.code !== 6060) break;
  }
  console.log({ launchProof: proof });
  const binSteps = [];
  for (const bs of [1, 2, 4, 5, 8, 10, 16, 20, 25, 50, 80, 100]) binSteps.push(await scan(bs, Math.max(bs, 10)));
  const fees10 = [];
  for (const f of [1, 2, 5, 10, 15, 20, 25, 50, 100]) fees10.push(await scan(10, f));
  console.log({ binSteps: binSteps.map((b) => `${b.binStep}:${b.ok ? "ok" : b.code}`), fees10: fees10.map((f) => `${f.feeBps}:${f.ok ? "ok" : f.code}`) });

  // ---- Q8: the real pair, created by the partner_auth PDA via CPI (funder holds leftover base) ----
  const activeId = activeIdFromDamm(sqrt, 10);
  const minFee10 = fees10.find((f) => f.ok)?.feeBps ?? 10;
  const [lbPair] = deriveCustomizablePermissionlessLbPair(baseMint, WSOL, DLMM_ID);
  const createTx = await pairTx(10, minFee10, activeId, partner.address, baseMint);
  const created = await sendWithPdas("Q8: initialize_customizable_permissionless_lb_pair2 by partner_auth via CPI", createTx, [partner], [], { expectFail: true });
  let createdBy = "partner_auth PDA via CPI";
  let createdSig = created.signature;
  if (created.err) {
    createdBy = "top-level (wallet) — CPI attempt failed";
    const funder = await funded("dlmm.funder", 5);
    createdSig = (await sendSdkTx("Q8: pair top-level (fallback)", await pairTx(10, minFee10, activeId, funder.publicKey, baseMint), [funder], { feePayer: funder })).signature;
  }

  // Uniqueness: a second customizable pair for the same mints with another bin step.
  const second = await scan(25, 25);
  // Creator powers: the creator tries to disable the pool (creator_pool_on_off_control = false).
  const pairApi = await DLMM.create(conn, lbPair, OPT);
  const statusIx = await pairApi.program.methods.setPairStatusPermissionless(1).accountsPartial({ lbPair, signer: partner.address }).instruction();
  const statusTry = await sendWithPdas("Q8: creator set_pair_status_permissionless (on/off control = false)", [statusIx], [partner], [], { expectFail: true });
  const lb = norm(pairApi.lbPair) as Record<string, unknown>;

  const result = {
    question: "Q8 — customizable permissionless LimitOrder pair: seeds, uniqueness, creator powers, PDA via CPI",
    funderMustHoldBaseToken: proof,
    seeds: "[ILM_BASE, min(mintX, mintY), max(mintX, mintY)] — no bin step (SDK deriveCustomizablePermissionlessLbPair)",
    lbPair: lbPair.toBase58(),
    createdBy,
    createSignature: createdSig,
    cpiAttempt: { signature: created.signature, err: created.err, errorLog: created.logs.filter((l) => l.includes("Error")) },
    params: { binStep: 10, feeBps: minFee10, activeId, concreteFunctionType: "LimitOrder (0)", collectFeeMode: "OnlyY (1)", activation: "slot, immediate", creatorPoolOnOffControl: false },
    uniqueness_secondPairOtherBinStep: second,
    creatorDisableAttempt: { signature: statusTry.signature, refused: statusTry.err !== null, err: statusTry.err, errorLog: statusTry.logs.filter((l) => l.includes("Error")) },
    statusChangers: "set_pair_status requires an `operator` account + signer (Meteora operator); set_pair_status_permissionless only for a creator with creator_pool_on_off_control (IDL)",
    lbPairState: { creator: lb.creator, status: lb.status, pairType: lb.pairType, activeId: lb.activeId, binStep: lb.binStep, creatorPoolOnOffControl: lb.creatorPoolOnOffControl },
  };
  writeEvidence("Q8/result.json", result);
  writeEvidence("Q9/pair-scans.json", {
    question: "Q9 — allowed bin steps / base fees for customizable LimitOrder pairs (simulated)",
    launchProofBalanceSearch: proof,
    binSteps,
    feesAtBinStep10: fees10,
  });
  writeEvidence("Q8/lb-pair-account.json", await dumpAccount(lbPair));
  writeEvidence("Q8/lb-pair-sdk-decode.json", lb);
  saveState({ "dlmm.lbPair": lbPair.toBase58() });
  console.log(JSON.stringify(result, null, 2));
}

export async function dlmmOrder(): Promise<void> {
  const config = pk(need("proof.config"));
  const pool = pk(need("proof.pool"));
  const baseMint = pk(need("proof.baseMint"));
  const lbPair = pk(need("dlmm.lbPair"));
  const partner = pda(PdaKind.partnerAuth, config);
  const vault = pda(PdaKind.vault, pool);
  const pair = await DLMM.create(conn, lbPair, OPT);

  // ---- bitmap extension needs (Q9) ----
  const arrIdx = binIdToBinArrayIndex(new BN(BID_BIN));
  const bitmap = { bidBin: BID_BIN, binArrayIndex: arrIdx.toString(), needsBitmapExtension: isOverflowDefaultBinArrayBitmap(arrIdx) };
  if (bitmap.needsBitmapExtension) {
    const ext = await pair.program.methods.initializeBinArrayBitmapExtension().accountsPartial({
      lbPair, binArrayBitmapExtension: deriveBinArrayBitmapExtension(lbPair, DLMM_ID)[0], funder: payer.publicKey,
    }).instruction();
    await send("Q9: initialize_bin_array_bitmap_extension", [ext]);
  }
  const initArrays = await pair.initializeBinArrays([arrIdx], payer.publicKey);
  if (initArrays.length) await send("Q9: initialize_bin_array for the bid bin", initArrays);

  // ---- Q9 order limits by simulation (PDA as sender/owner/payer) ----
  const placeTx = async (bins: { id: number; amount: bigint }[], order: Keypair) =>
    pair.placeLimitOrder({
      owner: partner.address, payer: partner.address, sender: partner.address, limitOrder: order.publicKey,
      params: { isAskSide: false, relativeBin: null, bins: bins.map((b) => ({ id: b.id, amount: new BN(b.amount.toString()) })) } as never,
    });
  // The order limits do not depend on who signs, so they are probed with a plain wallet,
  // top-level (a 50-bin order wrapped through the proxy does not fit in 1,232 bytes), through an
  // address lookup table for the larger orders.
  const limiter = await funded("dlmm.limiter", 5);
  await send("dlmm limiter WSOL", (await import("../wallets")).wrapIxs(limiter, 2_000_000_000n), [limiter]);
  const limiterTx = async (bins: { id: number; amount: bigint }[], order: Keypair) =>
    pair.placeLimitOrder({
      owner: limiter.publicKey, payer: limiter.publicKey, sender: limiter.publicKey, limitOrder: order.publicKey,
      params: { isAskSide: false, relativeBin: null, bins: bins.map((b) => ({ id: b.id, amount: new BN(b.amount.toString()) })) } as never,
    });
  // Bin arrays for a 51-bin span below the bid bin.
  const spanIdx = [...new Set([BID_BIN, BID_BIN - 50].map((b) => binIdToBinArrayIndex(new BN(b)).toString()))].map((s) => new BN(s));
  const spanInit = await pair.initializeBinArrays(spanIdx, payer.publicKey);
  if (spanInit.length) await send("Q9: initialize bin arrays for the 51-bin span", spanInit);
  const probeTx = await limiterTx(Array.from({ length: 2 }, (_, i) => ({ id: BID_BIN - i, amount: 1n })), Keypair.generate());
  const { ComputeBudgetProgram } = await import("@solana/web3.js");
  const altKeys = [...new Map(probeTx.instructions.flatMap((ix) => [ix.programId, ...ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey)]).map((k) => [k.toBase58(), k])).values()];
  const alt = await (await import("../env")).createAlt("Q9 limits", [...altKeys, ComputeBudgetProgram.programId]);
  const simPlace = async (bins: { id: number; amount: bigint }[]) => {
    const order = Keypair.generate();
    const tx = await limiterTx(bins, order);
    const r = await (await import("../env")).simulate(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))],
      limiter.publicKey,
      [alt],
    );
    return { bins: bins.length, amount: bins[0].amount.toString(), ok: r.err === null, code: r.customCode, cu: r.cu, error: r.logs.filter((l) => l.includes("Error")).slice(-1)[0] ?? null };
  };
  const minSize = [];
  for (const a of [1n, 10n, 1_000n, 100_000n, 1_000_000n]) minSize.push(await simPlace([{ id: BID_BIN, amount: a }]));
  const fiftyDesc = await simPlace(Array.from({ length: 50 }, (_, i) => ({ id: BID_BIN - i, amount: 1_000_000n })));
  const fifty = await simPlace(Array.from({ length: 50 }, (_, i) => ({ id: BID_BIN - 49 + i, amount: 1_000_000n })));
  const fiftyOne = await simPlace(Array.from({ length: 51 }, (_, i) => ({ id: BID_BIN - 50 + i, amount: 1_000_000n })));
  console.log({ minSize: minSize.map((m) => `${m.amount}:${m.ok ? "ok" : m.code}`), fiftyDesc, fifty, fiftyOne });

  // ---- Q5: place for real, by the PDA via CPI, fresh keypair order account signing outside ----
  //
  // Two preconditions that an earlier version of this step assumed and that do NOT hold on a
  // clean ledger:
  //
  //  1. `place_limit_order` requires the owner's token accounts to exist. Filtering the SDK's
  //     transaction down to DLMM instructions alone drops its ATA-creation instructions, and the
  //     program then fails with `3012 AccountNotInitialized caused by account: user_token`.
  //  2. `partner_auth` does not necessarily hold any WSOL. Q4 established that
  //     `claim_trading_fee` and `partner_withdraw_surplus` accept a destination not owned by the
  //     fee claimer, and this harness sends them to the *vault* PDA's ATA — so the migration fee
  //     and the claims are not in `partner_auth`'s own ATA at all.
  //
  // Both are fixed explicitly rather than by un-filtering, so the placement transaction still
  // contains exactly the one DLMM instruction whose CPI behaviour Q5 is about.
  const order = Keypair.generate();
  const partnerWsol = ata(WSOL, partner.address);
  const partnerBase = ata(baseMint, partner.address);
  await send("Q5: ensure partner_auth token accounts (quote in, base on fill)", [
    ensureAtaIx(WSOL, partner.address),
    ensureAtaIx(baseMint, partner.address),
  ]);

  // Size the bid to what the PDA actually holds; top up from the payer if it is short, and record
  // that this top-up is harness funding, not a protocol flow.
  const wantBid = 1_000_000_000n; // 1 SOL
  const held = await tokenBalance(partnerWsol);
  const toppedUp = held < wantBid ? wantBid - held : 0n;
  if (toppedUp > 0n) {
    await send("Q5: harness top-up of partner_auth WSOL (not a protocol flow)", [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: partnerWsol, lamports: Number(toppedUp) }),
      createSyncNativeInstruction(partnerWsol),
    ]);
  }
  const bidAmount = await tokenBalance(partnerWsol);
  if (bidAmount === 0n) throw new Error("Q5: partner_auth holds no WSOL to bid with");
  const w0 = bidAmount;
  // Only the DLMM instruction, so the CPI under test is isolated; the accounts it needs were
  // created above.
  const dlmmOnly = (tx: { instructions: import("@solana/web3.js").TransactionInstruction[] }) => tx.instructions.filter((ix) => ix.programId.equals(DLMM_ID));
  const placed = await sendWithPdasAlt("Q5: place_limit_order (PDA sender = owner = payer) via CPI", dlmmOnly(await placeTx([{ id: BID_BIN, amount: bidAmount }], order)), [partner], [order]);
  const w1 = await tokenBalance(ata(WSOL, partner.address));
  const afterPlace = norm(await pair.getLimitOrder(order.publicKey));

  // A seller fills part of the bid (X → Y through bin BID_BIN).
  const seller = await funded("proof.buyer0", 5);
  const sellAmount = 50_000_000_000_000n; // 50M tokens ≈ 1/3 of the bid's capacity at bin -11,920
  await pair.refetchStates();
  const binArraysSell = await pair.getBinArrayForSwap(true);
  const sq = pair.swapQuote(new BN(sellAmount.toString()), true, new BN(10_000), binArraysSell);
  const sB0 = await tokenBalance(ata(WSOL, seller.publicKey));
  const sX0 = await tokenBalance(ata(baseMint, seller.publicKey));
  const sellTx = await pair.swap({ inToken: baseMint, outToken: WSOL, inAmount: new BN(sellAmount.toString()), minOutAmount: new BN(0), lbPair, user: seller.publicKey, binArraysPubkey: sq.binArraysPubkey });
  const sold = await sendSdkTx("Q5: seller swaps X→Y through the bid", sellTx, [seller], { feePayer: seller });
  const sellerGotY = (await tokenBalance(ata(WSOL, seller.publicKey))) - sB0;
  const sellerGaveX = sX0 - (await tokenBalance(ata(baseMint, seller.publicKey)));
  const afterFill = norm(await pair.getLimitOrder(order.publicKey));

  // Do fills stay filled? A buyer tries to take base back (Y → X) through the same bin.
  const buyer = await funded("dlmm.buyer", 5);
  await send("dlmm buyer ATAs + wrap", [ensureAtaIx(baseMint, buyer.publicKey), ...(await import("../wallets")).wrapIxs(buyer, 500_000_000n)], [buyer]);
  await pair.refetchStates();
  let reverse: Record<string, unknown>;
  try {
    const binArraysBuy = await pair.getBinArrayForSwap(false);
    const bq = pair.swapQuote(new BN(100_000_000), false, new BN(10_000), binArraysBuy, true);
    const buyTx = await pair.swap({ inToken: WSOL, outToken: baseMint, inAmount: new BN(100_000_000), minOutAmount: new BN(0), lbPair, user: buyer.publicKey, binArraysPubkey: bq.binArraysPubkey });
    const t = await sendSdkTx("Q5: buyer swaps Y→X back through the filled bin", buyTx, [buyer], { feePayer: buyer, expectFail: true });
    reverse = { signature: t.signature, err: t.err, errorLog: t.logs.filter((l) => l.includes("Error")), quote: norm(bq) };
  } catch (e) {
    reverse = { sdkRefused: (e as Error).message ?? String(e) };
  }
  const afterReverse = norm(await pair.getLimitOrder(order.publicKey));

  // Cancel by the PDA via CPI: first to a destination it does not own (vault PDA), then its own.
  await send("vault PDA ATAs", [ensureAtaIx(WSOL, vault.address), ensureAtaIx(baseMint, vault.address)]);
  const cancelTx = async (destOwner: PublicKey) => {
    const tx = await pair.cancelLimitOrder({ limitOrderPubkey: order.publicKey, owner: partner.address, rentReceiver: partner.address, binIds: [BID_BIN] });
    // Point the payout accounts at `destOwner`'s ATAs (the SDK uses the owner's).
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(DLMM_ID)) continue;
      ix.keys = ix.keys.map((k) =>
        k.pubkey.equals(ata(baseMint, partner.address)) ? { ...k, pubkey: ata(baseMint, destOwner) }
        : k.pubkey.equals(ata(WSOL, partner.address)) ? { ...k, pubkey: ata(WSOL, destOwner) } : k);
    }
    return tx;
  };
  const vX0 = await tokenBalance(ata(baseMint, vault.address));
  const vY0 = await tokenBalance(ata(WSOL, vault.address));
  const cForeign = await sendWithPdasAlt("Q5: cancel_limit_order via CPI → vault PDA's accounts (not the owner's)", dlmmOnly(await cancelTx(vault.address)), [partner], [], { expectFail: true });
  let cancelled = cForeign;
  let destination = "vault PDA (foreign)";
  const pX0 = await tokenBalance(ata(baseMint, partner.address));
  const pY0 = await tokenBalance(ata(WSOL, partner.address));
  if (cForeign.err) {
    destination = "owner (partner_auth) — foreign destination refused";
    cancelled = await sendWithPdasAlt("Q5: cancel_limit_order via CPI → owner's accounts", dlmmOnly(await cancelTx(partner.address)), [partner], []);
  }
  const gotX = destination.startsWith("vault") ? (await tokenBalance(ata(baseMint, vault.address))) - vX0 : (await tokenBalance(ata(baseMint, partner.address))) - pX0;
  const gotY = destination.startsWith("vault") ? (await tokenBalance(ata(WSOL, vault.address))) - vY0 : (await tokenBalance(ata(WSOL, partner.address))) - pY0;
  const orderAccountAfterCancel = await conn.getAccountInfo(order.publicKey);

  const fill = afterFill as { totalFilledAmountX: string; totalUnfilledAmountY: string; totalFeeAmountX: string; totalFeeAmountY: string; totalSwappedAmountY: string };
  const result = {
    question: "Q5 — PDA places/cancels DLMM limit orders via CPI; fills persist; cancel returns unfilled + filled + fees",
    lbPair: lbPair.toBase58(),
    order: order.publicKey.toBase58(),
    bidBin: BID_BIN,
    place: { signature: placed.signature, cu: placed.cu, amountY: bidAmount.toString(), pdaWsolSpent: (w0 - w1).toString() },
    sell: { signature: sold.signature, sellerGaveX: sellerGaveX.toString(), sellerGotY: sellerGotY.toString(), quote: norm(sq) },
    orderAfterPlace: afterPlace,
    orderAfterFill: afterFill,
    reverseSwapThroughFilledBin: reverse,
    orderAfterReverse: afterReverse,
    fillsPersist: JSON.stringify((afterFill as Record<string, unknown>).totalFilledAmountX) === JSON.stringify((afterReverse as Record<string, unknown>).totalFilledAmountX),
    cancel: {
      foreignDestinationAttempt: { signature: cForeign.signature, err: cForeign.err, errorLog: cForeign.logs.filter((l) => l.includes("Error")) },
      destinationUsed: destination,
      signature: cancelled.signature,
      cu: cancelled.cu,
      receivedX: gotX.toString(),
      receivedY: gotY.toString(),
      expectedFromOrder: { filledX: fill.totalFilledAmountX, unfilledY: fill.totalUnfilledAmountY, feeX: fill.totalFeeAmountX, feeY: fill.totalFeeAmountY },
      orderAccountClosed: orderAccountAfterCancel === null,
    },
  };
  writeEvidence("Q5/result.json", result);
  writeEvidence("Q9/order-limits.json", {
    question: "Q9 — order limits (simulated; PDA as sender/owner/payer)",
    bitmap,
    minimumOrderSize: minSize,
    fiftyBinsAscending: fifty,
    fiftyBinsDescending: fiftyDesc,
    fiftyOneBinsAscending: fiftyOne,
  });
  saveState({ "dlmm.lastOrder": order.publicKey.toBase58() });
  console.log(JSON.stringify({ ...result, orderAfterPlace: undefined, sell: { ...result.sell, quote: undefined } }, null, 2));
  void TOKEN_PROGRAM_ID;
}
