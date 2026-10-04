/**
 * Shared DBC → DAMM v2 flow pieces for the graduation scenarios (Proof and Lite).
 */
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, CpAmmIdl } from "@meteora-ag/cp-amm-sdk";
import { utils as anchorUtils } from "@coral-xyz/anchor";
import { conn, Landed, payer, send, sendSdkTx } from "./env";
import { dbc, dbcClient } from "./dbc";
import { WSOL } from "./config";

export const DAMM_ID = new PublicKey(CpAmmIdl.address);
export const cpAmm = new CpAmm(conn);

/** BN/PublicKey → JSON-safe values. */
export function norm(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "object" && v !== null && "toBase58" in v) return (v as PublicKey).toBase58();
  if (BN.isBN(v)) return (v as BN).toString();
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, norm(x)]));
  return v;
}

export async function rawData(address: PublicKey): Promise<Buffer> {
  const a = await conn.getAccountInfo(address, "confirmed");
  if (!a) throw new Error(`account ${address.toBase58()} not found`);
  return Buffer.from(a.data);
}

export async function virtualPool(pool: PublicKey): Promise<Record<string, unknown>> {
  return norm(dbc.coder.accounts.decode("virtualPool", await rawData(pool))) as Record<string, unknown>;
}

export async function dammPool(pool: PublicKey): Promise<Record<string, unknown>> {
  return norm(await cpAmm.fetchPoolState(pool)) as Record<string, unknown>;
}

export async function dammPosition(position: PublicKey): Promise<Record<string, unknown>> {
  return norm(await cpAmm.fetchPositionState(position)) as Record<string, unknown>;
}

export interface CreatedPool {
  pool: PublicKey;
  baseMint: Keypair;
  landed: Landed;
}

export async function createPool(config: PublicKey, creator: Keypair, label: string): Promise<CreatedPool> {
  const baseMint = Keypair.generate();
  const tx = await dbcClient.creator.createPool({
    name: `Ballast P0 ${label}`,
    symbol: "BP0",
    uri: "https://example.invalid/p0.json",
    payer: payer.publicKey,
    poolCreator: creator.publicKey,
    config,
    baseMint: baseMint.publicKey,
  });
  const landed = await sendSdkTx(`${label}: initialize_virtual_pool_with_spl_token`, tx, [creator, baseMint]);
  const pool = deriveDbcPoolAddress(WSOL, baseMint.publicKey, config);
  return { pool, baseMint, landed };
}

export async function buy(label: string, buyer: Keypair, pool: PublicKey, amountIn: bigint): Promise<Landed> {
  const tx = await dbcClient.pool.swap({
    owner: buyer.publicKey,
    pool,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(0),
    swapBaseForQuote: false,
    referralTokenAccount: null,
    payer: buyer.publicKey,
  });
  return sendSdkTx(label, tx, [buyer], { feePayer: buyer });
}

/** Partial-fill buy (swap2, mode 1): Q15's partial-fill behaviour at the threshold. */
export async function buyPartialFill(label: string, buyer: Keypair, pool: PublicKey, amountIn: bigint): Promise<Landed> {
  const tx = await dbcClient.pool.swap2({
    owner: buyer.publicKey,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    payer: buyer.publicKey,
    swapMode: 1,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(0),
  } as never);
  return sendSdkTx(label, tx, [buyer], { feePayer: buyer });
}

/** DBC → DAMM v2 for a Customizable migration_fee_option (6): the SDK's DAMM v2 config for it. */
export const MIGRATION_DAMM_CONFIG = DAMM_V2_MIGRATION_FEE_ADDRESS[6];

export async function migrate(label: string, pool: PublicKey, opts: { expectFail?: boolean } = {}) {
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await dbcClient.migration.migrateToDammV2({
    payer: payer.publicKey,
    pool,
    dammConfig: MIGRATION_DAMM_CONFIG,
  });
  const landed = await sendSdkTx(label, transaction, [firstPositionNftKeypair, secondPositionNftKeypair], {
    expectFail: opts.expectFail,
  });
  return { landed, firstNft: firstPositionNftKeypair.publicKey, secondNft: secondPositionNftKeypair.publicKey };
}

/** Program-level view of a transaction's inner instructions, with DAMM v2 / DBC names decoded. */
export async function innerInstructions(signature: string) {
  const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t?.meta) throw new Error(`${signature} not found`);
  const keys = [
    ...t.transaction.message.staticAccountKeys.map((k) => k.toBase58()),
    ...(t.meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
    ...(t.meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
  ];
  const discs = new Map<string, string>();
  for (const [prog, idl] of [
    [DAMM_ID.toBase58(), CpAmmIdl],
    [dbc.programId.toBase58(), dbc.idl],
  ] as const) {
    for (const ix of (idl as { instructions: { name: string; discriminator: number[] }[] }).instructions) {
      discs.set(prog + ":" + Buffer.from(ix.discriminator).toString("hex"), ix.name);
    }
  }
  const bs58 = anchorUtils.bytes.bs58;
  return (t.meta.innerInstructions ?? []).flatMap((group) =>
    group.instructions.map((ix) => {
      const program = keys[ix.programIdIndex];
      const data = Buffer.from(bs58.decode(ix.data));
      const name = discs.get(program + ":" + data.subarray(0, 8).toString("hex"));
      return { outer: group.index, depth: (ix as { stackHeight?: number }).stackHeight ?? null, program, name: name ?? null };
    }),
  );
}

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
