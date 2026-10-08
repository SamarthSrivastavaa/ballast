/**
 * Program integration tests on the mainnet-binary local validator (D-001).
 *
 *   source ~/.ballast-env && pnpm localnet --quiet &
 *   bash tests/integration/p0/up.sh                       # payer funds
 *   pnpm exec tsx tests/integration/program/run.ts        # every suite (also `anchor test`)
 *   pnpm exec tsx tests/integration/program/run.ts part1,part5
 *
 * Deploys target/deploy/ballast.so (or `BALLAST_SO`) at its program id with the localnet payer as
 * upgrade authority (initialize_global requires the upgrade authority), then runs the suites.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertLocal, NeedsClone, REPO } from "../p0/src/env";
import { part1 } from "./src/part1";
import { part2 } from "./src/part2";
import { part3 } from "./src/part3";
import { part4 } from "./src/part4";
import { part5 } from "./src/part5";
import { part6 } from "./src/part6";

const SUITES: [string, () => Promise<number>][] = [
  ["part1", part1], ["part2", part2], ["part3", part3], ["part4", part4], ["part5", part5], ["part6", part6],
];

async function main(): Promise<void> {
  await assertLocal();
  execFileSync(
    "solana",
    ["program", "deploy", "-u", "l", "-k", resolve(REPO, ".keys/devnet/localnet.json"),
      "--program-id", resolve(REPO, "target/deploy/ballast-keypair.json"), resolve(REPO, process.env.BALLAST_SO ?? "target/deploy/ballast.so")],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const only = process.argv[2]?.split(",");
  let fails = 0;
  for (const [name, suite] of SUITES) if (!only || only.includes(name)) fails += await suite();
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof NeedsClone) console.error(`\nNEEDS CLONE\n${e.message}`);
  else console.error(e);
  process.exit(1);
});
