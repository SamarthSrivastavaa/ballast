/**
 * Ballast program client for the integration tests (mainnet-binary local validator, D-001).
 * Reuses the P0 harness plumbing: `send()` with per-transaction mainnet account discovery.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { conn, payer, REPO } from "../../p0/src/env";

export const IDL = JSON.parse(readFileSync(resolve(REPO, "target/idl/ballast.json"), "utf8"));
export const BALLAST_ID = new PublicKey(IDL.address);
export const ballast = new Program(IDL, new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" }));
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
