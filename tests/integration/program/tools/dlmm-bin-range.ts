/**
 * Characterization (mainnet DLMM binary, D-001): the bin-id range a Ballast LimitOrder pair accepts.
 * D-021's audit assumed a third party could pin the active bin at −40,000 (beyond the internal
 * bitmap); DLMM refused `initialize_bin_array` there with 6000 InvalidStartBinIndex. This reads the
 * pair's own bounds and probes `initialize_bin_array` at their edges by simulation.
 *
 *   pnpm exec tsx tests/integration/program/tools/dlmm-bin-range.ts <lb_pair>
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import BN from "bn.js";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import DLMM, { binIdToBinArrayIndex } from "@meteora-ag/dlmm";
import { conn, payer, REPO } from "../../p0/src/env";

async function main(): Promise<void> {
  const lbPair = new PublicKey(process.argv[2]);
  const pair = await DLMM.create(conn, lbPair, { cluster: "mainnet-beta" });
  const p = pair.lbPair.parameters as unknown as Record<string, number>;
  const out: Record<string, unknown> = {
    lbPair: lbPair.toBase58(), binStep: pair.lbPair.binStep, activeId: pair.lbPair.activeId,
    minBinId: p.minBinId, maxBinId: p.maxBinId,
    internalBitmapBins: [-512 * 70, 512 * 70 - 1],
  };
  const sim = async (index: number) => {
    const ixs = (await pair.initializeBinArrays([new BN(index)], payer.publicKey)).filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
    if (!ixs.length) return "exists";
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    return r.value.err ? (r.value.logs ?? []).find((l) => l.includes("Error Code")) ?? JSON.stringify(r.value.err) : "ok";
  };
  const probes: Record<string, string> = {};
  for (const id of [p.minBinId, p.minBinId - 70, p.maxBinId, p.maxBinId + 70, -35_840, -35_841, -40_000]) {
    const idx = Number(binIdToBinArrayIndex(new BN(id)).toString());
    probes[`bin ${id} (array ${idx})`] = await sim(idx).catch((e) => String((e as Error).message).split("\n")[0]);
  }
  out.initializeBinArrayProbes = probes;
  writeFileSync(resolve(REPO, "evidence/program/part2/dlmm-bin-range.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
