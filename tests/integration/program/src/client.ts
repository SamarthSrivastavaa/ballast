/**
 * Ballast program client for the integration tests (mainnet-binary local validator, D-001).
 * Reuses the P0 harness plumbing: `send()` with per-transaction mainnet account discovery.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { conn, payer, REPO } from "../../p0/src/env";

/** `BALLAST_IDL` points the suites at another build's IDL (the audit reproduction runs on D-020's). */
export const IDL = JSON.parse(readFileSync(resolve(REPO, process.env.BALLAST_IDL ?? "target/idl/ballast.json"), "utf8"));
export const BALLAST_ID = new PublicKey(IDL.address);
export const ballast = new Program(IDL, new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" }));
/** Typed view of the account namespace (the IDL is loaded as JSON, so Anchor cannot type it). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const accounts = ballast.account as unknown as Record<"global" | "class" | "launch", { fetch(k: PublicKey): Promise<any> }>;
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const find = (seeds: (Buffer | Uint8Array)[], program = BALLAST_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** §5 seeds. */
export const pdas = {
  global: () => find([Buffer.from("global")]),
  class: (config: PublicKey) => find([Buffer.from("class"), config.toBuffer()]),
  partner: (config: PublicKey) => find([Buffer.from("partner"), config.toBuffer()]),
  launch: (baseMint: PublicKey) => find([Buffer.from("launch"), baseMint.toBuffer()]),
  creator: (launch: PublicKey) => find([Buffer.from("creator"), launch.toBuffer()]),
  vault: (launch: PublicKey) => find([Buffer.from("vault"), launch.toBuffer()]),
  programData: () => find([BALLAST_ID.toBuffer()], BPF_UPGRADEABLE),
};

/** The Anchor error name a failed transaction's logs report, or null. */
export function errorName(logs: string[]): string | null {
  for (const l of logs) {
    const m = l.match(/Error Code: (\w+)\./);
    if (m) return m[1];
  }
  return null;
}
