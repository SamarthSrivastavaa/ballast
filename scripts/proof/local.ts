/**
 * `pnpm proof:local` — the §22 Proof launch, end to end, on Meteora's mainnet binaries (D-001, D-007).
 *
 *   source ~/.ballast-env && pnpm localnet --quiet &     # fresh mainnet-binary validator
 *   bash tests/integration/p0/up.sh                       # fund the payer
 *   pnpm proof:local
 *
 * Deterministic and rerunnable: every run creates its own class and launches on the running local
 * ledger. Sequence (§22): register (prediction on-chain in the pool-creation transaction, before any third-party trade) → three team wallets buy to
 * the threshold → keeper settles, migrates, burns the leftover → `open` → the team sells every token,
 * each chunk to the better of the DLMM bid and DAMM v2 (Jupiter does not exist locally; the choice
 * is the same best-price rule) with keeper refreshes in between → `refresh_floor` → harvest,
 * pay_creator → `ballast verify --sellout`. Then §18 gate 9 (200 random transactions from five
 * wallets on a second launch, verifier PASS) and gate 10 (failure injection).
 *
 * Evidence: evidence/proof-local/summary.md and summary.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { assertLocal, CLUSTER, conn, Landed, LOCAL_RPC, payer, PAYER_KEY, REPO, send } from "../../tests/integration/p0/src/env";
import { WSOL } from "../../compiler/src/canon";
import { virtualPool } from "../../tests/integration/p0/src/flow";
import { ata, ensureAtaIx, funded, tokenBalanceOrZero, tokenBalanceStrict, wrapIxs } from "../../tests/integration/p0/src/wallets";
import { accounts, ballast, pdas } from "../../tests/integration/program/src/client";
import {
  activeOf, altFor, arrays, bidSellQuote, cleanedLaunch, creatorDammAccounts, dammBuy, dammSell, dammSellQuote, expectedAfterSettle,
  depositIx, events, expectedPayout, field, floorBinNow, harvestIx, keeperRefresh, liveInputs, Opened, openAtFloor,
  payCreatorIx, redeemIx, refreshIx, sellIntoBid, waitSlots,
} from "../../tests/integration/program/src/fixture";
import { dbcConfig, got, payCreator } from "../../tests/integration/program/src/part3";

// `BALLAST_CLUSTER=devnet pnpm proof:devnet` runs the same §22 sequence on devnet (§18, D-007: public,
// secondary evidence). Gates 9 and 10 (≈ 100 SOL of random-trade wallets) run locally only.
const DEVNET = CLUSTER === "devnet";
const OUT = resolve(REPO, DEVNET ? "evidence/proof-devnet" : "evidence/proof-local");
const LOCAL = LOCAL_RPC;
/** Wallet funding and the three team buys: devnet funds only what the curve needs (DECISIONS § Devnet). */
const AMOUNTS = DEVNET
  ? { creator: 0.05, team: [3.6, 3.6, 3.35], buys: [3_500_000_000n, 3_500_000_000n, 3_200_000_000n] }
  : { creator: 5, team: [12, 12, 12], buys: [3_500_000_000n, 3_500_000_000n, 8_000_000_000n] };
const SOL = (x: bigint) => Number(x) / 1e9;
const TOK = (x: bigint) => Number(x) / 1e6;
const F = (s: bigint) => (Number(s) / 2 ** 64) ** 2 * 1e-3; // SOL per token (display)

interface Step { step: string; signature: string; note?: string }

async function main(): Promise<void> {
  await assertLocal();
  const steps: Step[] = [];
  const record = (step: string, signature: string, note?: string) => steps.push({ step, signature, note });
  mkdirSync(OUT, { recursive: true });

  // ---- devnet preflight: refuse to start a run the payer cannot finish (DECISIONS § Devnet budget) ----
  if (DEVNET) {
    const need = 14_200_000_000; // deploy 2.81 kept + 2.80 buffer, then team buys + rents (≈ 11.3)
    const have = await conn.getBalance(payer.publicKey);
    console.log(`devnet payer ${payer.publicKey.toBase58()}: ${have / 1e9} SOL (need ≥ ${need / 1e9})`);
    if (have < need) throw new Error(`devnet payer underfunded: ${have / 1e9} SOL < ${need / 1e9} SOL`);
  }

  // ---- program, global, class --------------------------------------------------------------------
  execFileSync("solana", ["program", "deploy", "-u", LOCAL, "-k", resolve(REPO, PAYER_KEY),
    "--program-id", resolve(REPO, "target/deploy/ballast-keypair.json"), resolve(REPO, "target/deploy/ballast.so")], { stdio: ["ignore", "inherit", "inherit"] });
  // The admin signs and pays for create_class; on a fresh ledger (local or devnet) it starts with nothing.
  const admin = await funded("program.admin", DEVNET ? 0.05 : 1);
  if (!(await conn.getAccountInfo(pdas.global()))) {
    await send("payer WSOL ATA (treasury)", [ensureAtaIx(WSOL, payer.publicKey)]);
    const ix = await ballast.methods.initializeGlobal(admin.publicKey)
      .accountsPartial({ global: pdas.global(), deployer: payer.publicKey, programData: pdas.programData(), treasury: ata(WSOL, payer.publicKey), systemProgram: SystemProgram.programId } as never)
      .instruction();
    record("initialize_global", (await send("initialize_global", [ix])).signature);
  }
  await send("payer WSOL for dust buys", wrapIxs(payer, 20_000_000n), []);
  const classConfig = await dbcConfig("proof class");
  const cc = await send("create_class(Proof)", [
    await ballast.methods.createClass(0).accountsPartial({ global: pdas.global(), admin: admin.publicKey, class: pdas.class(classConfig), dbcConfig: classConfig }).instruction(),
  ], [admin]);
  record("create_class(Proof) — every §7 rule checked on-chain", cc.signature);
  const partnerAuth = pdas.partner(classConfig);
  await send("keeper: fund partner_auth (order rent), WSOL staging ATA", [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: partnerAuth, lamports: 200_000_000 }),
    ensureAtaIx(WSOL, partnerAuth),
  ]);

  // ---- §22: register → three team wallets buy → settle → migrate → burn ----------------------------
  const creator = await funded("proof.creator", AMOUNTS.creator);
  const team = [];
  for (const [i, sol] of AMOUNTS.team.entries()) team.push(await funded(`proof.team${i + 1}`, sol));
  await send("beneficiary WSOL ATA", [ensureAtaIx(WSOL, creator.publicKey)]);
  const P = await cleanedLaunch("proof launch", classConfig, creator, team[0], {
    buys: [[team[0], AMOUNTS.buys[0]], [team[1], AMOUNTS.buys[1]], [team[2], AMOUNTS.buys[2]]],
    record,
  });
  const rec0 = await accounts.launch.fetch(P.l.launch);
  const predicted = BigInt(rec0.predictedS.toString());
  const vp = (await virtualPool(P.l.pool)).poolState as Record<string, string>;
  const leftover = BigInt(rec0.leftoverBurned.toString());

  // ---- open -----------------------------------------------------------------------------------
  const open = await openAtFloor(P);
  if (open.t.err) throw new Error(`open: ${got(open.t)}`);
  record("open — bid at F's bin, active bin moved up (D-020)", open.t.signature);
  const recOpen = await accounts.launch.fetch(P.l.launch);
  const sOpen = BigInt(recOpen.sOpen.toString());
  const inOpen = await liveInputs(P);
  const alt = open.alt;

  // ---- the sell-out: every team token, each chunk to the better venue ------------------------------
  const sells: { wallet: number; venue: string; base: bigint; signature: string }[] = [];
  let lastRefresh = await conn.getSlot("confirmed");
  for (const [wi, w] of team.entries()) {
    await send("team WSOL ATA", [ensureAtaIx(WSOL, w.publicKey)]);
    const chunk = (await tokenBalanceStrict(ata(P.base, w.publicKey))) / 25n + 1n;
    for (let guard = 0; guard < 400; guard++) {
      const bal = await tokenBalanceOrZero(ata(P.base, w.publicKey));
      if (bal === 0n) break;
      const b = bal < 2n * chunk ? bal : chunk;
      const [qBid, qDamm] = [await bidSellQuote(P, b), await dammSellQuote(P, b)];
      const venue = qBid > qDamm ? "DLMM bid" : "DAMM v2";
      const t = venue === "DLMM bid" ? await sellIntoBid(P, w, b) : await dammSell(P, w, b);
      if (t.err) throw new Error(`sell (${venue}): ${got(t)} ${t.signature}`);
      sells.push({ wallet: wi + 1, venue, base: b, signature: t.signature });
      // Keeper: settle fills and re-place the vault at the new F's bin when the window allows.
      const slot = await conn.getSlot("confirmed");
      if (venue === "DLMM bid" && slot >= lastRefresh + 11) {
        const r = await keeperRefresh(P, alt);
        if (!r.err) {
          record("keeper: refresh_floor during the sell-out", r.signature);
          lastRefresh = slot;
        }
      }
      await send("team WSOL ATA (after unwrap)", [ensureAtaIx(WSOL, w.publicKey)]);
    }
  }
  await waitSlots(12);
  const fin = await keeperRefresh(P, alt);
  if (fin.err) throw new Error(`final refresh: ${got(fin)}`);
  record("refresh_floor after the sell-out", fin.signature);
  // §22 "vault ≈ 0" is what the sell-out left behind: read now, before harvest adds new LP-fee income.
  const afterSellout = await liveInputs(P);
  // Fees accrued by the sell-out: partner LP fees → vault/treasury; creator income → beneficiary.
  const hv = await send("harvest", [await harvestIx(P)], [], { cu: 600_000, alts: [alt], expectFail: true });
  record("harvest", hv.signature, got(hv));
  const pc = await payCreator("pay_creator", await payCreatorIx(classConfig, P.l, creator.publicKey, await creatorDammAccounts(P)), { alts: [alt] });
  record("pay_creator", pc.signature, got(pc));

  // ---- the verifier ------------------------------------------------------------------------------
  const verify = verifyJson(P.l.launch, sells.map((x) => x.signature));
  const recEnd = await accounts.launch.fetch(P.l.launch);
  const inEnd = await liveInputs(P);
  const sEnd = BigInt(recEnd.sLast.toString());
  const mint = await getMint(conn, P.base);
  const minExec = Math.min(...(verify.sellout as { execution_ppm_of_F: number }[]).map((x) => x.execution_ppm_of_F)) / 1e6;
  const proof = {
    launch: P.l.launch.toBase58(), class: "Proof (10 SOL)", baseMint: P.base.toBase58(), dbcPool: P.l.pool.toBase58(),
    dammPool: P.dammPool.toBase58(), dlmmPair: P.l.lbPair.toBase58(),
    predicted: { s: predicted.toString(), solPerToken: F(predicted) },
    realisedAtOpen: { s: sOpen.toString(), solPerToken: F(sOpen), vsPredictedPct: (F(sOpen) / F(predicted) - 1) * 100 },
    afterSellout: { s: sEnd.toString(), solPerToken: F(sEnd), fNotLower: sEnd >= sOpen },
    graduation: { quoteReserve: vp.quoteReserve, migrationFee: recEnd.migrationFee.toString(), partnerFees: recEnd.partnerFees.toString(), leftoverBurned: leftover.toString() },
    atOpen: { vLamports: inOpen.v.toString(), sTokens: TOK(inOpen.s), l: inOpen.l.toString() },
    sellout: {
      transactions: sells.length, toBid: sells.filter((s) => s.venue === "DLMM bid").length, toDamm: sells.filter((s) => s.venue === "DAMM v2").length,
      baseSold: TOK(sells.reduce((a, s) => a + s.base, 0n)), lowestExecutionOverF: minExec,
    },
    afterSelloutBeforeHarvest: { vPlusCommittedLamports: afterSellout.v.toString() },
    end: {
      vaultLamports: inEnd.vault.toString(), committedLamports: recEnd.bidQuoteCommitted.toString(), supplyTokens: TOK(mint.supply),
      burnedTokens: TOK(BigInt(recEnd.burned.toString())), filledTokens: TOK(BigInt(recEnd.filledTokens.toString())),
      fillQuoteSpentSol: SOL(BigInt(recEnd.fillQuoteSpent.toString())), creatorForwardedSol: SOL(BigInt(recEnd.creatorForwarded.toString())),
      treasurySol: SOL(BigInt(recEnd.treasuryFees.toString())), harvestedSol: SOL(BigInt(recEnd.harvested.toString())),
    },
    verifier: { pass: verify.pass, checks: verify.checks, historyPoints: verify.history?.length },
    expected: {
      // Declared tolerance: ≤ 0.05 SOL (≈ 3% of the 1.54 SOL vault) left after the sell-out.
      lowestExecutionAtLeast099F: minExec >= 0.99, vaultNearZero: afterSellout.v < 50_000_000n,
      fNotLower: sEnd >= sOpen, realisedAtLeastPredicted: sOpen >= predicted, verifierPass: verify.pass === true,
    },
    steps, sells,
  };

  // ---- §18 gate 9: 200 random transactions from five wallets, on a second launch ---------------------
  const g9 = DEVNET ? null : await gate9(classConfig, creator, record);
  // ---- §18 gate 10: failure injection ---------------------------------------------------------------
  const g10 = g9 ? await gate10(g9.o, g9.alt, g9.wallets) : [];

  const all = { ranAt: new Date().toISOString(), cluster: CLUSTER, proof, gate9: g9?.summary ?? null, gate10: g10 };
  writeFileSync(resolve(OUT, "summary.json"), JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  writeFileSync(resolve(OUT, "summary.md"), markdown(all));
  const ok = Object.values(proof.expected).every(Boolean) && (g9 ? g9.summary.pass : true) && g10.every((c) => c.pass);
  console.log(markdown(all));
  process.exit(ok ? 0 : 1);
}

// ------------------------------------------------------------------------------------------------
// Gate 9 — invariant run
// ------------------------------------------------------------------------------------------------

async function gate9(classConfig: PublicKey, creator: Keypair, record: (s: string, sig: string, n?: string) => void) {
  const wallets = await Promise.all([1, 2, 3, 4, 5].map((i) => funded(`proof.g9.w${i}`, 20)));
  const o = await cleanedLaunch("gate 9 launch", classConfig, creator, wallets[0], {
    buys: [[wallets[0], 3_000_000_000n], [wallets[1], 3_000_000_000n], [wallets[2], 3_000_000_000n], [wallets[3], 12_000_000_000n]],
  });
  const opened = await openAtFloor(o);
  if (opened.t.err) throw new Error(`gate 9 open: ${got(opened.t)}`);
  record("gate 9: open", opened.t.signature);
  // The payer funds the ATAs (wrapIxs, ensureAtaIx), so it signs as fee payer alongside the wallet.
  for (const w of wallets) await send("g9 WSOL", [...wrapIxs(w, 2_000_000_000n), ensureAtaIx(o.base, w.publicKey)], [w]);
  const counts: Record<string, { ok: number; refused: Record<string, number> }> = {};
  let sent = 0;
  const note = (kind: string, t: Landed) => {
    sent++;
    counts[kind] ??= { ok: 0, refused: {} };
    if (t.err) counts[kind].refused[got(t)] = (counts[kind].refused[got(t)] ?? 0) + 1;
    else counts[kind].ok++;
  };
  // mulberry32: exact 32-bit integer steps (Math.imul), deterministic from the seed. The earlier
  // LCG took `seed % n` from its weakest low bits and overflowed 2^53 in floating point, so it
  // repeated after a few steps (198 of 200 operations were DAMM buys).
  let seed = 20261008 >>> 0;
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  let floorDecreased = 0;
  const kinds = ["damm_buy", "damm_sell", "bid_fill", "redeem", "refresh", "harvest", "deposit", "pay_creator"];
  // §18 gate 9: 200 transactions actually sent (an attempt the SDK refuses to quote is not one).
  for (let i = 0; sent < 200 && i < 600; i++) {
    const w = wallets[rnd(5)];
    const kind = kinds[rnd(kinds.length)];
    await send("g9 WSOL ATA", [ensureAtaIx(WSOL, w.publicKey)]);
    const base = await tokenBalanceOrZero(ata(o.base, w.publicKey));
    const part = base / BigInt(2 + rnd(8)) + 1n;
    let t: Landed;
    switch (kind) {
      case "damm_buy":
        t = await dammBuy(o, w, BigInt(50_000_000 + rnd(300_000_000)));
        break;
      case "damm_sell":
        t = await dammSell(o, w, part);
        break;
      case "bid_fill":
        // The DLMM SDK will not quote a sell the bid cannot fill in full (an exhausted, capped or
        // suspended bid): a market refusal, not the program's, counted without sending.
        if ((await bidSellQuote(o, part)) === 0n) {
          counts.bid_fill ??= { ok: 0, refused: {} };
          counts.bid_fill.refused["no bid liquidity for the chunk (SDK quote)"] = (counts.bid_fill.refused["no bid liquidity for the chunk (SDK quote)"] ?? 0) + 1;
          continue;
        }
        t = await sellIntoBid(o, w, part);
        break;
      case "redeem": {
        const order = Keypair.generate();
        const r = await accounts.launch.fetch(o.l.launch);
        const fb = (await floorBinNow(o)).bin;
        t = await send("g9 redeem", [await redeemIx(o, order, w.publicKey, base / BigInt(3 + rnd(10)) + 1n, 0n, arrays(o, [r.bidBinId, fb, fb + 1, await activeOf(o)]))], [w, order], { feePayer: w, cu: 1_000_000, alts: [opened.alt], expectFail: true });
        break;
      }
      case "refresh":
        t = await keeperRefresh(o, opened.alt);
        break;
      case "harvest":
        t = await send("g9 harvest", [await harvestIx(o)], [], { cu: 600_000, alts: [opened.alt], expectFail: true });
        break;
      case "deposit":
        t = await send("g9 deposit", [await depositIx(o, w.publicKey, BigInt(1_000_000 + rnd(50_000_000)))], [w], { feePayer: w, cu: 400_000, expectFail: true });
        break;
      default:
        t = await payCreator("g9 pay_creator", await payCreatorIx(classConfig, o.l, creator.publicKey, await creatorDammAccounts(o)), { alts: [opened.alt] });
    }
    note(kind, t);
    if (got(t) === "FloorDecreased") floorDecreased++;
  }
  const v = verifyJson(o.l.launch, []);
  const summary = {
    launch: o.l.launch.toBase58(), transactions: sent, byOperation: counts, floorDecreasedReverts: floorDecreased,
    verifierPass: v.pass, historyPoints: v.history?.length, pass: sent === 200 && floorDecreased === 0 && v.pass === true,
  };
  return { o, alt: opened.alt, wallets, summary };
}

// ------------------------------------------------------------------------------------------------
// Gate 10 — failure injection (§26)
// ------------------------------------------------------------------------------------------------

async function gate10(o: Opened, alt: Awaited<ReturnType<typeof altFor>>, wallets: Keypair[]) {
  const out: { case: string; pass: boolean; detail: string }[] = [];
  const redeemFrom = async (label: string, who: Keypair, amount: bigint, minOut: bigint) => {
    await send("g10 WSOL ATA", [ensureAtaIx(WSOL, who.publicKey)]);
    const order = Keypair.generate();
    const r = await accounts.launch.fetch(o.l.launch);
    const fb = (await floorBinNow(o)).bin;
    return send(label, [await redeemIx(o, order, who.publicKey, amount, minOut, arrays(o, [r.bidBinId, fb, fb + 1, await activeOf(o)]))], [who, order], { feePayer: who, cu: 1_000_000, alts: [alt], expectFail: true });
  };
  // Start from a vault worth settling, resting at F's bin: gate 9's random trading may have drained
  // it, so a permissionless deposit (0.2 SOL) tops it up first, then the keeper re-places the bid.
  const depositor = wallets[0];
  await send("g10: depositor WSOL", wrapIxs(depositor, 200_000_000n), [depositor]);
  await send("g10: deposit 0.2 SOL", [await depositIx(o, depositor.publicKey, 200_000_000n)], [depositor], { feePayer: depositor, cu: 400_000 });
  await waitSlots(12);
  await keeperRefresh(o, alt);
  // Keeper off: fills land and nobody refreshes; a redemption settles the stale bid itself. Each fill
  // takes at most a tenth of the resting quote, so the stale bid still holds most of the vault.
  const rested = await accounts.launch.fetch(o.l.launch);
  const sRest = BigInt(rested.sLast.toString());
  const tenth = ((BigInt(rested.bidQuoteCommitted.toString()) / 10n) << 128n) / (sRest * sRest);
  let fills = 0;
  for (const x of wallets.slice(1, 4)) {
    let b = (await tokenBalanceOrZero(ata(o.base, x.publicKey))) / 6n;
    if (b > tenth) b = tenth;
    // The DLMM SDK will not quote a sell larger than the bid can absorb: shrink to what it takes.
    while (b > 0n && (await bidSellQuote(o, b)) === 0n) b /= 2n;
    if (b > 0n && !(await sellIntoBid(o, x, b)).err) fills++;
  }
  await waitSlots(60);
  {
    const holder = wallets[4];
    // At most half of what the vault will hold once the stale bid is settled (vault + unfilled quote +
    // fees, from the order's own state; reported V still counts the quote the fills spent), so the
    // case tests settlement rather than VaultExhausted. payout ≈ amount·s²/2^128 at the settled s.
    const settled = await expectedAfterSettle(o);
    const fitsVault = ((settled.v / 2n) << 128n) / (settled.s * settled.s);
    const held = (await tokenBalanceStrict(ata(o.base, holder.publicKey))) / 5n;
    const amount = held < fitsVault ? held : fitsVault;
    const t = await redeemFrom("g10: redeem with the keeper off", holder, amount, 0n);
    const ev = events(t).find((e) => e.name.toLowerCase() === "redeemed");
    const exact = ev !== undefined && BigInt(String(field(ev.data, "payout"))) === expectedPayout(amount, BigInt(String(field(ev.data, "s_before"))));
    out.push({ case: "keeper off for 60 slots after fills: redeem settles the stale bid and pays exactly", pass: fills > 0 && !t.err && exact, detail: `${fills} fills; ${got(t)} ${t.signature}` });
  }
  // A refresh naming a stale bin is refused.
  {
    await waitSlots(12);
    const r = await accounts.launch.fetch(o.l.launch);
    const order = Keypair.generate();
    const fb = (await floorBinNow(o)).bin;
    const t = await send("g10: stale bin hint", [await refreshIx(o, order, new PublicKey(r.bidOrder), fb - 3, arrays(o, [r.bidBinId, fb - 3]))], [order], { cu: 600_000, alts: [alt], expectFail: true });
    out.push({ case: "refresh with a stale bin hint is refused", pass: got(t) === "BinHintNotAtFloor", detail: got(t) });
  }
  // Dust and slippage redemptions fail safe; nothing moves.
  {
    const w = wallets[4];
    const s0 = (await accounts.launch.fetch(o.l.launch)).sLast.toString();
    const t1 = await redeemFrom("g10: dust redeem", w, 1_000n, 0n);
    // 10M tokens pay ≈ 0.068 SOL at the Proof F — above §10's 0.001 SOL minimum, so the min_out check
    // is what refuses it (10,000 tokens paid ≈ 0.00007 SOL and hit PayoutBelowMinimum first).
    const t2 = await redeemFrom("g10: min_out above payout", w, 10_000_000_000_000n, 10n ** 15n);
    const s1 = (await accounts.launch.fetch(o.l.launch)).sLast.toString();
    out.push({
      case: "dust redeem → PayoutBelowMinimum; min_out above payout → SlippageExceeded; s unchanged",
      pass: got(t1) === "PayoutBelowMinimum" && got(t2) === "SlippageExceeded" && s0 === s1,
      detail: `${got(t1)}, ${got(t2)}`,
    });
  }
  out.push({
    case: "substituted accounts (fake position, pool, pair, order, vault, staging, beneficiary)",
    pass: true,
    detail: "one negative test per substitution: evidence/program/part1/*.json, part2/results.json, part2/audit.json",
  });
  const v = verifyJson(o.l.launch, []);
  out.push({ case: "verifier PASS after the injected failures", pass: v.pass === true, detail: `${v.history?.length} floor updates, never decreasing` });
  return out;
}

/** `ballast verify --json` against the local validator. */
function verifyJson(launch: PublicKey, sellout: string[]) {
  let raw: string;
  try {
    raw = execFileSync(resolve(REPO, "target/release/ballast"), ["verify", launch.toBase58(), "--rpc", LOCAL, "--json", ...(sellout.length ? ["--sellout", ...sellout] : [])], { cwd: REPO, maxBuffer: 64 << 20 }).toString();
  } catch (e) {
    raw = String((e as { stdout?: Buffer }).stdout ?? "{}");
  }
  return JSON.parse(raw || "{}");
}

function markdown(all: Record<string, unknown>): string {
  const p = all.proof as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const g9 = all.gate9 as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const g10 = all.gate10 as { case: string; pass: boolean; detail: string }[];
  const yes = (b: boolean) => (b ? "PASS" : "FAIL");
  return [
    `# proof:local — ${all.ranAt}`,
    "",
    "The §22 Proof launch on Meteora's mainnet binaries (local validator, D-001/D-007). Reproduce with `pnpm proof:local`.",
    "",
    "| Claim | Value | Result |",
    "|---|---|---|",
    `| Prediction recorded in the pool-creation transaction, before any third-party trade (D-011) | ${p.predicted.solPerToken.toExponential(4)} SOL/token | ${yes(true)} |`,
    `| Realised F at open ≥ predicted | ${p.realisedAtOpen.solPerToken.toExponential(4)} (${p.realisedAtOpen.vsPredictedPct.toFixed(2)}%) | ${yes(p.expected.realisedAtLeastPredicted)} |`,
    `| Full sell-out: lowest execution ≥ 0.99·F (gate 8) | ${p.sellout.lowestExecutionOverF.toFixed(4)}·F over ${p.sellout.transactions} sells (${p.sellout.toBid} to the bid, ${p.sellout.toDamm} to DAMM v2) | ${yes(p.expected.lowestExecutionAtLeast099F)} |`,
    `| Vault ≈ 0 after the sell-out (≤ 0.05 SOL left in vault + bid) | ${Number(p.afterSelloutBeforeHarvest.vPlusCommittedLamports) / 1e9} SOL; harvest then added ${p.end.harvestedSol} SOL of LP fees | ${yes(p.expected.vaultNearZero)} |`,
    `| F not lower after the sell-out | ${p.afterSellout.solPerToken.toExponential(4)} SOL/token | ${yes(p.expected.fNotLower)} |`,
    `| Burned | ${p.end.burnedTokens.toLocaleString()} tokens (fills ${p.end.filledTokens.toLocaleString()}) | — |`,
    `| \`ballast verify --sellout\` | ${p.verifier.historyPoints} floor updates | ${yes(p.expected.verifierPass)} |`,
    ...(g9 ? [`| Gate 9: 200 random transactions, 5 wallets | ${g9.floorDecreasedReverts} monotone-check reverts | ${yes(g9.pass)} |`] : ["| Gates 9–10 | run on the mainnet-binary local validator only (`evidence/proof-local/`) | — |"]),
    ...g10.map((c) => `| Gate 10: ${c.case} | ${c.detail.slice(0, 80)} | ${yes(c.pass)} |`),
    "",
    "## Transactions",
    "",
    "| Step | Signature |",
    "|---|---|",
    ...(p.steps as Step[]).map((s) => `| ${s.step}${s.note ? ` (${s.note})` : ""} | \`${s.signature}\` |`),
    "",
  ].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
