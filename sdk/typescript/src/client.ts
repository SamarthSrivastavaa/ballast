/**
 * Ballast client: every account of a launch derived from chain state, and the instruction builders
 * for the permissionless instructions (§6). Used by the keeper, the proof scripts and the app.
 *
 * Nothing here decides a number: F comes from the program's `floor()` view or from the floor crate
 * (WASM, `./floor`); bin choices use DLMM's own price function through the DLMM SDK.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import DLMM, { binIdToBinArrayIndex, deriveBinArray, getQPriceFromId } from "@meteora-ag/dlmm";

export const DBC_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DLMM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DAMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DAMM_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
/** The DAMM v2 config DBC migrates Customizable-option pools into (`DAMM_V2_MIGRATION_FEE_ADDRESS[6]`). */
export const DAMM_MIGRATION_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
const eventAuthority = (program: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], program)[0];
export const DBC_EVENT_AUTHORITY = eventAuthority(DBC_ID);
export const DAMM_EVENT_AUTHORITY = eventAuthority(DAMM_ID);
const DLMM_OPT = { cluster: "mainnet-beta" as const }; // the SDK's localhost id is not mainnet DLMM

export const LAUNCH_STATE = { registered: 1, funded: 2, migrated: 3, cleaned: 4, open: 5 } as const;

export const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

export interface LaunchView {
  key: PublicKey;
  /** The decoded `Launch` account (Anchor, camelCase). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  launch: any;
  classKey: PublicKey;
  classConfig: PublicKey;
  partnerAuth: PublicKey;
  creatorAuth: PublicKey;
  vault: PublicKey;
  stagingBase: PublicKey;
  stagingQuote: PublicKey;
  baseMint: PublicKey;
  dbcPool: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  lbPair: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  activeBin: number;
  binStep: number;
  dammPool: PublicKey;
  /** Recorded at `open`; discovered from the pool before it. */
  partnerPosition: PublicKey | null;
  creatorPosition: PublicKey | null;
  partnerNft: PublicKey | null;
  creatorNft: PublicKey | null;
  tokenAVault: PublicKey | null;
  tokenBVault: PublicKey | null;
}

const find = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export class BallastClient {
  readonly program: Program;
  constructor(readonly conn: Connection, idl: { address: string }, payer: PublicKey = PublicKey.default) {
    const wallet = { publicKey: payer, signTransaction: async <T>(t: T) => t, signAllTransactions: async <T>(t: T[]) => t } as unknown as Wallet;
    this.program = new Program(idl as never, new AnchorProvider(conn, wallet, { commitment: "confirmed" }));
  }
  get id(): PublicKey {
    return this.program.programId;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get accounts(): Record<string, { fetch(k: PublicKey): Promise<any>; all(f?: unknown[]): Promise<any[]> }> {
    return this.program.account as never;
  }

  pdas = {
    global: () => find([Buffer.from("global")], this.id),
    class: (config: PublicKey) => find([Buffer.from("class"), config.toBuffer()], this.id),
    partner: (config: PublicKey) => find([Buffer.from("partner"), config.toBuffer()], this.id),
    launch: (mint: PublicKey) => find([Buffer.from("launch"), mint.toBuffer()], this.id),
    creator: (launch: PublicKey) => find([Buffer.from("creator"), launch.toBuffer()], this.id),
    vault: (launch: PublicKey) => find([Buffer.from("vault"), launch.toBuffer()], this.id),
  };

  /** Every launch of the program (for the keeper and the app's index). */
  async launches(): Promise<PublicKey[]> {
    return (await this.accounts.launch.all()).map((a: { publicKey: PublicKey }) => a.publicKey);
  }

  /** All accounts of one launch, from chain state. */
  async view(key: PublicKey): Promise<LaunchView> {
    const launch = await this.accounts.launch.fetch(key);
    const cls = await this.accounts.class.fetch(launch.class);
    const classConfig = new PublicKey(cls.dbcConfig);
    const baseMint = new PublicKey(launch.baseMint);
    const dbcPool = new PublicKey(launch.dbcPool);
    const partnerAuth = this.pdas.partner(classConfig);
    const creatorAuth = this.pdas.creator(key);
    const pair = await DLMM.create(this.conn, new PublicKey(launch.dlmmPair), DLMM_OPT);
    const [hi, lo] = baseMint.toBuffer().compare(WSOL.toBuffer()) > 0 ? [baseMint, WSOL] : [WSOL, baseMint];
    const dammPool = find([Buffer.from("pool"), DAMM_MIGRATION_CONFIG.toBuffer(), hi.toBuffer(), lo.toBuffer()], DAMM_ID);
    const v: LaunchView = {
      key, launch, classKey: new PublicKey(launch.class), classConfig, partnerAuth, creatorAuth,
      vault: this.pdas.vault(key), stagingBase: ata(baseMint, partnerAuth), stagingQuote: ata(WSOL, partnerAuth),
      baseMint, dbcPool, baseVault: find([Buffer.from("token_vault"), baseMint.toBuffer(), dbcPool.toBuffer()], DBC_ID),
      quoteVault: find([Buffer.from("token_vault"), WSOL.toBuffer(), dbcPool.toBuffer()], DBC_ID),
      lbPair: new PublicKey(launch.dlmmPair), reserveX: pair.lbPair.reserveX, reserveY: pair.lbPair.reserveY,
      activeBin: pair.lbPair.activeId, binStep: pair.lbPair.binStep, dammPool,
      partnerPosition: null, creatorPosition: null, partnerNft: null, creatorNft: null, tokenAVault: null, tokenBVault: null,
    };
    const poolAcc = await this.conn.getAccountInfo(dammPool);
    if (poolAcc) {
      // DAMM v2 Pool: token_a_vault at 224, token_b_vault at 256 (meteora-types OFFSETS), after the discriminator.
      v.tokenAVault = new PublicKey(poolAcc.data.subarray(8 + 224, 8 + 256));
      v.tokenBVault = new PublicKey(poolAcc.data.subarray(8 + 256, 8 + 288));
    }
    if (launch.state === LAUNCH_STATE.open) {
      v.partnerPosition = new PublicKey(launch.partnerPosition);
      v.creatorPosition = new PublicKey(launch.creatorPosition);
      v.partnerNft = new PublicKey(launch.partnerNftAccount);
      v.creatorNft = new PublicKey(launch.creatorNftAccount);
    } else if (poolAcc) {
      // Before `open`: the pool's positions whose NFT accounts partner_auth / creator_auth hold.
      const positions = await this.conn.getProgramAccounts(DAMM_ID, { filters: [{ memcmp: { offset: 8, bytes: dammPool.toBase58() } }] });
      for (const p of positions) {
        const nftMint = new PublicKey(p.account.data.subarray(40, 72));
        const nftAcc = find([Buffer.from("position_nft_account"), nftMint.toBuffer()], DAMM_ID);
        const info = await this.conn.getAccountInfo(nftAcc);
        if (!info) continue;
        const holder = new PublicKey(info.data.subarray(32, 64));
        if (holder.equals(partnerAuth)) [v.partnerPosition, v.partnerNft] = [p.pubkey, nftAcc];
        if (holder.equals(creatorAuth)) [v.creatorPosition, v.creatorNft] = [p.pubkey, nftAcc];
      }
    }
    return v;
  }

  // ---- §6 builders ----------------------------------------------------------------------------

  private bid(v: LaunchView, newOrder: PublicKey) {
    const resting = new PublicKey(v.launch.bidOrder);
    return {
      launch: v.key, class: v.classKey, partnerAuth: v.partnerAuth, vault: v.vault, stagingBase: v.stagingBase,
      baseMint: v.baseMint, quoteMint: WSOL, dlmmPair: v.lbPair, reserveX: v.reserveX, reserveY: v.reserveY,
      bidOrder: resting.equals(PublicKey.default) ? newOrder : resting, newOrder,
      dlmmEventAuthority: DLMM_EVENT_AUTHORITY, dlmmProgram: DLMM_ID, memoProgram: MEMO_ID,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    };
  }

  private dbc(v: LaunchView) {
    return {
      launch: v.key, class: v.classKey, dbcConfig: v.classConfig, virtualPool: v.dbcPool, baseVault: v.baseVault,
      quoteVault: v.quoteVault, baseMint: v.baseMint, quoteMint: WSOL, partnerAuth: v.partnerAuth, vault: v.vault,
      stagingBase: v.stagingBase, dbcPoolAuthority: DBC_POOL_AUTHORITY, dbcEventAuthority: DBC_EVENT_AUTHORITY,
      dbcProgram: DBC_ID, tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  /** Bin-array keys for `bins`, deduplicated (passed as writable remaining accounts). */
  binArrays(v: LaunchView, bins: number[]): PublicKey[] {
    return [...new Map(bins.map((b) => deriveBinArray(v.lbPair, binIdToBinArrayIndex(new BN(b)), DLMM_ID)[0]).map((k) => [k.toBase58(), k])).values()];
  }

  settleIx(v: LaunchView) {
    return this.program.methods.settleGraduation().accountsPartial(this.dbc(v) as never).instruction();
  }
  burnLeftoverIx(v: LaunchView) {
    return this.program.methods.burnLeftover().accountsPartial(this.dbc(v) as never).instruction();
  }
  openIx(v: LaunchView, order: PublicKey, hint: number, bins: number[]) {
    return this.program.methods.open(hint).accountsPartial({
      bid: this.bid(v, order), creatorAuth: v.creatorAuth, dammPool: v.dammPool, partnerPosition: v.partnerPosition,
      creatorPosition: v.creatorPosition, partnerNftAccount: v.partnerNft, creatorNftAccount: v.creatorNft,
    } as never).remainingAccounts(this.binArrays(v, bins).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).instruction();
  }
  refreshIx(v: LaunchView, order: PublicKey, hint: number, bins: number[]) {
    return this.program.methods.refreshFloor(hint).accountsPartial({
      bid: this.bid(v, order), dammPool: v.dammPool, partnerPosition: v.partnerPosition, creatorPosition: v.creatorPosition,
    } as never).remainingAccounts(this.binArrays(v, bins).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).instruction();
  }
  redeemIx(v: LaunchView, order: PublicKey, holder: PublicKey, amount: bigint, minOut: bigint, bins: number[]) {
    return this.program.methods.redeem(new BN(amount.toString()), new BN(minOut.toString())).accountsPartial({
      bid: this.bid(v, order), dammPool: v.dammPool, partnerPosition: v.partnerPosition, creatorPosition: v.creatorPosition,
      holder, holderBase: ata(v.baseMint, holder), holderQuote: ata(WSOL, holder),
    } as never).remainingAccounts(this.binArrays(v, bins).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).instruction();
  }
  async harvestIx(v: LaunchView) {
    const g = await this.accounts.global.fetch(this.pdas.global());
    return this.program.methods.harvest().accountsPartial({
      launch: v.key, class: v.classKey, global: this.pdas.global(), partnerAuth: v.partnerAuth, vault: v.vault,
      stagingBase: v.stagingBase, stagingQuote: v.stagingQuote, baseMint: v.baseMint, quoteMint: WSOL, dammPool: v.dammPool,
      partnerPosition: v.partnerPosition, creatorPosition: v.creatorPosition, partnerNftAccount: v.partnerNft,
      tokenAVault: v.tokenAVault, tokenBVault: v.tokenBVault, treasury: new PublicKey(g.treasury),
      dammPoolAuthority: DAMM_POOL_AUTHORITY, dammEventAuthority: DAMM_EVENT_AUTHORITY, dammProgram: DAMM_ID, tokenProgram: TOKEN_PROGRAM_ID,
    } as never).instruction();
  }
  depositIx(v: LaunchView, depositor: PublicKey, amount: bigint) {
    return this.program.methods.deposit(new BN(amount.toString())).accountsPartial({
      launch: v.key, class: v.classKey, partnerAuth: v.partnerAuth, vault: v.vault, stagingBase: v.stagingBase,
      baseMint: v.baseMint, dammPool: v.dammPool, partnerPosition: v.partnerPosition, creatorPosition: v.creatorPosition,
      depositor, depositorQuote: ata(WSOL, depositor), tokenProgram: TOKEN_PROGRAM_ID,
    } as never).instruction();
  }
  payCreatorIx(v: LaunchView) {
    const open = v.launch.state === LAUNCH_STATE.open;
    return this.program.methods.payCreator().accountsPartial({
      launch: v.key, class: v.classKey, creatorAuth: v.creatorAuth, partnerAuth: v.partnerAuth, stagingBase: v.stagingBase,
      beneficiaryQuote: ata(WSOL, new PublicKey(v.launch.creatorBeneficiary)), vault: v.vault, baseMint: v.baseMint, quoteMint: WSOL,
      virtualPool: v.dbcPool, baseVault: v.baseVault, quoteVault: v.quoteVault, dbcPoolAuthority: DBC_POOL_AUTHORITY,
      dbcEventAuthority: DBC_EVENT_AUTHORITY, dbcProgram: DBC_ID, tokenProgram: TOKEN_PROGRAM_ID,
      dammPool: open ? v.dammPool : null, partnerPosition: open ? v.partnerPosition : null, creatorPosition: open ? v.creatorPosition : null,
      creatorNftAccount: open ? v.creatorNft : null, tokenAVault: open ? v.tokenAVault : null, tokenBVault: open ? v.tokenBVault : null,
      dammPoolAuthority: open ? DAMM_POOL_AUTHORITY : null, dammEventAuthority: open ? DAMM_EVENT_AUTHORITY : null, dammProgram: open ? DAMM_ID : null,
    } as never).instruction();
  }
  floorIx(v: LaunchView) {
    return this.program.methods.floor().accountsPartial({
      launch: v.key, class: v.classKey, partnerAuth: v.partnerAuth, vault: v.vault, stagingBase: v.stagingBase,
      baseMint: v.baseMint, dammPool: v.dammPool, partnerPosition: v.partnerPosition, creatorPosition: v.creatorPosition,
    } as never).instruction();
  }

  /** The program's `floor()` view, by simulation (§6). */
  async readFloor(v: LaunchView, payer: PublicKey): Promise<FloorReport> {
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [await this.floorIx(v)] }).compileToV0Message();
    const r = await this.conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    if (r.value.err || !r.value.returnData) throw new Error(`floor(): ${JSON.stringify(r.value.err)}`);
    const b = Buffer.from(r.value.returnData.data[0], "base64");
    const u128 = (o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
    return {
      s: u128(0), fQ64: u128(16), v: b.readBigUInt64LE(32), sSupply: b.readBigUInt64LE(40), l: u128(48), sLast: u128(64),
      binId: b.readInt32LE(80), binPrice: u128(84), capped: b[100] === 1, suspended: b[101] === 1,
    };
  }
}

export interface FloorReport {
  s: bigint;
  fQ64: bigint;
  v: bigint;
  sSupply: bigint;
  l: bigint;
  sLast: bigint;
  binId: number;
  binPrice: bigint;
  capped: boolean;
  suspended: boolean;
}

/** DLMM's own Q64 price of a bin (the SDK's exact BN arithmetic). */
export function binPriceQ64(id: number, binStep: number): bigint {
  return BigInt(getQPriceFromId(new BN(id), new BN(binStep)).toString());
}

/** F's bin: the highest bin whose DLMM price is ≤ F = s²/2^128 (§9), exact in bigint. */
export function floorBin(s: bigint, binStep: number): number {
  const f = Number(s) ** 2 / 2 ** 128;
  let id = Math.floor(Math.log(f) / Math.log(1 + binStep / 1e4));
  const s2 = s * s;
  while (binPriceQ64(id, binStep) << 64n > s2) id--;
  while (binPriceQ64(id + 1, binStep) << 64n <= s2) id++;
  return id;
}

/** Keys a transaction's instructions with a compute limit, for callers that build their own tx. */
export function withCu(ixs: TransactionInstruction[], units: number): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs];
}

export { Keypair };
