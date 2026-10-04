/**
 * Extra check (a): the lowest `migration_quote_threshold` the deployed DBC accepts, for a Lite
 * config (D-008: §7 shape, migration fee 0, 100% permanent LP split partner/creator).
 *
 * Method: simulate create_config on a ladder 10^0 … 10^10 lamports (proves where acceptance
 * starts and that it is monotonic over the ladder), binary-search the exact boundary inside the
 * bracketing rung, then LAND two real transactions — the minimum (accepted) and minimum − 1
 * (rejected, with its error code) — so the answer has signatures.
 */
import { Keypair } from "@solana/web3.js";
import { payer, send, simulate, writeEvidence } from "../env";
import { lite } from "../config";
import { createConfigIx } from "../dbc";
import { saveState } from "../state";

const litePartner = Keypair.generate();

async function trial(threshold: bigint) {
  const { ix, created } = await createConfigIx(lite(threshold), payer.publicKey, litePartner.publicKey);
  // The config keypair must sign; simulation runs with sigVerify off.
  const r = await simulate([ix]);
  return { threshold, ok: r.err === null, code: r.customCode, err: r.err, created, ix, lastLog: r.logs.filter((l) => l.includes("Error")).slice(-1)[0] };
}

export async function qa(): Promise<void> {
  const ladder = [];
  for (let e = 0; e <= 10; e++) ladder.push(await trial(10n ** BigInt(e)));
  const ladderView = ladder.map((t) => ({ threshold: t.threshold.toString(), ok: t.ok, code: t.code, error: t.lastLog }));
  console.log(ladderView);
  const firstOk = ladder.findIndex((t) => t.ok);
  if (firstOk < 0) throw new Error("no threshold on the ladder was accepted");
  const monotonic = ladder.slice(firstOk).every((t) => t.ok);

  let lo = firstOk === 0 ? 0n : ladder[firstOk - 1].threshold; // rejected (or 0)
  let hi = ladder[firstOk].threshold; // accepted
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await trial(mid)).ok) hi = mid;
    else lo = mid;
  }

  const accepted = await trial(hi);
  const okTx = await send(`(a) create_config Lite at minimum threshold ${hi}`, [accepted.ix], [accepted.created.config]);
  let rejected: Record<string, unknown> | null = null;
  if (hi > 1n) {
    const below = await trial(hi - 1n);
    const failTx = await send(`(a) create_config Lite at ${hi - 1n} (expected reject)`, [below.ix], [below.created.config], {
      expectFail: true,
    });
    rejected = {
      threshold: (hi - 1n).toString(),
      signature: failTx.signature,
      err: failTx.err,
      errorLog: failTx.logs.filter((l) => l.includes("Error")),
    };
  }

  const result = {
    check: "(a) lowest migration_quote_threshold the deployed DBC accepts (Lite config, D-008)",
    ladder: ladderView,
    monotonicOverLadder: monotonic,
    minimumThresholdLamports: hi.toString(),
    minimumThresholdSol: Number(hi) / 1e9,
    accepted: { signature: okTx.signature, config: accepted.created.config.publicKey.toBase58(), cu: okTx.cu },
    rejectedAtMinimumMinusOne: rejected,
  };
  writeEvidence("extra-a/result.json", result);
  saveState({ liteMinThreshold: hi.toString(), liteMinConfig: accepted.created.config.publicKey.toBase58() });
  console.log(JSON.stringify({ ...result, ladder: undefined }, null, 2));
}
