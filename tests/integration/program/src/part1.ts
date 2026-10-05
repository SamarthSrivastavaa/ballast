/**
 * Program Part 1 tests — `initialize_global` and `create_class` (§6, §7) on the mainnet-binary
 * local validator (D-001). Every §7 rule gets a negative test:
 *
 *   1. build the canonical Proof config (compiler/src/canon.ts), change exactly ONE field;
 *   2. create it on the real DBC binary — DBC must ACCEPT it, so any rejection is Ballast's;
 *   3. `create_class` must fail with THAT rule's own error code.
 *
 * Where DBC itself refuses every config that would violate a rule (e.g. LP percentages must sum to
 * 100), the case is reported `unreachable` with the DBC error as evidence — never faked.
 */
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { getDynamicFeeParams } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, Landed, payer, send } from "../../p0/src/env";
import { configParameters, isqrt, PROOF, Q128, shapedCurve, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { dbc } from "../../p0/src/dbc";
import { ensureAtaIx, ata, funded } from "../../p0/src/wallets";
import { ballast, errorName, pdas } from "./client";
import { Suite } from "./runner";

type Params = ReturnType<typeof configParameters>;
const bn = (x: bigint | number) => new BN(x.toString());

async function dbcConfig(label: string, params: Params, opts: { feeClaimer?: (cfg: PublicKey) => PublicKey; leftover?: (cfg: PublicKey) => PublicKey; quoteMint?: PublicKey } = {}) {
  const config = Keypair.generate();
  const partner = pdas.partner(config.publicKey);
  const ix = await dbc.methods
    .createConfig(params as never)
    .accountsPartial({
      config: config.publicKey,
      feeClaimer: (opts.feeClaimer ?? (() => partner))(config.publicKey),
      leftoverReceiver: (opts.leftover ?? (() => partner))(config.publicKey),
      quoteMint: opts.quoteMint ?? WSOL,
      payer: payer.publicKey,
    })
    .instruction();
  const t = await send(`${label}: DBC create_config`, [ix], [config], { expectFail: true });
  return { config: config.publicKey, landed: t };
}

async function createClass(label: string, admin: Keypair, config: PublicKey, sizeTag = 0, dbcConfigOverride?: PublicKey): Promise<Landed> {
  const ix = await ballast.methods
    .createClass(sizeTag)
    .accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(config), dbcConfig: dbcConfigOverride ?? config })
    .instruction();
  return send(`${label}: create_class`, [ix], [admin], { expectFail: true });
}

/** Curve helpers for the rule-4/rule-3 mutations (same arithmetic as the compiler). */
function segL(q: bigint, lo: bigint, hi: bigint) {
  return (q * Q128 + (hi - lo) - 1n) / (hi - lo);
}
function curveParams(points: { s: bigint; l: bigint }[]) {
  return points.map((p) => ({ sqrtPrice: bn(p.s), liquidity: bn(p.l) }));
}

export async function part1(): Promise<number> {
  const suite = new Suite("Program Part 1 — initialize_global, create_class");
  const admin = await funded("program.admin", 20);
  const intruder = await funded("program.intruder", 5);
  await send("payer WSOL ATA (treasury)", [ensureAtaIx(WSOL, payer.publicKey)]);
  const treasury = ata(WSOL, payer.publicKey);
  const otherMint = await createMint(conn, payer, payer.publicKey, null, 6);
  await send("payer ATA of a non-WSOL mint", [ensureAtaIx(otherMint, payer.publicKey)]);

  // ---------------------------------------------------------------- initialize_global
  const initIx = (deployer: PublicKey, t: PublicKey) =>
    ballast.methods
      .initializeGlobal(admin.publicKey)
      .accountsPartial({ global: pdas.global(), deployer, programData: pdas.programData(), treasury: t, systemProgram: SystemProgram.programId })
      .instruction();
  const expectErr = async (name: string, expected: string, ixP: Promise<import("@solana/web3.js").TransactionInstruction>, signers: Keypair[], feePayer?: Keypair) =>
    suite.case(name, async () => {
      const t = await send(name, [await ixP], signers, { expectFail: true, feePayer });
      const got = t.err ? errorName(t.logs) ?? JSON.stringify(t.err) : "succeeded";
      return { status: got === expected ? "pass" : "fail", expected, got, detail: { signature: t.signature } };
    });

  await expectErr("initialize_global: signer is not the upgrade authority", "NotUpgradeAuthority", initIx(intruder.publicKey, treasury), [intruder], intruder);
  await expectErr("initialize_global: treasury is not a token account", "TreasuryNotTokenAccount", initIx(payer.publicKey, admin.publicKey), []);
  await expectErr("initialize_global: treasury mint is not WSOL", "TreasuryWrongMint", initIx(payer.publicKey, ata(otherMint, payer.publicKey)), []);
  await suite.case("initialize_global: upgrade authority, WSOL treasury → ok", async () => {
    const t = await send("initialize_global", [await initIx(payer.publicKey, treasury)], [], { expectFail: true });
    const g = t.err ? null : await ballast.account.global.fetch(pdas.global());
    const ok = !t.err && g!.admin.equals(admin.publicKey) && g!.treasury.equals(treasury) && g!.classCreationEnabled === true;
    return { status: ok ? "pass" : "fail", expected: "ok", got: t.err ? errorName(t.logs) : "ok", detail: { signature: t.signature, global: g } };
  });
  await suite.case("initialize_global: second call is refused", async () => {
    const t = await send("initialize_global again", [await initIx(payer.publicKey, treasury)], [], { expectFail: true });
    return { status: t.err ? "pass" : "fail", expected: "refused (account in use)", got: t.err ? JSON.stringify(t.err) : "succeeded", detail: { signature: t.signature } };
  });

  // ---------------------------------------------------------------- create_class: positive
  const canonical = await dbcConfig("canonical Proof", configParameters(PROOF));
  await suite.case("create_class: canonical Proof config → ok, Class recorded", async () => {
    if (canonical.landed.err) return { status: "fail", expected: "DBC accepts", got: errorName(canonical.landed.logs) };
    const t = await createClass("canonical", admin, canonical.config);
    if (t.err) return { status: "fail", expected: "ok", got: errorName(t.logs) ?? JSON.stringify(t.err), detail: { signature: t.signature } };
    const c = await ballast.account.class.fetch(pdas.class(canonical.config));
    const ok = c.dbcConfig.equals(canonical.config) && c.sizeTag === 0 && c.bidBinStep === 10 && c.predictedSOpen.toString() === "47755047807748143";
    return { status: ok ? "pass" : "fail", expected: "Class fields per §5", got: ok ? "ok" : JSON.stringify(c), detail: { signature: t.signature, cu: t.cu } };
  });
  await suite.case("create_class: same config twice is refused", async () => {
    const t = await createClass("canonical again", admin, canonical.config);
    return { status: t.err ? "pass" : "fail", expected: "refused (class exists)", got: t.err ? JSON.stringify(t.err) : "succeeded" };
  });

  // ---------------------------------------------------------------- create_class: structural
  await suite.case("create_class: signer is not the admin", async () => {
    const t = await createClass("not admin", intruder, canonical.config);
    const got = errorName(t.logs);
    return { status: got === "NotAdmin" ? "pass" : "fail", expected: "NotAdmin", got };
  });
  const fresh = await dbcConfig("canonical Proof #2", configParameters(PROOF));
  await suite.case("create_class: unknown size_tag", async () => {
    const t = await createClass("unknown size", admin, fresh.config, 7);
    const got = errorName(t.logs);
    return { status: got === "UnknownSizeTag" ? "pass" : "fail", expected: "UnknownSizeTag", got };
  });
  await suite.case("rule 1: dbc_config not owned by DBC", async () => {
    const t = await createClass("wrong owner", admin, fresh.config, 0, admin.publicKey);
    const got = errorName(t.logs);
    return { status: got === "ConfigWrongOwner" ? "pass" : "fail", expected: "ConfigWrongOwner", got };
  });
  await suite.case("rule 1: DBC-owned account that is not a PoolConfig", async () => {
    // A DBC PartnerMetadata account: DBC-owned, different discriminator.
    const fc = Keypair.generate();
    const [pm] = PublicKey.findProgramAddressSync([Buffer.from("partner_metadata"), fc.publicKey.toBuffer()], dbc.programId);
    const ix = await dbc.methods.createPartnerMetadata({ padding: new Array(96).fill(0), name: "x", website: "x", logo: "x" } as never).accountsPartial({ partnerMetadata: pm, payer: payer.publicKey, feeClaimer: fc.publicKey }).instruction();
    await send("DBC partner metadata (wrong-type account)", [ix], [fc]);
    const t = await createClass("wrong discriminator", admin, fresh.config, 0, pm);
    const got = errorName(t.logs);
    return { status: got === "ConfigWrongDiscriminator" ? "pass" : "fail", expected: "ConfigWrongDiscriminator", got };
  });

  // ---------------------------------------------------------------- create_class: one rule per field
  const s0 = sqrtPriceQ64(PROOF.p0);
  const sAt = (k: bigint) => sqrtPriceQ64(PROOF.p0, k);
  const T = PROOF.threshold;
  const { curve } = shapedCurve(PROOF.p0, T);
  const mutations: { name: string; expected: string; mutate?: (p: Params) => void; opts?: Parameters<typeof dbcConfig>[2] }[] = [
    { name: "rule 2: quote_mint is not WSOL", expected: "ConfigQuoteMint", opts: { quoteMint: otherMint } },
    { name: "rule 2: fee_claimer is not partner_auth", expected: "ConfigFeeClaimer", opts: { feeClaimer: () => intruder.publicKey } },
    { name: "rule 2: leftover_receiver is not partner_auth", expected: "ConfigLeftoverReceiver", opts: { leftover: () => intruder.publicKey } },
    { name: "rule 2: token_type Token-2022", expected: "ConfigTokenType", mutate: (p) => (p.tokenType = 1) },
    { name: "rule 2: token_decimal 9", expected: "ConfigTokenDecimal", mutate: (p) => (p.tokenDecimal = 9) },
    { name: "rule 2: supply not fixed", expected: "ConfigFixedSupplyFlag", mutate: (p) => ((p as { tokenSupply: unknown }).tokenSupply = null) },
    { name: "rule 2: pre_migration_token_supply 2·10^15", expected: "ConfigPreMigrationSupply", mutate: (p) => (p.tokenSupply = { preMigrationTokenSupply: bn(2n * 10n ** 15n), postMigrationTokenSupply: bn(2n * 10n ** 15n) }) },
    { name: "rule 2: token_update_authority not Immutable", expected: "ConfigTokenUpdateAuthority", mutate: (p) => (p.tokenUpdateAuthority = 0) },
    { name: "rule 2: collect_fee_mode OutputToken", expected: "ConfigCollectFeeMode", mutate: (p) => (p.collectFeeMode = 1) },
    {
      name: "rule 2: migration_fee_option FixedBps100", expected: "ConfigMigrationFeeOption",
      mutate: (p) => { p.migrationFeeOption = 2; p.migratedPoolFee = { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 }; },
    },
    { name: "rule 2: migrated collect fee mode 1 (§7's old value, D-010)", expected: "ConfigMigratedCollectFeeMode", mutate: (p) => (p.migratedPoolFee.collectFeeMode = 1) },
    { name: "rule 2: migrated dynamic fee on", expected: "ConfigMigratedDynamicFee", mutate: (p) => (p.migratedPoolFee.dynamicFee = 1) },
    { name: "rule 2: migrated pool fee 200 bps", expected: "ConfigMigratedPoolFeeBps", mutate: (p) => (p.migratedPoolFee.poolFeeBps = 200) },
    { name: "rule 2: migrated pool base fee mode exponential", expected: "ConfigMigratedBaseFeeMode", mutate: (p) => (p.migratedPoolBaseFeeMode = 1) },
    {
      name: "rule 2: compounding pool (masked: needs collect mode 2, rejected first)", expected: "ConfigMigratedCollectFeeMode",
      mutate: (p) => { p.migratedPoolFee.collectFeeMode = 2; p.compoundingFeeBps = 100; },
    },
    { name: "rule 2: creator_trading_fee_percentage 40", expected: "ConfigCreatorTradingFee", mutate: (p) => (p.creatorTradingFeePercentage = 40) },
    { name: "rule 2: migration_fee_percentage 10", expected: "ConfigMigrationFeePercentage", mutate: (p) => (p.migrationFee.feePercentage = 10) },
    { name: "rule 2: creator_migration_fee_percentage 10", expected: "ConfigCreatorMigrationFeePercentage", mutate: (p) => (p.migrationFee.creatorFeePercentage = 10) },
    {
      name: "rule 2: partner permanent LP 40 (creator 60)", expected: "ConfigPartnerPermanentLp",
      mutate: (p) => { p.partnerPermanentLockedLiquidityPercentage = 40; p.creatorPermanentLockedLiquidityPercentage = 60; },
    },
    {
      name: "rule 2: creator permanent LP 40 (+10 unlocked)", expected: "ConfigCreatorPermanentLp",
      mutate: (p) => { p.creatorPermanentLockedLiquidityPercentage = 40; p.creatorLiquidityPercentage = 10; },
    },
    {
      name: "rule 2: LP vesting on", expected: "ConfigLpVesting",
      mutate: (p) => (p.partnerLiquidityVestingInfo = { vestingPercentage: 10, bpsPerPeriod: 1000, numberOfPeriods: 10, cliffDurationFromMigrationTime: 0, frequency: 3600 }),
    },
    {
      name: "rule 2: token locked vesting on", expected: "ConfigLockedVesting",
      mutate: (p) => (p.lockedVesting = { amountPerPeriod: bn(1_000_000_000_000n), cliffDurationFromMigrationTime: bn(0), frequency: bn(3600), numberOfPeriod: bn(10), cliffUnlockAmount: bn(0) }),
    },
    { name: "rule 2: enable_first_swap_with_min_fee", expected: "ConfigFirstSwapMinFee", mutate: (p) => (p.enableFirstSwapWithMinFee = true) },
    { name: "rule 2: base fee 2%", expected: "ConfigBaseFee", mutate: (p) => (p.poolFees.baseFee.cliffFeeNumerator = bn(20_000_000)) },
    { name: "rule 2: dynamic fee on", expected: "ConfigDynamicFee", mutate: (p) => ((p.poolFees as { dynamicFee: unknown }).dynamicFee = getDynamicFeeParams(100)) },
    {
      name: "rule 2: threshold 11 SOL (curve rebuilt, same shape)", expected: "ConfigThreshold",
      mutate: (p) => { const c = shapedCurve(PROOF.p0, 11_000_000_000n); p.migrationQuoteThreshold = bn(11_000_000_000n); p.curve = curveParams(c.curve.map((x) => ({ s: x.sqrtPrice, l: x.liquidity }))); },
    },
    {
      name: "rule 2: sqrt_start_price from p0 = 3.2473e-9", expected: "ConfigStartPrice",
      mutate: (p) => { const c = shapedCurve("3.2473e-9", T); p.sqrtStartPrice = bn(c.sqrtStart); p.curve = curveParams(c.curve.map((x) => ({ s: x.sqrtPrice, l: x.liquidity }))); },
    },
    {
      name: "rule 4: two-point curve", expected: "ConfigCurvePointCount",
      mutate: (p) => { const s1 = sAt(5n), s2 = sAt(8n); p.curve = curveParams([{ s: s1, l: segL((T * 5n) / 100n, s0, s1) }, { s: s2, l: segL((T * 95n) / 100n, s1, s2) }]); },
    },
    {
      name: "rule 4: non-zero fourth point", expected: "ConfigCurveTailNotZero",
      mutate: (p) => { p.curve = [...curveParams(curve.map((x) => ({ s: x.sqrtPrice, l: x.liquidity }))), { sqrtPrice: bn(sAt(9n)), liquidity: bn(curve[2].liquidity) }]; },
    },
    {
      name: "rule 4: migration price far below the last point (segment 3 × 1.5)", expected: "ConfigMigrationPriceOutOfBand",
      mutate: (p) => { p.curve = curveParams(curve.map((x, i) => ({ s: x.sqrtPrice, l: i === 2 ? (x.liquidity * 3n) / 2n : x.liquidity }))); },
    },
    {
      name: "rule 3: curve off by one unit of liquidity (hash mismatch)", expected: "ConfigHashMismatch",
      mutate: (p) => { p.curve = curveParams(curve.map((x, i) => ({ s: x.sqrtPrice, l: i === 0 ? x.liquidity + 1n : x.liquidity }))); },
    },
  ];

  for (const m of mutations) {
    await suite.case(m.name, async () => {
      const params = configParameters(PROOF);
      m.mutate?.(params);
      const cfg = await dbcConfig(m.name, params, m.opts);
      if (cfg.landed.err) {
        return {
          status: "unreachable", expected: m.expected, got: `DBC rejects this config itself: ${errorName(cfg.landed.logs) ?? JSON.stringify(cfg.landed.err)}`,
          detail: { dbcSignature: cfg.landed.signature },
        };
      }
      const t = await createClass(m.name, admin, cfg.config);
      const got = t.err ? errorName(t.logs) ?? JSON.stringify(t.err) : "succeeded";
      return { status: got === m.expected ? "pass" : "fail", expected: m.expected, got, detail: { dbcSignature: cfg.landed.signature, signature: t.signature } };
    });
  }

  // Rules that no DBC-valid config can violate — recorded, not faked.
  for (const [name, why] of [
    ["rule 1: wrong size with a PoolConfig discriminator", "only DBC writes DBC-owned accounts; it never writes a PoolConfig of another size"],
    ["rule 1: PoolConfig.version", "DBC sets version itself; the deployed binary writes 0 (Q12)"],
    ["rule 2: quote_token_flag Token-2022", "needs a Token-2022 quote mint with a DBC token badge (admin-issued)"],
    ["rule 2: partner unlocked LP > 0", "DBC requires the four LP percentages to sum to 100, so a permanent field deviates first"],
    ["rule 2: creator unlocked LP > 0 alone", "same: the sum forces a permanent field to deviate first (covered by 'creator permanent LP 40')"],
    ["rule 4: curve not ascending", "DBC rejects a non-ascending curve at create_config"],
    ["rule 4: capacity below threshold", "DBC rejects a curve that cannot reach the threshold at create_config"],
    ["rule 4: LP percentages sum ≠ 100", "DBC enforces the sum at create_config"],
  ] as const) {
    await suite.case(name, async () => ({ status: "unreachable", expected: "-", got: why }));
  }

  void isqrt;
  return suite.finish("program/part1/results.json");
}
