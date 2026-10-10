/**
 * The page's one write path, end to end on the local proof ledger: the quote the Redeem panel shows,
 * the transaction the Redeem button builds (`buildRedeemTx`, no lookup table), signed as a wallet
 * would sign it, landed, and checked against the chain: tokens burned, WSOL received, the program's
 * `Redeemed` event, §10's formula, and the page's numbers after reloading.
 *
 *   pnpm proof:local            # leaves the gate 9 launch Open with holders
 *   pnpm -F app test:redeem
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BallastClient, LAUNCH_STATE, WSOL } from "../../sdk/typescript/src/client";
import { loadFloor } from "../../sdk/typescript/src/floor";
import { buildRedeemTx, loadModel, REDEEM_FEE_BPS } from "../src/model";

const REPO = resolve(__dirname, "../..");
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";

async function main(): Promise<void> {
  const conn = new Connection(RPC, "confirmed");
  const idl = JSON.parse(readFileSync(resolve(REPO, "target/idl/ballast.json"), "utf8"));
  const floor = await loadFloor(readFileSync(resolve(REPO, "target/wasm32-unknown-unknown/release/floor_wasm.wasm")));
  const client = new BallastClient(conn, idl);
  const all = (await (client.program.account as never as { launch: { all(): Promise<{ publicKey: PublicKey; account: { state: number; registeredSlot: BN } }[]> } }).launch.all())
    .filter((x) => x.account.state === LAUNCH_STATE.open)
    .sort((a, b) => Number(b.account.registeredSlot.toString()) - Number(a.account.registeredSlot.toString()));
  const launch = process.env.LAUNCH ? new PublicKey(process.env.LAUNCH) : all[0]?.publicKey;
  if (!launch) throw new Error("no Open launch on this ledger — run pnpm proof:local first");

  // What the page shows before the click.
  const before = await loadModel(conn, idl, launch, floor);
  // A redemption worth a tenth of V: well above §10's 0.001 SOL minimum, well inside the vault.
  const amount = ((before.inputs.v / 10n) << 128n) / (before.s * before.s);
  const quote = floor.payout(amount, before.s, REDEEM_FEE_BPS);
  if (quote < 1_000_000n) throw new Error(`the vault is too small for a redemption above the minimum (quote ${quote} lamports)`);

  // A holder: the test wallet with the most tokens (the proof script's named wallets).
  const keys = JSON.parse(readFileSync(resolve(REPO, "tests/integration/p0/.state/keys.json"), "utf8")) as Record<string, number[]>;
  const bal = async (a: PublicKey) => conn.getTokenAccountBalance(a, "confirmed").then((b) => BigInt(b.value.amount), () => 0n);
  let holder: Keypair | null = null;
  let held = 0n;
  for (const k of Object.values(keys)) {
    const w = Keypair.fromSecretKey(Uint8Array.from(k));
    const b = await bal(getAssociatedTokenAddressSync(before.baseMint, w.publicKey, true));
    if (b > held) [holder, held] = [w, b];
  }
  if (!holder || held < amount) throw new Error(`no test wallet holds ${amount} base units of ${before.baseMint.toBase58()}`);
  const baseAta = getAssociatedTokenAddressSync(before.baseMint, holder.publicKey, true);
  const quoteAta = getAssociatedTokenAddressSync(WSOL, holder.publicKey, true);
  const [base0, wsol0] = [await bal(baseAta), await bal(quoteAta)];

  // The click: min_out defaults to the quote; the wallet signs, the page adds the order keypair.
  const { tx, order, size } = await buildRedeemTx(conn, idl, launch, holder.publicKey, amount, quote);
  tx.sign([order, holder]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const bh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction({ signature, ...bh }, "confirmed");
  let landed = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  for (let i = 0; i < 40 && !landed?.meta; i++) {
    await new Promise((r) => setTimeout(r, 250));
    landed = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  }
  if (!landed?.meta) throw new Error(`${signature} not found`);
  const logs = landed.meta.logMessages ?? [];
  if (landed.meta.err) throw new Error(`redeem failed ${JSON.stringify(landed.meta.err)}\n${logs.join("\n")}`);

  const events = [...new EventParser(new PublicKey(idl.address), new BorshCoder(idl)).parseLogs(logs)];
  const ev = events.find((e) => e.name.toLowerCase() === "redeemed")?.data as Record<string, { toString(): string }> | undefined;
  const pick = (k: string) => BigInt(String(ev?.[k] ?? ev?.[k.replace(/_(.)/g, (_m, c: string) => c.toUpperCase())] ?? -1));
  const [sBefore, sAfter, paid] = [pick("s_before"), pick("s_after"), pick("payout")];
  const [base1, wsol1] = [await bal(baseAta), await bal(quoteAta)];
  const after = await loadModel(conn, idl, launch, floor);

  const checks: Record<string, boolean> = {
    fitsWithoutLookupTable: size <= 1232,
    tokensBurnedExactly: base0 - base1 === amount,
    wsolReceivedEqualsEvent: wsol1 - wsol0 === paid,
    // Paid at s after settling the bid, which is never below the s the page quoted at.
    payoutEqualsFormulaAtSettledS: paid === floor.payout(amount, sBefore, REDEEM_FEE_BPS),
    payoutAtLeastPageQuote: paid >= quote,
    floorDidNotFall: sAfter >= sBefore && sBefore >= before.s,
    pageAfterShowsTheNewFloor: after.floorMatches && after.s === sAfter,
    supplyFellByAmount: before.inputs.sSupply - after.inputs.sSupply >= amount,
  };
  console.log(JSON.stringify({
    launch: launch.toBase58(), holder: holder.publicKey.toBase58(), signature, txBytes: size, cu: landed.meta.computeUnitsConsumed,
    amountBaseUnits: amount, pageQuoteLamports: quote, paidLamports: paid, sPage: before.s, sBefore, sAfter, checks,
  }, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
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
