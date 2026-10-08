/**
 * Ballast Lite (D-008): a DBC config only — the Proof/Public curve shape, flat 1% fee, migration fee 0,
 * 100% of the migrated liquidity permanently locked and split partner/creator. No Ballast program: the
 * floor is the locked-liquidity floor (`V = 0`), which `ballast scan` and the floor crate compute.
 *
 *   pnpm exec tsx scripts/lite/config.ts --rpc <url> --fee-claimer <pubkey> [--threshold-sol 10]
 *                                         [--payer-pubkey <funded address>]          # dry run
 *   pnpm exec tsx scripts/lite/config.ts ... --payer <keypair.json> --send           # not on mainnet
 *
 * Default is a dry run: the `create_config` transaction is built and simulated (read-only; D-007 does
 * not cover reads) and its accounts, compute units and rent are printed. `--send` signs and sends —
 * refused on mainnet, where every transaction needs the owner's approval first (D-007).
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { configParameters, lite, WSOL } from "../../compiler/src/canon";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rpc = arg("--rpc") ?? "http://127.0.0.1:8899";
  const conn = new Connection(rpc, "confirmed");
  const send = process.argv.includes("--send");
  const payer = arg("--payer")
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(arg("--payer")!, "utf8"))))
    : Keypair.generate();
  const feeClaimer = new PublicKey(arg("--fee-claimer") ?? payer.publicKey.toBase58());
  // A dry run signs nothing: simulate with any funded address as the fee payer (default: the claimer).
  const payerKey = send ? payer.publicKey : new PublicKey(arg("--payer-pubkey") ?? feeClaimer.toBase58());
  const thresholdSol = Number(arg("--threshold-sol") ?? 10);
  const spec = lite(BigInt(Math.round(thresholdSol * 1e9)));
  const params = configParameters(spec);
  const genesis = await conn.getGenesisHash();
  if (send && genesis === MAINNET_GENESIS) {
    throw new Error("refusing to send on mainnet: D-007 requires the owner's approval of this transaction first");
  }

  const dbc = new DynamicBondingCurveClient(conn, "confirmed");
  const config = Keypair.generate();
  const ix = await dbc.program.methods
    .createConfig(params as never)
    .accountsPartial({ config: config.publicKey, feeClaimer, leftoverReceiver: feeClaimer, quoteMint: WSOL, payer: payerKey })
    .instruction();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const rent = await conn.getMinimumBalanceForRentExemption(1_048 + 8);
  const summary = {
    rpc, mainnet: genesis === MAINNET_GENESIS, config: config.publicKey.toBase58(), feeClaimer: feeClaimer.toBase58(),
    class: { thresholdSol, p0: spec.p0, migrationFeePercentage: 0, partnerPermanentPct: 50, creatorPermanentPct: 50, fee: "1% flat", migratedPool: "DAMM v2 OnlyB, 1%" },
    configRentLamports: rent,
  };
  if (!send) {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log(JSON.stringify({ ...summary, dryRun: true, simulation: { err: sim.value.err, unitsConsumed: sim.value.unitsConsumed, logs: (sim.value.logs ?? []).slice(-6) } }, null, 2));
    process.exit(sim.value.err ? 1 : 0);
  }
  tx.sign([payer, config]);
  const signature = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(JSON.stringify({ ...summary, signature }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
