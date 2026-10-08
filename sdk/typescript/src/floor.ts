/**
 * The floor crate in TypeScript, by WebAssembly (§4 rule 1: only `ballast-floor` computes F — this
 * module runs that crate's code, it reimplements nothing).
 *
 * `crates/floor-wasm` exports u64 halves; this wrapper joins them into `bigint`s.
 *
 *   const floor = await loadFloor(bytes);       // bytes of floor_wasm.wasm (fs in Node, fetch in the app)
 *   floor.s({ v, s, l, sMax })                    // ⌊√F·2^64⌋, or null when §4's bounds refuse the inputs
 */

export interface FloorInputs {
  v: bigint;
  s: bigint;
  l: bigint;
  sMax: bigint;
}

export interface Floor {
  /** `s = ⌊√F · 2^64⌋`, or null when the inputs are out of §4's range. */
  s(i: FloorInputs): bigint | null;
  /** §10 payout for `amount` base units at `s`, net of `feeBps`. */
  payout(amount: bigint, s: bigint, feeBps: number): bigint;
  /** `price ≤ F < next` for DLMM Q64 bin prices (§9). */
  binAtOrBelow(price: bigint, next: bigint, s: bigint): boolean;
}

/** DAMM v2 `MAX_SQRT_PRICE` — the `s_max` of every Ballast pool (full range, §8). */
export const S_MAX_DAMM_V2 = 79_226_673_521_066_979_257_578_248_091n;

const M64 = (1n << 64n) - 1n;
const lo = (x: bigint) => x & M64;
const hi = (x: bigint) => x >> 64n;

type Exports = {
  floor_ok: (...a: bigint[]) => number;
  floor_lo: (...a: bigint[]) => bigint;
  floor_hi: (...a: bigint[]) => bigint;
  payout: (amount: bigint, sLo: bigint, sHi: bigint, fee: number) => bigint;
  bin_ok: (...a: bigint[]) => number;
};

/** Instantiate `floor_wasm.wasm`. i64 values cross the boundary as BigInt; results are unsigned. */
export async function loadFloor(bytes: BufferSource): Promise<Floor> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports as unknown as Exports;
  const u = (n: bigint) => BigInt.asUintN(64, n);
  return {
    s({ v, s, l, sMax }) {
      const args = [v, s, lo(l), hi(l), lo(sMax), hi(sMax)].map((n) => BigInt.asIntN(64, n));
      if (x.floor_ok(...args) !== 1) return null;
      return (u(x.floor_hi(...args)) << 64n) | u(x.floor_lo(...args));
    },
    payout(amount, s, feeBps) {
      return u(x.payout(BigInt.asIntN(64, amount), BigInt.asIntN(64, lo(s)), BigInt.asIntN(64, hi(s)), feeBps));
    },
    binAtOrBelow(price, next, s) {
      return x.bin_ok(...[lo(price), hi(price), lo(next), hi(next), lo(s), hi(s)].map((n) => BigInt.asIntN(64, n))) === 1;
    },
  };
}

/** F in SOL per token for a 6-decimal token: `s²/2^128 · 10^-3` (display only; never decide on it). */
export function fSolPerToken(s: bigint): number {
  return (Number(s) / 2 ** 64) ** 2 * 1e-3;
}
