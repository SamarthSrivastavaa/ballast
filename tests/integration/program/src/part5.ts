/**
 * Part 2 audit (7 Oct 2026): D-021, D-022 and the approved findings, reproduction first, on the
 * mainnet-binary local validator (D-001).
 *
 * Every reproducible finding has a case marked "(repro)" that FAILS on the D-020 build and passes on
 * the fixed one:
 *
 *   BALLAST_SO=../ballast-d020/ballast.so BALLAST_IDL=../ballast-d020/ballast.json \
 *     pnpm exec tsx tests/integration/program/run.ts part1,part5      # D-020: the repro cases fail
 *   pnpm exec tsx tests/integration/program/run.ts part1,part5        # fixed: everything passes
 *
 * Findings that Meteora's binaries cannot reach are recorded as unreachable-by-construction, with
 * the defensive check and the unit test that cover them.
 *
 *   Launch F — the creator bricks their own WSOL ATA (SetAuthority) before settlement (D-022).
 *   Launch G — a third party pins the active bin at the pair's minimum bin (D-021). At bin step 10
 *              DLMM confines bins to ±35,163 (`min_bin_id`/`max_bin_id`), inside the internal bitmap;
 *              the audit's −40,000 is refused with 6000 (evidence/program/part2/dlmm-bin-range.json).
 *              D-020 capped the whole vault ≈ 23,000 bins under F there; D-021 suspends instead.
 *   Launch H — a third party moves the active bin to the minimum bin with no order; `open` moves it
 *              back up to F's bin.
 *   Launch P — a pin 30 bins under F's bin: the cap, BidCapped in `redeem`, the rate-limit lift.
 *   Launch K — plain: events, `fill_quote_spent`, a staging donation, the vault's exits, `deposit`.
 */
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction, createTransferInstruction, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { conn, Landed, payer, send } from "../../p0/src/env";
import { WSOL } from "../../../../compiler/src/canon";
import { cpAmm, dammPool, rawData, virtualPool } from "../../p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceStrict, wallet, wrapIxs } from "../../p0/src/wallets";
import { accounts, ballast, pdas } from "./client";
import DLMM from "@meteora-ag/dlmm";
import {
  activeOf, altFor, arrays, big, binAtOrBelow, cancelWalletOrder, cancelWalletOrderIxs, cleanedLaunch, depositIx, events, expectedAfterSettle, expectedPayout,
  field, floorBinNow, goToBin, harvestIx, keeperArrays, key, liveInputs, MAX_CAP_DEPTH, OPT, Opened, openIx, payCreatorIx,
  pyFloor, readFloor, redeemIx, refreshIx, sellIntoBid, transfersOutOf, waitSlots, walletOrder,
} from "./fixture";
import { ballastCu, dbcConfig, got, payCreator } from "./part3";
import { Result, Suite } from "./runner";

type Case = Omit<Result, "name">;
const ok = (checks: Record<string, boolean>, detail: Record<string, unknown> = {}): Case => {
  const pass = Object.values(checks).every(Boolean);
  return { status: pass ? "pass" : "fail", expected: "every check", got: pass ? "ok" : JSON.stringify(checks), detail: { ...detail, checks } };
};
const failed = (t: Landed, expected = "ok"): Case => ({ status: "fail", expected, got: got(t), detail: { signature: t.signature, logs: t.logs.slice(-20) } });
const named = (t: Landed, name: string) => events(t).filter((e) => e.name.toLowerCase() === name.toLowerCase());
/** The deepest bin a third party can reach on a class pair: the pair's own `min_bin_id`. */
const minBin = async (o: Opened) => ((await DLMM.create(conn, o.l.lbPair, OPT)).lbPair.parameters as unknown as { minBinId: number }).minBinId;

export async function part5(): Promise<number> {
  const suite = new Suite("Part 2 audit fixes — D-021, D-022 and the approved findings (§5, §8, §9, §10, §12, §25)");
  const admin = wallet("program.admin");
  const creator = await funded("program.p5.creator", 10);
  const creatorF = await funded("program.p5.creatorF", 5);
  const stranger = await funded("program.p5.stranger", 20);
  const buyers = await Promise.all(["F", "G", "H", "P", "K"].map((n) => funded(`program.p5.buyer${n}`, 30)));
  const [buyerF, buyerG, buyerH, buyerP, buyerK] = buyers;

  await send("p5: payer WSOL for dust buys", wrapIxs(payer, 20_000_000n), []);
  await send("p5: stranger WSOL", wrapIxs(stranger, 3_000_000_000n), [stranger]);
  await send("p5: beneficiary WSOL ATAs", [ensureAtaIx(WSOL, creator.publicKey), ensureAtaIx(WSOL, creatorF.publicKey)]);
  const classConfig = await dbcConfig("p5 class");
  await send("p5: create_class", [
    await ballast.methods.createClass(0)
      .accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig })
      .instruction(),
  ], [admin]);
  const partnerAuth = pdas.partner(classConfig);
  await send("p5 keeper: fund partner_auth for order rent; WSOL staging ATA", [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: partnerAuth, lamports: 200_000_000 }),
    ensureAtaIx(WSOL, partnerAuth),
  ]);

  /** Open `o` at F's bin (moving the active bin up), with whatever extra remaining accounts it needs. */
  const openAtFloor = async (o: Opened, extra: PublicKey[] = []) => {
    const { bin } = await floorBinNow(o);
    const active = await activeOf(o);
    await keeperArrays(o, [bin, bin + 70]);
    const order = Keypair.generate();
    const alt = await altFor(o, [...arrays(o, [bin, bin + 70, active]), ...extra]);
    const t = await send(`open ${o.base.toBase58().slice(0, 6)} at F's bin`, [await openIx(o, order, bin, [...arrays(o, [bin, active]), ...extra])], [order], { cu: 600_000, alts: [alt], expectFail: true });
    return { t, bin, active, order, alt };
  };
  /** DAMM v2 trades so both positions accrue OnlyB LP fees. */
  const dammTrades = async (o: Opened, n = 2) => {
    const trader = await funded(`program.p5.trader.${o.base.toBase58().slice(0, 6)}`, 5);
    await send("trader WSOL + base ATAs", [...wrapIxs(trader, 1_500_000_000n), ensureAtaIx(o.base, trader.publicKey)], [trader]);
    const pool = (await dammPool(o.dammPool)) as Record<string, string>;
    for (let i = 0; i < n; i++) {
      const tx = await cpAmm.swap({
        payer: trader.publicKey, pool: o.dammPool, inputTokenMint: WSOL, outputTokenMint: o.base, amountIn: new BN(500_000_000), minimumAmountOut: new BN(0),
        tokenAMint: o.base, tokenBMint: WSOL, tokenAVault: new PublicKey(pool.tokenAVault), tokenBVault: new PublicKey(pool.tokenBVault),
        tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      });
      await send("DAMM buy", tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), [trader], { feePayer: trader, cu: 400_000 });
    }
  };

  // =============================================================================================
  // D-022 — launch F: the creator bricks their own beneficiary ATA before settlement
  // =============================================================================================
  let F: Opened | null = null;
  const benF = ata(WSOL, creatorF.publicKey);
  await suite.case("D-022 (repro): the creator reassigns their WSOL ATA's owner (SetAuthority) → settle_graduation still succeeds", async () => {
    let bricked = false;
    try {
      F = await cleanedLaunch("p5 launch F", classConfig, creatorF, buyerF, {
        beforeSettle: async () => {
          await send("creator F: SetAuthority(AccountOwner) on ATA(beneficiary, WSOL) → stranger", [
            createSetAuthorityInstruction(benF, creatorF.publicKey, AuthorityType.AccountOwner, stranger.publicKey),
          ], [creatorF], { feePayer: creatorF });
          bricked = new PublicKey((await rawData(benF)).subarray(32, 64)).equals(stranger.publicKey);
        },
      });
    } catch (e) {
      return { status: "fail", expected: "settle succeeds", got: String((e as Error).message).split("\n")[0], detail: { bricked } };
    }
    const rec = await accounts.launch.fetch(F.l.launch);
    return ok({ bricked, cleaned: rec.state === 4 }, { launch: F.l.launch.toBase58() });
  });
  await suite.case("D-022: with the beneficiary bricked, open, refresh, redeem and harvest are unaffected", async () => {
    if (!F) return { status: "fail", expected: "launch F cleaned", got: "blocked at settle_graduation" };
    const o: Opened = F;
    const op = await openAtFloor(o);
    if (op.t.err) return failed(op.t);
    await send("buyer F WSOL ATA", [ensureAtaIx(WSOL, buyerF.publicKey)]);
    const fill = await sellIntoBid(o, buyerF, 20_000_000_000_000n);
    await waitSlots(12);
    const want = binAtOrBelow((await expectedAfterSettle(o)).s);
    await keeperArrays(o, [want]);
    const ordR = Keypair.generate();
    const rf = await send("refresh F", [await refreshIx(o, ordR, new PublicKey((await accounts.launch.fetch(o.l.launch)).bidOrder), want, arrays(o, [op.bin, want, await activeOf(o)]))], [ordR], { cu: 600_000, alts: [op.alt], expectFail: true });
    await send("buyer F WSOL ATA (after unwrap)", [ensureAtaIx(WSOL, buyerF.publicKey)]);
    const rec = await accounts.launch.fetch(o.l.launch);
    const ordX = Keypair.generate();
    const rd = await send("redeem F", [await redeemIx(o, ordX, buyerF.publicKey, 5_000_000_000_000n, 0n, arrays(o, [rec.bidBinId, rec.bidBinId + 1, await activeOf(o)]))], [buyerF, ordX], { feePayer: buyerF, cu: 1_000_000, alts: [op.alt], expectFail: true });
    await dammTrades(o, 1);
    const hv = await send("harvest F", [await harvestIx(o)], [], { cu: 600_000, alts: [op.alt], expectFail: true });
    return ok(
      { open: !op.t.err, fill: !fill.err, refresh: !rf.err, redeem: !rd.err, harvest: !hv.err },
      { open: op.t.signature, refresh: rf.signature, redeem: rd.signature, harvest: hv.signature, errors: [got(rf), got(rd), got(hv)] },
    );
  });
  await suite.case("D-022: pay_creator alone fails (BeneficiaryAccountInvalid); the creator's fees stay claimable in DBC", async () => {
    if (!F) return { status: "fail", expected: "launch F cleaned", got: "blocked at settle_graduation" };
    const o: Opened = F;
    const vp0 = (await virtualPool(o.l.pool)).poolState as Record<string, string>;
    const t = await payCreator("pay_creator F (bricked)", await payCreatorIx(classConfig, o.l, creatorF.publicKey, null), {});
    const vp1 = (await virtualPool(o.l.pool)).poolState as Record<string, string>;
    return ok(
      { refused: got(t) === "BeneficiaryAccountInvalid", stillClaimable: vp1.creatorQuoteFee === vp0.creatorQuoteFee && BigInt(vp1.creatorQuoteFee) > 0n },
      { signature: t.signature, got: got(t), creatorQuoteFee: vp1.creatorQuoteFee },
    );
  });

  // =============================================================================================
  // D-021 — launch G: a dust bid pins the active bin at the pair's minimum bin before `open`
  // =============================================================================================
  const G = await cleanedLaunch("p5 launch G", classConfig, creator, buyerG);
  const fG = await floorBinNow(G);
  const PIN = await minBin(G);
  await keeperArrays(G, [fG.bin, fG.bin + 70]);
  const pinG: Record<string, unknown> = { pin: PIN };
  {
    await keeperArrays(G, [PIN], stranger);
    const mv = await goToBin(G, stranger, PIN, true);
    pinG.goTo = { signature: mv.signature, err: got(mv), active: await activeOf(G) };
    if (!mv.err) pinG.order = (await walletOrder(G, stranger, PIN, 1_000_000n)).toBase58();
  }
  const activeG = await activeOf(G);
  const remG = arrays(G, [fG.bin, activeG]);
  const altG = await altFor(G, [...remG, ...arrays(G, [fG.bin + 70])]);
  await suite.case("D-021: a third party moves the active bin to the pair's minimum bin and parks a dust bid there", async () =>
    ok({ moved: activeG === PIN, ordered: typeof pinG.order === "string", deep: fG.bin - PIN > MAX_CAP_DEPTH }, { ...pinG, activeG, floorBin: fG.bin }));
  await suite.case("D-021: open at F's bin while pinned → DLMM refuses the move; the launch stays Cleaned", async () => {
    const order = Keypair.generate();
    const t = await send("open G at F's bin (pinned)", [await openIx(G, order, fG.bin, remG)], [order], { cu: 600_000, alts: [altG], expectFail: true });
    const rec = await accounts.launch.fetch(G.l.launch);
    return ok({ refused: !!t.err, cleaned: rec.state === 4 }, { signature: t.signature, got: got(t) });
  });
  let openG: Landed | null = null;
  await suite.case("D-021 (repro): open with the pinned active bin as the hint → Open, vault unplaced, BidSuspended (D-020: the whole vault capped ≈ 23,000 bins under F)", async () => {
    const v0 = await tokenBalanceStrict(G.l.vault);
    const order = Keypair.generate();
    const t = await send("open G at the pinned active bin", [await openIx(G, order, activeG, remG)], [order], { cu: 600_000, alts: [altG], expectFail: true });
    if (t.err) return failed(t);
    openG = t;
    const rec = await accounts.launch.fetch(G.l.launch);
    const sus = named(t, "BidSuspended");
    return ok({
      open: rec.state === 5, suspended: rec.bidSuspended === true, unplaced: (await tokenBalanceStrict(G.l.vault)) === v0 && rec.bidQuoteCommitted.toString() === "0",
      noOrder: new PublicKey(rec.bidOrder).equals(PublicKey.default), sOpen: BigInt(rec.sOpen.toString()) === fG.s,
      event: sus.length === 1 && field(sus[0].data, "active_bin") === activeG,
    }, { signature: t.signature, cu: ballastCu(t) });
  });
  await suite.case("D-021: floor() while suspended — V is the whole vault, F from it", async () => {
    if (!openG) return { status: "fail", expected: "G open", got: "not open" };
    const f = await readFloor(G);
    const live = await liveInputs(G);
    return ok({ v: f.v === live.vault, s: f.s === pyFloor(live.v, live.s, live.l, live.sMax), suspended: f.suspended === true }, { s: f.s.toString() });
  });
  await suite.case("D-021: redemption stays live while suspended — exact payout from the unplaced vault", async () => {
    if (!openG) return { status: "fail", expected: "G open", got: "not open" };
    const live = await liveInputs(G);
    const s = pyFloor(live.v, live.s, live.l, live.sMax);
    const amount = 10_000_000_000_000n;
    const payout = expectedPayout(amount, s);
    // The curve buy's SDK swap unwrapped WSOL and closed the buyer's account (D-012: redeem refuses a
    // missing account), so the holder recreates it.
    await send("buyer G WSOL ATA", [ensureAtaIx(WSOL, buyerG.publicKey)]);
    const q0 = await tokenBalanceStrict(ata(WSOL, buyerG.publicKey));
    const v0 = await tokenBalanceStrict(G.l.vault);
    const order = Keypair.generate();
    const t = await send("redeem G (suspended)", [await redeemIx(G, order, buyerG.publicKey, amount, payout, remG)], [buyerG, order], { feePayer: buyerG, cu: 1_000_000, alts: [altG], expectFail: true });
    if (t.err) return failed(t);
    const rec = await accounts.launch.fetch(G.l.launch);
    return ok({
      payoutExact: (await tokenBalanceStrict(ata(WSOL, buyerG.publicKey))) - q0 === payout,
      vaultPaidOnly: v0 - (await tokenBalanceStrict(G.l.vault)) === payout,
      stillSuspended: rec.bidSuspended === true && rec.bidQuoteCommitted.toString() === "0",
      fRose: BigInt(rec.sLast.toString()) >= s,
      event: named(t, "BidSuspended").length === 1,
    }, { signature: t.signature, cu: ballastCu(t), payout: payout.toString() });
  });
  await suite.case("D-021: refresh while still pinned — F's bin is refused by DLMM, the active-bin hint stays suspended (rate limit not a lever)", async () => {
    if (!openG) return { status: "fail", expected: "G open", got: "not open" };
    const { bin } = await floorBinNow(G);
    await keeperArrays(G, [bin]);
    const o1 = Keypair.generate();
    const t1 = await send("refresh G at F's bin (pinned)", [await refreshIx(G, o1, PublicKey.default, bin, arrays(G, [bin, activeG]))], [o1], { cu: 600_000, alts: [altG], expectFail: true });
    // Suspended → suspended is not a lift, so it waits out the window like any refresh.
    await waitSlots(12);
    const o2 = Keypair.generate();
    const t2 = await send("refresh G at the pinned active bin", [await refreshIx(G, o2, PublicKey.default, activeG, remG)], [o2], { cu: 600_000, alts: [altG], expectFail: true });
    const rec = await accounts.launch.fetch(G.l.launch);
    return ok({ floorBinRefused: got(t1) === "BinRangeIsNotEmpty", suspendedAgain: !t2.err && rec.bidSuspended === true }, { t1: t1.signature, t2: t2.signature, got1: got(t1), got2: got(t2) });
  });

  await suite.case("audit 8 Oct (repro): a pin into a bin array nobody created cannot block redemption — the vault stays unplaced", async () => {
    if (!openG) return { status: "fail", expected: "G open", got: "not open" };
    // The pinner lifts their dust and moves the active bin to the bin just below F's bin array: within
    // the 70-bin cap, but in an array the keeper never created (it creates F's array and the next up).
    const fNow = await floorBinNow(G);
    const below = Math.floor(fNow.bin / 70) * 70 - 1;
    if (pinG.order) await cancelWalletOrder(G, stranger, new PublicKey(pinG.order as string), activeG);
    // The SDK's cancel unwraps WSOL, closing the stranger's WSOL account; later cases need it back.
    await send("stranger WSOL (again, after the SDK's unwrap)", wrapIxs(stranger, 1_000_000_000n), [stranger]);
    const mv = await goToBin(G, stranger, below, true);
    const arrayExists = (await conn.getAccountInfo(arrays(G, [below])[0])) !== null;
    const live = await liveInputs(G);
    const s = pyFloor(live.v, live.s, live.l, live.sMax);
    const amount = 5_000_000_000_000n;
    const payout = expectedPayout(amount, s);
    const q0 = await tokenBalanceStrict(ata(WSOL, buyerG.publicKey));
    const order = Keypair.generate();
    const t = await send("redeem G (cap bin's array missing)", [await redeemIx(G, order, buyerG.publicKey, amount, payout, arrays(G, [fNow.bin, below]))], [buyerG, order], { feePayer: buyerG, cu: 1_000_000, alts: [altG], expectFail: true });
    if (t.err) return failed(t);
    const rec = await accounts.launch.fetch(G.l.launch);
    return ok({
      moved: !mv.err && (await activeOf(G)) === below, capDepth: fNow.bin - below <= MAX_CAP_DEPTH, arrayMissing: !arrayExists,
      payoutExact: (await tokenBalanceStrict(ata(WSOL, buyerG.publicKey))) - q0 === payout,
      unplaced: rec.bidSuspended === true && rec.bidQuoteCommitted.toString() === "0",
      event: named(t, "BidSuspended").length === 1,
    }, { signature: t.signature, cu: ballastCu(t), active: below, floorBin: fNow.bin });
  });

  // =============================================================================================
  // D-021 — launch H: the active bin moved to the minimum bin without an order; open moves it up
  // =============================================================================================
  const H = await cleanedLaunch("p5 launch H", classConfig, creator, buyerH);
  const PIN_H = await minBin(H);
  await keeperArrays(H, [PIN_H], stranger);
  const mvH = await goToBin(H, stranger, PIN_H, true);
  await suite.case("D-020/D-021: open at F's bin moves the active bin up from the pair's minimum bin (≈ 23,000 bins)", async () => {
    if (mvH.err) return failed(mvH, "go_to_a_bin(min bin) lands");
    const active0 = await activeOf(H);
    const op = await openAtFloor(H);
    if (op.t.err) return failed(op.t);
    const rec = await accounts.launch.fetch(H.l.launch);
    return ok({
      startedFar: active0 === PIN_H, open: rec.state === 5, atFloorBin: rec.bidBinId === op.bin && !rec.bidCapped && !rec.bidSuspended,
      activeMoved: (await activeOf(H)) === op.bin, goTo: op.t.logs.some((l) => l.includes("Instruction: GoToABin")),
    }, { signature: op.t.signature, cu: ballastCu(op.t), from: active0, to: op.bin });
  });

  // =============================================================================================
  // D-020 / audit — launch P: a pin 30 bins under F's bin (a cap), BidCapped in redeem, the lift
  // =============================================================================================
  const P = await cleanedLaunch("p5 launch P", classConfig, creator, buyerP);
  const fP = await floorBinNow(P);
  const capBin = fP.bin - 30;
  await keeperArrays(P, [fP.bin, fP.bin + 70, capBin]);
  await goToBin(P, stranger, capBin);
  const dustP = await walletOrder(P, stranger, capBin, 1_000_000n);
  const remP = arrays(P, [fP.bin, capBin]);
  const altP = await altFor(P, [...remP, ...arrays(P, [fP.bin + 70]), dustP, ata(P.base, stranger.publicKey), ata(WSOL, stranger.publicKey), stranger.publicKey]);
  await suite.case("D-020/D-021: pinned 30 bins under F's bin → open caps at the active bin (within 70), BidCapped", async () => {
    const order = Keypair.generate();
    const t = await send("open P capped", [await openIx(P, order, capBin, remP)], [order], { cu: 600_000, alts: [altP], expectFail: true });
    if (t.err) return failed(t);
    const rec = await accounts.launch.fetch(P.l.launch);
    return ok({ capped: rec.bidCapped === true && rec.bidBinId === capBin, withinDepth: fP.bin - capBin <= MAX_CAP_DEPTH, event: named(t, "BidCapped").length === 1 }, { signature: t.signature });
  });
  await suite.case("D-020 (repro): redeem while capped re-places at the cap and emits BidCapped", async () => {
    await send("buyer P WSOL ATA", [ensureAtaIx(WSOL, buyerP.publicKey)]);
    const rec0 = await accounts.launch.fetch(P.l.launch);
    const order = Keypair.generate();
    const t = await send("redeem P (capped)", [await redeemIx(P, order, buyerP.publicKey, 10_000_000_000_000n, 0n, arrays(P, [rec0.bidBinId, capBin, fP.bin]))], [buyerP, order], { feePayer: buyerP, cu: 1_000_000, alts: [altP], expectFail: true });
    if (t.err) return failed(t);
    const rec = await accounts.launch.fetch(P.l.launch);
    const ev = named(t, "BidCapped");
    return ok({ stillCapped: rec.bidCapped === true && rec.bidBinId === capBin, event: ev.length === 1 && field(ev[0].data, "bin") === capBin }, { signature: t.signature, cu: ballastCu(t) });
  });
  await waitSlots(12);
  await suite.case("audit (repro): one transaction — a capped refresh, the blocker cancels, then a refresh that lifts the bid to F's bin inside the rate-limit window", async () => {
    const rec0 = await accounts.launch.fetch(P.l.launch);
    const want = binAtOrBelow((await expectedAfterSettle(P)).s);
    await keeperArrays(P, [want]);
    const oA = Keypair.generate();
    const oB = Keypair.generate();
    const capped = await refreshIx(P, oA, new PublicKey(rec0.bidOrder), capBin, arrays(P, [rec0.bidBinId, capBin]));
    const cancel = await cancelWalletOrderIxs(P, stranger, dustP, capBin);
    const lift = await refreshIx(P, oB, oA.publicKey, want, arrays(P, [capBin, want]));
    const alt = await altFor(P, [...arrays(P, [capBin, want, fP.bin + 70]), dustP, ata(P.base, stranger.publicKey), ata(WSOL, stranger.publicKey), stranger.publicKey]);
    const t = await send("capped refresh + cancel + lifting refresh", [capped, ...cancel, lift], [oA, oB, stranger], { cu: 1_400_000, alts: [alt], expectFail: true });
    if (t.err) return failed(t);
    const rec = await accounts.launch.fetch(P.l.launch);
    return ok({ lifted: rec.bidCapped === false && rec.bidBinId === want, order: new PublicKey(rec.bidOrder).equals(oB.publicKey), active: (await activeOf(P)) === want }, { signature: t.signature });
  });
  await suite.case("audit: only a lift skips the rate limit — two plain refreshes in one transaction are refused", async () => {
    // Deterministic whatever the slot timing: if the first refresh is still inside the window left
    // by the lift it is refused; otherwise it lands and opens a new window, which refuses the second.
    const rec0 = await accounts.launch.fetch(P.l.launch);
    const bin = rec0.bidBinId;
    const o1 = Keypair.generate();
    const o2 = Keypair.generate();
    const t = await send("two plain refreshes in one transaction", [
      await refreshIx(P, o1, new PublicKey(rec0.bidOrder), bin, arrays(P, [bin])),
      await refreshIx(P, o2, o1.publicKey, bin, arrays(P, [bin])),
    ], [o1, o2], { cu: 1_200_000, alts: [altP], expectFail: true });
    const rec = await accounts.launch.fetch(P.l.launch);
    const ok = got(t) === "RefreshRateLimited" && rec.bidOrder.toString() === rec0.bidOrder.toString();
    return { status: ok ? "pass" : "fail", expected: "RefreshRateLimited, nothing moves", got: got(t) };
  });

  // =============================================================================================
  // Approved findings — launch K (plain): events, fill_quote_spent, staging, the vault's exits
  // =============================================================================================
  const K = await cleanedLaunch("p5 launch K", classConfig, creator, buyerK);
  const opK = await openAtFloor(K);
  await suite.case("§25 (repro): FloorOpened carries the resting order", async () => {
    if (opK.t.err) return failed(opK.t);
    const ev = named(opK.t, "FloorOpened");
    return ok({ event: ev.length === 1, order: key(field(ev[0]?.data, "order")) === opK.order.publicKey.toBase58() }, { signature: opK.t.signature });
  });
  await send("buyer K WSOL ATA", [ensureAtaIx(WSOL, buyerK.publicKey)]);
  await sellIntoBid(K, buyerK, 30_000_000_000_000n);
  const donation = 1_000_000n; // one token, sent to partner_auth's base staging ATA by an outsider
  await send("outsider sends base to partner_auth's staging ATA", [createTransferInstruction(ata(K.base, buyerK.publicKey), K.staging, buyerK.publicKey, donation)], [buyerK], { feePayer: buyerK });
  await waitSlots(12);
  let refreshK: Landed | null = null;
  let kBefore: Record<string, { toString(): string }> = {};
  let kExpect: Awaited<ReturnType<typeof expectedAfterSettle>> | null = null;
  await suite.case("§5/§10 (repro): refresh burns the whole staging balance — fills plus the donation — and records it; staging ends at zero", async () => {
    kBefore = await accounts.launch.fetch(K.l.launch);
    kExpect = await expectedAfterSettle(K);
    const want = binAtOrBelow(kExpect.s);
    await keeperArrays(K, [want]);
    const supply0 = (await getMint(conn, K.base)).supply;
    const o = Keypair.generate();
    const t = await send("refresh K", [await refreshIx(K, o, new PublicKey(String(kBefore.bidOrder)), want, arrays(K, [opK.bin, want, await activeOf(K)]))], [o], { cu: 600_000, alts: [opK.alt], expectFail: true });
    if (t.err) return failed(t);
    refreshK = t;
    const rec = await accounts.launch.fetch(K.l.launch);
    const live = await liveInputs(K);
    return ok({
      stagingZero: (await tokenBalanceStrict(K.staging)) === 0n,
      supplyFell: supply0 - (await getMint(conn, K.base)).supply === kExpect.filled + donation,
      burnedRecorded: BigInt(rec.burned.toString()) - BigInt(kBefore.burned.toString()) === kExpect.filled + donation,
      fEqualsReference: BigInt(rec.sLast.toString()) === pyFloor(live.v, live.s, live.l, live.sMax) && BigInt(rec.sLast.toString()) === kExpect.s,
    }, { signature: t.signature, filled: kExpect.filled.toString(), donation: donation.toString() });
  });
  await suite.case("§25 (repro): FloorRefreshed carries quote_returned and the new order", async () => {
    if (!refreshK || !kExpect) return { status: "fail", expected: "refresh landed", got: "no refresh" };
    const ev = named(refreshK, "FloorRefreshed");
    const rec = await accounts.launch.fetch(K.l.launch);
    return ok({
      event: ev.length === 1, quoteReturned: big(field(ev[0]?.data, "quote_returned")) === kExpect.back,
      order: key(field(ev[0]?.data, "order")) === new PublicKey(rec.bidOrder).toBase58(),
      burned: big(field(ev[0]?.data, "burned")) === kExpect.filled + donation,
    });
  });
  await suite.case("§10 ledger (repro): fill_quote_spent = quote committed − quote returned", async () => {
    if (!refreshK || !kExpect) return { status: "fail", expected: "refresh landed", got: "no refresh" };
    const rec = await accounts.launch.fetch(K.l.launch);
    const spent = rec.fillQuoteSpent === undefined ? null : BigInt(rec.fillQuoteSpent.toString());
    return ok({ recorded: spent === BigInt(kBefore.bidQuoteCommitted.toString()) - kExpect.back && spent !== null && spent > 0n }, { spent: String(spent) });
  });
  await dammTrades(K, 2);
  await suite.case("§10 (repro): harvest never transfers out of the vault — the treasury's 10% leaves from WSOL staging", async () => {
    const t = await send("harvest K", [await harvestIx(K)], [], { cu: 600_000, alts: [opK.alt], expectFail: true });
    if (t.err) return failed(t);
    const outs = await transfersOutOf(t.signature, K.l.vault);
    return ok({ noTransferOutOfVault: outs.length === 0, stagingZero: (await tokenBalanceStrict(K.stagingQuote)) === 0n }, { signature: t.signature, outOfVault: outs });
  });
  await suite.case("§5 staging: WSOL sent to partner_auth's staging ATA is swept into the vault by harvest", async () => {
    const gift = 7_000_000n;
    // The DLMM SDK's cancel unwrapped (closed) the stranger's WSOL account earlier; wrap again.
    // wrapIxs funds the ATA from the payer, so the payer signs too (default fee payer); with the
    // stranger as sole signer the transaction was dropped at signature verification.
    await send("outsider wraps WSOL", wrapIxs(stranger, gift), [stranger]);
    await send("outsider sends WSOL to partner_auth's WSOL staging", [createTransferInstruction(ata(WSOL, stranger.publicKey), K.stagingQuote, stranger.publicKey, gift)], [stranger], { feePayer: stranger });
    const v0 = await tokenBalanceStrict(K.l.vault);
    const t0 = await tokenBalanceStrict(new PublicKey((await accounts.global.fetch(pdas.global())).treasury));
    const t = await send("harvest K (with WSOL in staging)", [await harvestIx(K)], [], { cu: 600_000, alts: [opK.alt], expectFail: true });
    if (t.err) return failed(t);
    const ev = named(t, "Harvested")[0];
    const toVault = big(field(ev?.data, "to_vault"));
    const toTreasury = big(field(ev?.data, "to_treasury"));
    return ok({
      stagingZero: (await tokenBalanceStrict(K.stagingQuote)) === 0n,
      vaultGotGift: (await tokenBalanceStrict(K.l.vault)) - v0 === toVault && toVault !== null && toVault >= gift,
      treasuryOnlyFromFees: (await tokenBalanceStrict(new PublicKey((await accounts.global.fetch(pdas.global())).treasury))) - t0 === toTreasury,
    }, { signature: t.signature, toVault: String(toVault), toTreasury: String(toTreasury) });
  });
  await suite.case("§5 rule 3 (repro): deposit from an account of another mint → DepositorAccountInvalid", async () => {
    await send("buyer K base ATA", [ensureAtaIx(K.base, buyerK.publicKey)]);
    const t = await send("deposit from a base account", [await depositIx(K, buyerK.publicKey, 1n, ata(K.base, buyerK.publicKey))], [buyerK], { feePayer: buyerK, expectFail: true });
    return { status: got(t) === "DepositorAccountInvalid" ? "pass" : "fail", expected: "DepositorAccountInvalid", got: got(t) };
  });

  // =============================================================================================
  // Unreachable on Meteora's binaries — covered by a defensive check and a unit test
  // =============================================================================================
  const unreachable = (name: string, why: string) => suite.case(name, async () => ({ status: "unreachable", expected: "-", got: why }));
  await unreachable("§5 rules 1–2: the resting order is decoded (DLMM owner, LimitOrder discriminator, owner == partner_auth, lb_pair)",
    "its key must first equal launch.bid_order, which only Ballast writes with an order it placed itself (floor_ix::check_bid_order)");
  await unreachable("§5 rule 2: the pair's bin step equals the class bin step",
    "the pair address is recorded at registration with the class bin step verified (D-014) and DLMM never changes a pair's bin step (floor_ix::read_pair)");
  await unreachable("§8: an L decrease emits BackingDecreased per position, degrades the launch, keeps redemption open",
    "permanent liquidity cannot decrease on Meteora's binaries; unit test floor_ix::tests::backing_decrease_is_per_position, identity-only reads after open (damm::read_position_identity)");
  await unreachable("§5 rule 1: bin arrays carry the BinArray discriminator",
    "only DLMM can create an account at the bin-array PDA, and only as a BinArray (floor_ix::is_bin_array)");
  await unreachable("D-021: go_to_a_bin / place / cancel through the bitmap extension",
    "at the classes' bin step 10 DLMM confines bins to ±35,163, inside the internal bitmap (±35,840): −40,000 is refused with 6000 (evidence/program/part2/dlmm-bin-range.json). Support is kept for other bin steps; unit test dlmm::tests::bitmap_extension_boundary");

  return suite.finish(process.env.BALLAST_SO ? "part2/audit-repro-d020.json" : "part2/audit.json");
}
