/**
 * §7 canonical DBC configs, built in exact integer arithmetic.
 *
 * - sqrt prices: s = ⌊√(p_raw · 2^128)⌋ with p_raw in lamports per base unit
 *   (p in SOL/token × 10^9 lamports/SOL ÷ 10^6 base units/token).
 * - curve: three points at √(5·p0), √(6·p0), √(8·p0) carrying 5% / 40% / 55% of the threshold;
 *   segment liquidity L_i = ⌈q_i · 2^128 / (s_i − s_{i−1})⌉ (§7 "Encoding the curve"), rounded UP
 *   so the curve can always absorb the whole threshold.
 *
 * Parameters are passed raw to the DBC program (Anchor client over the SDK's IDL), never through
 * the SDK's own validators, so DBC's on-chain validation is what accepts or rejects them.
 */
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const Q128 = 1n << 128n;

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/** p0 as a decimal string in SOL/token, e.g. "3.2472e-9" → exact rational num/den in lamports/base unit. */
function pRaw(p0: string): { num: bigint; den: bigint } {
  const [mant, expS] = p0.toLowerCase().split("e");
  const exp = Number(expS ?? 0);
  const [i, f = ""] = mant.split(".");
  let num = BigInt(i + f);
  let den = 10n ** BigInt(f.length);
  // × 10^9 lamports/SOL ÷ 10^6 base units/token = × 10^3, then the decimal exponent.
  const e = exp + 3;
  if (e >= 0) num *= 10n ** BigInt(e);
  else den *= 10n ** BigInt(-e);
  return { num, den };
}

export function sqrtPriceQ64(p0: string, multiple = 1n): bigint {
  const { num, den } = pRaw(p0);
  return isqrt((multiple * num * Q128) / den);
}

export interface CurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export function shapedCurve(p0: string, threshold: bigint): { sqrtStart: bigint; curve: CurvePoint[] } {
  const sqrtStart = sqrtPriceQ64(p0);
  const points = [5n, 6n, 8n].map((k) => sqrtPriceQ64(p0, k));
  const shares = [5n, 40n, 55n];
  const curve: CurvePoint[] = [];
  let prev = sqrtStart;
  points.forEach((s, i) => {
    const q = (threshold * shares[i]) / 100n;
    const liquidity = (q * Q128 + (s - prev) - 1n) / (s - prev); // ceil
    curve.push({ sqrtPrice: s, liquidity });
    prev = s;
  });
  return { sqrtStart, curve };
}

export interface ClassSpec {
  name: "proof" | "lite" | string;
  p0: string;
  threshold: bigint;
  migrationFeePercentage: number;
  partnerPermanent: number;
  creatorPermanent: number;
  /** DBC `migrated_pool_fee.collect_fee_mode` (DBC enum: 0 QuoteToken, 1 OutputToken, 2 Compounding). D-010: 0 → DAMM OnlyB. */
  migratedCollectFeeMode?: number;
}

/** §7 Proof: 10 SOL, p0 = 3.2472e-9 SOL/token, 15% migration fee, 50/50 permanent. */
export const PROOF: ClassSpec = {
  name: "proof",
  p0: "3.2472e-9",
  threshold: 10_000_000_000n,
  migrationFeePercentage: 15,
  partnerPermanent: 50,
  creatorPermanent: 50,
};

/** D-008 Lite: same shape, migration fee 0, 100% permanently locked LP split partner/creator. */
export function lite(threshold: bigint): ClassSpec {
  return { ...PROOF, name: "lite", threshold, migrationFeePercentage: 0 };
}

const bn = (x: bigint | number) => new BN(x.toString());
const ZERO_VESTING_INFO = {
  vestingPercentage: 0,
  bpsPerPeriod: 0,
  numberOfPeriods: 0,
  cliffDurationFromMigrationTime: 0,
  frequency: 0,
};

/** ConfigParameters in the Anchor client's camelCase, every §7 row explicit. */
export function configParameters(spec: ClassSpec) {
  const { sqrtStart, curve } = shapedCurve(spec.p0, spec.threshold);
  return {
    poolFees: {
      // Flat 1%: cliff numerator 10,000,000 of 10^9, no periods (§7 "Base fee").
      baseFee: {
        cliffFeeNumerator: bn(10_000_000),
        firstFactor: 0,
        secondFactor: bn(0),
        thirdFactor: bn(0),
        baseFeeMode: 0,
      },
      dynamicFee: null, // §7: disabled
    },
    collectFeeMode: 0, // quote
    migrationOption: 1, // DAMM v2
    activationType: 0, // slot
    tokenType: 0, // SPL
    tokenDecimal: 6,
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: spec.partnerPermanent,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: spec.creatorPermanent,
    migrationQuoteThreshold: bn(spec.threshold),
    sqrtStartPrice: bn(sqrtStart),
    lockedVesting: {
      amountPerPeriod: bn(0),
      cliffDurationFromMigrationTime: bn(0),
      frequency: bn(0),
      numberOfPeriod: bn(0),
      cliffUnlockAmount: bn(0),
    },
    migrationFeeOption: 6, // Customizable
    tokenSupply: { preMigrationTokenSupply: bn(10n ** 15n), postMigrationTokenSupply: bn(10n ** 15n) },
    creatorTradingFeePercentage: 50,
    tokenUpdateAuthority: 1, // Immutable
    migrationFee: { feePercentage: spec.migrationFeePercentage, creatorFeePercentage: 0 },
    // §7 "Migrated pool" (D-010): 100 bps, DAMM OnlyB, dynamic fee off; compounding 0.
    // D-010: DBC QuoteToken (0) yields a DAMM v2 OnlyB (1) pool. §7 originally wrote 1 here (= DBC OutputToken → BothToken).
    migratedPoolFee: { collectFeeMode: spec.migratedCollectFeeMode ?? 0, dynamicFee: 0, poolFeeBps: 100 },
    poolCreationFee: bn(0),
    partnerLiquidityVestingInfo: ZERO_VESTING_INFO,
    creatorLiquidityVestingInfo: ZERO_VESTING_INFO,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: 0,
      sqrtPriceStepBps: 0,
      schedulerExpirationDuration: 0,
      reductionFactor: bn(0),
    },
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
    padding: [0, 0],
    curve: curve.map((c) => ({ sqrtPrice: bn(c.sqrtPrice), liquidity: bn(c.liquidity) })),
  };
}
