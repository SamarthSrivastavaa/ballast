/**
 * STEP 3 check (c), D-008: does a Ballast Lite DBC config migrate with 100% of its liquidity
 * permanently locked? On Meteora's mainnet binaries (local validator, D-001):
 *
 *   create the Lite config → create a pool → buy to the threshold → migrate to DAMM v2 →
 *   read both positions in the migration slot: unlocked = vested = 0, permanent > 0, and
 *   Σ permanent = the pool's liquidity → the locked-liquidity floor (V = 0) with the floor crate.
 *
 *   pnpm exec tsx scripts/lite/check-c.ts        → evidence/lite/check-c.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { assertLocal, conn, payer, REPO, send } from "../../tests/integration/p0/src/env";
import { configParameters, lite, WSOL } from "../../compiler/src/canon";
import { dbc } from "../../tests/integration/p0/src/dbc";
import { buyPartialFill, createPool, dammPool, dammPosition, migrate } from "../../tests/integration/p0/src/flow";
import { funded } from "../../tests/integration/p0/src/wallets";
import { loadFloor, S_MAX_DAMM_V2 } from "../../sdk/typescript/src/floor";

const DAMM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const position = (nft: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), nft.toBuffer()], DAMM_ID)[0];

async function main(): Promise<void> {
  await assertLocal();
  const partner = await funded("lite.partner", 5);
  const creator = await funded("lite.creator", 5);
  const buyer = await funded("lite.buyer", 30);
  const config = Keypair.generate();
  const cc = await send("Lite create_config", [
    await dbc.methods.createConfig(configParameters(lite(10_000_000_000n)) as never)
      .accountsPartial({ config: config.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey, quoteMint: WSOL, payer: payer.publicKey })
      .instruction(),
  ], [config]);
  const { pool, baseMint } = await createPool(config.publicKey, creator, "Lite pool");
  const b = await buyPartialFill("Lite: buy to the threshold", buyer, pool, 12_000_000_000n);
  const mig = await migrate("Lite: migrate", pool);
  const positions = [position(mig.firstNft), position(mig.secondNft)];
  const pos = (await Promise.all(positions.map(dammPosition))) as Record<string, string>[];
  const damm = new PublicKey(String((pos[0] as Record<string, unknown>).pool));
  const p = (await dammPool(damm)) as Record<string, string>;
  const permanent = pos.reduce((a, x) => a + BigInt(x.permanentLockedLiquidity), 0n);
  const supply = (await getMint(conn, baseMint.publicKey)).supply;
  const floor = await loadFloor(readFileSync(resolve(REPO, "target/wasm32-unknown-unknown/release/floor_wasm.wasm")));
  const s = floor.s({ v: 0n, s: supply, l: permanent, sMax: BigInt(p.sqrtMaxPrice ?? S_MAX_DAMM_V2) });
  const sPrice = BigInt(p.sqrtPrice);
  const checks = {
    bothFullyPermanent: pos.every((x) => x.unlockedLiquidity === "0" && x.vestedLiquidity === "0" && BigInt(x.permanentLockedLiquidity) > 0n),
    allLiquidityPermanent: permanent === BigInt(p.liquidity),
    floorExists: s !== null && s > 0n,
  };
  const out = {
    ranAt: new Date().toISOString(), what: "D-008 Lite: 100% permanently locked migration (STEP 3 check (c))",
    signatures: { createConfig: cc.signature, buy: b.signature, migrate: mig.landed.signature },
    config: config.publicKey.toBase58(), pool: pool.toBase58(), dammPool: damm.toBase58(), positions: positions.map(String),
    permanent: permanent.toString(), poolLiquidity: p.liquidity, supply: supply.toString(),
    lockedLiquidityFloor: { s: s?.toString(), floorOverPrice: s ? Number(s * 1_000_000n / sPrice) ** 2 / 1e12 : null },
    checks, pass: Object.values(checks).every(Boolean),
  };
  mkdirSync(resolve(REPO, "evidence/lite"), { recursive: true });
  writeFileSync(resolve(REPO, "evidence/lite/check-c.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
