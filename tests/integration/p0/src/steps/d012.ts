/**
 * D-012 proof: `tokenBalanceStrict` throws for a token account that does not exist, where
 * `tokenBalanceOrZero` silently returns 0.
 *
 * This is the near-miss from Q5 turned into a check: the bid was placed against an account that was
 * never created, because the balance read could not distinguish "missing" from "empty".
 */
import { Keypair } from "@solana/web3.js";
import { payer, send, writeEvidence } from "../env";
import { WSOL } from "../config";
import { ata, ensureAtaIx, tokenBalanceOrZero, tokenBalanceStrict } from "../wallets";

export async function d012(): Promise<void> {
  // An ATA address for an owner that has never had one: derivable, but not on chain.
  const stranger = Keypair.generate().publicKey;
  const missing = ata(WSOL, stranger);

  let threw: string | null = null;
  try {
    await tokenBalanceStrict(missing);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const orZero = await tokenBalanceOrZero(missing);

  // And the strict helper must still work once the account exists.
  const mineExists = ata(WSOL, payer.publicKey);
  await send("D-012: ensure the payer's WSOL ATA exists", [ensureAtaIx(WSOL, payer.publicKey)]);
  const strictOnExisting = await tokenBalanceStrict(mineExists);

  const result = {
    decision: "D-012 — a missing token account is an ERROR, never 0",
    missingAccount: missing.toBase58(),
    strictThrew: threw !== null,
    strictMessage: threw,
    orZeroReturned: orZero.toString(),
    strictOnExistingAccount: strictOnExisting.toString(),
    verdict:
      threw !== null && orZero === 0n
        ? "PASS — strict throws, orZero returns 0; the ambiguity is now explicit in the name"
        : "FAIL",
  };

  writeEvidence("d012/result.json", result);
  console.log(JSON.stringify(result, null, 2));
  if (threw === null) throw new Error("D-012: tokenBalanceStrict did NOT throw for a missing account");
  if (orZero !== 0n) throw new Error("D-012: tokenBalanceOrZero did not return 0");
}
