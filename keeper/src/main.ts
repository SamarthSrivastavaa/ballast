/**
 * `pnpm keeper -- --rpc <url> --keypair <path> [--launch <addr>...] [--once] [--interval <ms>]`
 *
 * Runs the Ballast keeper (cranks only; every instruction is permissionless). Without `--launch` it
 * cranks every launch of the program. Logs one JSON line per crank (§25).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BallastClient } from "../../sdk/typescript/src/client";
import { loadFloor } from "../../sdk/typescript/src/floor";
import { Keeper } from "./keeper";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rpc = arg("--rpc") ?? process.env.BALLAST_RPC ?? "http://127.0.0.1:8899";
  const keypair = arg("--keypair") ?? resolve(__dirname, "../../.keys/devnet/localnet.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypair, "utf8"))));
  const idl = JSON.parse(readFileSync(resolve(__dirname, "../../target/idl/ballast.json"), "utf8"));
  const conn = new Connection(rpc, "confirmed");
  const only: PublicKey[] = [];
  process.argv.forEach((a, i) => {
    if (a === "--launch" && process.argv[i + 1]) only.push(new PublicKey(process.argv[i + 1]));
  });
  const floor = await loadFloor(readFileSync(resolve(__dirname, "../../target/wasm32-unknown-unknown/release/floor_wasm.wasm")));
  const keeper = new Keeper(conn, new BallastClient(conn, idl, payer.publicKey), payer, { floor });
  await keeper.run(only, Number(arg("--interval") ?? 10_000), process.argv.includes("--once"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
