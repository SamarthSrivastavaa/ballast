/**
 * Throwaway local wallets and token plumbing for the P0 harness.
 *
 * Keys live in tests/integration/p0/.state/keys.json (gitignored) so a scenario can be resumed
 * step by step on the same validator run; they are local-validator keys only and are never written
 * to evidence/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { airdrop, conn, payer, REPO } from "./env";
import { WSOL } from "./config";

const KEYS = resolve(REPO, "tests/integration/p0/.state/keys.json");

function loadKeys(): Record<string, number[]> {
  return existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, "utf8")) : {};
}

export function wallet(name: string): Keypair {
  const keys = loadKeys();
  if (!keys[name]) {
    keys[name] = Array.from(Keypair.generate().secretKey);
    mkdirSync(resolve(KEYS, ".."), { recursive: true });
    writeFileSync(KEYS, JSON.stringify(keys));
  }
  return Keypair.fromSecretKey(Uint8Array.from(keys[name]));
}

export function resetKeys(prefix: string): void {
  const keys = loadKeys();
  for (const k of Object.keys(keys)) if (k.startsWith(prefix)) delete keys[k];
  mkdirSync(resolve(KEYS, ".."), { recursive: true });
  writeFileSync(KEYS, JSON.stringify(keys));
}

/** A named wallet holding at least `sol` SOL: tops up only the shortfall, so reruns on a ledger whose
 * wallets were partly spent still start funded (devnet transfers only what is missing). */
export async function funded(name: string, sol: number): Promise<Keypair> {
  const w = wallet(name);
  const shortfall = Math.round(sol * 1e9) - (await conn.getBalance(w.publicKey));
  if (shortfall > 0) await airdrop(w.publicKey, shortfall / 1e9);
  return w;
}

export function ata(mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, program);
}

export function ensureAtaIx(mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, owner, program), owner, mint, program);
}

/** Wrap `lamports` into owner's WSOL ATA (payer funds the ATA rent; owner funds the lamports). */
export function wrapIxs(owner: Keypair, lamports: bigint): TransactionInstruction[] {
  const a = ata(WSOL, owner.publicKey);
  return [
    ensureAtaIx(WSOL, owner.publicKey),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: a, lamports }),
    createSyncNativeInstruction(a),
  ];
}

/**
 * Balance of a token account that MUST exist (D-012).
 *
 * Throws if the account is missing. Use this wherever the number decides something — funding, bid
 * sizing, payouts, reconciliation. Q5 placed a bid against a non-existent account because the
 * returns-zero form made "missing" indistinguishable from "empty".
 */
export async function tokenBalanceStrict(account: PublicKey): Promise<bigint> {
  const r = await conn.getTokenAccountBalance(account).catch((e: unknown) => {
    throw new Error(
      `token account ${account.toBase58()} does not exist or is unreadable (D-012: a missing ` +
        `token account is an error, never 0): ${e instanceof Error ? e.message : String(e)}`,
    );
  });
  if (!r?.value) throw new Error(`token account ${account.toBase58()} returned no balance (D-012)`);
  return BigInt(r.value.amount);
}

/**
 * Balance, or 0 when the account does not exist.
 *
 * Only for cases where "absent" and "empty" are genuinely equivalent — e.g. probing whether a
 * wallet has ever held a mint. Never for funding or payout decisions: see `tokenBalanceStrict`.
 */
export async function tokenBalanceOrZero(account: PublicKey): Promise<bigint> {
  const r = await conn.getTokenAccountBalance(account).catch(() => null);
  return r ? BigInt(r.value.amount) : 0n;
}

/** @deprecated D-012: ambiguous. Use `tokenBalanceStrict` or, deliberately, `tokenBalanceOrZero`. */
export async function tokenBalance(account: PublicKey): Promise<bigint> {
  return tokenBalanceOrZero(account);
}
