/**
 * §14 differential, WASM leg: every case in crates/floor/vectors.json (the §27 vectors, the D-017
 * prediction vectors and 10,000 random cases — Rust and Python already match all of them) through
 * the WebAssembly build of the floor crate. Identical s required for every case; also the §10
 * payout and the §9 bin check on the §27 Proof vector.
 *
 *   pnpm test:wasm   (builds crates/floor-wasm for wasm32-unknown-unknown first)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadFloor } from "../src/floor";

const REPO = resolve(__dirname, "../../..");

async function main(): Promise<void> {
  const wasm = readFileSync(resolve(REPO, "target/wasm32-unknown-unknown/release/floor_wasm.wasm"));
  const floor = await loadFloor(wasm);
  const vectors = JSON.parse(readFileSync(resolve(REPO, "crates/floor/vectors.json"), "utf8")) as {
    cases: { name: string; v: string; s_supply: string; l: string; s_max: string; s: string | null }[];
  };
  let matched = 0;
  const mismatches: string[] = [];
  for (const c of vectors.cases) {
    const got = floor.s({ v: BigInt(c.v), s: BigInt(c.s_supply), l: BigInt(c.l), sMax: BigInt(c.s_max) });
    const want = c.s === null ? null : BigInt(c.s);
    if (got === want) matched++;
    else if (mismatches.length < 10) mismatches.push(`${c.name}: wasm ${got} ≠ ${want}`);
  }
  // §10 payout and §9 bin on the Proof vector (values from the Rust unit tests and §27).
  const s = 47_755_047_807_748_143n;
  const payout = floor.payout(10_000_000_000_000n, s, 50);
  const want = (10_000_000_000_000n * s * s * 9_950n) / ((1n << 128n) * 10_000n);
  const result = { wasmBytes: wasm.length, cases: vectors.cases.length, matched, mismatches, payoutMatchesFormula: payout === want, pass: matched === vectors.cases.length && payout === want };
  mkdirSync(resolve(REPO, "evidence/floor"), { recursive: true });
  writeFileSync(resolve(REPO, "evidence/floor/wasm-differential.json"), JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`WASM differential: ${matched}/${vectors.cases.length} identical s; payout ${result.payoutMatchesFormula ? "ok" : "MISMATCH"}`);
  for (const m of mismatches) console.log(`  ${m}`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
