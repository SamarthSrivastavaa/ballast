/**
 * The Ballast keeper (§31: cranks only). Liveness, never authority: every instruction it sends is
 * permissionless, and anyone can run it. Per launch, by state:
 *
 *   Registered  curve complete      → settle_graduation
 *   Funded      not yet migrated    → DBC migration_damm_v2 (Meteora's keeper usually gets there first)
 *               migrated            → burn_leftover
 *   Cleaned                         → bin arrays (D-013), then open at F's bin; if a third-party order
 *                                     blocks the move (DLMM 6056), open at the active bin (D-020 cap,
 *                                     D-021 suspension)
 *   Open        bid stale or filled, or capped/suspended → refresh_floor (same fallback)
 *               every `harvestEvery` passes             → harvest, pay_creator
 *               partner_auth below its rent float       → top it up
 *
 * Every crank is logged with its signature and compute units (§25 keeper log).
 */
import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import DLMM, { binIdToBinArrayIndex } from "@meteora-ag/dlmm";
import BN from "bn.js";
import { ata, BallastClient, DAMM_ID, DLMM_EVENT_AUTHORITY, DLMM_ID, floorBin, LAUNCH_STATE, LaunchView, MEMO_ID, WSOL } from "../../sdk/typescript/src/client";
import type { Floor } from "../../sdk/typescript/src/floor";

/** DLMM's error when a third-party order blocks go_to_a_bin (D-020). Errors are matched by the name
 * the failing program logs: Anchor numbers every program's errors from 6000, so a code alone is
 * ambiguous between DLMM and Ballast. */
const BIN_RANGE_NOT_EMPTY = "BinRangeIsNotEmpty";
const BIN_HINT_NOT_AT_FLOOR = "BinHintNotAtFloor";
/** The rate limit of refresh_floor (canon::REFRESH_MIN_SLOTS). */
const REFRESH_MIN_SLOTS = 10;
const PARTNER_AUTH_FLOAT = 50_000_000n;

export interface CrankLog {
  at: string;
  launch: string;
  action: string;
  signature?: string;
  cu?: number | null;
  error?: string;
}

export interface KeeperOptions {
  /** Passes between harvest/pay_creator rounds. */
  harvestEvery?: number;
  log?: (l: CrankLog) => void;
  /** The floor crate (WASM), for F's bin before `open` exists. */
  floor?: Floor;
}

export class Keeper {
  private pass = 0;
  private readonly dbc: DynamicBondingCurveClient;
  constructor(readonly conn: Connection, readonly client: BallastClient, readonly payer: Keypair, readonly opts: KeeperOptions = {}) {
    this.dbc = new DynamicBondingCurveClient(conn, "confirmed");
  }

  private log(l: Omit<CrankLog, "at">) {
    (this.opts.log ?? ((x) => console.log(JSON.stringify(x))))({ at: new Date().toISOString(), ...l });
  }

  private alts = new Map<string, AddressLookupTableAccount>();

  /** One address lookup table per launch with its static accounts: an `open` carries ≈ 28 accounts,
   * past the 1,232-byte transaction limit without one. Created once, then cached. */
  private async alt(v: LaunchView): Promise<AddressLookupTableAccount> {
    const cached = this.alts.get(v.key.toBase58());
    if (cached) return cached;
    const keys = [
      v.key, v.classKey, v.partnerAuth, v.creatorAuth, v.vault, v.stagingBase, v.stagingQuote, v.baseMint, WSOL, v.lbPair,
      v.reserveX, v.reserveY, v.dammPool, v.partnerPosition, v.creatorPosition, v.partnerNft, v.creatorNft, v.tokenAVault, v.tokenBVault,
      this.client.id, DLMM_EVENT_AUTHORITY, DLMM_ID, MEMO_ID, DAMM_ID, TOKEN_PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId,
    ].filter((k): k is PublicKey => k !== null);
    const slot = await this.conn.getSlot("finalized");
    const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: this.payer.publicKey, payer: this.payer.publicKey, recentSlot: slot });
    await this.send(v.key, "create lookup table", [create, AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: this.payer.publicKey, payer: this.payer.publicKey, addresses: keys })], [], 200_000, false);
    const s0 = await this.conn.getSlot("confirmed");
    while ((await this.conn.getSlot("confirmed")) <= s0 + 1) await new Promise((r) => setTimeout(r, 200));
    const table = (await this.conn.getAddressLookupTable(address)).value;
    if (!table) throw new Error("lookup table not found");
    this.alts.set(v.key.toBase58(), table);
    return table;
  }

  /** Send instructions; returns the failing program's error name (else the raw error) or null on
   * success. Never throws on a revert. */
  async send(launch: PublicKey, action: string, ixs: TransactionInstruction[], signers: Keypair[] = [], cu = 600_000, useAlt = true): Promise<string | null> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const v = useAlt ? this.views.get(launch.toBase58()) : undefined;
    const alts = v && v.partnerPosition ? [await this.alt(v)] : [];
    const msg = new TransactionMessage({ payerKey: this.payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs] }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([this.payer, ...signers]);
    try {
      const signature = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      const t = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const err = t?.meta?.err;
      const named = (t?.meta?.logMessages ?? []).map((l) => l.match(/Error Code: (\w+)\./)?.[1]).find(Boolean);
      const code = err ? named ?? JSON.stringify(err) : null;
      this.log({ launch: launch.toBase58(), action, signature, cu: t?.meta?.computeUnitsConsumed ?? null, error: code ?? undefined });
      return code;
    } catch (e) {
      this.log({ launch: launch.toBase58(), action, error: String((e as Error).message ?? e).slice(0, 200) });
      return "send failed";
    }
  }

  /** D-013: create the bin arrays the next placement needs (top-level, permissionless). */
  private async arrays(v: LaunchView, bins: number[]) {
    const pair = await DLMM.create(this.conn, v.lbPair, { cluster: "mainnet-beta" });
    const idx = [...new Set(bins.map((b) => binIdToBinArrayIndex(new BN(b)).toString()))].map((x) => new BN(x));
    const ixs = (await pair.initializeBinArrays(idx, this.payer.publicKey)).filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
    for (const ix of ixs) await this.send(v.key, "initialize_bin_array", [ix], [], 400_000);
  }

  /** F's bin for the floor the next placement will compute. */
  private async targetBin(v: LaunchView): Promise<number> {
    const f = await this.client.readFloor(v, this.payer.publicKey).catch(() => null);
    if (f) return floorBin(f.s, v.binStep);
    // Before `open` the floor() view does not exist yet: compute s from the same live V, S, L that
    // `open` will read, with the floor crate itself (WASM, §4 rule 1).
    if (!this.opts.floor || !v.partnerPosition || !v.creatorPosition) {
      return floorBin(BigInt(v.launch.predictedS.toString()), v.binStep);
    }
    const u128 = (b: Buffer, at: number) => b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n);
    const [pool, pp, cp] = await this.conn.getMultipleAccountsInfo([v.dammPool, v.partnerPosition, v.creatorPosition]);
    if (!pool || !pp || !cp) return floorBin(BigInt(v.launch.predictedS.toString()), v.binStep);
    const vault = BigInt((await this.conn.getTokenAccountBalance(v.vault)).value.amount);
    const staging = BigInt((await this.conn.getTokenAccountBalance(v.stagingBase).catch(() => ({ value: { amount: "0" } }))).value.amount);
    const supply = BigInt((await this.conn.getTokenSupply(v.baseMint)).value.amount);
    const s = this.opts.floor.s({
      v: vault + BigInt(v.launch.bidQuoteCommitted.toString()),
      s: supply - staging,
      l: u128(pp.data, 8 + 176) + u128(cp.data, 8 + 176), // Position.permanent_locked_liquidity
      sMax: u128(pool.data, 8 + 432), // Pool.sqrt_max_price
    });
    return floorBin(s ?? BigInt(v.launch.predictedS.toString()), v.binStep);
  }

  /** `open` / `refresh_floor` at F's bin, else at the active bin when DLMM refuses the move (D-020/D-021). */
  private async place(v: LaunchView, kind: "open" | "refresh"): Promise<void> {
    let hint = await this.targetBin(v);
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.arrays(v, [hint, hint + 1]);
      const order = Keypair.generate();
      const bins = [hint, v.activeBin, Number(v.launch.bidBinId)];
      const ix = kind === "open" ? await this.client.openIx(v, order.publicKey, hint, bins) : await this.client.refreshIx(v, order.publicKey, hint, bins);
      const code = await this.send(v.key, `${kind}_floor(hint ${hint})`, [ix], [order]);
      if (code === null) return;
      if (code === BIN_RANGE_NOT_EMPTY && hint !== v.activeBin) {
        hint = v.activeBin; // capped within 70 bins, else suspended — the program decides (D-021)
        continue;
      }
      if (code === BIN_HINT_NOT_AT_FLOOR) {
        // BinHintNotAtFloor: F moved between the read and the send; recompute and retry.
        hint = await this.targetBin(await this.client.view(v.key));
        continue;
      }
      return;
    }
  }

  private views = new Map<string, LaunchView>();

  /** One pass over one launch. */
  async crank(key: PublicKey): Promise<void> {
    const v = await this.client.view(key);
    this.views.set(key.toBase58(), v);
    const state = v.launch.state as number;
    if (state === LAUNCH_STATE.registered) {
      const pool = await this.dbc.state.getPool(v.dbcPool);
      const cfg = await this.dbc.state.getPoolConfig(v.classConfig);
      if (pool && cfg && new BN(pool.poolState.quoteReserve).gte(new BN(cfg.migrationQuoteThreshold))) {
        await this.send(key, "settle_graduation", [createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, v.stagingBase, v.partnerAuth, v.baseMint), await this.client.settleIx(v)]);
      }
      return;
    }
    if (state === LAUNCH_STATE.funded) {
      const pool = await this.dbc.state.getPool(v.dbcPool);
      if (pool && pool.poolState.migrationProgress < 3) {
        const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await this.dbc.migration.migrateToDammV2({ payer: this.payer.publicKey, pool: v.dbcPool, dammConfig: new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck") });
        await this.send(key, "migration_damm_v2", transaction.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), [firstPositionNftKeypair, secondPositionNftKeypair], 1_000_000);
      } else {
        await this.send(key, "burn_leftover", [createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, v.stagingBase, v.partnerAuth, v.baseMint), await this.client.burnLeftoverIx(v)]);
      }
      return;
    }
    await this.floatPartnerAuth(v);
    if (state === LAUNCH_STATE.cleaned) {
      await this.place(v, "open");
      return;
    }
    if (state !== LAUNCH_STATE.open) return;
    const f = await this.client.readFloor(v, this.payer.publicKey);
    const want = floorBin(f.s, v.binStep);
    const slot = await this.conn.getSlot("confirmed");
    const limited = slot < Number(v.launch.lastRefreshSlot) + REFRESH_MIN_SLOTS;
    const held = f.capped || f.suspended;
    const stale = !held && Number(v.launch.bidBinId) < want && !new PublicKey(v.launch.bidOrder).equals(PublicKey.default);
    const filled = await this.orderFilled(v);
    if ((held || stale || filled) && (!limited || held)) await this.place(v, "refresh");
    this.pass++;
    if (this.pass % (this.opts.harvestEvery ?? 30) === 0) {
      await this.send(key, "harvest", [createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, v.stagingQuote, v.partnerAuth, WSOL), await this.client.harvestIx(v)]);
      await this.send(key, "pay_creator", [createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, ata(WSOL, new PublicKey(v.launch.creatorBeneficiary)), new PublicKey(v.launch.creatorBeneficiary), WSOL), await this.client.payCreatorIx(v)]);
    }
  }

  /** The resting order has bought base that a refresh would settle and burn. */
  private async orderFilled(v: LaunchView): Promise<boolean> {
    const order = new PublicKey(v.launch.bidOrder);
    if (order.equals(PublicKey.default)) return false;
    try {
      const pair = await DLMM.create(this.conn, v.lbPair, { cluster: "mainnet-beta" });
      const lo = await pair.getLimitOrder(order);
      return Number((lo as unknown as { limitOrderData: { totalSwappedAmountX: string } }).limitOrderData.totalSwappedAmountX) > 0;
    } catch {
      return false;
    }
  }

  /** §5: partner_auth pays order rent; keep a float. */
  private async floatPartnerAuth(v: LaunchView) {
    const bal = BigInt(await this.conn.getBalance(v.partnerAuth));
    if (bal < PARTNER_AUTH_FLOAT) {
      await this.send(v.key, "fund partner_auth", [
        SystemProgram.transfer({ fromPubkey: this.payer.publicKey, toPubkey: v.partnerAuth, lamports: Number(PARTNER_AUTH_FLOAT * 2n - bal) }),
        createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, v.stagingQuote, v.partnerAuth, WSOL),
        createAssociatedTokenAccountIdempotentInstruction(this.payer.publicKey, v.stagingBase, v.partnerAuth, v.baseMint),
      ]);
    }
  }

  /** Crank every launch (or `only`) every `intervalMs` until stopped; `once` makes one pass. */
  async run(only: PublicKey[] = [], intervalMs = 10_000, once = false): Promise<void> {
    for (;;) {
      const keys = only.length ? only : await this.client.launches();
      for (const k of keys) {
        await this.crank(k).catch((e) => this.log({ launch: k.toBase58(), action: "crank", error: String((e as Error).message ?? e).slice(0, 300) }));
      }
      if (once) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
