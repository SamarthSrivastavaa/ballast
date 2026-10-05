/**
 * Program integration tests on the mainnet-binary local validator (D-001).
 *
 *   source ~/.ballast-env && pnpm localnet --quiet &
 *   bash tests/integration/p0/up.sh                 # payer funds
 *   pnpm exec tsx tests/integration/program/run.ts  # (also Anchor.toml's `anchor test` script)
 *
 * Deploys target/deploy/ballast.so at its program id with the localnet payer as upgrade authority
 * (initialize_global requires the upgrade authority), then runs the suites.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertLocal, NeedsClone, REPO } from "../p0/src/env";
import { part1 } from "./src/part1";
import { part2 } from "./src/part2";

async function main(): Promise<void> {
  await assertLocal();
  execFileSync(
    "solana",
    ["program", "deploy", "-u", "l", "-k", resolve(REPO, ".keys/devnet/localnet.json"),
      "--program-id", resolve(REPO, "target/deploy/ballast-keypair.json"), resolve(REPO, "target/deploy/ballast.so")],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const only = process.argv[2];
  let fails = 0;
  if (!only || only === "part1") fails += await part1();
  if (!only || only === "part2") fails += await part2();
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof NeedsClone) console.error(`\nNEEDS CLONE\n${e.message}`);
  else console.error(e);
  process.exit(1);
});
