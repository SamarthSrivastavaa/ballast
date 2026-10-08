/**
 * The keeper (§31) on the mainnet-binary local validator (D-001): launches driven by nothing but
 * `Keeper.crank()` after the buys — settle, migrate, burn, open at F's bin; a refresh after fills;
 * harvest and pay_creator on schedule; and a third-party pin before `open`, met by the keeper's
 * D-020/D-021 fallback (F's bin refused with 6056 → the active bin).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SystemProgram } from "@solana/web3.js";
import { conn, payer, REPO, send } from "../../p0/src/env";
import { PROOF, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { buyPartialFill } from "../../p0/src/flow";
import { ensureAtaIx, funded, wallet, wrapIxs } from "../../p0/src/wallets";
import { BallastClient, floorBin, LAUNCH_STATE, LaunchView } from "../../../../sdk/typescript/src/client";
import { loadFloor } from "../../../../sdk/typescript/src/floor";
import { CrankLog, Keeper } from "../../../../keeper/src/keeper";
import { accounts, ballast, IDL, pdas } from "./client";
import { cancelWalletOrder, goToBin, keeperArrays, Opened, sellIntoBid, waitSlots, walletOrder } from "./fixture";
import { launch, Launch } from "./launch";
import { dbcConfig } from "./part3";
import { Suite } from "./runner";

/** The fixture's view of a launch, from the SDK's. */
function opened(v: LaunchView, l: Launch, classConfig: Opened["classConfig"], creator: Opened["creator"]): Opened {
  return {
    classConfig, l, base: v.baseMint, partnerAuth: v.partnerAuth, staging: v.stagingBase, stagingQuote: v.stagingQuote,
    dammPool: v.dammPool, partnerPosition: v.partnerPosition!, creatorPosition: v.creatorPosition!, partnerNft: v.partnerNft!,
    creatorNft: v.creatorNft!, reserveX: v.reserveX, reserveY: v.reserveY, creator,
  };
}

export async function part6(): Promise<number> {
  const suite = new Suite("Keeper (§31) — launches driven by cranks alone, on mainnet binaries");
  const admin = wallet("program.admin");
  const creator = await funded("program.k.creator", 5);
  const buyer = await funded("program.k.buyer", 30);
  const buyer2 = await funded("program.k.buyer2", 30);
  const stranger = await funded("program.k.stranger", 10);
  await send("k: payer WSOL", wrapIxs(payer, 20_000_000n), []);
  await send("k: stranger WSOL", wrapIxs(stranger, 1_000_000_000n), [stranger]);
  await send("k: beneficiary WSOL ATA", [ensureAtaIx(WSOL, creator.publicKey)]);
  const classConfig = await dbcConfig("keeper class");
  await send("k: create_class", [
    await ballast.methods.createClass(0).accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig }).instruction(),
  ], [admin]);
  await send("k: fund partner_auth", [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pdas.partner(classConfig), lamports: 100_000_000 })]);

  const logs: CrankLog[] = [];
  const floor = await loadFloor(readFileSync(resolve(REPO, "target/wasm32-unknown-unknown/release/floor_wasm.wasm")));
  const client = new BallastClient(conn, IDL, payer.publicKey);
  const keeper = new Keeper(conn, client, payer, { floor, harvestEvery: 3, log: (l) => logs.push(l) });
  const trail = (from: number) => logs.slice(from).map((x) => `${x.action}${x.error ? ` ✗${x.error}` : ""}`);
  const state = async (k: Launch) => (await accounts.launch.fetch(k.launch)).state as number;
  /** Crank until the launch reaches `target` (at most `max` cranks). */
  const crankTo = async (k: Launch, target: number, max = 8) => {
    for (let i = 0; i < max && (await state(k)) < target; i++) await keeper.crank(k.launch);
    return state(k);
  };

  // ---- launch 1: the whole lifecycle -------------------------------------------------------------
  const l1 = await launch("keeper launch 1", classConfig, creator, sqrtPriceQ64(PROOF.p0));
  await buyPartialFill("keeper launch 1: buy to the threshold", buyer, l1.pool, 12_000_000_000n);
  await suite.case("keeper: Registered → Funded → (migrated) → Cleaned → Open by cranks alone", async () => {
    const from = logs.length;
    const end = await crankTo(l1, LAUNCH_STATE.open);
    const rec = await accounts.launch.fetch(l1.launch);
    const v = await client.view(l1.launch);
    const f = await client.readFloor(v, payer.publicKey);
    const ok = end === LAUNCH_STATE.open && rec.bidBinId === floorBin(f.s, v.binStep) && !rec.bidCapped && !rec.bidSuspended;
    return { status: ok ? "pass" : "fail", expected: "Open with the bid at F's bin", got: JSON.stringify({ end, bin: rec.bidBinId, trail: trail(from) }) };
  });
  const o1 = opened(await client.view(l1.launch), l1, classConfig, creator);
  await suite.case("keeper: after a fill, the next crank settles it and re-places the vault at F's new bin", async () => {
    await send("k: buyer WSOL ATA", [ensureAtaIx(WSOL, buyer.publicKey)]);
    const before = await accounts.launch.fetch(l1.launch);
    const fill = await sellIntoBid(o1, buyer, 20_000_000_000_000n);
    await waitSlots(12);
    const from = logs.length;
    await keeper.crank(l1.launch);
    const rec = await accounts.launch.fetch(l1.launch);
    const refreshed = logs.slice(from).some((x) => x.action.startsWith("refresh_floor") && !x.error);
    const ok = !fill.err && refreshed && BigInt(rec.sLast.toString()) > BigInt(before.sLast.toString()) && BigInt(rec.filledTokens.toString()) > 0n;
    return { status: ok ? "pass" : "fail", expected: "refresh after the fill; F rose", got: JSON.stringify(trail(from)) };
  });
  await suite.case("keeper: harvest and pay_creator on schedule", async () => {
    const from = logs.length;
    for (let i = 0; i < 3; i++) await keeper.crank(l1.launch);
    const ran = logs.slice(from).filter((x) => (x.action === "harvest" || x.action === "pay_creator") && !x.error).map((x) => x.action);
    const ok = ran.includes("harvest") && ran.includes("pay_creator");
    return { status: ok ? "pass" : "fail", expected: "harvest + pay_creator", got: JSON.stringify(trail(from)) };
  });

  // ---- launch 2: a third party pins the active bin 30 bins under F's bin before `open` -----------
  const l2 = await launch("keeper launch 2", classConfig, creator, sqrtPriceQ64(PROOF.p0));
  await buyPartialFill("keeper launch 2: buy to the threshold", buyer2, l2.pool, 12_000_000_000n);
  await suite.case("keeper: a pin before open — F's bin refused (6056), the keeper opens at the active bin instead (D-020/D-021)", async () => {
    const cleaned = await crankTo(l2, LAUNCH_STATE.cleaned);
    if (cleaned !== LAUNCH_STATE.cleaned) return { status: "fail", expected: "Cleaned", got: String(cleaned) };
    const v = await client.view(l2.launch);
    const o2 = opened(v, l2, classConfig, creator);
    const target = floorBin(BigInt(v.launch.predictedS.toString()), v.binStep) + 5; // ≈ F's bin at open
    const pin = target - 30;
    await keeperArrays(o2, [pin], stranger);
    await goToBin(o2, stranger, pin);
    const dust = await walletOrder(o2, stranger, pin, 1_000_000n);
    const from = logs.length;
    await keeper.crank(l2.launch);
    const rec = await accounts.launch.fetch(l2.launch);
    const t = trail(from);
    await cancelWalletOrder(o2, stranger, dust, pin);
    const fellBack = t.some((x) => x.includes("BinRangeIsNotEmpty")) && t.some((x) => x.startsWith(`open_floor(hint ${pin})`) && !x.includes("✗"));
    const ok = fellBack && rec.state === LAUNCH_STATE.open && rec.bidCapped === true && rec.bidBinId === pin;
    return { status: ok ? "pass" : "fail", expected: "open refused at F's bin, then capped at the pin", got: JSON.stringify({ t, capped: rec.bidCapped, bin: rec.bidBinId, pin }) };
  });
  await suite.case("keeper: once the pin is gone, the next crank lifts the capped bid to F's bin", async () => {
    await waitSlots(12);
    const from = logs.length;
    await keeper.crank(l2.launch);
    const rec = await accounts.launch.fetch(l2.launch);
    const v = await client.view(l2.launch);
    const f = await client.readFloor(v, payer.publicKey);
    const ok = !rec.bidCapped && rec.bidBinId === floorBin(f.s, v.binStep);
    return { status: ok ? "pass" : "fail", expected: "uncapped at F's bin", got: JSON.stringify({ t: trail(from), bin: rec.bidBinId }) };
  });

  return suite.finish("keeper/results.json");
}
