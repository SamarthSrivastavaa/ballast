/**
 * Program Part 2 — `open`, `refresh_floor`, `redeem`, `floor`, `harvest`, `deposit`, and `pay_creator`
 * once `Open` (§6, §8, §9, §10, D-020, D-021, D-022) on the mainnet-binary local validator (D-001).
 *
 *   Launch D is graduated, cleaned, then opened; launch E (same class) supplies foreign-but-real
 *   Meteora accounts for the substitution tests, then a third party pins its active bin 725 bins
 *   under F's bin before `open` (D-021: the DLMM leg is suspended, never stranded). Expected values
 *   come from independent sources: F from the Python reference (tests/reference/floor.py), bin prices
 *   from the DLMM SDK's exact `getQPriceFromId` and from the `price` DLMM itself stores in the bin,
 *   balances read back.
 *
 * Every negative case changes exactly one account or argument and must fail with the error the
 * check that owns it reports.
 */
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import DLMM, { binIdToBinArrayIndex } from "@meteora-ag/dlmm";
import { conn, payer, send } from "../../p0/src/env";
import { WSOL } from "../../../../compiler/src/canon";
import { cpAmm, dammPool, dammPosition, rawData, virtualPool } from "../../p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceStrict, wallet, wrapIxs } from "../../p0/src/wallets";
import { accounts, ballast, pdas } from "./client";
import {
  activeOf, altFor, arrays, big, binArrayOf, binAtOrBelow, cancelWalletOrder, cleanedLaunch, creatorDammAccounts, depositIx,
  events, expectedAfterSettle, expectedPayout, field, harvestIx, keeperArrays, liveInputs, OPT, Opened, OpenOver, openIx, payCreatorIx,
  pyFloor, qPrice, readFloor, redeemIx, refreshIx, sellIntoBid, transfersOutOf, waitSlots, walletOrder,
} from "./fixture";
import { ballastCu, dbcConfig, got, payCreator } from "./part3";
import { Suite } from "./runner";

const outcome = got;

export async function part4(): Promise<number> {
  const suite = new Suite("Program Part 2 — open, refresh_floor, redeem, floor, harvest, deposit, pay_creator (§6, §8, §9, §10)");
  const admin = wallet("program.admin");
  const creator = await funded("program.p2.creator", 10);
  const buyerD = await funded("program.p2.buyerD", 30);
  const buyerE = await funded("program.p2.buyerE", 30);

  // The payer funds each launch's dust buy from WSOL wrapped in advance (D-011), as part2.ts does.
  await send("part2: payer WSOL for dust buys", wrapIxs(payer, 20_000_000n), []);
  await send("part2: beneficiary WSOL ATA", [ensureAtaIx(WSOL, creator.publicKey)]);
  const classConfig = await dbcConfig("part2 class");
  await send("part2: create_class", [
    await ballast.methods.createClass(0)
      .accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig })
      .instruction(),
  ], [admin]);
  const D = await cleanedLaunch("part2 launch D", classConfig, creator, buyerD);
  const E = await cleanedLaunch("part2 launch E", classConfig, creator, buyerE);
  const pair = await DLMM.create(conn, D.l.lbPair, OPT);

  // §5: partner_auth holds lamports for order rent; the keeper funds it and creates its staging ATAs.
  await send("keeper: fund partner_auth for order rent; WSOL staging ATA", [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: D.partnerAuth, lamports: 100_000_000 }),
    ensureAtaIx(WSOL, D.partnerAuth),
  ]);

  // The expected floor at open, from the reference.
  const in0 = await liveInputs(D);
  const s0 = pyFloor(in0.v, in0.s, in0.l, in0.sMax);
  const hint = binAtOrBelow(s0);
  const rec0 = await accounts.launch.fetch(D.l.launch);
  const predicted = BigInt(rec0.predictedS.toString());

  // ---- open: positive on D, then the D-021 suspended path on E ---------------------------------
  const activeD0 = await activeOf(D);
  await keeperArrays(D, [hint, hint + 70]);
  const remD0 = arrays(D, [hint, activeD0]);
  const altD = await altFor(D, [...remD0, ...arrays(D, [hint + 70]), E.l.lbPair, E.l.vault, E.dammPool, E.partnerPosition, E.creatorPosition, E.partnerNft, E.creatorNft]);
  const tryOpen = async (label: string, x: OpenOver = {}, bin = hint) => {
    const order = Keypair.generate();
    return send(`open: ${label}`, [await openIx(D, order, bin, remD0, x)], [order], { cu: 600_000, alts: [altD], expectFail: true });
  };

  // ---- open: one defect each ----------------------------------------------------------------
  const openNegatives: [string, string, OpenOver, number?][] = [
    ["partner position from another launch's pool", "PositionWrongPool", { partnerPosition: E.partnerPosition, partnerNftAccount: E.partnerNft }],
    ["partner/creator positions swapped (NFT holder wrong)", "PositionNftHolder", {
      partnerPosition: D.creatorPosition, partnerNftAccount: D.creatorNft, creatorPosition: D.partnerPosition, creatorNftAccount: D.partnerNft,
    }],
    ["position owned by another program (the launch account)", "PositionInvalid", { partnerPosition: D.l.launch }],
    ["the same position twice", "PositionsNotDistinct", { creatorPosition: D.partnerPosition, creatorNftAccount: D.partnerNft }],
    ["creator NFT account is not the position's", "PositionNftHolder", { creatorNftAccount: E.creatorNft }],
    ["DAMM pool of another launch (not this launch's migrated pool)", "DammPoolNotMigrated", { dammPool: E.dammPool }],
    ["DAMM pool account owned by another program", "DammPoolInvalid", { dammPool: D.l.pool }],
    ["DLMM pair of another launch", "PairAccountsInvalid", { bid: { dlmmPair: E.l.lbPair } }],
    ["reserve_y not the pair's", "PairAccountsInvalid", { bid: { reserveY: D.reserveX } }],
    ["vault of another launch", "ConstraintSeeds", { bid: { vault: E.l.vault } }],
    ["partner_auth not the class PDA (order owner ≠ partner_auth)", "ConstraintSeeds", { bid: { partnerAuth: creator.publicKey } }],
    ["bin hint one above F's bin", "BinHintNotAtFloor", {}, hint + 1],
    ["bin hint one below F's bin (not the active bin)", "BinHintNotAtFloor", {}, hint - 1],
    ["bin array not passed (D-013)", "BinArrayMissing", { remaining: [] }],
    ["staging is not partner_auth's base ATA (D-012)", "StagingNotPartnerAta", { bid: { stagingBase: ata(D.base, payer.publicKey) } }],
  ];
  for (const [name, expected, x, bin] of openNegatives) {
    await suite.case(`open: ${name}`, async () => {
      const t = await tryOpen(name, x, bin ?? hint);
      return { status: outcome(t) === expected ? "pass" : "fail", expected, got: outcome(t), detail: { signature: t.signature } };
    });
  }
  await suite.case("refresh_floor before open (state Cleaned)", async () => {
    const order = Keypair.generate();
    const t = await send("refresh before open", [await refreshIx(D, order, order.publicKey, hint, remD0)], [order], { cu: 600_000, alts: [altD], expectFail: true });
    return { status: outcome(t) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: outcome(t) };
  });

  const order0 = Keypair.generate();
  await suite.case("open: launch D → Open; Ballast moves the active bin (D-020) and rests the whole vault at F's bin", async () => {
    const t = await send("open D", [await openIx(D, order0, hint, remD0)], [order0], { cu: 600_000, alts: [altD], expectFail: true });
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-25) } };
    const rec = await accounts.launch.fetch(D.l.launch);
    const vaultAfter = await tokenBalanceStrict(D.l.vault);
    const orderOwner = new PublicKey((await rawData(order0.publicKey)).subarray(40, 72));
    await pair.refetchStates();
    const binArr = await pair.program.account.binArray.fetch(binArrayOf(D.l.lbPair, hint));
    const lower = Number(binIdToBinArrayIndex(new BN(hint)).toString()) * 70;
    const storedPrice = BigInt((binArr as { bins: { price: BN }[] }).bins[hint - lower].price.toString());
    const sOpen = BigInt(rec.sOpen.toString());
    const opened = events(t).find((e) => e.name === "floorOpened" || e.name === "FloorOpened");
    const checks = {
      state: rec.state === 5,
      activeMovedByProgram: activeD0 < hint && pair.lbPair.activeId === hint,
      goToABinCpi: t.logs.some((l) => l.includes("Instruction: GoToABin")),
      sOpenEqualsReference: sOpen === s0,
      sOpenAtLeastPredicted: sOpen >= predicted,
      sLast: BigInt(rec.sLast.toString()) === sOpen,
      vaultEmptied: vaultAfter === 0n,
      committedIsWholeVault: BigInt(rec.bidQuoteCommitted.toString()) === in0.vault,
      binRecorded: rec.bidBinId === hint && rec.bidCapped === false && rec.bidSuspended === false,
      orderRecorded: new PublicKey(rec.bidOrder).equals(order0.publicKey),
      orderOwnerIsPartnerAuth: orderOwner.equals(D.partnerAuth),
      vendoredPriceEqualsStoredBinPrice: storedPrice === qPrice(hint),
      positionsRecorded: new PublicKey(rec.partnerPosition).equals(D.partnerPosition) && new PublicKey(rec.creatorPosition).equals(D.creatorPosition),
      lOpen: BigInt(rec.lOpen.toString()) === in0.l,
      perPositionL: BigInt(rec.partnerLRecorded.toString()) + BigInt(rec.creatorLRecorded.toString()) === in0.l,
      eventOrder: opened !== undefined && new PublicKey(field(opened.data, "order") as PublicKey).equals(order0.publicKey),
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks),
      detail: {
        signature: t.signature, txCu: t.cu, openCu: ballastCu(t), sOpen: sOpen.toString(), predicted: predicted.toString(),
        realisedOverPredicted: Number(sOpen) / Number(predicted), activeBefore: activeD0, bin: hint, binPrice: storedPrice.toString(),
        vault: in0.vault.toString(), v: in0.v.toString(), s: in0.s.toString(), l: in0.l.toString(), checks,
      },
    };
  });
  await suite.case("open: second call refused (state Open)", async () => {
    const t = await tryOpen("open D again");
    return { status: outcome(t) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: outcome(t) };
  });

  // ---- floor() view ----------------------------------------------------------------------------
  await suite.case("floor(): return data = Python reference on live V, S, L; bin price = DLMM's", async () => {
    const f = await readFloor(D);
    const live = await liveInputs(D);
    const ref = pyFloor(live.v, live.s, live.l, live.sMax);
    const rec = await accounts.launch.fetch(D.l.launch);
    const checks = {
      s: f.s === ref, v: f.v === live.v, sSupply: f.sSupply === live.s, l: f.l === live.l,
      fQ64: f.fQ64 === (f.s * f.s) >> 64n, sLast: f.sLast === BigInt(rec.sLast.toString()),
      bin: f.binId === rec.bidBinId, binPrice: f.binPrice === qPrice(rec.bidBinId), placed: f.capped === false && f.suspended === false,
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every field", got: ok ? "ok" : JSON.stringify(checks), detail: { s: f.s.toString(), cu: f.cu, checks } };
  });

  // ---- a seller fills part of the bid; refresh_floor settles it --------------------------------
  const holder = buyerD;
  await send("holder WSOL ATA", [ensureAtaIx(WSOL, holder.publicKey)]);
  await suite.case("fill: a seller swaps base → WSOL on the pair and fills part of Ballast's bid", async () => {
    const t = await sellIntoBid(D, holder, 30_000_000_000_000n); // 30M tokens
    const e = await expectedAfterSettle(D);
    return { status: !t.err && e.filled > 0n ? "pass" : "fail", expected: "filled > 0", got: `${outcome(t)} filled ${e.filled}`, detail: { signature: t.signature, filled: e.filled.toString(), back: e.back.toString() } };
  });

  await suite.case("refresh_floor: inside the rate limit is refused", async () => {
    const order = Keypair.generate();
    const rec = await accounts.launch.fetch(D.l.launch);
    const t = await send("refresh too soon", [await refreshIx(D, order, new PublicKey(rec.bidOrder), hint, arrays(D, [hint]))], [order], { cu: 600_000, alts: [altD], expectFail: true });
    return { status: outcome(t) === "RefreshRateLimited" ? "pass" : "fail", expected: "RefreshRateLimited", got: outcome(t) };
  });
  await waitSlots(12);

  const stranger = await funded("program.p2.stranger", 5);
  await send("stranger WSOL", wrapIxs(stranger, 500_000_000n), [stranger]);
  const foreign = await walletOrder(D, stranger, hint - 5, 1_000_000n);
  await suite.case("refresh_floor: a limit order owned by someone else (not launch.bid_order)", async () => {
    const order = Keypair.generate();
    const t = await send("refresh with a foreign order", [await refreshIx(D, order, foreign, hint, arrays(D, [hint, hint - 5]))], [order], { cu: 600_000, alts: [altD], expectFail: true });
    return { status: outcome(t) === "BidOrderMismatch" ? "pass" : "fail", expected: "BidOrderMismatch", got: outcome(t) };
  });
  {
    const e = await expectedAfterSettle(D);
    const want = binAtOrBelow(e.s);
    for (const [name, bin] of [["too high", want + 1], ["too low", want - 1]] as const) {
      await suite.case(`refresh_floor: bin hint ${name}`, async () => {
        const order = Keypair.generate();
        const rec = await accounts.launch.fetch(D.l.launch);
        const t = await send(`refresh hint ${name}`, [await refreshIx(D, order, new PublicKey(rec.bidOrder), bin, arrays(D, [hint, bin, want]))], [order], { cu: 600_000, alts: [altD], expectFail: true });
        return { status: outcome(t) === "BinHintNotAtFloor" ? "pass" : "fail", expected: "BinHintNotAtFloor", got: outcome(t) };
      });
    }
  }
  await suite.case("refresh_floor: cancel → burn the fill → F rises → whole vault re-placed at F's new bin", async () => {
    const e = await expectedAfterSettle(D);
    const want = binAtOrBelow(e.s);
    await keeperArrays(D, [want]);
    const before = await accounts.launch.fetch(D.l.launch);
    const supply0 = (await getMint(conn, D.base)).supply;
    const order = Keypair.generate();
    const t = await send("refresh D", [await refreshIx(D, order, new PublicKey(before.bidOrder), want, arrays(D, [hint, want, await activeOf(D)]))], [order], { cu: 600_000, alts: [altD], expectFail: true });
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } };
    const rec = await accounts.launch.fetch(D.l.launch);
    const supply1 = (await getMint(conn, D.base)).supply;
    const live = await liveInputs(D);
    const sNew = BigInt(rec.sLast.toString());
    const committed0 = BigInt(before.bidQuoteCommitted.toString());
    const checks = {
      fillBurned: supply0 - supply1 === e.filled,
      filledRecorded: BigInt(rec.filledTokens.toString()) - BigInt(before.filledTokens.toString()) === e.filled,
      fillQuoteSpent: BigInt(rec.fillQuoteSpent.toString()) - BigInt(before.fillQuoteSpent.toString()) === committed0 - e.back,
      sEqualsReference: sNew === e.s && sNew === pyFloor(live.v, live.s, live.l, live.sMax),
      fRose: sNew > BigInt(before.sLast.toString()),
      reweighted: BigInt(rec.bidQuoteCommitted.toString()) === e.back && live.vault === 0n,
      newBin: rec.bidBinId === want && rec.bidCapped === false,
      newOrder: new PublicKey(rec.bidOrder).equals(order.publicKey),
      oldOrderClosed: (await conn.getAccountInfo(new PublicKey(before.bidOrder))) === null,
      stagingZero: (await tokenBalanceStrict(D.staging)) === 0n,
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, refreshCu: ballastCu(t), filled: e.filled.toString(), sBefore: before.sLast.toString(), sNew: sNew.toString(), bin: want, checks } };
  });
  await waitSlots(12);
  await suite.case("refresh_floor: no change since the last refresh is harmless (same s, same bin)", async () => {
    const before = await accounts.launch.fetch(D.l.launch);
    const order = Keypair.generate();
    const t = await send("refresh D, nothing changed", [await refreshIx(D, order, new PublicKey(before.bidOrder), before.bidBinId, arrays(D, [before.bidBinId]))], [order], { cu: 600_000, alts: [altD], expectFail: true });
    const rec = await accounts.launch.fetch(D.l.launch);
    const ok = !t.err && rec.sLast.toString() === before.sLast.toString() && rec.bidBinId === before.bidBinId && rec.bidQuoteCommitted.toString() === before.bidQuoteCommitted.toString();
    return { status: ok ? "pass" : "fail", expected: "succeeds, nothing moves", got: outcome(t), detail: { signature: t.signature, cu: ballastCu(t) } };
  });

  // ---- redeem ----------------------------------------------------------------------------------
  // The SDK's sell swap unwraps WSOL, which closes the holder's WSOL account; recreate it (D-012:
  // redeem refuses a missing account rather than reading it as 0 — the case below proves that).
  await send("holder WSOL ATA (again, after the SDK's unwrap)", [ensureAtaIx(WSOL, holder.publicKey)]);
  const redeemRemaining = async () => { const r = await accounts.launch.fetch(D.l.launch); return arrays(D, [r.bidBinId, r.bidBinId + 1, r.bidBinId + 70, await activeOf(D)]); };
  const tryRedeem = async (label: string, amount: bigint, minOut: bigint, holderQuote?: PublicKey) => {
    const order = Keypair.generate();
    return send(`redeem: ${label}`, [await redeemIx(D, order, holder.publicKey, amount, minOut, await redeemRemaining(), holderQuote)], [holder, order], { feePayer: holder, cu: 1_000_000, alts: [altD], expectFail: true });
  };
  {
    const live = await liveInputs(D);
    const s = pyFloor(live.v, live.s, live.l, live.sMax);
    const amount = 10_000_000_000_000n; // 10M tokens
    const payout = expectedPayout(amount, s);
    await suite.case("redeem: min_out above the payout", async () => {
      const t = await tryRedeem("min_out above payout", amount, payout + 1n);
      return { status: outcome(t) === "SlippageExceeded" ? "pass" : "fail", expected: "SlippageExceeded", got: outcome(t) };
    });
    await suite.case("redeem: payout below 0.001 SOL", async () => {
      const t = await tryRedeem("dust", 100_000_000_000n, 0n);
      return { status: outcome(t) === "PayoutBelowMinimum" ? "pass" : "fail", expected: "PayoutBelowMinimum", got: outcome(t) };
    });
    await suite.case("redeem: payout above the vault", async () => {
      const t = await tryRedeem("above vault", 1_000_000_000_000_000n, 0n);
      return { status: outcome(t) === "VaultExhausted" ? "pass" : "fail", expected: "VaultExhausted", got: outcome(t) };
    });
    await suite.case("redeem: holder WSOL account missing (D-012: an error, never 0)", async () => {
      const t = await tryRedeem("missing WSOL account", amount, 0n, ata(WSOL, Keypair.generate().publicKey));
      return { status: outcome(t) === "HolderAccountInvalid" ? "pass" : "fail", expected: "HolderAccountInvalid", got: outcome(t) };
    });
    await suite.case("redeem: the same redemption twice in one transaction", async () => {
      const before = await accounts.launch.fetch(D.l.launch);
      const order = Keypair.generate();
      const ix = await redeemIx(D, order, holder.publicKey, amount, 0n, await redeemRemaining());
      const t = await send("double redeem", [ix, ix], [holder, order], { feePayer: holder, cu: 1_400_000, alts: [altD], expectFail: true });
      const after = await accounts.launch.fetch(D.l.launch);
      // The first copy succeeds and re-places the bid under a new order; the second copy then names
      // an order that is no longer launch.bid_order, so the whole transaction reverts.
      const ok = outcome(t) === "BidOrderMismatch" && after.sLast.toString() === before.sLast.toString() && after.redeemedTokens.toString() === before.redeemedTokens.toString();
      return { status: ok ? "pass" : "fail", expected: "BidOrderMismatch, nothing moves", got: outcome(t), detail: { signature: t.signature } };
    });
    await suite.case("redeem: exact payout at s after settlement; holder burns; F rises; bid re-placed", async () => {
      const before = await accounts.launch.fetch(D.l.launch);
      const q0 = await tokenBalanceStrict(ata(WSOL, holder.publicKey));
      const b0 = await tokenBalanceStrict(ata(D.base, holder.publicKey));
      const supply0 = (await getMint(conn, D.base)).supply;
      const t = await tryRedeem("10M tokens", amount, payout);
      if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } };
      const rec = await accounts.launch.fetch(D.l.launch);
      const live2 = await liveInputs(D);
      const sNew = BigInt(rec.sLast.toString());
      const want = binAtOrBelow(sNew);
      const ev = events(t).find((e) => /^[rR]edeemed$/.test(e.name));
      const checks = {
        payoutExact: (await tokenBalanceStrict(ata(WSOL, holder.publicKey))) - q0 === payout,
        holderBurned: b0 - (await tokenBalanceStrict(ata(D.base, holder.publicKey))) === amount,
        supplyFell: supply0 - (await getMint(conn, D.base)).supply === amount,
        sNewEqualsReference: sNew === pyFloor(live2.v, live2.s, live2.l, live2.sMax),
        fRose: sNew >= s && sNew >= BigInt(before.sLast.toString()),
        recorded: BigInt(rec.redeemedTokens.toString()) - BigInt(before.redeemedTokens.toString()) === amount
          && BigInt(rec.redeemedLamports.toString()) - BigInt(before.redeemedLamports.toString()) === payout,
        replacedAtFloorBin: rec.bidBinId === want && rec.bidCapped === false && live2.vault === 0n,
        event: ev !== undefined && big(field(ev.data, "payout")) === payout && big(field(ev.data, "s_before")) === s && big(field(ev.data, "s_after")) === sNew,
      };
      const ok = Object.values(checks).every(Boolean);
      return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, txCu: t.cu, redeemCu: ballastCu(t), payout: payout.toString(), s: s.toString(), sNew: sNew.toString(), checks } };
    });
  }

  // ---- harvest (partner position only; D-022) ---------------------------------------------------
  const global = await accounts.global.fetch(pdas.global());
  const treasury = new PublicKey(global.treasury);
  {
    // DAMM v2 trades accrue OnlyB (WSOL) LP fees to both permanent positions.
    const trader = await funded("program.p2.trader", 10);
    await send("trader WSOL + base ATAs", [...wrapIxs(trader, 3_000_000_000n), ensureAtaIx(D.base, trader.publicKey)], [trader]);
    const pool = (await dammPool(D.dammPool)) as Record<string, string>;
    for (let i = 0; i < 3; i++) {
      const tx = await cpAmm.swap({
        payer: trader.publicKey, pool: D.dammPool, inputTokenMint: WSOL, outputTokenMint: D.base,
        amountIn: new BN(500_000_000), minimumAmountOut: new BN(0),
        tokenAMint: D.base, tokenBMint: WSOL, tokenAVault: new PublicKey(pool.tokenAVault), tokenBVault: new PublicKey(pool.tokenBVault),
        tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      });
      await send("DAMM buy", tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), [trader], { feePayer: trader, cu: 400_000 });
    }
  }
  await suite.case("harvest: treasury account is not global.treasury", async () => {
    const t = await send("harvest wrong treasury", [await harvestIx(D, { treasury: ata(WSOL, stranger.publicKey) })], [], { cu: 600_000, alts: [altD], expectFail: true });
    return { status: outcome(t) === "TreasuryMismatch" ? "pass" : "fail", expected: "TreasuryMismatch", got: outcome(t) };
  });
  await suite.case("harvest: WSOL staging is not partner_auth's WSOL ATA", async () => {
    const t = await send("harvest wrong staging", [await harvestIx(D, { stagingQuote: ata(WSOL, stranger.publicKey) })], [], { cu: 600_000, alts: [altD], expectFail: true });
    return { status: outcome(t) === "StagingQuoteInvalid" ? "pass" : "fail", expected: "StagingQuoteInvalid", got: outcome(t) };
  });
  await suite.case("harvest: partner LP fees via WSOL staging: 10% → treasury, rest → vault; vault never a source; F rises", async () => {
    const before = await accounts.launch.fetch(D.l.launch);
    const [pp0, cp0] = await Promise.all([D.partnerPosition, D.creatorPosition].map(dammPosition)) as Record<string, Record<string, string>>[];
    const v0 = await tokenBalanceStrict(D.l.vault);
    const t0 = await tokenBalanceStrict(treasury);
    const t = await send("harvest D", [await harvestIx(D)], [], { cu: 600_000, alts: [altD], expectFail: true });
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } };
    const [pp1, cp1] = await Promise.all([D.partnerPosition, D.creatorPosition].map(dammPosition)) as Record<string, Record<string, string>>[];
    const rec = await accounts.launch.fetch(D.l.launch);
    const toVault = (await tokenBalanceStrict(D.l.vault)) - v0;
    const toTreasury = (await tokenBalanceStrict(treasury)) - t0;
    const partnerClaimed = BigInt(pp1.metrics.totalClaimedBFee) - BigInt(pp0.metrics.totalClaimedBFee);
    const live = await liveInputs(D);
    const checks = {
      partnerSplit: toVault + toTreasury === partnerClaimed && toTreasury === (partnerClaimed * 1000n) / 10_000n,
      feesNonZero: partnerClaimed > 0n,
      creatorPositionUntouched: cp1.metrics.totalClaimedBFee === cp0.metrics.totalClaimedBFee,
      noTransferOutOfVault: (await transfersOutOf(t.signature, D.l.vault)).length === 0,
      stagingZero: (await tokenBalanceStrict(D.stagingQuote)) === 0n && (await tokenBalanceStrict(D.staging)) === 0n,
      recorded: BigInt(rec.harvested.toString()) - BigInt(before.harvested.toString()) === toVault
        && BigInt(rec.treasuryFees.toString()) - BigInt(before.treasuryFees.toString()) === toTreasury,
      fRose: BigInt(rec.sLast.toString()) > BigInt(before.sLast.toString())
        && BigInt(rec.sLast.toString()) === pyFloor(live.v, live.s, live.l, live.sMax),
      lUnchanged: live.l === BigInt(rec.lOpen.toString()),
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, harvestCu: ballastCu(t), toVault: toVault.toString(), toTreasury: toTreasury.toString(), checks } };
  });

  // ---- pay_creator once Open (D-022) ------------------------------------------------------------
  const dammD = await creatorDammAccounts(D);
  await suite.case("pay_creator: Open without the DAMM v2 accounts", async () => {
    const t = await payCreator("pay_creator D without DAMM accounts", await payCreatorIx(classConfig, D.l, creator.publicKey, null), { alts: [altD] });
    return { status: outcome(t) === "PositionNotRecorded" ? "pass" : "fail", expected: "PositionNotRecorded", got: outcome(t) };
  });
  await suite.case("pay_creator: the partner position passed as the creator's", async () => {
    const t = await payCreator("pay_creator D wrong position", await payCreatorIx(classConfig, D.l, creator.publicKey, { ...dammD, creatorPosition: D.partnerPosition, creatorNftAccount: D.partnerNft }), { alts: [altD] });
    return { status: outcome(t) === "PositionNotRecorded" ? "pass" : "fail", expected: "PositionNotRecorded", got: outcome(t) };
  });
  await suite.case("pay_creator: Open → DBC creator fees + creator LP fees → beneficiary; floor untouched; CreatorPaid", async () => {
    const before = await accounts.launch.fetch(D.l.launch);
    const vp = (await virtualPool(D.l.pool)).poolState as Record<string, string>;
    const cp0 = (await dammPosition(D.creatorPosition)) as Record<string, Record<string, string>>;
    const ben = ata(WSOL, creator.publicKey);
    const b0 = await tokenBalanceStrict(ben);
    const v0 = await tokenBalanceStrict(D.l.vault);
    const t = await payCreator("pay_creator D", await payCreatorIx(classConfig, D.l, creator.publicKey, dammD), { alts: [altD] });
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } };
    const cp1 = (await dammPosition(D.creatorPosition)) as Record<string, Record<string, string>>;
    const rec = await accounts.launch.fetch(D.l.launch);
    const dbcFees = BigInt(vp.creatorQuoteFee);
    const lpFees = BigInt(cp1.metrics.totalClaimedBFee) - BigInt(cp0.metrics.totalClaimedBFee);
    const paid = (await tokenBalanceStrict(ben)) - b0;
    const ev = events(t).find((e) => /^[cC]reatorPaid$/.test(e.name));
    const checks = {
      paidExactly: paid === dbcFees + lpFees && dbcFees > 0n && lpFees > 0n,
      event: ev !== undefined && big(field(ev.data, "dbc_fees")) === dbcFees && big(field(ev.data, "lp_fees")) === lpFees,
      recorded: BigInt(rec.creatorForwarded.toString()) - BigInt(before.creatorForwarded.toString()) === paid,
      vaultUntouched: (await tokenBalanceStrict(D.l.vault)) === v0,
      floorUntouched: rec.sLast.toString() === before.sLast.toString(),
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, cu: ballastCu(t), dbcFees: dbcFees.toString(), lpFees: lpFees.toString(), checks } };
  });

  // ---- deposit ---------------------------------------------------------------------------------
  const depositor = await funded("program.p2.depositor", 5);
  await send("depositor WSOL + base ATA", [...wrapIxs(depositor, 1_000_000_000n), ensureAtaIx(D.base, depositor.publicKey)], [depositor]);
  await suite.case("deposit: zero amount", async () => {
    const t = await send("deposit 0", [await depositIx(D, depositor.publicKey, 0n)], [depositor], { feePayer: depositor, expectFail: true });
    return { status: outcome(t) === "DepositZero" ? "pass" : "fail", expected: "DepositZero", got: outcome(t) };
  });
  await suite.case("deposit: depositor account of another mint (§5 rule 3)", async () => {
    const t = await send("deposit from a base account", [await depositIx(D, depositor.publicKey, 1n, ata(D.base, depositor.publicKey))], [depositor], { feePayer: depositor, expectFail: true });
    return { status: outcome(t) === "DepositorAccountInvalid" ? "pass" : "fail", expected: "DepositorAccountInvalid", got: outcome(t) };
  });
  await suite.case("deposit: WSOL account not the depositor's (§5 rule 3)", async () => {
    const t = await send("deposit from someone else's WSOL", [await depositIx(D, depositor.publicKey, 1n, ata(WSOL, stranger.publicKey))], [depositor], { feePayer: depositor, expectFail: true });
    return { status: outcome(t) === "DepositorAccountInvalid" ? "pass" : "fail", expected: "DepositorAccountInvalid", got: outcome(t) };
  });
  await suite.case("deposit: WSOL → vault; F rises; no claim created", async () => {
    const before = await accounts.launch.fetch(D.l.launch);
    const v0 = await tokenBalanceStrict(D.l.vault);
    const t = await send("deposit 0.5 SOL", [await depositIx(D, depositor.publicKey, 500_000_000n)], [depositor], { feePayer: depositor, cu: 400_000, expectFail: true });
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-15) } };
    const rec = await accounts.launch.fetch(D.l.launch);
    const live = await liveInputs(D);
    const checks = {
      vault: (await tokenBalanceStrict(D.l.vault)) - v0 === 500_000_000n,
      recorded: BigInt(rec.deposited.toString()) - BigInt(before.deposited.toString()) === 500_000_000n,
      fRose: BigInt(rec.sLast.toString()) > BigInt(before.sLast.toString()) && BigInt(rec.sLast.toString()) === pyFloor(live.v, live.s, live.l, live.sMax),
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, depositCu: ballastCu(t), checks } };
  });

  // ---- D-021 on launch E: a pin 725 bins under F's bin suspends the DLMM leg; refresh lifts it --
  const inE = await liveInputs(E);
  const sE = pyFloor(inE.v, inE.s, inE.l, inE.sMax);
  const hintE = binAtOrBelow(sE);
  const activeE = await activeOf(E);
  await keeperArrays(E, [hintE, hintE + 70, activeE]);
  const dust = await walletOrder(E, stranger, activeE, 1_000_000n); // a dust bid AT the active bin
  const remE = arrays(E, [hintE, activeE]);
  const altE = await altFor(E, [...remE, ...arrays(E, [hintE + 70])]);
  const tryOpenE = async (label: string, bin: number) => {
    const order = Keypair.generate();
    const t = await send(`open E: ${label}`, [await openIx(E, order, bin, remE)], [order], { cu: 600_000, alts: [altE], expectFail: true });
    return { t, order };
  };
  await suite.case("D-020: open at F's bin while a third-party order pins the active bin → DLMM refuses the move (6056)", async () => {
    const { t } = await tryOpenE("F's bin, blocked", hintE);
    return { status: outcome(t) === "BinRangeIsNotEmpty" ? "pass" : "fail", expected: "BinRangeIsNotEmpty", got: outcome(t), detail: { signature: t.signature, activeE, hintE } };
  });
  await suite.case("D-020: a 'cap' one below the active bin is refused", async () => {
    const { t } = await tryOpenE("below the active bin", activeE - 1);
    return { status: outcome(t) === "BinHintNotAtFloor" ? "pass" : "fail", expected: "BinHintNotAtFloor", got: outcome(t) };
  });
  await suite.case("D-021: pinned 725 bins under F's bin → Open with the vault unplaced; V counted; BidSuspended", async () => {
    const v0 = await tokenBalanceStrict(E.l.vault);
    const { t } = await tryOpenE("pinned deep: suspended", activeE);
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } };
    const rec = await accounts.launch.fetch(E.l.launch);
    const f = await readFloor(E);
    const ev = events(t);
    const checks = {
      state: rec.state === 5, suspended: rec.bidSuspended === true && rec.bidCapped === false,
      unplaced: (await tokenBalanceStrict(E.l.vault)) === v0 && rec.bidOrder.toString() === PublicKey.default.toBase58() && rec.bidQuoteCommitted.toString() === "0",
      vCounted: f.v === v0 && f.s === sE && f.suspended === true,
      sOpenAtLeastPredicted: BigInt(rec.sOpen.toString()) >= BigInt(rec.predictedS.toString()),
      event: ev.some((e) => /^[bB]idSuspended$/.test(e.name) && field(e.data, "active_bin") === activeE),
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, cu: ballastCu(t), activeE, hintE, checks } };
  });
  await cancelWalletOrder(E, stranger, dust, activeE);
  await suite.case("D-021: once the blocker is gone, refresh_floor (rate limit skipped while suspended) moves the active bin and places at F's bin", async () => {
    const before = await accounts.launch.fetch(E.l.launch);
    const order = Keypair.generate();
    const t = await send("refresh E", [await refreshIx(E, order, new PublicKey(before.bidOrder), hintE, arrays(E, [hintE, activeE]))], [order], { cu: 600_000, alts: [altE], expectFail: true });
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } };
    const rec = await accounts.launch.fetch(E.l.launch);
    const checks = {
      placed: rec.bidSuspended === false && rec.bidCapped === false && rec.bidBinId === hintE && BigInt(rec.bidQuoteCommitted.toString()) > 0n,
      active: (await activeOf(E)) === hintE, goTo: t.logs.some((l) => l.includes("Instruction: GoToABin")),
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: t.signature, cu: ballastCu(t), checks } };
  });

  return suite.finish("part2/results.json");
}
