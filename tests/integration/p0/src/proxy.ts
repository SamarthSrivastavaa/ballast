/**
 * Client for the p0_harness `proxy` instruction: re-issue SDK-built Meteora instructions as CPIs
 * signed by harness PDAs (partner_auth / creator_auth / vault).
 *
 * The instruction data is borsh-encoded by hand from the harness IDL's layout (discriminator +
 * Vec<Call>), so nothing here depends on Anchor's TS name-casing rules.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { REPO } from "./env";

const IDL = JSON.parse(readFileSync(resolve(REPO, "tests/integration/p0/target/idl/p0_harness.json"), "utf8"));
export const HARNESS_ID = new PublicKey(IDL.address);
const PROXY_DISC = Buffer.from(IDL.instructions.find((i: { name: string }) => i.name === "proxy").discriminator);

export const PdaKind = { partnerAuth: 0, creatorAuth: 1, vault: 2 } as const;
type Kind = (typeof PdaKind)[keyof typeof PdaKind];
const PREFIX: Record<Kind, string> = { 0: "partner_auth", 1: "creator_auth", 2: "vault" };

export interface Pda {
  kind: Kind;
  key: PublicKey;
  address: PublicKey;
  bump: number;
}

export function pda(kind: Kind, key: PublicKey): Pda {
  const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from(PREFIX[kind]), key.toBuffer()], HARNESS_ID);
  return { kind, key, address, bump };
}

export interface ProxiedCall {
  ix: TransactionInstruction;
  /** Harness PDAs that must sign this call (they appear as signers in `ix`). */
  signers: Pda[];
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** Build one `proxy` instruction carrying `calls` in order. */
export function proxyIx(calls: ProxiedCall[]): TransactionInstruction {
  const pdaSet = new Set(calls.flatMap((c) => c.signers.map((s) => s.address.toBase58())));
  const metas: AccountMeta[] = [];
  const index = new Map<string, number>();
  const add = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): number => {
    const k = pubkey.toBase58();
    // A harness PDA cannot sign the outer transaction; the proxy signs for it with invoke_signed.
    const outerSigner = isSigner && !pdaSet.has(k);
    const i = index.get(k);
    if (i !== undefined) {
      metas[i].isSigner ||= outerSigner;
      metas[i].isWritable ||= isWritable;
      return i;
    }
    metas.push({ pubkey, isSigner: outerSigner, isWritable });
    index.set(k, metas.length - 1);
    return metas.length - 1;
  };

  const parts: Buffer[] = [PROXY_DISC, u32(calls.length)];
  for (const c of calls) {
    for (const s of c.signers) {
      const used = c.ix.keys.find((k) => k.pubkey.equals(s.address));
      if (!used?.isSigner) throw new Error(`PDA ${s.address.toBase58()} is not a signer of this call`);
    }
    const program = add(c.ix.programId, false, false);
    const accts = c.ix.keys.map((k) => ({ i: add(k.pubkey, k.isSigner, k.isWritable), s: k.isSigner, w: k.isWritable }));
    if (metas.length > 255) throw new Error("proxy: more than 255 accounts");
    parts.push(Buffer.from([program]), u32(accts.length));
    for (const a of accts) parts.push(Buffer.from([a.i, a.s ? 1 : 0, a.w ? 1 : 0]));
    parts.push(u32(c.ix.data.length), Buffer.from(c.ix.data), u32(c.signers.length));
    for (const s of c.signers) parts.push(Buffer.from([s.kind]), s.key.toBuffer(), Buffer.from([s.bump]));
  }
  return new TransactionInstruction({ programId: HARNESS_ID, keys: metas, data: Buffer.concat(parts) });
}
