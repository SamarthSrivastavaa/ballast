/**
 * `pnpm -F compiler emit` — compile the §7 classes into the constants `programs/ballast` pins.
 *
 * For each size (Proof, Public): `sqrt_start_price`, the three-point curve, the §7 rule-3 preimage
 * and `config_hash`, and `predicted_s_open` taken from the §27 vector of the same name in
 * `crates/floor/vectors.json` (produced by the independent Python reference and matched bit for
 * bit by `ballast-floor`). Writes `compiler/out/classes.json` (committed) and prints the Rust
 * `ClassCanon` literals.
 *
 * `--check` recomputes everything and fails if `classes.json` or the values pinned in
 * `programs/ballast/src/lib.rs` differ — so a §7 change cannot silently leave the program behind.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROOF, PUBLIC, shapedCurve, type ClassSpec } from "./canon";
import { configHash, configHashPreimage } from "./hash";

const REPO = resolve(__dirname, "../..");
const OUT = resolve(REPO, "compiler/out/classes.json");
const LIB = resolve(REPO, "programs/ballast/src/lib.rs");
const SUPPLY = 10n ** 15n;
/** §7 rule-4 band (D-017): max shortfall measured on the mainnet DBC binary + 2 (evidence/program/d017/band.json). */
const TOLERANCE = 4_580_461n;
const STATE = resolve(REPO, "programs/ballast/src/state.rs");
const REFERENCE = resolve(REPO, "tests/reference/floor.py");
const SIZES: { tag: number; spec: ClassSpec; vector: string }[] = [
  { tag: 0, spec: PROOF, vector: "proof" },
  { tag: 1, spec: PUBLIC, vector: "public" },
];

function compile() {
  const vectors = JSON.parse(readFileSync(resolve(REPO, "crates/floor/vectors.json"), "utf8"));
  const cases = (vectors.cases ?? vectors.vectors) as { name: string; s: string }[];
  return SIZES.map(({ tag, spec, vector }) => {
    const { sqrtStart, curve } = shapedCurve(spec.p0, spec.threshold);
    const preimage = configHashPreimage(sqrtStart, curve, spec.threshold, SUPPLY, SUPPLY);
    const hash = configHash(preimage);
    // D-017: the pinned prediction is the LOWEST of the §27 vector and the §7 prediction at both
    // ends of the rule-4 band, so it never assumes the favourable end of the band DBC may land in.
    const byName = (n: string) => {
      const c = cases.find((x) => x.name === n);
      if (!c) throw new Error(`no vector named ${n} in crates/floor/vectors.json`);
      return c;
    };
    const candidates = [byName(vector), byName(`${vector}_band_lo`), byName(`${vector}_band_hi`)];
    const predicted = candidates.reduce((m, c) => (BigInt(c.s) < BigInt(m.s) ? c : m));
    const [, lo, hi] = candidates;
    return {
      sizeTag: tag,
      name: spec.name,
      p0: spec.p0,
      migrationQuoteThreshold: spec.threshold.toString(),
      sqrtStartPrice: sqrtStart.toString(),
      curve: curve.map((c) => ({ sqrtPrice: c.sqrtPrice.toString(), liquidity: c.liquidity.toString() })),
      preMigrationTokenSupply: SUPPLY.toString(),
      postMigrationTokenSupply: SUPPLY.toString(),
      preimageHex: preimage.toString("hex"),
      configHash: hash.toString("hex"),
      configHashBytes: [...hash],
      predictedSOpen: predicted.s,
      predictedSource: `crates/floor/vectors.json case "${predicted.name}" — min of §27 "${vector}", "${lo.name}", "${hi.name}" (D-017)`,
      bandPrediction: {
        migrationPriceTolerance: TOLERANCE.toString(),
        bandLoS: lo.s,
        bandHiS: hi.s,
        lowerFEnd: BigInt(lo.s) < BigInt(hi.s) ? "band_lo (last point − tolerance)" : "band_hi (last curve point)",
      },
    };
  });
}

function rustLiteral(c: ReturnType<typeof compile>[number]): string {
  return [
    `        sqrt_start_price: ${c.sqrtStartPrice},`,
    `        config_hash: [${c.configHashBytes.join(", ")}],`,
  ].join("\n");
}

function main(): void {
  const classes = compile();
  const json = JSON.stringify({ generatedBy: "compiler/src/emit.ts", spec: "§7 + D-010", classes }, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const problems: string[] = [];
    if (readFileSync(OUT, "utf8") !== json) problems.push("compiler/out/classes.json is stale — run pnpm -F compiler emit");
    const lib = readFileSync(LIB, "utf8");
    const tol = TOLERANCE.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
    if (!readFileSync(STATE, "utf8").includes(`MIGRATION_PRICE_TOLERANCE: u128 = ${tol};`))
      problems.push(`state.rs: MIGRATION_PRICE_TOLERANCE is not ${tol} (D-017)`);
    if (!readFileSync(REFERENCE, "utf8").includes(`MIGRATION_PRICE_TOLERANCE = ${tol}`))
      problems.push(`tests/reference/floor.py: MIGRATION_PRICE_TOLERANCE is not ${tol} (D-017)`);
    for (const c of classes) {
      if (!lib.includes(`sqrt_start_price: ${c.sqrtStartPrice},`)) problems.push(`lib.rs: ${c.name} sqrt_start_price not pinned to ${c.sqrtStartPrice}`);
      // Parsed, not string-matched: rustfmt wraps the 32-byte array across lines.
      const pinned = [...lib.matchAll(/config_hash:\s*\[([^\]]*)\]/g)].map((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean).join(","));
      if (!pinned.includes(c.configHashBytes.join(","))) problems.push(`lib.rs: ${c.name} config_hash not pinned to ${c.configHash}`);
      if (!lib.includes(`predicted_s_open: ${c.predictedSOpen.replace(/\B(?=(\d{3})+(?!\d))/g, "_")},`))
        problems.push(`lib.rs: ${c.name} predicted_s_open is not ${c.predictedSOpen}`);
    }
    if (problems.length) {
      console.error("COMPILER CHECK FAILED\n" + problems.map((p) => "  - " + p).join("\n"));
      process.exit(1);
    }
    console.log("compiler check PASSED: classes.json and programs/ballast CLASSES match §7");
    return;
  }
  writeFileSync(OUT, json);
  for (const c of classes) console.log(`// ${c.name} (size_tag ${c.sizeTag}), config_hash ${c.configHash}\n${rustLiteral(c)}`);
}

main();
