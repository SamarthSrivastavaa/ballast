/**
 * STEP 3 P0 harness runner (D-001: mainnet-binary local validator).
 *
 *   source ~/.ballast-env && pnpm localnet --quiet &   # then deploy the harness (see README)
 *   pnpm exec tsx tests/integration/p0/src/run.ts <step> [...]
 *
 * Each step writes evidence under evidence/p0/<Q>/ and fails loudly. A NeedsClone error means a
 * mainnet account must be added to the fixtures (see env.ts) before the step can run.
 */
import { assertLocal, NeedsClone } from "./env";
import { q12 } from "./steps/q12";
import { qa } from "./steps/qa";
import { proofBuy, proofPreMigration, proofSetup } from "./steps/proof";
import { proofMigrate } from "./steps/proofMigrate";
import { proofPost } from "./steps/proofPost";
import { q2fix } from "./steps/q2fix";
import { dlmmOrder, dlmmPair } from "./steps/dlmm";
import { d011Fit } from "./steps/d011";
import { d012 } from "./steps/d012";

const STEPS: Record<string, () => Promise<void>> = {
  q12,
  qa,
  "proof-setup": proofSetup,
  "proof-buy": proofBuy,
  "proof-premigration": proofPreMigration,
  "proof-migrate": proofMigrate,
  "proof-post": proofPost,
  "q2-characterize": q2fix,
  "dlmm-pair": dlmmPair,
  "dlmm-order": dlmmOrder,
  "d011-fit": d011Fit,
  d012,
};

async function main(): Promise<void> {
  await assertLocal();
  const names = process.argv.slice(2);
  if (!names.length) throw new Error(`usage: run.ts <${Object.keys(STEPS).join("|")}> ...`);
  for (const n of names) {
    const step = STEPS[n];
    if (!step) throw new Error(`unknown step ${n}`);
    console.log(`\n=== ${n} ===`);
    await step();
  }
}

main().catch((e) => {
  if (e instanceof NeedsClone) console.error(`\nNEEDS CLONE\n${e.message}`);
  else console.error(e);
  process.exit(1);
});
