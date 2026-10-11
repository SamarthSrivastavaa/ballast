/**
 * The demo runbook: one launch, step by step, every step a real transaction on the local validator
 * running Meteora's mainnet DBC, DAMM v2 and DLMM binaries. Each step prints a summary made to be
 * filmed and saves its signatures under evidence/demo/<id>/.
 *
 *   pnpm demo:reset      fresh wallets, a fresh DBC config and class
 *   pnpm demo:launch     the launch transaction; F is recorded before any third-party trade
 *   pnpm demo:buy        three wallets buy to graduation
 *   pnpm demo:graduate   15% migration fee to the vault; migration to DAMM v2; leftover burned
 *   pnpm demo:floor      the vault rests as one DLMM limit order at F's bin
 *   pnpm demo:dump       every holder token sold, each chunk to the better venue; dump.csv
 *   pnpm demo:verify     `ballast verify` in a fresh process
 *   pnpm demo:chart      the animated chart page, from dump.csv
 *   pnpm demo:all        all of the above in order
 *
 * Needs: `pnpm localnet --quiet &`, `bash tests/integration/p0/up.sh`, `anchor build`,
 * `cargo build --release -p ballast-verifier`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { assertLocal, conn, LOCAL_RPC, payer, PAYER_KEY, REPO, send } from "../tests/integration/p0/src/env";
import { PROOF, sqrtPriceQ64, WSOL } from "../compiler/src/canon";
import { buyPartialFill, MIGRATION_DAMM_CONFIG, migrate, rawData, virtualPool } from "../tests/integration/p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceOrZero, tokenBalanceStrict, wallet } from "../tests/integration/p0/src/wallets";
import { accounts, ballast, pdas } from "../tests/integration/program/src/client";
import { launch, type Launch } from "../tests/integration/program/src/launch";
import {
  bestRoute, dammSell, keeperRefresh, liveInputs, nftAccountOf, OPT, positionOf, sellIntoBid, openAtFloor, waitSlots, type Opened,
} from "../tests/integration/program/src/fixture";
import { burn, dbcConfig, got, graduationAccounts, settle } from "../tests/integration/program/src/part3";

// ---- display ------------------------------------------------------------------------------------
const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", r: "\x1b[31m", x: "\x1b[0m" };
const F = (s: bigint) => (Number(s) / 2 ** 64) ** 2 * 1e-3; // SOL per token, display only
const sci = (x: number) => x.toExponential(4);
const sol = (lamports: bigint | number) => (Number(lamports) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
const tok = (base: bigint) => (Number(base) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC)}`;
const ad = (a: PublicKey | string) => `https://explorer.solana.com/address/${a.toString()}?cluster=custom&customUrl=${encodeURIComponent(LOCAL_RPC)}`;

function banner(step: string, title: string): void {
  console.log(`\n${C.b}${C.c}━━ ${step.toUpperCase()} ━━${C.x}  ${C.b}${title}${C.x}\n`);
}
function rows(list: [string, string][]): void {
  const w = Math.max(...list.map(([k]) => k.length));
  for (const [k, v] of list) console.log(`  ${C.dim}${k.padEnd(w)}${C.x}   ${v}`);
}
const ok = (msg: string) => console.log(`  ${C.g}✓${C.x} ${msg}`);
function big(lines: string[]): void {
  const w = Math.max(...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length));
  console.log(`\n  ${C.g}┏${"━".repeat(w + 2)}┓${C.x}`);
  for (const l of lines) console.log(`  ${C.g}┃${C.x} ${l}${" ".repeat(w - l.replace(/\x1b\[[0-9;]*m/g, "").length)} ${C.g}┃${C.x}`);
  console.log(`  ${C.g}┗${"━".repeat(w + 2)}┛${C.x}\n`);
}

// ---- state between steps (local test keys only; the directory is gitignored) -----------------------
const STATE_DIR = resolve(REPO, "demo/.state");
const STATE = resolve(STATE_DIR, "state.json");
type Json = unknown;
function enc(v: unknown): Json {
  if (v instanceof Keypair) return { $kp: Array.from(v.secretKey) };
  if (v instanceof PublicKey) return { $pk: v.toBase58() };
  if (typeof v === "bigint") return { $bi: v.toString() };
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}
function dec(v: Json): unknown {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") {
    const o = v as Record<string, Json>;
    if ("$kp" in o) return Keypair.fromSecretKey(Uint8Array.from(o.$kp as number[]));
    if ("$pk" in o) return new PublicKey(o.$pk as string);
    if ("$bi" in o) return BigInt(o.$bi as string);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, dec(x)]));
  }
  return v;
}
interface Sell { n: number; wallet: number; venue: string; base: bigint; quoted: bigint; signature: string; slot: number }
interface State {
  id: string; classConfig: PublicKey; l?: Launch; P?: Opened; alt?: PublicKey; predictedS?: bigint; sOpen?: bigint;
  circulating?: bigint; sells?: Sell[]; steps: { step: string; label: string; signature: string }[];
}
const load = (): State => {
  if (!existsSync(STATE)) throw new Error("no demo in progress — run `pnpm demo:reset` first");
  return dec(JSON.parse(readFileSync(STATE, "utf8"))) as State;
};
const out = (s: State) => {
  const d = resolve(REPO, "evidence/demo", s.id);
  mkdirSync(d, { recursive: true });
  return d;
};
function save(s: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(enc(s)));
  writeFileSync(resolve(out(s), "signatures.json"), JSON.stringify(s.steps, null, 2) + "\n");
}
const note = (s: State, step: string, label: string, signature: string) => s.steps.push({ step, label, signature });
const buyers = (s: State) => [1, 2, 3].map((i) => wallet(`demo.${s.id}.buyer${i}`));
const creatorOf = (s: State) => wallet(`demo.${s.id}.creator`);
/** The curve's final price (the class's last curve point), SOL per token: what graduation buyers pay. */
const graduationPrice = (): number => {
  const cls = JSON.parse(readFileSync(resolve(REPO, "compiler/out/classes.json"), "utf8")).classes[0];
  return F(BigInt(cls.curve[cls.curve.length - 1].sqrtPrice));
};

// ---- steps --------------------------------------------------------------------------------------
async function reset(): Promise<void> {
  await assertLocal();
  banner("reset", "A fresh DBC config, a fresh class, funded wallets");
  if (!(await conn.getAccountInfo(ballast.programId))?.executable) {
    execFileSync("solana", ["program", "deploy", "-u", LOCAL_RPC, "-k", resolve(REPO, PAYER_KEY), "--program-id",
      resolve(REPO, "target/deploy/ballast-keypair.json"), resolve(REPO, "target/deploy/ballast.so")], { stdio: ["ignore", "inherit", "inherit"] });
  }
  const now = new Date();
  const id = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const s: State = { id, classConfig: PublicKey.default, steps: [] };
  const admin = await funded("program.admin", 1);
  if (!(await conn.getAccountInfo(pdas.global()))) {
    await send("payer WSOL ATA (treasury)", [ensureAtaIx(WSOL, payer.publicKey)]);
    const ix = await ballast.methods.initializeGlobal(admin.publicKey)
      .accountsPartial({ global: pdas.global(), deployer: payer.publicKey, programData: pdas.programData(), treasury: ata(WSOL, payer.publicKey), systemProgram: SystemProgram.programId } as never)
      .instruction();
    note(s, "reset", "initialize_global", (await send("initialize_global", [ix])).signature);
  }
  s.classConfig = await dbcConfig("demo class");
  const cc = await send("create_class(Proof)", [
    await ballast.methods.createClass(0).accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(s.classConfig), dbcConfig: s.classConfig }).instruction(),
  ], [admin]);
  note(s, "reset", "create_class", cc.signature);
  const partnerAuth = pdas.partner(s.classConfig);
  await send("keeper float for partner_auth", [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: partnerAuth, lamports: 200_000_000 }),
    ensureAtaIx(WSOL, partnerAuth),
  ]);
  await funded(`demo.${id}.creator`, 5);
  for (const i of [1, 2, 3]) await funded(`demo.${id}.buyer${i}`, 12);
  save(s);
  rows([
    ["Demo id", id],
    ["Cluster", "local validator, Meteora mainnet binaries"],
    ["Ballast program", ballast.programId.toBase58()],
    ["DBC config", s.classConfig.toBase58()],
    ["Class (10 SOL)", pdas.class(s.classConfig).toBase58()],
    ["Wallets", "1 creator, 3 buyers, funded"],
  ]);
  ok(`create_class checked the config field by field on-chain  ${C.dim}${cc.signature.slice(0, 20)}…${C.x}`);
}

async function doLaunch(): Promise<void> {
  const s = load();
  banner("launch", "One transaction. The floor is recorded before any third-party trade");
  const creator = creatorOf(s);
  await send("beneficiary WSOL ATA", [ensureAtaIx(WSOL, creator.publicKey)]);
  const l = await launch("demo launch", s.classConfig, creator, sqrtPriceQ64(PROOF.p0));
  if (l.landed.err) throw new Error(`launch failed: ${got(l.landed)}`);
  s.l = l;
  const rec = await accounts.launch.fetch(l.launch);
  s.predictedS = BigInt(rec.predictedS.toString());
  note(s, "launch", "launch: DBC pool + dust buy + DLMM pair + transfer_pool_creator + register_launch", l.landed.signature);
  const [pF, pG] = [F(s.predictedS), graduationPrice()];
  const prediction = {
    cluster: "local validator (Meteora mainnet binaries)", mint: l.baseMint.publicKey.toBase58(), launch: l.launch.toBase58(),
    dbcPool: l.pool.toBase58(), dlmmPair: l.lbPair.toBase58(), predictedS: s.predictedS.toString(), predictedFSolPerToken: pF,
    recordedAtSlot: Number(rec.registeredSlot.toString()), signature: l.landed.signature,
    graduationPriceSolPerToken: pG, floorOverGraduationPrice: pF / pG, worstCaseFromGraduationPct: (1 - pF / pG) * 100,
  };
  writeFileSync(resolve(out(s), "prediction.json"), JSON.stringify(prediction, null, 2) + "\n");
  save(s);
  rows([
    ["Token mint", l.baseMint.publicKey.toBase58()],
    ["Launch account", l.launch.toBase58()],
    ["DBC pool", l.pool.toBase58()],
    ["DLMM pair", l.lbPair.toBase58()],
    ["Transaction", tx(l.landed.signature)],
  ]);
  big([
    `${C.b}PREDICTED FLOOR  F = ${sci(pF)} SOL/token${C.x}`,
    `recorded on-chain at slot ${prediction.recordedAtSlot}, in the pool-creation transaction`,
    `curve's final price ${sci(pG)}  →  worst case from there: ${C.y}−${prediction.worstCaseFromGraduationPct.toFixed(1)}%${C.x} (a lower bound on F)`,
  ]);
}

async function buy(): Promise<void> {
  const s = load();
  if (!s.l) throw new Error("run demo:launch first");
  banner("buy", "Three wallets buy on Meteora's Dynamic Bonding Curve until it graduates");
  const amounts = [3_500_000_000n, 3_500_000_000n, 8_000_000_000n];
  for (const [i, w] of buyers(s).entries()) {
    const before = BigInt(await conn.getBalance(w.publicKey));
    const t = await buyPartialFill(`demo buy ${i + 1}`, w, s.l.pool, amounts[i]);
    if (t.err) throw new Error(`buy ${i + 1}: ${got(t)}`);
    note(s, "buy", `buy ${i + 1}`, t.signature);
    const spent = before - BigInt(await conn.getBalance(w.publicKey));
    const got_ = await tokenBalanceStrict(ata(s.l.baseMint.publicKey, w.publicKey));
    const reserve = BigInt(String(((await virtualPool(s.l.pool)).poolState as Record<string, string>).quoteReserve));
    const pct = Math.min(100, Number((reserve * 10_000n) / PROOF.threshold) / 100);
    console.log(`  ${C.g}✓${C.x} buyer ${i + 1}  paid ${sol(spent).padStart(12)} SOL   holds ${tok(got_).padStart(12)} tokens   curve ${pct.toFixed(1).padStart(5)}% ${"█".repeat(Math.round(pct / 4))}${C.dim}${"░".repeat(25 - Math.round(pct / 4))}${C.x}`);
  }
  save(s);
  big([`${C.b}GRADUATED${C.x}  the curve holds its 10 SOL threshold`]);
}

async function graduate(): Promise<void> {
  const s = load();
  if (!s.l) throw new Error("run demo:launch first");
  banner("graduate", "15% to the vault. 85% into DAMM v2, locked for good");
  const l = s.l;
  const creator = creatorOf(s);
  const acc = graduationAccounts(s.classConfig, l, creator.publicKey);
  const st = await settle("demo settle", acc);
  if (st.err) throw new Error(`settle: ${got(st)}`);
  note(s, "graduate", "settle_graduation", st.signature);
  const mig = await migrate("demo migrate", l.pool);
  note(s, "graduate", "migration_damm_v2", mig.landed.signature);
  const bu = await burn("demo burn_leftover", acc);
  if (bu.err) throw new Error(`burn_leftover: ${got(bu)}`);
  note(s, "graduate", "burn_leftover", bu.signature);
  const base = l.baseMint.publicKey;
  const partnerAuth = pdas.partner(s.classConfig);
  const nfts = [mig.firstNft, mig.secondNft];
  const holders = await Promise.all(nfts.map(async (m) => new PublicKey((await rawData(nftAccountOf(m))).subarray(32, 64))));
  const pi = holders.findIndex((h) => h.equals(partnerAuth));
  const ci = holders.findIndex((h) => h.equals(l.creatorAuth));
  if (pi < 0 || ci < 0) throw new Error("the migrated position NFTs are not held by the Ballast PDAs");
  const pair = await DLMM.create(conn, l.lbPair, OPT);
  s.P = {
    classConfig: s.classConfig, l, base, partnerAuth, staging: ata(base, partnerAuth), stagingQuote: ata(WSOL, partnerAuth), creator,
    dammPool: deriveDammV2PoolAddress(MIGRATION_DAMM_CONFIG, base, WSOL),
    partnerPosition: positionOf(nfts[pi]), creatorPosition: positionOf(nfts[ci]),
    partnerNft: nftAccountOf(nfts[pi]), creatorNft: nftAccountOf(nfts[ci]),
    reserveX: pair.lbPair.reserveX, reserveY: pair.lbPair.reserveY,
  };
  save(s);
  const rec = await accounts.launch.fetch(l.launch);
  const live = await liveInputs(s.P);
  rows([
    ["Migration fee → vault", `${sol(BigInt(rec.migrationFee.toString()))} SOL  (15% of the raise)`],
    ["Partner fees → vault", `${sol(BigInt(rec.partnerFees.toString()))} SOL`],
    ["Vault", `${s.P.l.vault.toBase58()}  holds ${sol(live.vault)} SOL`],
    ["DAMM v2 pool", s.P.dammPool.toBase58()],
    ["Locked position 1", `${s.P.partnerPosition.toBase58()}  ${C.dim}NFT held by partner_auth${C.x}`],
    ["Locked position 2", `${s.P.creatorPosition.toBase58()}  ${C.dim}NFT held by creator_auth${C.x}`],
    ["Unsold supply burned", `${tok(BigInt(rec.leftoverBurned.toString()))} tokens`],
    ["Outstanding supply", `${tok(live.s)} tokens`],
  ]);
  ok(`settle_graduation   ${C.dim}${tx(st.signature)}${C.x}`);
  ok(`migration_damm_v2   ${C.dim}${tx(mig.landed.signature)}${C.x}`);
  ok(`burn_leftover       ${C.dim}${tx(bu.signature)}${C.x}`);
}

async function floor(): Promise<void> {
  const s = load();
  if (!s.P) throw new Error("run demo:graduate first");
  banner("floor", "The whole vault rests as one DLMM limit order at F");
  const open = await openAtFloor(s.P);
  if (open.t.err) throw new Error(`open: ${got(open.t)}`);
  note(s, "floor", "open", open.t.signature);
  s.alt = open.alt.key;
  const rec = await accounts.launch.fetch(s.P.l.launch);
  s.sOpen = BigInt(rec.sOpen.toString());
  save(s);
  const [fOpen, fPred] = [F(s.sOpen), F(s.predictedS!)];
  rows([
    ["Vault (PDA)", ad(s.P.l.vault)],
    ["DLMM pair", ad(s.P.l.lbPair)],
    ["Limit order", ad(new PublicKey(rec.bidOrder))],
    ["Bid", `${sol(BigInt(rec.bidQuoteCommitted.toString()))} SOL resting in bin ${rec.bidBinId}, the highest bin at or below F`],
    ["DAMM v2 pool", ad(s.P.dammPool)],
    ["Transaction", tx(open.t.signature)],
  ]);
  big([
    `${C.b}FLOOR OPEN   F = ${sci(fOpen)} SOL/token${C.x}`,
    `predicted before any third-party trade: ${sci(fPred)}   realised: ${C.g}${fOpen >= fPred ? "+" : ""}${((fOpen / fPred - 1) * 100).toFixed(2)}%${C.x}  ${fOpen >= fPred ? "✓ at or above the prediction" : "✗"}`,
  ]);
}

async function dump(): Promise<void> {
  const s = load();
  if (!s.P || !s.alt) throw new Error("run demo:floor first");
  banner("dump", "Sell every holder token. Each chunk goes to the better of the DLMM bid and DAMM v2");
  const P = s.P;
  const alt = (await conn.getAddressLookupTable(s.alt)).value;
  if (!alt) throw new Error("lookup table not found");
  const team = buyers(s);
  const held = await Promise.all(team.map((w) => tokenBalanceStrict(ata(P.base, w.publicKey))));
  const circulating = held.reduce((a, b) => a + b, 0n);
  s.circulating = circulating;
  const sells: Sell[] = [];
  let sold = 0n;
  let lastRefresh = await conn.getSlot("confirmed");
  console.log(`  ${C.dim}  #  venue      tokens sold     quoted SOL/token   supply sold${C.x}`);
  for (const [wi, w] of team.entries()) {
    await send("WSOL ATA", [ensureAtaIx(WSOL, w.publicKey)]);
    const chunk = held[wi] / 25n + 1n;
    for (let guard = 0; guard < 400; guard++) {
      const bal = await tokenBalanceOrZero(ata(P.base, w.publicKey));
      if (bal === 0n) break;
      const { venue, amount: b, quoted } = await bestRoute(P, bal < 2n * chunk ? bal : chunk);
      const t = venue === "DLMM bid" ? await sellIntoBid(P, w, b) : await dammSell(P, w, b);
      if (t.err) throw new Error(`sell (${venue}): ${got(t)} ${t.signature}`);
      sold += b;
      sells.push({ n: sells.length + 1, wallet: wi + 1, venue, base: b, quoted, signature: t.signature, slot: t.slot });
      const pct = Number((sold * 10_000n) / circulating) / 100;
      const price = (Number(quoted) / Number(b)) * 1e-3;
      console.log(`  ${String(sells.length).padStart(3)}  ${venue === "DLMM bid" ? C.g : C.c}${venue.padEnd(9)}${C.x}  ${tok(b).padStart(11)}     ${sci(price).padStart(12)}      ${pct.toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(pct / 4))}`);
      const slot = await conn.getSlot("confirmed");
      if (venue === "DLMM bid" && slot >= lastRefresh + 11) {
        const r = await keeperRefresh(P, alt);
        if (!r.err) {
          note(s, "dump", "keeper refresh_floor", r.signature);
          lastRefresh = slot;
        }
      }
      await send("WSOL ATA (after unwrap)", [ensureAtaIx(WSOL, w.publicKey)]);
    }
  }
  await waitSlots(12);
  const fin = await keeperRefresh(P, alt);
  if (!fin.err) note(s, "dump", "final refresh_floor", fin.signature);
  s.sells = sells;
  for (const x of sells) note(s, "dump", `sell ${x.n} (${x.venue})`, x.signature);
  save(s);

  // Realised execution of every sell, and F in force at its slot, from the verifier (raw chain data).
  const v = verifyJson(P.base, sells.map((x) => x.signature));
  const history = (v.history as { slot: number; s: string }[]).map((h) => ({ slot: h.slot, s: BigInt(h.s) }));
  const sAt = (slot: number) => [...history].reverse().find((h) => h.slot <= slot)?.s ?? s.sOpen!;
  const ppm = new Map((v.sellout as { signature: string; execution_ppm_of_F: number }[]).map((x) => [x.signature, x.execution_ppm_of_F]));
  let cum = 0n;
  const csv = ["n,wallet,venue,tokens_sold,cumulative_supply_sold_pct,execution_sol_per_token,floor_f_sol_per_token,execution_over_f,slot,signature"];
  const pts = sells.map((x) => {
    cum += x.base;
    const f = F(sAt(x.slot));
    const over = (ppm.get(x.signature) ?? 0) / 1e6;
    const row = { n: x.n, venue: x.venue, soldPct: Number((cum * 1_000_000n) / circulating) / 10_000, price: over * f, f, over };
    csv.push([x.n, x.wallet, x.venue, Number(x.base) / 1e6, row.soldPct.toFixed(4), row.price.toExponential(6), f.toExponential(6), over.toFixed(6), x.slot, x.signature].join(","));
    return row;
  });
  writeFileSync(resolve(out(s), "dump.csv"), csv.join("\n") + "\n");
  const rec = await accounts.launch.fetch(P.l.launch);
  const sEnd = BigInt(rec.sLast.toString());
  const left = (await Promise.all(team.map((w) => tokenBalanceOrZero(ata(P.base, w.publicKey))))).reduce((a, b) => a + b, 0n);
  const lowest = pts.reduce((a, b) => (b.over < a.over ? b : a));
  const bidFills = pts.filter((p) => p.venue === "DLMM bid").map((p) => p.over);
  const lowestBid = bidFills.length ? Math.min(...bidFills) : null;
  const summary = {
    mint: P.base.toBase58(), sells: sells.length, toBid: sells.filter((x) => x.venue === "DLMM bid").length, toDamm: sells.filter((x) => x.venue === "DAMM v2").length,
    holderTokensAtStart: (Number(circulating) / 1e6), holderTokensLeft: Number(left) / 1e6, supplyAbsorbedPct: Number(((circulating - left) * 1_000_000n) / circulating) / 10_000,
    lowestExecutionSolPerToken: lowest.price, fInForceThenSolPerToken: lowest.f, lowestExecutionOverF: lowest.over,
    lowestExecutionVenue: lowest.venue, lowestBidFillOverF: lowestBid,
    fAtOpenSolPerToken: F(s.sOpen!), fAfterSolPerToken: F(sEnd), fNotLower: sEnd >= s.sOpen!, verifierPass: v.pass === true,
    points: pts,
  };
  writeFileSync(resolve(out(s), "dump.json"), JSON.stringify(summary, null, 2) + "\n");
  big([
    `${C.b}SOLD ${summary.supplyAbsorbedPct.toFixed(2)}% OF EVERY TOKEN HOLDERS HAD${C.x}   ${sells.length} sells: ${summary.toBid} to the bid, ${summary.toDamm} to DAMM v2`,
    `lowest execution   ${sci(lowest.price)} SOL/token   (a ${lowest.venue} sell)`,
    `floor F then       ${sci(lowest.f)} SOL/token`,
    `${C.b}lowest execution = ${lowest.over.toFixed(4)} × F${C.x}   ${lowest.over >= 0.99 ? `${C.g}✓ within 1% of F, fees included${C.x}` : `${C.r}✗ below 0.99 × F${C.x}`}`,
    ...(lowestBid === null ? [] : [`fills on the DLMM bid: never below ${lowestBid.toFixed(4)} × F (bin price at or just under F, less DLMM's fee)`]),
    `F at open ${sci(F(s.sOpen!))}  →  F now ${sci(F(sEnd))}   ${sEnd >= s.sOpen! ? `${C.g}✓ not lower${C.x}` : `${C.r}✗ lower${C.x}`}`,
  ]);
  console.log(`  ${C.dim}Scope: selling straight into the DAMM v2 pool can execute below F; the DLMM bid and redemption do not.${C.x}`);
  console.log(`  ${C.dim}Every fill: ${resolve(out(s), "dump.csv")}${C.x}\n`);
  if (!(lowest.over >= 0.99 && sEnd >= s.sOpen! && v.pass === true)) process.exit(1);
}

function verifyJson(mint: PublicKey, sellout: string[]) {
  let raw: string;
  try {
    raw = execFileSync(resolve(REPO, "target/release/ballast"), ["verify", mint.toBase58(), "--rpc", LOCAL_RPC, "--json", ...(sellout.length ? ["--sellout", ...sellout] : [])], { cwd: REPO, maxBuffer: 64 << 20 }).toString();
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? "{}");
  }
  return JSON.parse(raw || "{}");
}

async function verify(): Promise<void> {
  const s = load();
  if (!s.l) throw new Error("run demo:launch first");
  banner("verify", "Don't trust this script. One command, raw accounts, the same floor crate");
  const cmd = ["verify", s.l.baseMint.publicKey.toBase58(), "--cluster", "local"];
  console.log(`  ${C.b}$ ballast ${cmd.join(" ")}${C.x}\n`);
  let text: string;
  let code = 0;
  try {
    text = execFileSync(resolve(REPO, "target/release/ballast"), cmd, { cwd: REPO, maxBuffer: 64 << 20 }).toString();
  } catch (e) {
    text = String((e as { stdout?: Buffer }).stdout ?? "");
    code = 1;
  }
  writeFileSync(resolve(out(s), "verify.txt"), text);
  console.log(text.replace(/^PASS/gm, `${C.g}PASS${C.x}`).replace(/^FAIL/gm, `${C.r}FAIL${C.x}`).replace(/(RESULT: FLOOR VERIFIED ✓.*)/g, `${C.b}${C.g}$1${C.x}`));
  if (code) process.exit(1);
}

function chart(): void {
  const s = load();
  const d = resolve(out(s), "dump.json");
  if (!existsSync(d)) throw new Error("run demo:dump first");
  banner("chart", "The dump, animated, from dump.csv");
  const page = readFileSync(resolve(REPO, "demo/chart.template.html"), "utf8").replace("/*DATA*/null", readFileSync(d, "utf8"));
  writeFileSync(resolve(out(s), "chart.html"), page);
  for (const dir of ["app/public", "app/dist"]) if (existsSync(resolve(REPO, dir))) writeFileSync(resolve(REPO, dir, "demo-chart.html"), page);
  rows([
    ["Chart file", resolve(out(s), "chart.html")],
    ["Served at", "http://localhost:4173/demo-chart.html   (while `vite preview` runs)"],
    ["Controls", "space = replay · ?still=1 = final frame · ?speed=2 = twice as fast"],
  ]);
}

const STEPS: Record<string, () => Promise<void> | void> = { reset, launch: doLaunch, buy, graduate, floor, dump, verify, chart };
(async () => {
  const which = process.argv[2] ?? "";
  const list = which === "all" ? Object.keys(STEPS) : [which];
  for (const k of list) {
    if (!STEPS[k]) throw new Error(`unknown step "${k}" — one of: ${Object.keys(STEPS).join(", ")}, all`);
    await STEPS[k]();
  }
  process.exit(0);
})().catch((e) => {
  console.error(`\n  ${C.r}✗ ${(e as Error).message ?? e}${C.x}\n`);
  process.exit(1);
});
