/**
 * `settle_graduation`, `burn_leftover` (§6) and, before `open`, `pay_creator` (D-022) on the
 * mainnet-binary local validator.
 *
 *   Launch A, normal order: register → buy to the threshold → settle → migrate → burn.
 *   Launch B, keeper lag (§5): register → buy → migrate → settle → a third party front-runs DBC's
 *   permissionless `withdraw_leftover` → burn (burns what already sits in partner_auth's ATA).
 *   Launch C, front-run before a late settle: register → buy → migrate → front-run → settle → burn;
 *   settle must leave the leftover for `burn_leftover` to burn and record (D-016).
 *
 * Each negative case substitutes one account or makes one out-of-order call, and must fail with the
 * error that check owns. Positive cases reconcile every lamport and base unit (§10, §18 gate 4).
 */
import BN from "bn.js";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createInitializeAccount3Instruction, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { deriveDbcTokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, Landed, payer, send } from "../../p0/src/env";
import { configParameters, PROOF, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { dbc } from "../../p0/src/dbc";
import { buyPartialFill, migrate, virtualPool } from "../../p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceStrict, wallet } from "../../p0/src/wallets";
import { accounts, ballast, errorName, pdas } from "./client";
import { launch, Launch } from "./launch";
import { Suite } from "./runner";

/** DBC's constant pool authority and its `__event_authority` PDA (vendored IDL, Q4). */
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DBC_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], dbc.programId)[0];
const U64_MAX = new BN("18446744073709551615");
const THRESHOLD = 10_000_000_000n; // Proof class (§7)
const MIGRATION_FEE = (THRESHOLD * 15n) / 100n; // §7 migration_fee_percentage 15, creator share 0
const SUPPLY = 10n ** 15n;

type Accts = Record<string, PublicKey>;

export function graduationAccounts(classConfig: PublicKey, l: Launch, beneficiary: PublicKey): Accts {
  const base = l.baseMint.publicKey;
  const partner = pdas.partner(classConfig);
  return {
    launch: l.launch, class: pdas.class(classConfig), dbcConfig: classConfig, virtualPool: l.pool,
    baseVault: deriveDbcTokenVaultAddress(l.pool, base), quoteVault: deriveDbcTokenVaultAddress(l.pool, WSOL),
    baseMint: base, quoteMint: WSOL, partnerAuth: partner, creatorAuth: l.creatorAuth, vault: l.vault,
    stagingBase: ata(base, partner), beneficiaryQuote: ata(WSOL, beneficiary),
    dbcPoolAuthority: DBC_POOL_AUTHORITY, dbcEventAuthority: DBC_EVENT_AUTHORITY, dbcProgram: dbc.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

function burnAccounts(a: Accts): Accts {
  const { creatorAuth: _c, beneficiaryQuote: _b, ...rest } = a;
  return rest;
}

/**
 * The keeper's idempotent staging ATA creation, then the call. D-022: settlement no longer touches
 * the beneficiary, so the keeper creates nothing of the creator's (`a` still names the D-020
 * accounts, which the current IDL ignores, for the reproduction run).
 */
export async function settle(label: string, a: Accts, pre: TransactionInstruction[] = []): Promise<Landed> {
  const ix = await ballast.methods.settleGraduation().accountsPartial(a).instruction();
  return send(label, [...pre, ensureAtaIx(a.baseMint, a.partnerAuth), ix], [], { cu: 400_000, expectFail: true });
}

/**
 * D-022 `pay_creator`. `damm` holds the DAMM v2 accounts required once `Open` (null before);
 * `over` substitutes single accounts for the negative cases.
 */
export async function payCreatorIx(classConfig: PublicKey, l: Launch, beneficiary: PublicKey, damm: Record<string, PublicKey> | null, over: Record<string, PublicKey | null> = {}): Promise<TransactionInstruction> {
  const acc = graduationAccounts(classConfig, l, beneficiary);
  const none = {
    dammPool: null, partnerPosition: null, creatorPosition: null, creatorNftAccount: null, tokenAVault: null, tokenBVault: null,
    dammPoolAuthority: null, dammEventAuthority: null, dammProgram: null,
  };
  return ballast.methods.payCreator().accountsPartial({
    launch: l.launch, class: acc.class, creatorAuth: l.creatorAuth, partnerAuth: acc.partnerAuth, stagingBase: acc.stagingBase,
    beneficiaryQuote: acc.beneficiaryQuote, vault: l.vault, baseMint: acc.baseMint, quoteMint: WSOL, virtualPool: l.pool,
    baseVault: acc.baseVault, quoteVault: acc.quoteVault, dbcPoolAuthority: DBC_POOL_AUTHORITY, dbcEventAuthority: DBC_EVENT_AUTHORITY,
    dbcProgram: dbc.programId, tokenProgram: TOKEN_PROGRAM_ID, ...(damm ?? none), ...over,
  } as never).instruction();
}

export async function payCreator(label: string, ix: TransactionInstruction, opts: { alts?: AddressLookupTableAccount[] } = {}): Promise<Landed> {
  return send(label, [ix], [], { cu: 400_000, expectFail: true, alts: opts.alts });
}

export async function burn(label: string, a: Accts, pre: TransactionInstruction[] = []): Promise<Landed> {
  const ix = await ballast.methods.burnLeftover().accountsPartial(burnAccounts(a)).instruction();
  return send(label, [...pre, ensureAtaIx(a.baseMint, a.partnerAuth), ix], [], { cu: 400_000, expectFail: true });
}

export const got = (l: Landed) => (l.err ? errorName(l.logs) ?? JSON.stringify(l.err) : "succeeded");
export const ballastCu = (l: Landed) => {
  const m = l.logs.map((x) => x.match(/^Program HSSv\w+ consumed (\d+)/)).find(Boolean);
  return m ? Number(m[1]) : null;
};

async function ps(pool: PublicKey): Promise<Record<string, string>> {
  return (await virtualPool(pool)).poolState as Record<string, string>;
}

export async function dbcConfig(label: string): Promise<PublicKey> {
  const config = Keypair.generate();
  const partner = pdas.partner(config.publicKey);
  const ix = await dbc.methods
    .createConfig(configParameters(PROOF) as never)
    .accountsPartial({ config: config.publicKey, feeClaimer: partner, leftoverReceiver: partner, quoteMint: WSOL, payer: payer.publicKey })
    .instruction();
  await send(`${label}: DBC create_config`, [ix], [config]);
  return config.publicKey;
}

/** A token account of `mint` owned by `owner` that is NOT its ATA (a keypair account). */
async function nonAtaAccount(label: string, mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  const k = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(165);
  await send(label, [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: rent, space: 165, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(k.publicKey, mint, owner),
  ], [k]);
  return k.publicKey;
}

export async function part3(): Promise<number> {
  const suite = new Suite("Program Part 1 — settle_graduation, burn_leftover (§6)");
  const admin = wallet("program.admin");
  const creator = await funded("program.creator", 10);
  const stranger = await funded("program.stranger", 10);
  const buyerA = await funded("program.buyerA", 30);
  const buyerB = await funded("program.buyerB", 30);
  // The beneficiary's WSOL ATA exists up front (the creator's own business since D-022).
  await send("ensure payer/stranger/beneficiary WSOL ATAs", [ensureAtaIx(WSOL, payer.publicKey), ensureAtaIx(WSOL, stranger.publicKey), ensureAtaIx(WSOL, creator.publicKey)]);

  const classConfig = await dbcConfig("graduation suite class");
  await send("graduation suite: create_class", [
    await ballast.methods.createClass(0)
      .accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig })
      .instruction(),
  ], [admin]);
  const s0 = sqrtPriceQ64(PROOF.p0);
  const A = await launch("graduation launch A", classConfig, creator, s0);
  const B = await launch("graduation launch B", classConfig, creator, s0);
  const C = await launch("graduation launch C", classConfig, creator, s0);
  for (const l of [A, B, C]) if (l.landed.err) throw new Error(`launch failed: ${errorName(l.landed.logs)} ${l.landed.signature}`);
  const accA = graduationAccounts(classConfig, A, creator.publicKey);
  const accB = graduationAccounts(classConfig, B, creator.publicKey);
  const accC = graduationAccounts(classConfig, C, creator.publicKey);
  const baseA = A.baseMint.publicKey;

  // ---- settle_graduation: before completion ----------------------------------------------------
  await suite.case("settle_graduation: curve not complete", async () => {
    const r = await settle("settle A before completion", accA);
    return { status: got(r) === "CurveNotComplete" ? "pass" : "fail", expected: "CurveNotComplete", got: got(r), detail: { signature: r.signature } };
  });

  await buyPartialFill("launch A: buy to the threshold (swap2 PartialFill)", buyerA, A.pool, 12_000_000_000n);
  await buyPartialFill("launch B: buy to the threshold (swap2 PartialFill)", buyerB, B.pool, 12_000_000_000n);
  await buyPartialFill("launch C: buy to the threshold (swap2 PartialFill)", buyerB, C.pool, 12_000_000_000n);
  const beneficiaryNonAta = await nonAtaAccount("creator-owned non-ATA WSOL account", WSOL, creator.publicKey);

  // ---- settle_graduation: one substitution per case --------------------------------------------
  const strangerBase = ata(baseA, stranger.publicKey);
  const subs: { name: string; expected: string; over: Accts; pre?: TransactionInstruction[] }[] = [
    { name: "staging base account is not partner_auth's ATA", expected: "StagingNotPartnerAta", over: { stagingBase: strangerBase }, pre: [ensureAtaIx(baseA, stranger.publicKey)] },
    { name: "quote vault of another pool", expected: "PoolVaultMismatch", over: { quoteVault: accB.quoteVault } },
    { name: "base vault of another pool", expected: "PoolVaultMismatch", over: { baseVault: accB.baseVault } },
    { name: "substituted vault (another launch's)", expected: "ConstraintSeeds", over: { vault: B.vault } },
    { name: "virtual pool of another launch", expected: "ConstraintAddress", over: { virtualPool: B.pool } },
    { name: "DBC config that is not the class's", expected: "ConstraintAddress", over: { dbcConfig: await dbcConfig("foreign config") } },
    { name: "fake DBC program", expected: "ConstraintAddress", over: { dbcProgram: SystemProgram.programId } },
  ];
  for (const c of subs) {
    await suite.case(`settle_graduation: ${c.name}`, async () => {
      const r = await settle(`settle A: ${c.name}`, { ...accA, ...c.over }, c.pre);
      return { status: got(r) === c.expected ? "pass" : "fail", expected: c.expected, got: got(r), detail: { signature: r.signature } };
    });
  }

  await suite.case("burn_leftover: launch still Registered (settle first)", async () => {
    const r = await burn("burn B while Registered", accB);
    return { status: got(r) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: got(r), detail: { signature: r.signature } };
  });

  // ---- settle_graduation: positive (A, before migration) ---------------------------------------
  await suite.case("settle_graduation: launch A → Funded; 15% + partner fees → vault; creator fees stay in DBC (D-022)", async () => {
    const before = await ps(A.pool);
    const v0 = await tokenBalanceStrict(A.vault);
    const ben = ata(WSOL, creator.publicKey);
    const b0 = await tokenBalanceStrict(ben);
    const r = await settle("settle A", accA);
    if (r.err) return { status: "fail", expected: "ok", got: got(r), detail: { signature: r.signature, logs: r.logs.slice(-15) } };
    const after = await ps(A.pool);
    const v1 = await tokenBalanceStrict(A.vault);
    const b1 = await tokenBalanceStrict(ben);
    const rec = await accounts.launch.fetch(A.launch);
    const partnerFees = BigInt(before.partnerQuoteFee);
    const checks = {
      state: rec.state === 2,
      vaultDelta: v1 - v0 === MIGRATION_FEE + partnerFees,
      migrationFeeRecorded: BigInt(rec.migrationFee.toString()) === MIGRATION_FEE,
      partnerFeesRecorded: BigInt(rec.partnerFees.toString()) === partnerFees,
      partnerFeesNonZero: partnerFees > 0n,
      dbcPartnerFeeZero: after.partnerQuoteFee === "0",
      beneficiaryUntouched: b1 === b0 && rec.creatorForwarded.toString() === "0",
      creatorFeesStillClaimable: after.creatorQuoteFee === before.creatorQuoteFee && BigInt(after.creatorQuoteFee) > 0n,
      noBaseFees: before.partnerBaseFee === "0" && before.creatorBaseFee === "0",
      stagingEmpty: (await tokenBalanceStrict(accA.stagingBase)) === 0n,
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks),
      detail: {
        signature: r.signature, txCu: r.cu, settleCu: ballastCu(r), migrationFee: (v1 - v0 - partnerFees).toString(),
        partnerFees: partnerFees.toString(), creatorFeesLeftInDbc: after.creatorQuoteFee, quoteReserve: before.quoteReserve,
        migrationFeeWithdrawStatus: after.migrationFeeWithdrawStatus, checks,
      },
    };
  });

  await suite.case("settle_graduation: second call refused (double settlement)", async () => {
    const r = await settle("settle A again", accA);
    return { status: got(r) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: got(r), detail: { signature: r.signature } };
  });

  // ---- pay_creator before open (D-022): creator income only, one substitution per case ---------
  const payA = (over: Record<string, PublicKey | null> = {}) => payCreatorIx(classConfig, A, creator.publicKey, null, over);
  const paySubs: { name: string; expected: string; over: Record<string, PublicKey | null> }[] = [
    { name: "beneficiary WSOL account owned by someone else", expected: "BeneficiaryAccountInvalid", over: { beneficiaryQuote: ata(WSOL, stranger.publicKey) } },
    { name: "beneficiary's own WSOL account that is not its ATA (D-016)", expected: "BeneficiaryAccountInvalid", over: { beneficiaryQuote: beneficiaryNonAta } },
    { name: "beneficiary account = this launch's vault", expected: "BeneficiaryAccountInvalid", over: { beneficiaryQuote: A.vault } },
    { name: "creator_auth of another launch", expected: "ConstraintSeeds", over: { creatorAuth: B.creatorAuth } },
    { name: "virtual pool of another launch", expected: "ConstraintAddress", over: { virtualPool: B.pool } },
    { name: "quote vault of another pool", expected: "PoolVaultMismatch", over: { quoteVault: accB.quoteVault } },
    { name: "staging base account is not partner_auth's ATA", expected: "StagingNotPartnerAta", over: { stagingBase: strangerBase } },
    { name: "fake DBC program", expected: "ConstraintAddress", over: { dbcProgram: SystemProgram.programId } },
  ];
  for (const c of paySubs) {
    await suite.case(`pay_creator: ${c.name}`, async () => {
      const r = await payCreator(`pay_creator A: ${c.name}`, await payA(c.over));
      return { status: got(r) === c.expected ? "pass" : "fail", expected: c.expected, got: got(r), detail: { signature: r.signature } };
    });
  }
  await suite.case("pay_creator: before open → DBC creator fees → ATA(beneficiary, WSOL), exactly; CreatorPaid", async () => {
    const before = await ps(A.pool);
    const ben = ata(WSOL, creator.publicKey);
    const b0 = await tokenBalanceStrict(ben);
    const v0 = await tokenBalanceStrict(A.vault);
    const r = await payCreator("pay_creator A", await payA());
    if (r.err) return { status: "fail", expected: "ok", got: got(r), detail: { signature: r.signature, logs: r.logs.slice(-15) } };
    const after = await ps(A.pool);
    const rec = await accounts.launch.fetch(A.launch);
    const fees = BigInt(before.creatorQuoteFee);
    const paid = (await tokenBalanceStrict(ben)) - b0;
    const checks = {
      paidExactly: paid === fees && fees > 0n,
      dbcCreatorFeeZero: after.creatorQuoteFee === "0",
      recorded: BigInt(rec.creatorForwarded.toString()) === fees,
      vaultUntouched: (await tokenBalanceStrict(A.vault)) === v0,
      stagingEmpty: (await tokenBalanceStrict(accA.stagingBase)) === 0n,
      event: r.logs.some((l) => l.startsWith("Program data:")),
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { signature: r.signature, cu: ballastCu(r), fees: fees.toString(), checks } };
  });
  await suite.case("pay_creator: again with nothing accrued → succeeds, pays 0", async () => {
    const b0 = await tokenBalanceStrict(ata(WSOL, creator.publicKey));
    const r = await payCreator("pay_creator A again", await payA());
    const ok = !r.err && (await tokenBalanceStrict(ata(WSOL, creator.publicKey))) === b0;
    return { status: ok ? "pass" : "fail", expected: "succeeds, 0 paid", got: got(r), detail: { signature: r.signature } };
  });

  // ---- DBC itself refuses claims by anyone but the PDAs (§17 "claim by non-PDA") ----------------
  const dbcRefusal = async (name: string, ix: TransactionInstruction) => {
    await suite.case(`DBC: ${name} by a non-PDA signer is refused`, async () => {
      const r = await send(`DBC ${name} by stranger`, [ensureAtaIx(baseA, stranger.publicKey), ix], [stranger, payer], { expectFail: true, feePayer: stranger });
      return { status: r.err ? "pass" : "fail", expected: "refused by DBC", got: got(r), detail: { signature: r.signature } };
    });
  };
  const dbcPool = { config: classConfig, baseVault: accA.baseVault, quoteVault: accA.quoteVault, baseMint: baseA, quoteMint: WSOL };
  await dbcRefusal("claim_trading_fee", await dbc.methods.claimTradingFee(U64_MAX, U64_MAX).accountsPartial({
    ...dbcPool, pool: A.pool, tokenAAccount: strangerBase, tokenBAccount: ata(WSOL, stranger.publicKey),
    feeClaimer: stranger.publicKey, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction());
  await dbcRefusal("claim_creator_trading_fee", await dbc.methods.claimCreatorTradingFee(U64_MAX, U64_MAX).accountsPartial({
    pool: A.pool, tokenAAccount: strangerBase, tokenBAccount: ata(WSOL, stranger.publicKey), baseVault: accA.baseVault,
    quoteVault: accA.quoteVault, baseMint: baseA, quoteMint: WSOL, creator: stranger.publicKey,
    tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction());
  await dbcRefusal("withdraw_migration_fee (partner flag)", await dbc.methods.withdrawMigrationFee(0).accountsPartial({
    config: classConfig, virtualPool: A.pool, tokenQuoteAccount: ata(WSOL, stranger.publicKey), quoteVault: accA.quoteVault,
    quoteMint: WSOL, sender: stranger.publicKey, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  }).instruction());

  // ---- burn_leftover: before migration, then migrate A ----------------------------------------
  await suite.case("burn_leftover: before migration (CreatedPool not reached)", async () => {
    const r = await burn("burn A before migration", accA);
    return { status: got(r) === "PoolNotMigrated" ? "pass" : "fail", expected: "PoolNotMigrated", got: got(r), detail: { signature: r.signature, migrationProgress: (await ps(A.pool)).migrationProgress } };
  });
  const migA = await migrate("launch A: migrate to DAMM v2 (top-level keeper)", A.pool);

  await suite.case("burn_leftover: staging base account is not partner_auth's ATA", async () => {
    const other = await nonAtaAccount("partner_auth-owned non-ATA base account (A)", baseA, accA.partnerAuth);
    const r = await burn("burn A with non-ATA staging", { ...accA, stagingBase: other });
    return { status: got(r) === "StagingNotPartnerAta" ? "pass" : "fail", expected: "StagingNotPartnerAta", got: got(r), detail: { signature: r.signature } };
  });

  await suite.case("DBC: withdraw_leftover to a partner_auth-owned NON-ATA account is refused (leftover can only reach the ATA)", async () => {
    const other = await nonAtaAccount("partner_auth-owned non-ATA base account (DBC probe)", baseA, accA.partnerAuth);
    const ix = await dbc.methods.withdrawLeftover().accountsPartial({
      config: classConfig, virtualPool: A.pool, tokenBaseAccount: other, baseVault: accA.baseVault, baseMint: baseA,
      leftoverReceiver: accA.partnerAuth, tokenBaseProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    const r = await send("DBC withdraw_leftover → non-ATA partner_auth account (stranger)", [ix], [stranger], { expectFail: true, feePayer: stranger });
    return { status: r.err ? "pass" : "fail", expected: "refused by DBC", got: got(r), detail: { signature: r.signature, received: (await tokenBalanceStrict(other)).toString() } };
  });

  // ---- burn_leftover: positive (A, Ballast performs the withdrawal) ----------------------------
  await suite.case("burn_leftover: launch A → Cleaned; leftover withdrawn and burned, surplus → vault", async () => {
    const before = await ps(A.pool);
    const supply0 = (await getMint(conn, baseA, "confirmed")).supply;
    const bv0 = await tokenBalanceStrict(accA.baseVault);
    const v0 = await tokenBalanceStrict(A.vault);
    const r = await burn("burn A", accA);
    if (r.err) return { status: "fail", expected: "ok", got: got(r), detail: { signature: r.signature, logs: r.logs.slice(-15) } };
    const after = await ps(A.pool);
    const supply1 = (await getMint(conn, baseA, "confirmed")).supply;
    const bv1 = await tokenBalanceStrict(accA.baseVault);
    const v1 = await tokenBalanceStrict(A.vault);
    const rec = await accounts.launch.fetch(A.launch);
    const burned = BigInt(rec.leftoverBurned.toString());
    const checks = {
      state: rec.state === 4,
      supplyFell: supply0 - supply1 === burned,
      burnedNonZero: burned > 0n,
      baseVaultDrainedByLeftover: bv0 - bv1 === burned,
      burnedCounter: BigInt(rec.burned.toString()) === burned,
      surplusRecorded: BigInt(rec.surplus.toString()) === v1 - v0,
      stagingEmpty: (await tokenBalanceStrict(accA.stagingBase)) === 0n,
      dbcLeftoverFlag: String(after.isWithdrawLeftover) === "1",
      dbcSurplusFlag: String(after.isPartnerWithdrawSurplus) === "1",
      vaultReconciles: v1 === MIGRATION_FEE + BigInt(rec.partnerFees.toString()) + BigInt(rec.surplus.toString()),
      tokenConservation: supply1 === SUPPLY - burned,
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks),
      detail: {
        signature: r.signature, txCu: r.cu, burnCu: ballastCu(r), migrateSignature: migA.landed.signature, leftover: burned.toString(),
        surplus: (v1 - v0).toString(), quoteReserve: before.quoteReserve, baseVaultBefore: bv0.toString(), baseVaultAfter: bv1.toString(),
        supplyBefore: supply0.toString(), supplyAfter: supply1.toString(), vault: v1.toString(), checks,
      },
    };
  });

  await suite.case("burn_leftover: second call refused", async () => {
    const r = await burn("burn A again", accA);
    return { status: got(r) === "LaunchWrongState" ? "pass" : "fail", expected: "LaunchWrongState", got: got(r), detail: { signature: r.signature } };
  });

  // ---- Launch B: keeper lag — migrate before settle, leftover front-run by a third party --------
  const migB = await migrate("launch B: migrate BEFORE settle (keeper lag)", B.pool);
  await suite.case("settle_graduation: after migration (keeper lag, §5) → Funded", async () => {
    const before = await ps(B.pool);
    const v0 = await tokenBalanceStrict(B.vault);
    const r = await settle("settle B after migration", accB);
    if (r.err) return { status: "fail", expected: "ok", got: got(r), detail: { signature: r.signature, logs: r.logs.slice(-15) } };
    const v1 = await tokenBalanceStrict(B.vault);
    const rec = await accounts.launch.fetch(B.launch);
    const ok = rec.state === 2 && v1 - v0 === MIGRATION_FEE + BigInt(before.partnerQuoteFee);
    return { status: ok ? "pass" : "fail", expected: "Funded, vault += 15% + partner fees", got: `state ${rec.state}, vault +${v1 - v0}`, detail: { signature: r.signature, migrateSignature: migB.landed.signature, migrationProgress: before.migrationProgress } };
  });

  await suite.case("burn_leftover: leftover front-run by a third party into partner_auth's ATA → still burned", async () => {
    const baseB = B.baseMint.publicKey;
    const ix = await dbc.methods.withdrawLeftover().accountsPartial({
      config: classConfig, virtualPool: B.pool, tokenBaseAccount: accB.stagingBase, baseVault: accB.baseVault, baseMint: baseB,
      leftoverReceiver: accB.partnerAuth, tokenBaseProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    const front = await send("DBC withdraw_leftover by a stranger → partner_auth ATA (front-run)", [ensureAtaIx(baseB, accB.partnerAuth), ix], [stranger, payer], { expectFail: true, feePayer: stranger });
    if (front.err) return { status: "fail", expected: "front-run lands", got: got(front), detail: { signature: front.signature } };
    const sitting = await tokenBalanceStrict(accB.stagingBase);
    const supply0 = (await getMint(conn, baseB, "confirmed")).supply;
    const r = await burn("burn B after front-run", accB);
    if (r.err) return { status: "fail", expected: "ok", got: got(r), detail: { signature: r.signature, logs: r.logs.slice(-15) } };
    const supply1 = (await getMint(conn, baseB, "confirmed")).supply;
    const rec = await accounts.launch.fetch(B.launch);
    const checks = {
      state: rec.state === 4,
      burnedWhatSat: BigInt(rec.leftoverBurned.toString()) === sitting && sitting > 0n,
      supplyFell: supply0 - supply1 === sitting,
      stagingEmpty: (await tokenBalanceStrict(accB.stagingBase)) === 0n,
      tokenConservation: supply1 === SUPPLY - sitting,
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { frontRun: front.signature, signature: r.signature, burnCu: ballastCu(r), leftover: sitting.toString(), checks } };
  });

  // ---- Launch C: migrate → front-run → late settle → burn (D-016) ------------------------------
  const migC = await migrate("launch C: migrate BEFORE settle (keeper lag)", C.pool);
  await suite.case("leftover front-run BEFORE a late settle: settle leaves it, burn_leftover burns and records it", async () => {
    const baseC = C.baseMint.publicKey;
    const ix = await dbc.methods.withdrawLeftover().accountsPartial({
      config: classConfig, virtualPool: C.pool, tokenBaseAccount: accC.stagingBase, baseVault: accC.baseVault, baseMint: baseC,
      leftoverReceiver: accC.partnerAuth, tokenBaseProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    const front = await send("DBC withdraw_leftover by a stranger → partner_auth ATA (before settle)", [ensureAtaIx(baseC, accC.partnerAuth), ix], [stranger, payer], { expectFail: true, feePayer: stranger });
    if (front.err) return { status: "fail", expected: "front-run lands", got: got(front), detail: { signature: front.signature } };
    const sitting = await tokenBalanceStrict(accC.stagingBase);
    const s = await settle("settle C after the front-run", accC);
    if (s.err) return { status: "fail", expected: "settle ok", got: got(s), detail: { signature: s.signature, logs: s.logs.slice(-15) } };
    const afterSettle = await accounts.launch.fetch(C.launch);
    const stagingAfterSettle = await tokenBalanceStrict(accC.stagingBase);
    const supply0 = (await getMint(conn, baseC, "confirmed")).supply;
    const b = await burn("burn C", accC);
    if (b.err) return { status: "fail", expected: "burn ok", got: got(b), detail: { signature: b.signature, logs: b.logs.slice(-15) } };
    const supply1 = (await getMint(conn, baseC, "confirmed")).supply;
    const rec = await accounts.launch.fetch(C.launch);
    const checks = {
      settleBurnedNothing: afterSettle.burned.toString() === "0",
      settleLeftLeftover: stagingAfterSettle === sitting && sitting > 0n,
      funded: afterSettle.state === 2,
      cleaned: rec.state === 4,
      leftoverRecorded: BigInt(rec.leftoverBurned.toString()) === sitting,
      burnedCounter: BigInt(rec.burned.toString()) === sitting,
      supplyFell: supply0 - supply1 === sitting,
      stagingEmpty: (await tokenBalanceStrict(accC.stagingBase)) === 0n,
      tokenConservation: supply1 === SUPPLY - sitting,
    };
    const ok = Object.values(checks).every(Boolean);
    return { status: ok ? "pass" : "fail", expected: "every check", got: ok ? "ok" : JSON.stringify(checks), detail: { migrate: migC.landed.signature, frontRun: front.signature, settle: s.signature, burn: b.signature, leftover: sitting.toString(), checks } };
  });

  await suite.case("pay_creator: CreatorBaseFee (creator base-token fee fails closed)", async () => ({
    status: "unreachable", expected: "-",
    got: "§7 rule 2 (ConfigCollectFeeMode) pins DBC collect_fee_mode = QuoteToken, so creator_base_fee cannot accrue on any class pool",
  }));

  return suite.finish("part1/graduation.json");
}
