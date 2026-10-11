/**
 * Mainnet dry run: the whole Proof launch on the local validator running Meteora's mainnet DBC,
 * DAMM v2 and DLMM binaries, with every wallet's SOL measured before and after each step. Nothing
 * is sent to mainnet. Rent per byte is read from mainnet (read-only) so the deploy cost is exact.
 *
 *   pnpm mainnet:dryrun        → evidence/mainnet-dryrun/cost.json and cost.md
 *
 * The launch steps are the demo runbook's (demo/run.ts); a mainnet run would send the same
 * instructions with the same amounts.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { conn, payer, REPO } from "../../tests/integration/p0/src/env";
import { wallet } from "../../tests/integration/p0/src/wallets";
import { pdas } from "../../tests/integration/program/src/client";

const OUT = resolve(REPO, "evidence/mainnet-dryrun");
const STEPS = ["reset", "launch", "buy", "graduate", "floor", "dump"];
const SOL = (l: number) => l / 1e9;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const so = statSync(resolve(REPO, "target/deploy/ballast.so")).size;
  const [programData, programAccount, buffer] = await Promise.all([45 + so, 36, 37 + so].map((n) => mainnet.getMinimumBalanceForRentExemption(n)));

  const run = (step: string) => execFileSync("pnpm", ["exec", "tsx", "demo/run.ts", step], { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });
  const admin = wallet("program.admin");
  const balances = async (who: Record<string, PublicKey>) => Object.fromEntries(await Promise.all(Object.entries(who).map(async ([k, v]) => [k, await conn.getBalance(v)] as const)));
  const before = await balances({ payer: payer.publicKey, admin: admin.publicKey });

  run("reset");
  const state = JSON.parse(readFileSync(resolve(REPO, "demo/.state/state.json"), "utf8"));
  const id = state.id as string;
  const classConfig = new PublicKey(state.classConfig.$pk);
  const who: Record<string, PublicKey> = {
    payer: payer.publicKey, admin: admin.publicKey, creator: wallet(`demo.${id}.creator`).publicKey,
    buyer1: wallet(`demo.${id}.buyer1`).publicKey, buyer2: wallet(`demo.${id}.buyer2`).publicKey, buyer3: wallet(`demo.${id}.buyer3`).publicKey,
    partner_auth: pdas.partner(classConfig),
  };
  const snaps: { after: string; lamports: Record<string, number> }[] = [{ after: "reset", lamports: await balances(who) }];
  for (const step of STEPS.slice(1)) {
    run(step);
    snaps.push({ after: step, lamports: await balances(who) });
  }
  const [first, last] = [snaps[0].lamports, snaps[snaps.length - 1].lamports];
  const buyers = ["buyer1", "buyer2", "buyer3"];
  const afterBuy = snaps.find((s) => s.after === "buy")!.lamports;
  const bought = buyers.reduce((a, k) => a + (first[k] - afterBuy[k]), 0);
  const back = buyers.reduce((a, k) => a + (last[k] - afterBuy[k]), 0);
  // The payer: class and config rents and the keeper float in `reset` (measured from before it),
  // then every rent and fee of the launch and the cranks.
  const payerReset = before.payer - first.payer;
  const payerRest = first.payer - last.payer;
  const adminSpent = before.admin - last.admin; // may be negative if `reset` topped it up
  const dump = JSON.parse(readFileSync(resolve(REPO, "evidence/demo", id, "dump.json"), "utf8"));

  const cost = {
    ranAt: new Date().toISOString(),
    what: "Dry run on the local validator with Meteora's mainnet binaries. No mainnet transaction was sent.",
    demoId: id, programBytes: so,
    deploy: { programDataLamports: programData, programAccountLamports: programAccount, transientBufferLamports: buffer, writeTransactions: Math.ceil(so / 1012), estWriteFeesLamports: Math.ceil(so / 1012) * 5000 },
    launch: {
      payerClassConfigAndKeeperFloatLamports: payerReset, payerLaunchRentsAndCrankFeesLamports: payerRest, adminLamports: adminSpent,
      buysLamports: bought, sellProceedsLamports: back, lockedOrSpentInTheLaunchLamports: bought - back,
      creatorLamportsDelta: last.creator - first.creator, partnerAuthFloatLamports: last.partner_auth,
    },
    sellOut: { sells: dump.sells, lowestExecutionOverF: dump.lowestExecutionOverF, lowestExecutionVenue: dump.lowestExecutionVenue, lowestBidFillOverF: dump.lowestBidFillOverF, fNotLower: dump.fNotLower },
    snapshots: snaps,
  };
  const peak = programData + programAccount + Math.max(buffer, bought + payerReset + payerRest + Math.max(adminSpent, 0)) + cost.deploy.estWriteFeesLamports;
  const spent = programData + programAccount + cost.deploy.estWriteFeesLamports + payerReset + payerRest + Math.max(adminSpent, 0) + (bought - back);
  writeFileSync(resolve(OUT, "cost.json"), JSON.stringify({ ...cost, peakLamports: peak, spentForGoodLamports: spent }, null, 2) + "\n");
  const row = (a: string, l: number, note: string) => `| ${a} | ${SOL(l).toFixed(6)} | ${note} |`;
  const md = [
    `# Mainnet dry run — ${cost.ranAt}`,
    "",
    "The whole Proof launch on the local validator running Meteora's mainnet binaries, with every wallet measured. **No mainnet transaction was sent.** Rent is read from mainnet.",
    "",
    "| Item | SOL | Notes |",
    "|---|---|---|",
    row(`Program rent (${so.toLocaleString("en-US")} bytes)`, programData + programAccount, "kept while the program is deployed"),
    row("Deploy buffer", buffer, "transient: refunded when the deploy finishes"),
    row("Deploy write transactions", cost.deploy.estWriteFeesLamports, `${cost.deploy.writeTransactions} transactions at the base fee; priority fees extra`),
    row("DBC config, class, keeper float", payerReset + Math.max(adminSpent, 0), "rents; the 0.2 SOL float stays with the program's PDA"),
    row("Launch rents and every crank's fees", payerRest, "DBC pool, mint, metadata, DLMM pair and bin arrays, lookup table, cranks"),
    row("Buys to the 10 SOL threshold", bought, "three wallets, 1% curve fee included"),
    row("Sale proceeds on a full sell-out", -back, "comes back to the three wallets"),
    row("**Peak balance needed**", peak, "the deploy buffer is refunded before the buys"),
    row("**Spent for good after a full sell-out**", spent, "includes the program rent; `solana program close` would return that part"),
    "",
    `Sell-out in this run: ${dump.sells} sells; lowest execution ${dump.lowestExecutionOverF.toFixed(4)} × F (a ${dump.lowestExecutionVenue} sell); fills on the DLMM bid never below ${dump.lowestBidFillOverF?.toFixed(4)} × F; F not lower: ${dump.fNotLower}.`,
    "",
  ].join("\n");
  writeFileSync(resolve(OUT, "cost.md"), md);
  console.log("\n" + md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
