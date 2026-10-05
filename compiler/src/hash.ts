/**
 * §7 rule 3: `sha256(sqrt_start_price ‖ curve[0..20] ‖ migration_quote_threshold ‖ supply fields)`,
 * all little-endian, exactly as `programs/ballast::config_hash_preimage` lays them out:
 *
 *   16 (u128 sqrt_start_price)
 *   + 20 × (16 u128 sqrt_price ‖ 16 u128 liquidity)      — unused curve slots are zero
 *   + 8 (u64 migration_quote_threshold) + 8 (u64 pre_migration_token_supply) + 8 (u64 post)
 *   = 680 bytes
 *
 * `programs/ballast/tests/hash_preimage.rs` checks the Rust side against compiler/out/classes.json.
 */
import { createHash } from "node:crypto";
import type { CurvePoint } from "./canon";

export const CURVE_CAPACITY = 20; // on-chain PoolConfig curve slots (Q12)

const le = (v: bigint, bytes: number): Buffer => {
  if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new Error(`${v} does not fit u${8 * bytes}`);
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
};

export function configHashPreimage(sqrtStart: bigint, curve: CurvePoint[], threshold: bigint, preSupply: bigint, postSupply: bigint): Buffer {
  if (curve.length > CURVE_CAPACITY) throw new Error("curve longer than the on-chain capacity");
  const parts = [le(sqrtStart, 16)];
  for (let i = 0; i < CURVE_CAPACITY; i++) {
    const p = curve[i] ?? { sqrtPrice: 0n, liquidity: 0n };
    parts.push(le(p.sqrtPrice, 16), le(p.liquidity, 16));
  }
  parts.push(le(threshold, 8), le(preSupply, 8), le(postSupply, 8));
  const out = Buffer.concat(parts);
  if (out.length !== 680) throw new Error(`preimage is ${out.length} bytes, expected 680`);
  return out;
}

export function configHash(preimage: Buffer): Buffer {
  return createHash("sha256").update(preimage).digest();
}
