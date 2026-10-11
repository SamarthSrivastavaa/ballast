/**
 * STEP 3 P0 harness — shared plumbing (D-001: the mainnet-binary local validator is authoritative).
 *
 * Every transaction goes through `send()`, which first runs ACCOUNT DISCOVERY: a Solana
 * transaction can only read the accounts it lists, so the full set of accounts a Meteora program
 * can read in a step is exactly that transaction's keys. Any key that is absent locally but exists
 * on mainnet is a mainnet account the program reads that has not been cloned yet. `send()` stops,
 * records it in evidence/p0/accounts/discovery.jsonl, and the account is added to
 * scripts/fixtures/manifest.json and pinned by `pnpm fixtures:dump` — found by execution, never
 * guessed. Mainnet is only ever READ here (getMultipleAccounts); nothing is signed for it (D-007).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export const REPO = resolve(__dirname, "../../../..");
export const EVIDENCE = resolve(REPO, "evidence/p0");
/**
 * `BALLAST_CLUSTER=devnet`: the §18 devnet proof (D-007: devnet is the public, secondary evidence;
 * D-001: the mainnet-binary local validator governs). An explicit opt-in — without it every signing
 * path stays loopback-only. Devnet uses its own payer key, pins devnet's genesis, never touches
 * mainnet, and funds wallets by transfer from the payer (devnet airdrops are rate-limited).
 */
export const CLUSTER: "localnet" | "devnet" | "mainnet" =
  process.env.BALLAST_CLUSTER === "devnet" ? "devnet" : process.env.BALLAST_CLUSTER === "mainnet" ? "mainnet" : "localnet";
/**
 * `BALLAST_CLUSTER=mainnet` signs and sends REAL transactions with REAL SOL. It exists for the
 * mainnet Proof launch only (submission/MAINNET.md) and refuses to load unless all of these hold:
 *   BALLAST_GO_MAINNET   exactly "GO MAINNET" — the owner's approval, typed by the owner (D-007)
 *   BALLAST_MAINNET_RPC  an RPC URL that accepts transactions
 *   BALLAST_MAINNET_PAYER  path to the funded keypair, outside this repository
 *   BALLAST_MAINNET_KEYS   path for the launch's wallets' keys, outside this repository
 * On mainnet every transaction is simulated first and is not sent if the simulation fails.
 */
if (CLUSTER === "mainnet") {
  if (process.env.BALLAST_GO_MAINNET !== "GO MAINNET") throw new Error('refusing mainnet: BALLAST_GO_MAINNET is not exactly "GO MAINNET"');
  for (const k of ["BALLAST_MAINNET_RPC", "BALLAST_MAINNET_PAYER", "BALLAST_MAINNET_KEYS"]) {
    if (!process.env[k]) throw new Error(`refusing mainnet: ${k} is not set`);
  }
  for (const k of ["BALLAST_MAINNET_PAYER", "BALLAST_MAINNET_KEYS"]) {
    if (resolve(process.env[k]!).startsWith(resolve(__dirname, "../../../.."))) throw new Error(`refusing mainnet: ${k} points inside the repository`);
  }
}
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const LOCAL_RPC =
  CLUSTER === "mainnet" ? process.env.BALLAST_MAINNET_RPC! : process.env.LOCALNET_RPC_URL ?? (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");
/** Priority fee in micro-lamports per compute unit (mainnet default 20,000; 0 elsewhere). */
export const CU_PRICE = Number(process.env.BALLAST_CU_PRICE ?? (CLUSTER === "mainnet" ? 20_000 : 0));
export const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const conn = new Connection(LOCAL_RPC, "confirmed");
export const mainnet = new Connection(MAINNET_RPC, "confirmed");

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolve(REPO, path), "utf8"))));
}
export const PAYER_KEY = CLUSTER === "mainnet" ? process.env.BALLAST_MAINNET_PAYER! : CLUSTER === "devnet" ? ".keys/devnet/payer.json" : ".keys/devnet/localnet.json";
export const payer = loadKeypair(PAYER_KEY);

/** This harness signs and sends: it may only ever talk to a loopback, non-mainnet validator (D-007). */
export async function assertLocal(): Promise<void> {
  if (CLUSTER === "mainnet") {
    const g = await conn.getGenesisHash();
    if (g !== MAINNET_GENESIS) throw new Error(`refusing: BALLAST_CLUSTER=mainnet but genesis is ${g}`);
    return;
  }
  if (CLUSTER === "devnet") {
    const g = await conn.getGenesisHash();
    if (g !== DEVNET_GENESIS) throw new Error(`refusing: BALLAST_CLUSTER=devnet but genesis is ${g}`);
    return;
  }
  const host = new URL(LOCAL_RPC).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error(`refusing non-loopback RPC ${host}`);
  const g = await conn.getGenesisHash();
  if (!g || g === MAINNET_GENESIS) throw new Error(`refusing: genesis ${g}`);
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

export function evidencePath(rel: string): string {
  const p = resolve(EVIDENCE, rel);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v instanceof PublicKey ? v.toBase58() : v;
export function writeEvidence(rel: string, data: unknown): void {
  writeFileSync(evidencePath(rel), JSON.stringify(data, replacer, 2) + "\n");
}
export function appendEvidence(rel: string, data: unknown): void {
  appendFileSync(evidencePath(rel), JSON.stringify(data, replacer) + "\n");
}

/** Raw account dump: base64 data + owner, so any decode can be re-done from evidence alone. */
export async function dumpAccount(address: PublicKey): Promise<Record<string, unknown> | null> {
  const r = await conn.getAccountInfoAndContext(address, "confirmed");
  if (!r.value) return null;
  return {
    address: address.toBase58(),
    slot: r.context.slot,
    owner: r.value.owner.toBase58(),
    lamports: r.value.lamports,
    executable: r.value.executable,
    dataLen: r.value.data.length,
    dataBase64: Buffer.from(r.value.data).toString("base64"),
  };
}

// ---------------------------------------------------------------------------------------------
// Account discovery (D-001)
// ---------------------------------------------------------------------------------------------

export class NeedsClone extends Error {
  constructor(
    public label: string,
    public accounts: { address: string; owner: string; dataLen: number }[],
  ) {
    super(
      `${label}: ${accounts.length} mainnet account(s) this transaction reads are not on the local validator:\n` +
        accounts.map((a) => `  ${a.address}  owner ${a.owner}  ${a.dataLen} B`).join("\n") +
        `\nAdd them to scripts/fixtures/manifest.json (discoveredBy: "${label}"), pnpm fixtures:dump, restart pnpm localnet.`,
    );
  }
}

async function getMany(c: Connection, keys: PublicKey[], slice: boolean) {
  const out: ({ owner: PublicKey; data: Buffer } | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const res = await c.getMultipleAccountsInfo(chunk, slice ? { dataSlice: { offset: 0, length: 0 } } : undefined);
    out.push(...res.map((r) => (r ? { owner: r.owner, data: Buffer.from(r.data) } : null)));
  }
  return out;
}

export async function discover(label: string, keys: PublicKey[]): Promise<void> {
  // The clone check names mainnet accounts to pin for the local validator; on devnet they already exist.
  if (CLUSTER !== "localnet") return;
  const uniq = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  const local = await getMany(conn, uniq, true);
  const missing = uniq.filter((_, i) => local[i] === null);
  // The public mainnet RPC drops connections under load. Retry with backoff; if it stays down, the
  // clone check (which only names accounts to pin) is skipped with a warning rather than failing a run.
  let onMainnet: ({ owner: PublicKey; data: Buffer } | null)[] = [];
  for (let attempt = 0; missing.length; attempt++) {
    try {
      onMainnet = await getMany(mainnet, missing, false);
      break;
    } catch (e) {
      if (attempt >= 5) {
        console.warn(`discover(${label}): mainnet RPC unreachable (${(e as Error).message}); clone check skipped`);
        onMainnet = missing.map(() => null);
        break;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const needs = missing
    .map((k, i) => ({ k, m: onMainnet[i] }))
    .filter((x) => x.m !== null)
    .map((x) => ({ address: x.k.toBase58(), owner: x.m!.owner.toBase58(), dataLen: x.m!.data.length }));
  appendEvidence("accounts/discovery.jsonl", {
    label,
    at: new Date().toISOString(),
    keys: uniq.length,
    presentLocally: uniq.length - missing.length,
    absentBoth: missing.length - needs.length,
    mainnetOnly: needs,
  });
  if (needs.length) throw new NeedsClone(label, needs);
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

export interface Landed {
  label: string;
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
  cu: number | null;
}

export interface SendOpts {
  cu?: number;
  alts?: AddressLookupTableAccount[];
  expectFail?: boolean;
  feePayer?: Keypair;
}

export async function send(
  label: string,
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
  opts: SendOpts = {},
): Promise<Landed> {
  const feePayer = opts.feePayer ?? payer;
  const all = [
    ...(opts.cu ? [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cu })] : []),
    ...(CU_PRICE > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE })] : []),
    ...ixs,
  ];
  const keys = [feePayer.publicKey, ...all.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)])];
  await discover(label, keys);

  const uniqSigners = [...new Map([feePayer, ...signers].map((s) => [s.publicKey.toBase58(), s])).values()];
  // Mainnet: never pay for a transaction that would fail. Simulate first; if it fails, report the
  // failure to a caller that handles failures, or stop.
  if (CLUSTER === "mainnet") {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const probe = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message(opts.alts ?? []));
    const sim = await conn.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      if (!opts.expectFail) throw new Error(`${label}: simulation failed, NOT SENT ${JSON.stringify(sim.value.err)}\n${logs.join("\n")}`);
      return { label, signature: "(not sent: simulation failed)", slot: sim.context.slot, err: sim.value.err, logs, cu: sim.value.unitsConsumed ?? null };
    }
  }
  let signature = "";
  // A transaction whose blockhash expired before it confirmed can no longer land, so resending it
  // with a fresh blockhash is safe; the local validator occasionally drops one under load.
  for (let attempt = 0; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: all })
      .compileToV0Message(opts.alts ?? []);
    const tx = new VersionedTransaction(msg);
    const needed = new Set(msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58()));
    // A transaction missing a signature is dropped at verification and only "expires" — name it now.
    const have = new Set(uniqSigners.map((s) => s.publicKey.toBase58()));
    const missing = [...needed].filter((k) => !have.has(k));
    if (missing.length) throw new Error(`${label}: missing signer(s) ${missing.join(", ")}`);
    tx.sign(uniqSigners.filter((s) => needed.has(s.publicKey.toBase58())));
    signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    try {
      await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      break;
    } catch (e) {
      // A public RPC's confirmation can reject for a transaction that did land (seen on devnet with
      // a failed create_class, as an error with no message): if the signature has a status, read it.
      if ((await conn.getSignatureStatus(signature)).value) break;
      const why = (e as Error)?.message ?? JSON.stringify(e);
      if (attempt >= 2 || !String(why).includes("block height exceeded")) {
        throw new Error(`${label}: ${why} ${signature}`);
      }
    }
  }
  // A confirmed signature can lag in getTransaction on a busy validator; look again before failing.
  let t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  for (let i = 0; i < 40 && !t?.meta; i++) {
    await new Promise((r) => setTimeout(r, 250));
    t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  }
  if (!t?.meta) throw new Error(`${label}: ${signature} not found after confirmation`);
  const landed: Landed = {
    label,
    signature,
    slot: t.slot,
    err: t.meta.err,
    logs: t.meta.logMessages ?? [],
    cu: t.meta.computeUnitsConsumed ?? null,
  };
  appendEvidence("txlog.jsonl", { ...landed, logs: undefined, logLines: landed.logs.length });
  if (landed.err && !opts.expectFail) {
    throw new Error(`${label} FAILED ${JSON.stringify(landed.err)} ${signature}\n${landed.logs.join("\n")}`);
  }
  return landed;
}

/** Simulate on the local validator (sigVerify off): used to search parameter boundaries cheaply. */
export async function simulate(
  ixs: TransactionInstruction[],
  feePayer: PublicKey = payer.publicKey,
  alts: AddressLookupTableAccount[] = [],
): Promise<{ err: unknown; logs: string[]; cu: number | null; customCode: number | null }> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  const code = JSON.stringify(r.value.err ?? null).match(/"Custom":(\d+)/)?.[1];
  return { err: r.value.err, logs: r.value.logs ?? [], cu: r.value.unitsConsumed ?? null, customCode: code ? Number(code) : null };
}

/** Send a legacy Transaction built by an SDK (its instructions are re-sent through `send`). */
export async function sendSdkTx(label: string, tx: Transaction, signers: Keypair[] = [], opts: SendOpts = {}) {
  const ixs = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  return send(label, ixs, signers, { cu: opts.cu ?? 1_400_000, ...opts });
}

export async function airdrop(to: PublicKey, sol: number): Promise<void> {
  if (CLUSTER !== "localnet") {
    // Devnet airdrops are rate-limited: wallets are funded from the payer instead.
    await send(`fund ${to.toBase58().slice(0, 8)} ${sol} SOL`, [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
    ]);
    return;
  }
  const sig = await conn.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL));
  await conn.confirmTransaction(sig, "confirmed");
}

export async function fundPda(pda: PublicKey, lamports: number): Promise<Landed> {
  return send(`fund ${pda.toBase58().slice(0, 8)}`, [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports }),
  ]);
}

export async function createAlt(label: string, addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
  const slot = await conn.getSlot("finalized");
  const [create, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  await send(`${label}: create ALT`, [create]);
  for (let i = 0; i < addresses.length; i += 25) {
    await send(`${label}: extend ALT`, [
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: alt,
        authority: payer.publicKey,
        payer: payer.publicKey,
        addresses: addresses.slice(i, i + 25),
      }),
    ]);
  }
  // A lookup table is usable from the slot after its last extension.
  const s0 = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) <= s0 + 1) await new Promise((r) => setTimeout(r, 200));
  const acct = (await conn.getAddressLookupTable(alt)).value;
  if (!acct) throw new Error("ALT not found");
  return acct;
}

export function cuOf(logs: string[], programId: string): number[] {
  return logs
    .map((l) => l.match(new RegExp(`^Program ${programId} consumed (\\d+) of`)))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
}
