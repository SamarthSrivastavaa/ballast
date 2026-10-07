/**
 * Characterization (mainnet DLMM binary, D-001): where may a limit-order bid sit relative to the
 * pair's active bin, and can `go_to_a_bin` (permissionless) move the active bin above it?
 *
 * Found by Program Part 2: `open`'s bid at F's bin (≈ −11,920) was refused with
 * `6105 InvalidPlaceLimitOrderParameters` (place_limit_order.rs:133) because the D-011 launch
 * transaction creates the pair with active_id at the DBC start price p0 (−12,645), BELOW F.
 *
 *   pnpm exec tsx tests/integration/program/tools/dlmm-active-bin.ts <lbPair> <baseMint>
 *
 * Wallet-level, top-level SDK transactions only — no Ballast program involved. Writes
 * evidence/program/part2/dlmm-active-bin.json.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import DLMM, { binIdToBinArrayIndex } from "@meteora-ag/dlmm";
import { conn, payer, REPO, send } from "../../p0/src/env";
import { WSOL } from "../../../../compiler/src/canon";
import { ata, ensureAtaIx, funded, tokenBalanceStrict, wrapIxs } from "../../p0/src/wallets";

const OPT = { cluster: "mainnet-beta" as const };
const noCb = (ixs: TransactionInstruction[]) => ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
const code = (logs: string[]) => logs.map((l) => l.match(/Error Code: (\w+)\. Error Number: (\d+)/)).find(Boolean)?.slice(1, 3).join(" ") ?? null;

async function main() {
  const [lbPair, baseMint] = process.argv.slice(2).map((x) => new PublicKey(x));
  const pair = await DLMM.create(conn, lbPair, OPT);
  const bidder = await funded("char.bidder", 10);
  const asker = await funded("char.asker", 10);
  await send("char: bidder WSOL + base ATA", [...wrapIxs(bidder, 3_000_000_000n), ensureAtaIx(baseMint, bidder.publicKey)], [bidder]);
  await send("char: asker ATAs", [ensureAtaIx(baseMint, asker.publicKey), ensureAtaIx(WSOL, asker.publicKey)], [asker]);
  const out: Record<string, unknown> = { lbPair: lbPair.toBase58() };
  const active = async () => { await pair.refetchStates(); return pair.lbPair.activeId; };
  const arrays = async (ids: number[]) => {
    const idx = [...new Set(ids.map((i) => binIdToBinArrayIndex(new BN(i)).toString()))].map((s) => new BN(s));
    const ixs = noCb(await pair.initializeBinArrays(idx, payer.publicKey));
    if (ixs.length) await send("char: init bin arrays", ixs, [], { cu: 1_000_000 });
  };
  const bid = async (label: string, id: number, amount = 10_000_000n) => {
    await arrays([id]);
    const order = Keypair.generate();
    const tx = await pair.placeLimitOrder({
      owner: bidder.publicKey, payer: bidder.publicKey, sender: bidder.publicKey, limitOrder: order.publicKey,
      params: { isAskSide: false, relativeBin: null, bins: [{ id, amount: new BN(amount.toString()) }] } as never,
    });
    const dl = tx.instructions.filter((ix) => ix.programId.equals(pair.program.programId));
    const t = await send(`char: ${label}`, dl, [bidder, order], { cu: 400_000, expectFail: true });
    return { label, bin: id, ok: !t.err, error: code(t.logs), signature: t.signature, order: order.publicKey.toBase58() };
  };
  const goTo = async (label: string, id: number) => {
    await pair.refetchStates();
    const from = binIdToBinArrayIndex(new BN(pair.lbPair.activeId));
    const to = binIdToBinArrayIndex(new BN(id));
    await arrays([pair.lbPair.activeId, id]);
    const ix = await pair.program.methods.goToABin(id).accountsPartial({
      lbPair, binArrayBitmapExtension: null,
      fromBinArray: PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), from.toTwos(64).toArrayLike(Buffer, "le", 8)], pair.program.programId)[0],
      toBinArray: PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), to.toTwos(64).toArrayLike(Buffer, "le", 8)], pair.program.programId)[0],
    } as never).instruction();
    const stranger = Keypair.generate();
    const t = await send(`char: ${label}`, [ix], [], { cu: 400_000, expectFail: true });
    void stranger;
    return { label, target: id, ok: !t.err, error: code(t.logs), activeAfter: await active(), signature: t.signature, cu: t.cu };
  };

  const a0 = await active();
  out.activeAtStart = a0;
  const F_BIN = -11_920; // §27 Proof bid bin
  out.e1_bidBelowActive = await bid("E1 bid at active − 1", a0 - 1);
  out.e2_bidAtActive = await bid("E2 bid at active", a0);
  out.e3_bidAboveActive = await bid("E3 bid at active + 1", a0 + 1);
  out.e3b_bidAtFloorBin = await bid("E3b bid at the floor bin (above active)", F_BIN);
  out.e4_goToAboveFloor = await goTo("E4 go_to_a_bin(floor bin + 1) by a non-signer, bids resting below", F_BIN + 1);
  out.e5_bidAtFloorBinAfterGoTo = await bid("E5 bid at the floor bin after go_to_a_bin", F_BIN);
  out.e6_bidAtNewActive = await bid("E6 bid at the new active bin", F_BIN + 1);
  // Can go_to_a_bin move DOWN across a resting bid? (Would let anyone re-strand the next placement.)
  out.e7_goToDownAcrossBid = await goTo("E7 go_to_a_bin down across the resting floor-bin bid", F_BIN - 100);
  // A third party's ask between the floor bin and the active bin: does it block go_to_a_bin / the bid?
  out.e8_askAboveActive = await (async () => {
    await pair.refetchStates();
    const id = pair.lbPair.activeId + 5;
    await arrays([id]);
    const order = Keypair.generate();
    const tx = await pair.placeLimitOrder({
      owner: asker.publicKey, payer: asker.publicKey, sender: asker.publicKey, limitOrder: order.publicKey,
      params: { isAskSide: true, relativeBin: null, bins: [{ id, amount: new BN(1_000_000) }] } as never,
    });
    void tx;
    return { skipped: "asker holds no base on this pair; see E9" };
  })();
  out.e9_goToUpAgain = await goTo("E9 go_to_a_bin further up (no liquidity between)", F_BIN + 50);
  out.bidderWsolLeft = (await tokenBalanceStrict(ata(WSOL, bidder.publicKey))).toString();
  const path = resolve(REPO, "evidence/program/part2/dlmm-active-bin.json");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
