/**
 * Send an SDK-built transaction where some instructions need a harness PDA's signature: exactly
 * those instructions are re-issued through the p0_harness proxy (CPI + invoke_signed); the rest go
 * top-level unchanged. Keypair signers (e.g. a fresh limit-order account) sign the outer tx and
 * their signer privilege flows into the CPI.
 */
import { ComputeBudgetProgram, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAlt, Landed, send, SendOpts, simulate } from "./env";
import { Pda, proxyIx } from "./proxy";

export function wrapForPdas(ixs: TransactionInstruction[], pdas: Pda[]): TransactionInstruction[] {
  return ixs
    .filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))
    .map((ix) => {
      const signing = pdas.filter((p) => ix.keys.some((k) => k.isSigner && k.pubkey.equals(p.address)));
      return signing.length ? proxyIx([{ ix, signers: signing }]) : ix;
    });
}

export function sendWithPdas(
  label: string,
  tx: Transaction | TransactionInstruction[],
  pdas: Pda[],
  signers: Keypair[] = [],
  opts: SendOpts = {},
): Promise<Landed> {
  const ixs = Array.isArray(tx) ? tx : tx.instructions;
  return send(label, wrapForPdas(ixs, pdas), signers, { cu: 1_400_000, ...opts });
}

export function simulateWithPdas(tx: Transaction | TransactionInstruction[], pdas: Pda[]) {
  const ixs = Array.isArray(tx) ? tx : tx.instructions;
  return simulate([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...wrapForPdas(ixs, pdas)]);
}

/**
 * Same as sendWithPdas, through a fresh address lookup table holding every non-signer key: for
 * proxied DLMM instructions that do not fit in 1,232 bytes otherwise.
 */
export async function sendWithPdasAlt(
  label: string,
  ixs: TransactionInstruction[],
  pdas: Pda[],
  signers: Keypair[] = [],
  opts: SendOpts = {},
): Promise<Landed> {
  const wrapped = wrapForPdas(ixs, pdas);
  const keys = [...new Map(
    [ComputeBudgetProgram.programId, ...wrapped.flatMap((ix) => [ix.programId, ...ix.keys.filter((k) => !k.isSigner).map((k) => k.pubkey)])]
      .map((k) => [k.toBase58(), k]),
  ).values()];
  const alt = await createAlt(label, keys);
  return send(label, wrapped, signers, { cu: 1_400_000, ...opts, alts: [alt] });
}
