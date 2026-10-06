/**
 * `register_launch` (§6, D-011) on the mainnet-binary local validator. Runs after part1 on the same
 * ledger (Global exists). One positive atomic launch, then one launch transaction per defect, each
 * required to fail with the specific error that check owns.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { conn, payer, send } from "../../p0/src/env";
import { configParameters, PROOF, sqrtPriceQ64, WSOL } from "../../../../compiler/src/canon";
import { dbc } from "../../p0/src/dbc";
import { funded, wallet, wrapIxs } from "../../p0/src/wallets";
import { accounts, ballast, errorName, pdas } from "./client";
import { CLASS_DUST, launch, LaunchOpts } from "./launch";
import { Suite } from "./runner";

async function dbcConfig(label: string): Promise<PublicKey> {
  const config = Keypair.generate();
  const partner = pdas.partner(config.publicKey);
  const ix = await dbc.methods
    .createConfig(configParameters(PROOF) as never)
    .accountsPartial({ config: config.publicKey, feeClaimer: partner, leftoverReceiver: partner, quoteMint: WSOL, payer: payer.publicKey })
    .instruction();
  await send(`${label}: DBC create_config`, [ix], [config]);
  return config.publicKey;
}

export async function part2(): Promise<number> {
  const suite = new Suite("Program Part 1 — register_launch (D-011)");
  const admin = wallet("program.admin");
  const creator = await funded("program.creator", 10);
  const stranger = await funded("program.stranger", 10);
  // The payer and the stranger fund their dust buys from WSOL wrapped in advance (not part of the launch).
  await send("payer WSOL for dust buys", wrapIxs(payer, 100_000_000n), []);
  await send("stranger WSOL", wrapIxs(stranger, 100_000_000n), [stranger]);

  const classConfig = await dbcConfig("register suite class");
  const classIx = await ballast.methods.createClass(0)
    .accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig })
    .instruction();
  await send("register suite: create_class", [classIx], [admin]);
  const foreignConfig = await dbcConfig("foreign config (no class)");
  const s0 = sqrtPriceQ64(PROOF.p0);

  // ---- positive -------------------------------------------------------------------------------
  await suite.case("register_launch: the D-011 atomic launch transaction → Registered", async () => {
    const l = await launch("positive launch", classConfig, creator, s0);
    if (l.landed.err) return { status: "fail", expected: "ok", got: errorName(l.landed.logs) ?? JSON.stringify(l.landed.err), detail: { signature: l.landed.signature, logs: l.landed.logs.slice(-12) } };
    const rec = await accounts.launch.fetch(l.launch);
    const vault = await getAccount(conn, l.vault, "confirmed");
    const cls = await accounts.class.fetch(pdas.class(classConfig));
    const checks = {
      state: rec.state === 1,
      predicted: rec.predictedS.toString() === "47755047807748143",
      pool: rec.dbcPool.equals(l.pool),
      mint: rec.baseMint.equals(l.baseMint.publicKey),
      pair: rec.dlmmPair.equals(l.lbPair),
      beneficiary: rec.creatorBeneficiary.equals(creator.publicKey),
      vaultIsWsol: vault.mint.equals(WSOL),
      vaultOwnedByPartnerAuth: vault.owner.equals(pdas.partner(classConfig)),
      vaultEmpty: vault.amount === 0n,
      classLaunches: cls.launches === 1,
    };
    const ok = Object.values(checks).every(Boolean);
    const cu = l.landed.logs.map((x) => x.match(/^Program HSSv\w+ consumed (\d+)/)).find(Boolean);
    return {
      status: ok ? "pass" : "fail", expected: "all fields per §5", got: ok ? "ok" : JSON.stringify(checks),
      detail: { signature: l.landed.signature, txCu: l.landed.cu, registerLaunchCu: cu ? Number(cu[1]) : null, txBytes: l.txBytes, launch: l.launch.toBase58(), vault: l.vault.toBase58(), checks },
    };
  });

  // ---- one defect per transaction --------------------------------------------------------------
  const cases: { name: string; expected: string; opts: () => LaunchOpts | Promise<LaunchOpts> }[] = [
    { name: "pair bin step 25 (class is 10)", expected: "LaunchPairWrongBinStep", opts: () => ({ pair: { binStep: 25, baseFactor: 400 } }) },
    { name: "pair collects fees in both tokens", expected: "LaunchPairWrongFeeMode", opts: () => ({ pair: { collectFeeMode: 0 } }) },
    { name: "pair base fee 5 bps", expected: "LaunchPairWrongBaseFee", opts: () => ({ pair: { baseFactor: 5_000 } }) },
    { name: "pair creator keeps on/off control", expected: "LaunchPairCreatorControl", opts: () => ({ pair: { onOff: true } }) },
    { name: "no DLMM pair", expected: "LaunchPairWrongOwner", opts: () => ({ pair: { omit: true } }) },
    { name: "dust buy just over the limit (1,010,000 > 1,000,000; reserve stays ≤ limit)", expected: "LaunchDustBuyTooLarge", opts: () => ({ dust: 1_010_000n }) },
    { name: "first buy 2× the dust limit (reserve > limit)", expected: "LaunchPoolAlreadyTraded", opts: () => ({ dust: 2n * CLASS_DUST }) },
    { name: "two swaps before register", expected: "LaunchTooManySwaps", opts: () => ({ dust: 400_000n, extraSwap: 400_000n }) },
    { name: "the first buy is by someone other than the payer", expected: "LaunchSwapNotByPayer", opts: () => ({ swapper: stranger }) },
    { name: "no creator transfer", expected: "LaunchCreatorNotTransferred", opts: () => ({ transferTo: null }) },
    { name: "creator transferred to someone else", expected: "LaunchCreatorNotTransferred", opts: () => ({ transferTo: stranger.publicKey }) },
    { name: "register signed by a different 'creator'", expected: "LaunchCreatorMismatch", opts: () => ({ registerCreator: stranger }) },
    { name: "pool from a DBC config with no Ballast class", expected: "LaunchWrongConfig", opts: () => ({ poolConfig: foreignConfig }) },
    { name: "an unexpected DBC instruction before register", expected: "LaunchUnexpectedDbcInstruction", opts: () => ({ extraDbcIx: true }) },
    { name: "pool created in an EARLIER transaction (third-party trade window)", expected: "LaunchPoolNotCreatedInTx", opts: () => ({ poolInEarlierTx: true }) },
    { name: "creator_beneficiary = partner_auth (D-016)", expected: "BeneficiaryIsBallastPda", opts: () => ({ beneficiary: (p) => p.partnerAuth }) },
    { name: "creator_beneficiary = creator_auth (D-016)", expected: "BeneficiaryIsBallastPda", opts: () => ({ beneficiary: (p) => p.creatorAuth }) },
    { name: "creator_beneficiary = the launch's vault (D-016)", expected: "BeneficiaryIsBallastPda", opts: () => ({ beneficiary: (p) => p.vault }) },
  ];
  for (const c of cases) {
    await suite.case(`register_launch: ${c.name}`, async () => {
      const l = await launch(c.name, classConfig, creator, s0, await c.opts());
      const got = l.landed.err ? errorName(l.landed.logs) ?? JSON.stringify(l.landed.err) : "succeeded";
      return { status: got === c.expected ? "pass" : "fail", expected: c.expected, got, detail: { signature: l.landed.signature } };
    });
  }

  await suite.case("register_launch: LaunchPairNotCreatedInTx", async () => ({
    status: "unreachable", expected: "-",
    got: "the pair is keyed by the base mint, which only exists from this transaction's own pool creation; a pair cannot pre-exist, so the state check fires first (covered by 'no DLMM pair')",
  }));

  return suite.finish("part1/register_launch.json");
}
