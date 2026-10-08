/**
 * Shared fixture for the Part 2 suites (part4, part5) on the mainnet-binary local validator (D-001):
 * a launch driven to `Cleaned`, the Ballast instruction builders, the keeper's top-level DLMM steps,
 * third-party DLMM actions (orders, `go_to_a_bin`, the bitmap extension), event decoding, and the
 * independent expected values — F from the Python reference, bin prices from the DLMM SDK.
 *
 * Builders pass the union of the D-020 and current account names, so the reproduction run against
 * the D-020 build (`BALLAST_IDL`, `BALLAST_SO`) exercises the same calls; Anchor ignores names its
 * IDL does not list.
 */
import { execFileSync } from "node:child_process";
import BN from "bn.js";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import DLMM, { binIdToBinArrayIndex, deriveBinArray, getQPriceFromId } from "@meteora-ag/dlmm";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, createAlt, Landed, payer, REPO, send } from "../../p0/src/env";
import { PROOF, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { buyPartialFill, cpAmm, dammPool, dammPosition, MIGRATION_DAMM_CONFIG, migrate, norm, rawData } from "../../p0/src/flow";
import { ata, tokenBalanceStrict } from "../../p0/src/wallets";
import { accounts, ballast, errorName, IDL, pdas } from "./client";
import { DLMM_ID, launch, Launch } from "./launch";
import { burn, got, graduationAccounts, payCreatorIx, settle } from "./part3";

export const OPT = { cluster: "mainnet-beta" as const }; // T7: the SDK's localhost id is not mainnet DLMM
export const BIN_STEP = 10;
export const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
export const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const DAMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DAMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DAMM_ID)[0];
const REDEEM_FEE_BPS = 50n;
const Q128 = 1n << 128n;
/** D-021 `canon::MAX_CAP_DEPTH`. */
export const MAX_CAP_DEPTH = 70;

// ---------------------------------------------------------------------------------------------
// Independent expected values
// ---------------------------------------------------------------------------------------------

/** s from the independent Python reference (§11) — never from the program under test. */
export function pyFloor(v: bigint, s: bigint, l: bigint, sMax: bigint): bigint {
  const code = `import sys; sys.path.insert(0, "tests/reference"); from floor import floor_sqrt_q64; print(floor_sqrt_q64(${v}, ${s}, ${l}, ${sMax}))`;
  return BigInt(execFileSync("python3", ["-c", code], { cwd: REPO }).toString().trim());
}

/** §10 payout, written from the formula: ⌊T·s²·(10⁴ − φ)/(2¹²⁸·10⁴)⌋. */
export function expectedPayout(amount: bigint, s: bigint): bigint {
  return (amount * s * s * (10_000n - REDEEM_FEE_BPS)) / (Q128 * 10_000n);
}

/** DLMM's own Q64 bin price (SDK `getQPriceFromId`, exact BN). */
export function qPrice(id: number): bigint {
  return BigInt(getQPriceFromId(new BN(id), new BN(BIN_STEP)).toString());
}

/** Highest bin whose price ≤ F = s²/2¹²⁸ (§9), exact in bigint. */
export function binAtOrBelow(s: bigint): number {
  const f = Number(s) ** 2 / 2 ** 128;
  let id = Math.floor(Math.log(f) / Math.log(1 + BIN_STEP / 1e4));
  const s2 = s * s;
  while (qPrice(id) << 64n > s2) id--;
  while (qPrice(id + 1) << 64n <= s2) id++;
  return id;
}

// ---------------------------------------------------------------------------------------------
// Launch fixture
// ---------------------------------------------------------------------------------------------

export interface Opened {
  classConfig: PublicKey;
  l: Launch;
  base: PublicKey;
  partnerAuth: PublicKey;
  staging: PublicKey;
  stagingQuote: PublicKey;
  dammPool: PublicKey;
  partnerPosition: PublicKey;
  creatorPosition: PublicKey;
  partnerNft: PublicKey;
  creatorNft: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  creator: Keypair;
}

export const nftAccountOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), mint.toBuffer()], DAMM_ID)[0];
export const positionOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), mint.toBuffer()], DAMM_ID)[0];
export const binArrayOf = (pair: PublicKey, id: number) => deriveBinArray(pair, binIdToBinArrayIndex(new BN(id)), DLMM_ID)[0];
export const extensionOf = (pair: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bitmap"), pair.toBuffer()], DLMM_ID)[0];
/** The bin's array lies outside the pair's internal bitmap (index beyond −512 … 511). */
export const outsideBitmap = (id: number) => {
  const idx = Number(binIdToBinArrayIndex(new BN(id)).toString());
  return idx < -512 || idx > 511;
};

/** Owner field of a Token-2022 account (offset 32). */
async function tokenOwner(account: PublicKey): Promise<PublicKey> {
  return new PublicKey((await rawData(account)).subarray(32, 64));
}

/** Hooks between the steps of `cleanedLaunch`. */
export interface CleanOpts {
  /** After the buy to the threshold, before `settle_graduation`. */
  beforeSettle?: (l: Launch) => Promise<void>;
  /** Buys in order (the last one partial-fills to the threshold); default one buy by `buyer`. */
  buys?: [Keypair, bigint][];
  /** Every signature along the way, for evidence. */
  record?: (label: string, signature: string) => void;
}

/** Register → buy to the threshold → settle → migrate → burn_leftover: a launch in `Cleaned`. */
export async function cleanedLaunch(label: string, classConfig: PublicKey, creator: Keypair, buyer: Keypair, opts: CleanOpts = {}): Promise<Opened> {
  const rec = opts.record ?? (() => undefined);
  const l = await launch(label, classConfig, creator, sqrtPriceQ64(PROOF.p0));
  if (l.landed.err) throw new Error(`${label}: launch failed ${errorName(l.landed.logs)}`);
  rec("launch (D-011: DBC pool + dust buy + DLMM pair + transfer_pool_creator + register_launch)", l.landed.signature);
  const acc = graduationAccounts(classConfig, l, creator.publicKey);
  for (const [i, [w, amount]] of (opts.buys ?? [[buyer, 12_000_000_000n]]).entries()) {
    rec(`buy ${i + 1}`, (await buyPartialFill(`${label}: buy ${i + 1}`, w, l.pool, amount)).signature);
  }
  await opts.beforeSettle?.(l);
  const st = await settle(`${label}: settle`, acc);
  if (st.err) throw new Error(`${label}: settle ${got(st)}`);
  rec("settle_graduation", st.signature);
  const mig = await migrate(`${label}: migrate`, l.pool);
  rec("migration_damm_v2 (top-level keeper)", mig.landed.signature);
  const bu = await burn(`${label}: burn_leftover`, acc);
  if (bu.err) throw new Error(`${label}: burn ${got(bu)}`);
  rec("burn_leftover", bu.signature);
  const base = l.baseMint.publicKey;
  const partnerAuth = pdas.partner(classConfig);
  // Which migrated NFT went to whom is read, not assumed.
  const nfts = [mig.firstNft, mig.secondNft];
  const holders = await Promise.all(nfts.map((m) => tokenOwner(nftAccountOf(m))));
  const pi = holders.findIndex((h) => h.equals(partnerAuth));
  const ci = holders.findIndex((h) => h.equals(l.creatorAuth));
  if (pi < 0 || ci < 0) throw new Error(`${label}: NFT holders ${holders.map(String)} are not partner_auth/creator_auth`);
  const pair = await DLMM.create(conn, l.lbPair, OPT);
  return {
    classConfig, l, base, partnerAuth, staging: ata(base, partnerAuth), stagingQuote: ata(WSOL, partnerAuth), creator,
    dammPool: deriveDammV2PoolAddress(MIGRATION_DAMM_CONFIG, base, WSOL),
    partnerPosition: positionOf(nfts[pi]), creatorPosition: positionOf(nfts[ci]),
    partnerNft: nftAccountOf(nfts[pi]), creatorNft: nftAccountOf(nfts[ci]),
    reserveX: pair.lbPair.reserveX, reserveY: pair.lbPair.reserveY,
  };
}

/** Live §4 inputs, read the way the verifier will: V = vault + committed, S = supply − staging. */
export async function liveInputs(o: Opened): Promise<{ v: bigint; s: bigint; l: bigint; sMax: bigint; vault: bigint }> {
  const rec = await accounts.launch.fetch(o.l.launch);
  const vault = await tokenBalanceStrict(o.l.vault);
  const supply = (await getMint(conn, o.base)).supply;
  const staging = await tokenBalanceStrict(o.staging);
  const pos = await Promise.all([o.partnerPosition, o.creatorPosition].map(dammPosition));
  const l = pos.reduce((a, p) => a + BigInt((p as Record<string, string>).permanentLockedLiquidity), 0n);
  const pool = (await dammPool(o.dammPool)) as Record<string, string>;
  return { v: vault + BigInt(rec.bidQuoteCommitted.toString()), s: supply - staging, l, sMax: BigInt(pool.sqrtMaxPrice), vault };
}

/** F's bin for the launch's live inputs, from the reference. */
export async function floorBinNow(o: Opened): Promise<{ s: bigint; bin: number }> {
  const i = await liveInputs(o);
  const s = pyFloor(i.v, i.s, i.l, i.sMax);
  return { s, bin: binAtOrBelow(s) };
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

const parser = new EventParser(ballast.programId, new BorshCoder(IDL));

export interface Ev { name: string; data: Record<string, unknown> }

/** Ballast's events in a landed transaction, decoded with the loaded IDL. */
export function events(t: Landed): Ev[] {
  return [...parser.parseLogs(t.logs)].map((e) => ({ name: e.name, data: e.data as Record<string, unknown> }));
}

/** An event field by its IDL (snake_case) name, tolerant of the coder's camelCase. */
export function field(d: Record<string, unknown> | undefined, snake: string): unknown {
  if (!d) return undefined;
  return d[snake] ?? d[snake.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())];
}

export const big = (x: unknown) => (x === undefined || x === null ? null : BigInt((x as { toString(): string }).toString()));
export const key = (x: unknown) => (x === undefined || x === null ? null : new PublicKey(x as PublicKey).toBase58());

// ---------------------------------------------------------------------------------------------
// Ballast builders
// ---------------------------------------------------------------------------------------------

/**
 * The composite `bid` accounts (floor_ix::BidAccounts). With no resting order (`bid_order` is the
 * default key: vault exhausted or DLMM leg suspended) any writable account fills the slot — the
 * default key is the System Program, which the runtime demotes to read-only.
 */
export function bidAccounts(o: Opened, newOrder: PublicKey, bidOrder: PublicKey) {
  return {
    launch: o.l.launch, class: pdas.class(o.classConfig), partnerAuth: o.partnerAuth, vault: o.l.vault,
    stagingBase: o.staging, baseMint: o.base, quoteMint: WSOL, dlmmPair: o.l.lbPair,
    reserveX: o.reserveX, reserveY: o.reserveY, bidOrder: bidOrder.equals(PublicKey.default) ? newOrder : bidOrder, newOrder,
    dlmmEventAuthority: DLMM_EVENT_AUTHORITY, dlmmProgram: DLMM_ID, memoProgram: MEMO,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}

export const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

export type OpenOver = Partial<{
  bid: Partial<ReturnType<typeof bidAccounts>>; creatorAuth: PublicKey; dammPool: PublicKey; partnerPosition: PublicKey;
  creatorPosition: PublicKey; partnerNftAccount: PublicKey; creatorNftAccount: PublicKey; remaining: PublicKey[];
}>;

export const openIx = async (o: Opened, order: Keypair, bin: number, remaining: PublicKey[], x: OpenOver = {}) =>
  ballast.methods.open(bin)
    .accountsPartial({
      bid: { ...bidAccounts(o, order.publicKey, order.publicKey), ...(x.bid ?? {}) },
      creatorAuth: x.creatorAuth ?? o.l.creatorAuth, dammPool: x.dammPool ?? o.dammPool,
      partnerPosition: x.partnerPosition ?? o.partnerPosition, creatorPosition: x.creatorPosition ?? o.creatorPosition,
      partnerNftAccount: x.partnerNftAccount ?? o.partnerNft, creatorNftAccount: x.creatorNftAccount ?? o.creatorNft,
    } as never)
    .remainingAccounts((x.remaining ?? remaining).map(writable))
    .instruction();

export const refreshIx = async (o: Opened, order: Keypair, bidOrder: PublicKey, bin: number, remaining: PublicKey[]) =>
  ballast.methods.refreshFloor(bin)
    .accountsPartial({ bid: bidAccounts(o, order.publicKey, bidOrder), dammPool: o.dammPool, partnerPosition: o.partnerPosition, creatorPosition: o.creatorPosition } as never)
    .remainingAccounts(remaining.map(writable)).instruction();

/** `refresh_floor` naming the launch's current resting order. */
export const refreshNowIx = async (o: Opened, order: Keypair, bin: number, remaining: PublicKey[]) =>
  refreshIx(o, order, new PublicKey((await accounts.launch.fetch(o.l.launch)).bidOrder), bin, remaining);

export const redeemIx = async (o: Opened, order: Keypair, holder: PublicKey, amount: bigint, minOut: bigint, remaining: PublicKey[], holderQuote?: PublicKey) => {
  const rec = await accounts.launch.fetch(o.l.launch);
  return ballast.methods.redeem(new BN(amount.toString()), new BN(minOut.toString()))
    .accountsPartial({
      bid: bidAccounts(o, order.publicKey, new PublicKey(rec.bidOrder)), dammPool: o.dammPool, partnerPosition: o.partnerPosition,
      creatorPosition: o.creatorPosition, holder, holderBase: ata(o.base, holder), holderQuote: holderQuote ?? ata(WSOL, holder),
    } as never)
    .remainingAccounts(remaining.map(writable)).instruction();
};

export const floorIx = async (o: Opened) =>
  ballast.methods.floor().accountsPartial({
    launch: o.l.launch, class: pdas.class(o.classConfig), partnerAuth: o.partnerAuth, vault: o.l.vault, stagingBase: o.staging,
    baseMint: o.base, dammPool: o.dammPool, partnerPosition: o.partnerPosition, creatorPosition: o.creatorPosition,
  } as never).instruction();

/** `floor()` via simulation; decodes the borsh `FloorReport`. */
export async function readFloor(o: Opened) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [await floorIx(o)] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  if (r.value.err || !r.value.returnData) throw new Error(`floor(): ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).slice(-3).join(" | ")}`);
  const b = Buffer.from(r.value.returnData.data[0], "base64");
  const u128 = (off: number) => b.readBigUInt64LE(off) + (b.readBigUInt64LE(off + 8) << 64n);
  return {
    s: u128(0), fQ64: u128(16), v: b.readBigUInt64LE(32), sSupply: b.readBigUInt64LE(40), l: u128(48), sLast: u128(64),
    binId: b.readInt32LE(80), binPrice: u128(84), capped: b.length > 100 ? b[100] === 1 : null, suspended: b.length > 101 ? b[101] === 1 : null,
    cu: r.value.unitsConsumed ?? null,
  };
}

/** `harvest`, with the union of the D-020 and current accounts (D-022 dropped the creator's). */
export async function harvestIx(o: Opened, x: Partial<{ treasury: PublicKey; stagingQuote: PublicKey }> = {}) {
  const pool = (await dammPool(o.dammPool)) as Record<string, string>;
  const global = await accounts.global.fetch(pdas.global());
  return ballast.methods.harvest().accountsPartial({
    launch: o.l.launch, class: pdas.class(o.classConfig), global: pdas.global(), partnerAuth: o.partnerAuth, creatorAuth: o.l.creatorAuth,
    vault: o.l.vault, stagingBase: o.staging, stagingQuote: x.stagingQuote ?? o.stagingQuote, baseMint: o.base, quoteMint: WSOL,
    dammPool: o.dammPool, partnerPosition: o.partnerPosition, creatorPosition: o.creatorPosition, partnerNftAccount: o.partnerNft,
    creatorNftAccount: o.creatorNft, tokenAVault: new PublicKey(pool.tokenAVault), tokenBVault: new PublicKey(pool.tokenBVault),
    treasury: x.treasury ?? new PublicKey(global.treasury), beneficiaryQuote: ata(WSOL, o.creator.publicKey),
    dammPoolAuthority: DAMM_POOL_AUTHORITY, dammEventAuthority: DAMM_EVENT_AUTHORITY, dammProgram: DAMM_ID, tokenProgram: TOKEN_PROGRAM_ID,
  } as never).instruction();
}

export const depositIx = async (o: Opened, depositor: PublicKey, amount: bigint, depositorQuote?: PublicKey) =>
  ballast.methods.deposit(new BN(amount.toString())).accountsPartial({
    launch: o.l.launch, class: pdas.class(o.classConfig), partnerAuth: o.partnerAuth, vault: o.l.vault, stagingBase: o.staging,
    baseMint: o.base, dammPool: o.dammPool, partnerPosition: o.partnerPosition, creatorPosition: o.creatorPosition,
    depositor, depositorQuote: depositorQuote ?? ata(WSOL, depositor), tokenProgram: TOKEN_PROGRAM_ID,
  } as never).instruction();

/** The DAMM v2 accounts `pay_creator` needs once `Open` (D-022). */
export async function creatorDammAccounts(o: Opened): Promise<Record<string, PublicKey>> {
  const pool = (await dammPool(o.dammPool)) as Record<string, string>;
  return {
    dammPool: o.dammPool, partnerPosition: o.partnerPosition, creatorPosition: o.creatorPosition, creatorNftAccount: o.creatorNft,
    tokenAVault: new PublicKey(pool.tokenAVault), tokenBVault: new PublicKey(pool.tokenBVault),
    dammPoolAuthority: DAMM_POOL_AUTHORITY, dammEventAuthority: DAMM_EVENT_AUTHORITY, dammProgram: DAMM_ID,
  };
}

export { payCreatorIx };

// ---------------------------------------------------------------------------------------------
// Keeper and third parties (top-level DLMM)
// ---------------------------------------------------------------------------------------------

export const activeOf = async (o: Opened) => (await DLMM.create(conn, o.l.lbPair, OPT)).lbPair.activeId;

const noCb = (ixs: TransactionInstruction[]) => ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

/** D-013: the keeper creates bin arrays (top-level) before Ballast needs them. */
export async function keeperArrays(o: Opened, bins: number[], funder: Keypair = payer): Promise<void> {
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  const idx = [...new Set(bins.map((b) => binIdToBinArrayIndex(new BN(b)).toString()))].map((x) => new BN(x));
  // The SDK adds its own compute-budget instruction; `send` sets the limit (two = DuplicateInstruction).
  for (const ix of noCb(await p.initializeBinArrays(idx, funder.publicKey))) {
    await send("initialize_bin_array", [ix], [funder], { cu: 400_000, feePayer: funder });
  }
}

/** Bin-array addresses for `bins`, deduplicated. */
export const arrays = (o: Opened, bins: number[]) => [...new Map(bins.map((b) => binArrayOf(o.l.lbPair, b)).map((k) => [k.toBase58(), k])).values()];

export const altFor = async (o: Opened, extra: PublicKey[]) => createAlt(`ALT ${o.base.toBase58().slice(0, 6)}`, [
  ...Object.values(bidAccounts(o, payer.publicKey, payer.publicKey)).filter((k) => !k.equals(payer.publicKey)),
  o.dammPool, o.partnerPosition, o.creatorPosition, o.partnerNft, o.creatorNft, o.l.creatorAuth, o.stagingQuote,
  ballast.programId, ComputeBudgetProgram.programId, ...extra,
]);

export async function waitSlots(n: number): Promise<void> {
  const s0 = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) < s0 + n) await new Promise((r) => setTimeout(r, 200));
}

/** An order a wallet places top-level through the SDK (third-party liquidity on the same pair). */
export async function walletOrder(o: Opened, who: Keypair, bin: number, amount: bigint, ask = false): Promise<PublicKey> {
  await keeperArrays(o, [bin], who);
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  const order = Keypair.generate();
  const tx = await p.placeLimitOrder({
    owner: who.publicKey, payer: who.publicKey, sender: who.publicKey, limitOrder: order.publicKey,
    params: { isAskSide: ask, relativeBin: null, bins: [{ id: bin, amount: new BN(amount.toString()) }] } as never,
  });
  const ixs = tx.instructions.filter((ix) => ix.programId.equals(DLMM_ID));
  // Outside the internal bitmap the order needs the pair's extension (writable optional account 1).
  if (outsideBitmap(bin)) {
    for (const ix of ixs) if (ix.keys[1]?.pubkey.equals(DLMM_ID)) ix.keys[1] = writable(extensionOf(o.l.lbPair));
  }
  await send(`wallet order at ${bin}`, ixs, [who, order], { cu: 400_000, feePayer: who });
  return order.publicKey;
}

export async function cancelWalletOrder(o: Opened, who: Keypair, order: PublicKey, bin: number): Promise<void> {
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  const tx = await p.cancelLimitOrder({ limitOrderPubkey: order, owner: who.publicKey, rentReceiver: who.publicKey, binIds: [bin] });
  await send("wallet cancels its order", noCb(tx.instructions), [who], { cu: 400_000, feePayer: who });
}

/** `cancel_limit_order` + close for a wallet's order, as instructions (to bundle with other calls). */
export async function cancelWalletOrderIxs(o: Opened, who: Keypair, order: PublicKey, bin: number): Promise<TransactionInstruction[]> {
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  const tx = await p.cancelLimitOrder({ limitOrderPubkey: order, owner: who.publicKey, rentReceiver: who.publicKey, binIds: [bin] });
  return noCb(tx.instructions);
}

/** Permissionless `initialize_bin_array_bitmap_extension` for the pair (any funder). */
export async function initExtension(o: Opened, funder: Keypair): Promise<Landed> {
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  const ix = await p.program.methods.initializeBinArrayBitmapExtension()
    .accountsPartial({ lbPair: o.l.lbPair, binArrayBitmapExtension: extensionOf(o.l.lbPair), funder: funder.publicKey, rent: SYSVAR_RENT_PUBKEY } as never)
    .instruction();
  return send("third party: initialize_bin_array_bitmap_extension", [ix], [funder], { cu: 400_000, feePayer: funder });
}

/** Permissionless top-level `go_to_a_bin(to)`, no signer but the fee payer (D-020 evidence). */
export async function goToBin(o: Opened, who: Keypair, to: number, expectFail = false): Promise<Landed> {
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  const from = p.lbPair.activeId;
  const opt = async (id: number) => ((await conn.getAccountInfo(binArrayOf(o.l.lbPair, id))) ? binArrayOf(o.l.lbPair, id) : null);
  const needsExt = [from, to].some(outsideBitmap);
  const ix = await p.program.methods.goToABin(to)
    .accountsPartial({
      lbPair: o.l.lbPair, binArrayBitmapExtension: needsExt ? extensionOf(o.l.lbPair) : null,
      fromBinArray: await opt(from), toBinArray: await opt(to),
    } as never)
    .instruction();
  return send(`third party: go_to_a_bin(${to}) from ${from}`, [ix], [who], { cu: 400_000, feePayer: who, expectFail });
}

/** Expected s after the next settlement, from the resting order's own state (SDK) and live V, S, L. */
export async function expectedAfterSettle(o: Opened) {
  const rec = await accounts.launch.fetch(o.l.launch);
  const p = await DLMM.create(conn, o.l.lbPair, OPT);
  // SDK amounts are UI decimal strings; for a bid, the base it bought is `totalSwappedAmountX`
  // and what cancel returns in quote is the unfilled amount plus fees (Q5: exactly).
  const lo = (norm(await p.getLimitOrder(new PublicKey(rec.bidOrder))) as { limitOrderData: Record<string, string> }).limitOrderData;
  const units = (x: string, d: number) => { const [i, f = ""] = x.split("."); return BigInt(i + f.padEnd(d, "0").slice(0, d)); };
  const filled = units(lo.totalSwappedAmountX, 6);
  const back = units(lo.transferFeeExcludedWithdrawableAmountY, 9);
  const live = await liveInputs(o);
  const staging = await tokenBalanceStrict(o.staging);
  const v = live.vault + back;
  const s = live.s - filled; // staging (already outside S) is burned too, which leaves S unchanged
  return { s: pyFloor(v, s, live.l, live.sMax), filled, back, v, supply: s, l: live.l, sMax: live.sMax, staging };
}

/** A seller swaps base → WSOL on the pair, filling the resting bid. */
export async function sellIntoBid(o: Opened, seller: Keypair, amount: bigint): Promise<Landed> {
  const pair = await DLMM.create(conn, o.l.lbPair, OPT);
  const binArrays = await pair.getBinArrayForSwap(true);
  const q = pair.swapQuote(new BN(amount.toString()), true, new BN(10_000), binArrays);
  const tx = await pair.swap({ inToken: o.base, outToken: WSOL, inAmount: new BN(amount.toString()), minOutAmount: new BN(0), lbPair: o.l.lbPair, user: seller.publicKey, binArraysPubkey: q.binArraysPubkey });
  return send("seller fills the bid", noCb(tx.instructions), [seller], { feePayer: seller, cu: 400_000, expectFail: true });
}

/** Keeper: `open` at F's bin (creating its bin arrays first), moving the active bin up (D-020). */
export async function openAtFloor(o: Opened, extra: PublicKey[] = []) {
  const { bin } = await floorBinNow(o);
  const active = await activeOf(o);
  await keeperArrays(o, [bin, bin + 70]);
  const order = Keypair.generate();
  const alt = await altFor(o, [...arrays(o, [bin, bin + 70, active]), ...extra]);
  const t = await send(`open ${o.base.toBase58().slice(0, 6)} at F's bin`, [await openIx(o, order, bin, [...arrays(o, [bin, active]), ...extra])], [order], { cu: 600_000, alts: [alt], expectFail: true });
  return { t, bin, active, order, alt };
}

/** Keeper: `refresh_floor` at F's bin after settlement (D-020), creating the bin array if needed. */
export async function keeperRefresh(o: Opened, alt: Awaited<ReturnType<typeof altFor>>): Promise<Landed> {
  const rec = await accounts.launch.fetch(o.l.launch);
  const live = rec.bidOrder.toString() !== PublicKey.default.toBase58();
  const s = live ? (await expectedAfterSettle(o)).s : (await floorBinNow(o)).s;
  const want = binAtOrBelow(s);
  await keeperArrays(o, [want]);
  const order = Keypair.generate();
  const active = await activeOf(o);
  return send("keeper: refresh_floor", [await refreshIx(o, order, new PublicKey(rec.bidOrder), want, arrays(o, [rec.bidBinId, want, active]))], [order], { cu: 600_000, alts: [alt], expectFail: true });
}

/** DAMM v2 net quote for selling `b` base, from the pool's L and price (Q3's formulas; 1% fee). */
export async function dammSellQuote(o: Opened, b: bigint): Promise<bigint> {
  const p = (await dammPool(o.dammPool)) as Record<string, string>;
  const l = BigInt(p.liquidity);
  const s0 = BigInt(p.sqrtPrice);
  const s1 = (l * s0 + (l + b * s0) - 1n) / (l + b * s0);
  const gross = (l * (s0 - s1)) >> 128n;
  return gross - (gross * 100n + 9_999n) / 10_000n;
}

/** DLMM net quote for selling `b` base into the pair (the SDK's own swap quote). */
export async function bidSellQuote(o: Opened, b: bigint): Promise<bigint> {
  const pair = await DLMM.create(conn, o.l.lbPair, OPT);
  try {
    const arrs = await pair.getBinArrayForSwap(true);
    const q = pair.swapQuote(new BN(b.toString()), true, new BN(10_000), arrs);
    return BigInt(q.outAmount.toString());
  } catch {
    return 0n;
  }
}

/** A DAMM v2 sell of `b` base by `who`. */
export async function dammSell(o: Opened, who: Keypair, b: bigint): Promise<Landed> {
  const p = (await dammPool(o.dammPool)) as Record<string, string>;
  const tx = await cpAmm.swap({
    payer: who.publicKey, pool: o.dammPool, inputTokenMint: o.base, outputTokenMint: WSOL,
    amountIn: new BN(b.toString()), minimumAmountOut: new BN(0),
    tokenAMint: o.base, tokenBMint: WSOL, tokenAVault: new PublicKey(p.tokenAVault), tokenBVault: new PublicKey(p.tokenBVault),
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  });
  return send("DAMM v2 sell", noCb(tx.instructions), [who], { feePayer: who, cu: 400_000, expectFail: true });
}

/** A DAMM v2 buy for `q` lamports of WSOL by `who` (who holds WSOL). */
export async function dammBuy(o: Opened, who: Keypair, q: bigint): Promise<Landed> {
  const p = (await dammPool(o.dammPool)) as Record<string, string>;
  const tx = await cpAmm.swap({
    payer: who.publicKey, pool: o.dammPool, inputTokenMint: WSOL, outputTokenMint: o.base,
    amountIn: new BN(q.toString()), minimumAmountOut: new BN(0),
    tokenAMint: o.base, tokenBMint: WSOL, tokenAVault: new PublicKey(p.tokenAVault), tokenBVault: new PublicKey(p.tokenBVault),
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
  });
  return send("DAMM v2 buy", noCb(tx.instructions), [who], { feePayer: who, cu: 400_000, expectFail: true });
}

/** SPL Token transfers out of `source` among a transaction's inner instructions (§10 exits). */
export async function transfersOutOf(signature: string, source: PublicKey): Promise<{ destination: string; amount: string }[]> {
  const t = await conn.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const out: { destination: string; amount: string }[] = [];
  for (const g of t?.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const p = (ix as { parsed?: { type: string; info: Record<string, string> }; program?: string }).parsed;
      if (!p || (ix as { program?: string }).program !== "spl-token") continue;
      if ((p.type === "transfer" || p.type === "transferChecked") && p.info.source === source.toBase58()) {
        out.push({ destination: p.info.destination, amount: p.info.amount ?? p.info.tokenAmount ?? "?" });
      }
    }
  }
  return out;
}

export { got };
