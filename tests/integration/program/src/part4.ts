/**
 * Program Part 2 — `open`, `refresh_floor`, `redeem`, `floor`, `harvest`, `deposit` (§6, §8, §9, §10)
 * on the mainnet-binary local validator (D-001).
 *
 *   Launch D is graduated, cleaned, then opened; launch E (same class) supplies foreign-but-real
 *   Meteora accounts for the substitution tests. Expected values come from independent sources:
 *   F from the Python reference (tests/reference/floor.py), bin prices from the DLMM SDK's exact
 *   `getQPriceFromId` and from the `price` DLMM itself stores in the bin, balances read back.
 *
 * Every negative case changes exactly one account or argument and must fail with the error the
 * check that owns it reports.
 */
import { execFileSync } from "node:child_process";
import BN from "bn.js";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import DLMM, { binIdToBinArrayIndex, deriveBinArray, getQPriceFromId } from "@meteora-ag/dlmm";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, createAlt, Landed, payer, REPO, send, simulate } from "../../p0/src/env";
import { PROOF, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { buyPartialFill, cpAmm, dammPool, dammPosition, MIGRATION_DAMM_CONFIG, migrate, rawData } from "../../p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceStrict, wallet, wrapIxs } from "../../p0/src/wallets";
import { accounts, ballast, errorName, pdas } from "./client";
import { DLMM_ID, launch, Launch } from "./launch";
import { ballastCu, burn, dbcConfig, got, graduationAccounts, settle } from "./part3";
import { Suite } from "./runner";

const OPT = { cluster: "mainnet-beta" as const }; // T7: the SDK's localhost id is not mainnet DLMM
const BIN_STEP = 10;
const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const DAMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const REDEEM_FEE_BPS = 50n;
const Q128 = 1n << 128n;

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
  dammPool: PublicKey;
  partnerPosition: PublicKey;
  creatorPosition: PublicKey;
  partnerNft: PublicKey;
  creatorNft: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  creator: Keypair;
}

const nftAccountOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), mint.toBuffer()], DAMM_ID)[0];
const positionOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), mint.toBuffer()], DAMM_ID)[0];
const binArrayOf = (pair: PublicKey, id: number) => deriveBinArray(pair, binIdToBinArrayIndex(new BN(id)), DLMM_ID)[0];

/** Owner field of a Token-2022 account (offset 32). */
async function tokenOwner(account: PublicKey): Promise<PublicKey> {
  return new PublicKey((await rawData(account)).subarray(32, 64));
}

/** Register → buy to the threshold → settle → migrate → burn_leftover: a launch in `Cleaned`. */
export async function cleanedLaunch(label: string, classConfig: PublicKey, creator: Keypair, buyer: Keypair): Promise<Opened> {
  const l = await launch(label, classConfig, creator, sqrtPriceQ64(PROOF.p0));
  if (l.landed.err) throw new Error(`${label}: launch failed ${errorName(l.landed.logs)}`);
  const acc = graduationAccounts(classConfig, l, creator.publicKey);
  await buyPartialFill(`${label}: buy to the threshold`, buyer, l.pool, 12_000_000_000n);
  const st = await settle(`${label}: settle`, acc, creator.publicKey);
  if (st.err) throw new Error(`${label}: settle ${got(st)}`);
  const mig = await migrate(`${label}: migrate`, l.pool);
  const bu = await burn(`${label}: burn_leftover`, acc);
  if (bu.err) throw new Error(`${label}: burn ${got(bu)}`);
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
    classConfig, l, base, partnerAuth, staging: ata(base, partnerAuth), creator,
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

/** The composite `bid` accounts (floor_ix::BidAccounts). */
export function bidAccounts(o: Opened, newOrder: PublicKey, bidOrder: PublicKey) {
  return {
    launch: o.l.launch, class: pdas.class(o.classConfig), partnerAuth: o.partnerAuth, vault: o.l.vault,
    stagingBase: o.staging, baseMint: o.base, quoteMint: WSOL, dlmmPair: o.l.lbPair,
    reserveX: o.reserveX, reserveY: o.reserveY, bidOrder, newOrder,
    dlmmEventAuthority: DLMM_EVENT_AUTHORITY, dlmmProgram: DLMM_ID, memoProgram: MEMO,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}

const writable = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

/** Error name or "succeeded", from either Anchor's log line or a plain program error. */
const outcome = (t: Landed) => got(t);

// ---------------------------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------------------------

export async function part4(): Promise<number> {
  const suite = new Suite("Program Part 2 — open, refresh_floor, redeem, floor, harvest, deposit (§6, §8, §9, §10)");
  const admin = wallet("program.admin");
  const creator = await funded("program.p2.creator", 10);
  const buyerD = await funded("program.p2.buyerD", 30);
  const buyerE = await funded("program.p2.buyerE", 30);

  // The payer funds each launch's dust buy from WSOL wrapped in advance (D-011), as part2.ts does.
  await send("part2: payer WSOL for dust buys", wrapIxs(payer, 20_000_000n), []);
  const classConfig = await dbcConfig("part2 class");
  await send("part2: create_class", [
    await ballast.methods.createClass(0)
      .accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig })
      .instruction(),
  ], [admin]);
  const D = await cleanedLaunch("part2 launch D", classConfig, creator, buyerD);
  const E = await cleanedLaunch("part2 launch E", classConfig, creator, buyerE);
  const pair = await DLMM.create(conn, D.l.lbPair, OPT);

  // §5: partner_auth holds lamports for order rent; the keeper funds it.
  await send("keeper: fund partner_auth for order rent", [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: D.partnerAuth, lamports: 100_000_000 }),
  ]);

  // The expected floor at open, from the reference.
  const in0 = await liveInputs(D);
  const s0 = pyFloor(in0.v, in0.s, in0.l, in0.sMax);
  const hint = binAtOrBelow(s0);
  const rec0 = await accounts.launch.fetch(D.l.launch);
  const predicted = BigInt(rec0.predictedS.toString());

  // D-013: the keeper creates the bid bin's array and the next one up, top-level, before `open`.
  const idx = binIdToBinArrayIndex(new BN(hint));
  // The SDK adds its own compute-budget instruction; `send` sets the limit (two = DuplicateInstruction).
  const initArrays = (await pair.initializeBinArrays([idx, idx.add(new BN(1))], payer.publicKey))
    .filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  if (initArrays.length) await send("keeper: initialize_bin_array (bid bin + next up)", initArrays, [], { cu: 600_000 });
  const arr = binArrayOf(D.l.lbPair, hint);

  // One lookup table for every static account the bid instructions touch.
  const alt: AddressLookupTableAccount = await createAlt("part2 bid accounts", [
    ...Object.values(bidAccounts(D, payer.publicKey, payer.publicKey)).filter((k) => !k.equals(payer.publicKey)),
    D.dammPool, D.partnerPosition, D.creatorPosition, D.partnerNft, D.creatorNft, D.l.creatorAuth, arr,
    binArrayOf(D.l.lbPair, hint + 70), ballast.programId, ComputeBudgetProgram.programId,
    E.l.lbPair, E.l.vault, E.dammPool, E.partnerPosition, E.creatorPosition, E.partnerNft, E.creatorNft,
  ]);

  type OpenOver = Partial<{
    bid: Partial<ReturnType<typeof bidAccounts>>; creatorAuth: PublicKey; dammPool: PublicKey; partnerPosition: PublicKey;
    creatorPosition: PublicKey; partnerNftAccount: PublicKey; creatorNftAccount: PublicKey; hint: number; remaining: PublicKey[];
  }>;
  const openIx = async (order: Keypair, o: OpenOver = {}): Promise<TransactionInstruction> =>
    ballast.methods.open(o.hint ?? hint)
      .accountsPartial({
        bid: { ...bidAccounts(D, order.publicKey, order.publicKey), ...(o.bid ?? {}) },
        creatorAuth: o.creatorAuth ?? D.l.creatorAuth,
        dammPool: o.dammPool ?? D.dammPool,
        partnerPosition: o.partnerPosition ?? D.partnerPosition,
        creatorPosition: o.creatorPosition ?? D.creatorPosition,
        partnerNftAccount: o.partnerNftAccount ?? D.partnerNft,
        creatorNftAccount: o.creatorNftAccount ?? D.creatorNft,
      } as never)
      .remainingAccounts((o.remaining ?? [arr]).map(writable))
      .instruction();
  const tryOpen = async (label: string, o: OpenOver = {}) => {
    const order = Keypair.generate();
    return send(`open: ${label}`, [await openIx(order, o)], [order], { cu: 600_000, alts: [alt], expectFail: true });
  };

  // ---- open: one defect each ----------------------------------------------------------------
  const openNegatives: [string, string, OpenOver][] = [
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
    ["bin hint one above the floor bin", "BinHintNotAtFloor", { hint: hint + 1 }],
    ["bin hint one below the floor bin", "BinHintNotAtFloor", { hint: hint - 1 }],
    ["bin array not passed (D-013)", "BinArrayMissing", { remaining: [] }],
    ["staging is not partner_auth's base ATA (D-012)", "StagingNotPartnerAta", { bid: { stagingBase: ata(D.base, payer.publicKey) } }],
  ];
  for (const [name, expected, o] of openNegatives) {
    await suite.case(`open: ${name}`, async () => {
      const t = await tryOpen(name, o);
      return { status: outcome(t) === expected ? "pass" : "fail", expected, got: outcome(t), detail: { signature: t.signature } };
    });
  }
  await suite.case("refresh_floor before open (state Cleaned)", async () => {
    const order = Keypair.generate();
    const ix = await ballast.methods.refreshFloor(hint)
      .accountsPartial({ bid: bidAccounts(D, order.publicKey, order.publicKey), dammPool: D.dammPool, partnerPosition: D.partnerPosition, creatorPosition: D.creatorPosition } as never)
      .remainingAccounts([writable(arr)]).instruction();
    const t = await send("refresh before open", [ix], [order], { cu: 600_000, alts: [alt], expectFail: true });
    return { status: outcome(t) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: outcome(t) };
  });

  // ---- CHARACTERIZATION, pending an owner decision (DECISIONS § OPEN DECISION active bin) --------
  // DLMM refuses a bid above the pair's active bin (6105), and the D-011 launch transaction creates
  // the pair with active_id at p0, below F. Here a top-level, permissionless `go_to_a_bin(hint)`
  // moves the active bin up to F's bin first, so the rest of `open` can be validated on the binary.
  await suite.case("characterization: go_to_a_bin(F's bin) top-level, no signer, empty range", async () => {
    await pair.refetchStates();
    const from = pair.lbPair.activeId;
    const ix = await pair.program.methods.goToABin(hint).accountsPartial({
      lbPair: D.l.lbPair, binArrayBitmapExtension: null,
      fromBinArray: binArrayOf(D.l.lbPair, from), toBinArray: binArrayOf(D.l.lbPair, hint),
    } as never).instruction();
    const fromIdx = binIdToBinArrayIndex(new BN(from));
    const pre = (await pair.initializeBinArrays([fromIdx], payer.publicKey)).filter((x) => !x.programId.equals(ComputeBudgetProgram.programId));
    if (pre.length) await send("keeper: init the active bin's array", pre, [], { cu: 600_000 });
    const t = await send("keeper: go_to_a_bin(F's bin)", [ix], [], { cu: 200_000, expectFail: true });
    await pair.refetchStates();
    const ok = !t.err && pair.lbPair.activeId === hint;
    return { status: ok ? "pass" : "fail", expected: `active ${hint}`, got: `${outcome(t)} active ${pair.lbPair.activeId}`, detail: { from, to: hint, signature: t.signature, cu: t.cu } };
  });

  // ---- open: positive ------------------------------------------------------------------------
  const order0 = Keypair.generate();
  let opened: Landed | null = null;
  await suite.case("open: launch D → Open; whole vault rests as one bid at the highest bin ≤ F", async () => {
    const t = await send("open D", [await openIx(order0)], [order0], { cu: 600_000, alts: [alt], expectFail: true });
    opened = t;
    if (t.err) return { status: "fail", expected: "ok", got: outcome(t), detail: { signature: t.signature, logs: t.logs.slice(-25) } };
    const rec = await accounts.launch.fetch(D.l.launch);
    const vaultAfter = await tokenBalanceStrict(D.l.vault);
    const orderData = await rawData(order0.publicKey);
    const orderOwner = new PublicKey(orderData.subarray(40, 72));
    await pair.refetchStates();
    const binArr = await pair.program.account.binArray.fetch(arr);
    const lower = Number(binIdToBinArrayIndex(new BN(hint)).toString()) * 70;
    const storedPrice = BigInt((binArr as { bins: { price: BN }[] }).bins[hint - lower].price.toString());
    const sOpen = BigInt(rec.sOpen.toString());
    const checks = {
      state: rec.state === 5,
      sOpenEqualsReference: sOpen === s0,
      sOpenAtLeastPredicted: sOpen >= predicted,
      sLast: BigInt(rec.sLast.toString()) === sOpen,
      vaultEmptied: vaultAfter === 0n,
      committedIsWholeVault: BigInt(rec.bidQuoteCommitted.toString()) === in0.vault,
      binRecorded: rec.bidBinId === hint,
      orderRecorded: new PublicKey(rec.bidOrder).equals(order0.publicKey),
      orderOwnerIsPartnerAuth: orderOwner.equals(D.partnerAuth),
      vendoredPriceEqualsStoredBinPrice: storedPrice === qPrice(hint),
      positionsRecorded: new PublicKey(rec.partnerPosition).equals(D.partnerPosition) && new PublicKey(rec.creatorPosition).equals(D.creatorPosition),
      lOpen: BigInt(rec.lOpen.toString()) === in0.l,
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks),
      detail: {
        signature: t.signature, txCu: t.cu, openCu: ballastCu(t), sOpen: sOpen.toString(), predicted: predicted.toString(),
        realisedOverPredicted: Number(sOpen) / Number(predicted), bin: hint, binPrice: storedPrice.toString(),
        vault: in0.vault.toString(), v: in0.v.toString(), s: in0.s.toString(), l: in0.l.toString(), checks,
      },
    };
  });
  await suite.case("open: second call refused (state Open)", async () => {
    const t = await tryOpen("open D again");
    return { status: outcome(t) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: outcome(t) };
  });

  void opened; void simulate; void buyerE; void cpAmm; void ensureAtaIx; void TOKEN_2022;
  return suite.finish("part2/results.json");
}
