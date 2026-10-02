/**
 * `pnpm fixtures:exec` — STEP 2 TEST 1: prove each pinned mainnet program EXECUTES on the
 * mainnet-binary local validator (`pnpm localnet`). "Loaded" is not enough.
 *
 * Every probe is a real transaction, landed (skipPreflight) so it has a signature and logs:
 *
 *  - `success` probes run a real instruction to completion:
 *      DBC `create_partner_metadata` (PDA init via system CPI + Anchor self-CPI event), and
 *      Token Metadata `CreateMetadataAccountV3` on a fresh SPL mint.
 *  - `dispatch` probes call a real instruction by its Anchor discriminator with no accounts.
 *    The program's own entrypoint and dispatcher run: an instruction that exists fails with
 *    Anchor 102 InstructionDidNotDeserialize (it takes args) or 3005 AccountNotEnoughKeys (it
 *    takes none); one that does not exist fails with 101 InstructionFallbackNotFound. All three
 *    prove execution; only 102/3005 prove the deployed binary contains that instruction (a LEAD
 *    for STEP 3, not a verification).
 *
 *  - `control` probes send a discriminator no program defines; each must fail with 101.
 *
 * Before any probe it refuses a non-loopback or mainnet RPC (D-007) and measures the bytes the
 * validator actually serves at each ID; they must equal the pins (D-001).
 *
 * Writes evidence/step-1a/exec/<program>.json and summary.json. Exits non-zero unless every
 * program executed and every success probe succeeded.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { MAINNET_GENESIS, REPO, fetchProgram, genesisHash, hostOf, loadManifest, loadPins } from "./lib";

const RPC = process.env.LOCALNET_RPC_URL ?? "http://127.0.0.1:8899";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OUT = resolve(REPO, "evidence/step-1a/exec");

type Kind = "success" | "dispatch" | "control";
interface ProbeResult {
  program: string;
  programId: string;
  instruction: string;
  kind: Kind;
  signature: string;
  slot: number;
  err: unknown;
  computeUnitsConsumed: number | null;
  /** True when the program's own code produced log output and consumed compute units. */
  executed: boolean;
  /** dispatch/control probes: true = 102/3005 (instruction present), false = 101 (absent). */
  instructionPresent: boolean | null;
  passed: boolean;
  logs: string[];
}

const anchorDisc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

async function land(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  extraSigners: Keypair[] = [],
): Promise<{ signature: string; slot: number; err: unknown; logs: string[]; cu: number | null }> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, ...extraSigners);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!t?.meta) throw new Error(`${signature}: transaction not found after confirmation`);
  return {
    signature,
    slot: t.slot,
    err: t.meta.err,
    logs: t.meta.logMessages ?? [],
    cu: t.meta.computeUnitsConsumed ?? null,
  };
}

/**
 * Did the program's own code run? It was invoked, consumed compute units, and either emitted a
 * log line or returned a `Custom(n)` error. Only program code can return `Custom(n)`: a program
 * that fails to load or verify surfaces as a runtime error (InvalidAccountData,
 * UnsupportedProgramId, ProgramFailedToComplete, …), never as a custom code. The custom-code arm
 * exists because DAMM v2's `swap` takes a pre-Anchor fast path that returns 3005 in 45 CU without
 * logging (observed 2 Oct 2026, evidence/step-1a/exec/damm_v2.json).
 */
function executedBy(programId: string, logs: string[], err: unknown): boolean {
  const invoked = logs.some((l) => l.startsWith(`Program ${programId} invoke [1]`));
  const consumed = logs.some((l) => {
    const m = l.match(new RegExp(`^Program ${programId} consumed (\\d+) of`));
    return m !== null && Number(m[1]) > 0;
  });
  const emitted = logs.some((l) => l.startsWith("Program log: ") || l.startsWith("Program data: "));
  const customCode = JSON.stringify(err ?? null).includes('"Custom"');
  return invoked && consumed && (emitted || customCode);
}

/**
 * solana-test-validator 2.1.21 cannot write a `None` upgrade authority: `--upgradeable-program … none`
 * becomes `Some(Pubkey::default())`, the all-zero key, which nobody can sign for (observed 2 Oct
 * 2026 for Token Metadata, finding T8). That single encoding is the only accepted difference; every
 * other authority must match the pin exactly, and the bytes always must.
 */
const ZERO_PUBKEY = "11111111111111111111111111111111";
function authorityMatches(live: string, pinned: string): boolean {
  return live === pinned || (pinned === "none" && live === ZERO_PUBKEY);
}

async function main(): Promise<void> {
  // This harness signs and sends. It may only ever talk to a local validator: loopback host, and
  // a genesis that is not mainnet-beta (D-007), so no environment variable can aim it at a cluster.
  if (!LOOPBACK.has(new URL(RPC).hostname)) throw new Error(`refusing non-loopback RPC ${hostOf(RPC)}`);
  const genesis = await genesisHash(RPC);
  if (genesis === MAINNET_GENESIS) throw new Error("refusing: RPC genesis is mainnet-beta");

  const conn = new Connection(RPC, "confirmed");
  const version = await conn.getVersion();
  const manifest = loadManifest();
  const pins = loadPins();
  const id = (name: string) => new PublicKey(pins.programs[name].id);

  // Precondition (D-001): the validator is running exactly the pinned mainnet bytes, with the
  // pinned upgrade authority, at each real ID. Measured here from the validator, never copied
  // from the pins file.
  const loaded: Record<string, { sha256: string; upgradeAuthority: string }> = {};
  for (const p of manifest.programs) {
    const pin = pins.programs[p.name];
    // Bytes are measured at the manifest ID and probes go to the pinned ID: they must be one ID.
    if (pin.id !== p.id) throw new Error(`${p.name}: pinned id ${pin.id} ≠ manifest id ${p.id}`);
    const { pin: live } = await fetchProgram(p.id, RPC, "confirmed");
    if (live.sha256 !== pin.sha256 || !authorityMatches(live.upgradeAuthority, pin.upgradeAuthority)) {
      throw new Error(
        `${p.name}: validator does not serve the pinned program — boot it with pnpm localnet\n` +
          `  served sha256    ${live.sha256}\n  pinned sha256    ${pin.sha256}\n` +
          `  served authority ${live.upgradeAuthority}\n  pinned authority ${pin.upgradeAuthority}`,
      );
    }
    const info = await conn.getAccountInfo(id(p.name));
    if (!info?.executable) throw new Error(`${p.name}: not executable at ${p.id}`);
    loaded[p.name] = { sha256: live.sha256, upgradeAuthority: live.upgradeAuthority };
    console.log(`loaded  ${p.name.padEnd(15)} sha256 ${live.sha256.slice(0, 16)}… = pin`);
  }

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(resolve(REPO, ".keys/devnet/localnet.json"), "utf8"))),
  );
  const airdrop = await conn.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(airdrop, "confirmed");

  const results: ProbeResult[] = [];
  const record = (
    program: string,
    instruction: string,
    kind: Kind,
    r: Awaited<ReturnType<typeof land>>,
  ): void => {
    const programId = pins.programs[program].id;
    const executed = executedBy(programId, r.logs, r.err);
    // Anchor decodes args before accounts, so a matched discriminator fails with 102 (args
    // missing) or 3005 (no-arg instruction, accounts missing). 101 means no handler matched.
    const code = JSON.stringify(r.err ?? null).match(/"Custom":(\d+)/)?.[1];
    const present = code === "3005" || code === "102" ? true : code === "101" ? false : null;
    const passed =
      kind === "success" ? executed && r.err === null : kind === "control" ? executed && present === false : executed;
    results.push({
      program,
      programId,
      instruction,
      kind,
      signature: r.signature,
      slot: r.slot,
      err: r.err,
      computeUnitsConsumed: r.cu,
      executed,
      instructionPresent: kind === "success" ? null : present,
      passed,
      logs: r.logs,
    });
    const tag = passed ? "PASS" : "FAIL";
    const extra = kind === "success" ? ` err=${JSON.stringify(r.err)}` : ` present=${present}`;
    console.log(`${tag} ${program.padEnd(15)} ${kind.padEnd(8)} ${instruction.padEnd(46)} cu=${r.cu}${extra}`);
  };

  // --- success: DBC create_partner_metadata ---------------------------------------------------
  {
    const dbc = id("dbc");
    const ixDef = DynamicBondingCurveIdl.instructions.find((i) => i.name === "create_partner_metadata");
    if (!ixDef) throw new Error("create_partner_metadata missing from DBC IDL");
    const disc = Buffer.from(ixDef.discriminator);
    if (!disc.equals(anchorDisc("create_partner_metadata"))) throw new Error("IDL discriminator ≠ sha256 rule");
    const feeClaimer = Keypair.generate();
    const [partnerMetadata] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_metadata"), feeClaimer.publicKey.toBuffer()],
      dbc,
    );
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], dbc);
    const data = Buffer.concat([
      disc,
      Buffer.alloc(96), // padding [u8; 96]
      borshString("Ballast toolchain probe"),
      borshString("https://example.invalid"),
      borshString("https://example.invalid/logo.png"),
    ]);
    const ix = new TransactionInstruction({
      programId: dbc,
      keys: [
        { pubkey: partnerMetadata, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: feeClaimer.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: dbc, isSigner: false, isWritable: false },
      ],
      data,
    });
    record("dbc", "create_partner_metadata", "success", await land(conn, payer, ix, [feeClaimer]));
  }

  // --- success: Token Metadata CreateMetadataAccountV3 ---------------------------------------
  {
    const tm = id("token_metadata");
    const mint = await createMint(conn, payer, payer.publicKey, null, 6);
    const [metadata] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), tm.toBuffer(), mint.toBuffer()],
      tm,
    );
    const data = Buffer.concat([
      Buffer.from([33]), // MetadataInstruction::CreateMetadataAccountV3
      borshString("Ballast probe"),
      borshString("BPROBE"),
      borshString("https://example.invalid/probe.json"),
      Buffer.from([0, 0]), // seller_fee_basis_points: u16 = 0
      Buffer.from([0]), // creators: None
      Buffer.from([0]), // collection: None
      Buffer.from([0]), // uses: None
      Buffer.from([1]), // is_mutable: true
      Buffer.from([0]), // collection_details: None
    ]);
    const ix = new TransactionInstruction({
      programId: tm,
      keys: [
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // mint authority
        { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // update authority
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    record("token_metadata", "CreateMetadataAccountV3", "success", await land(conn, payer, ix));
  }

  // --- dispatch probes: the instructions Ballast and STEP 3 depend on ------------------------
  const dispatch: Record<string, string[]> = {
    dbc: [
      "create_config",
      "initialize_virtual_pool_with_spl_token",
      "swap2",
      "migration_damm_v2",
      "withdraw_migration_fee",
      "claim_trading_fee",
      "partner_withdraw_surplus",
      "withdraw_leftover",
      "transfer_pool_creator",
    ],
    damm_v2: ["initialize_customizable_pool", "claim_position_fee", "split_position", "permanent_lock_position", "swap"],
    dlmm: [
      "place_limit_order",
      "cancel_limit_order",
      "close_limit_order_if_empty",
      "initialize_customizable_permissionless_lb_pair2",
      "swap2",
    ],
    jup_locker: ["create_vesting_escrow", "claim"],
  };
  for (const [program, names] of Object.entries(dispatch)) {
    for (const name of names) {
      const ix = new TransactionInstruction({ programId: id(program), keys: [], data: anchorDisc(name) });
      record(program, name, "dispatch", await land(conn, payer, ix));
    }
    // Negative control: a discriminator no program defines must come back 101 (absent), or the
    // "present" signal above would be unfalsifiable.
    const control = "ballast_no_such_instruction";
    const ix = new TransactionInstruction({ programId: id(program), keys: [], data: anchorDisc(control) });
    record(program, control, "control", await land(conn, payer, ix));
  }

  // --- verdict --------------------------------------------------------------------------------
  mkdirSync(OUT, { recursive: true });
  const perProgram = manifest.programs.map((p) => {
    const mine = results.filter((r) => r.program === p.name);
    writeFileSync(resolve(OUT, `${p.name}.json`), JSON.stringify(mine, null, 2) + "\n");
    return {
      program: p.name,
      programId: p.id,
      pinnedSha256: pins.programs[p.name].sha256,
      loadedSha256: loaded[p.name].sha256,
      executes: mine.some((r) => r.executed),
      probesPassed: mine.filter((r) => r.passed).length,
      probes: mine.length,
    };
  });
  const allPassed = results.every((r) => r.passed) && perProgram.every((p) => p.executes);
  const summary = {
    test: "STEP 2 TEST 1 — mainnet Meteora binaries execute on solana-test-validator",
    validator: version,
    validatorGenesis: genesis,
    rpcHost: hostOf(RPC),
    ranAt: new Date().toISOString(),
    verdict: allPassed ? "PASS" : "FAIL",
    programs: perProgram,
  };
  writeFileSync(resolve(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nvalidator ${JSON.stringify(version)}\nTEST 1 ${summary.verdict}`);
  if (!allPassed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
