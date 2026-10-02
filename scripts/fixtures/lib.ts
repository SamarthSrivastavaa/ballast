/**
 * Shared by `pnpm fixtures:dump`, `fixtures:check`, `localnet` and `fixtures:exec` (D-001, §17).
 *
 * Reads go straight to JSON-RPC `getAccountInfo`, never through a signer: a mainnet read here
 * spends nothing and signs nothing (D-007). For an upgradeable program, ONE read of its
 * ProgramData account returns the ELF bytes, the slot it was last deployed in and its upgrade
 * authority together, at one context slot, so the pin cannot mix two deployments.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO = resolve(__dirname, "../..");
export const MANIFEST_PATH = resolve(REPO, "scripts/fixtures/manifest.json");
export const PINS_PATH = resolve(REPO, "evidence/fixtures/mainnet-pins.json");
export const FIXTURES_DIR = resolve(REPO, "fixtures");

/** Override with MAINNET_RPC_URL. Only the host is ever written to evidence, never a key. */
export const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
/** `getGenesisHash` of mainnet-beta. A pin may only come from, and be checked against, this cluster. */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** UpgradeableLoaderState::ProgramData header: u32 tag (3) + u64 slot + Option<Pubkey> (1 + 32). */
const PROGRAMDATA_HEADER = 4 + 8 + 1 + 32;

export interface ManifestProgram {
  name: string;
  label: string;
  id: string;
  source: string;
}
export interface ManifestAccount {
  name: string;
  address: string;
  why: string;
  discoveredBy: string;
}
export interface Manifest {
  programs: ManifestProgram[];
  accounts: ManifestAccount[];
}

export interface ProgramPin {
  id: string;
  label: string;
  loader: string;
  programdataAddress: string;
  /** `None` is recorded as the string "none", as `solana program show` prints it. */
  upgradeAuthority: string;
  lastDeploySlot: number;
  readAtSlot: number;
  soFile: string;
  soBytes: number;
  /** sha256 of the dumped ELF exactly as `solana program dump` writes it. */
  sha256: string;
  /** sha256 with trailing zero bytes stripped: the solana-verify `get-program-hash` convention. */
  executableSha256: string;
}
export interface AccountPin {
  address: string;
  owner: string;
  lamports: number;
  executable: boolean;
  dataBytes: number;
  dataSha256: string;
  readAtSlot: number;
  jsonFile: string;
}
export interface Pins {
  schema: 1;
  cluster: "mainnet-beta";
  genesisHash: string;
  rpcHost: string;
  dumpedAt: string;
  programs: Record<string, ProgramPin>;
  accounts: Record<string, AccountPin>;
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

export function loadPins(): Pins {
  return JSON.parse(readFileSync(PINS_PATH, "utf8")) as Pins;
}

export function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function stripTrailingZeros(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}

/** Host only: a provider URL can carry an API key in its path or query, which must never reach evidence. */
export function hostOf(url: string): string {
  return new URL(url).host;
}

export interface RawAccount {
  slot: number;
  lamports: number;
  owner: string;
  executable: boolean;
  rentEpoch: number;
  space: number;
  data: Buffer;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      // Fail closed: a reply with neither `result` nor `error` (e.g. a proxy's {"message": …}) must
      // never read as a value — exec.ts's "genesis is not mainnet" test would pass on `undefined`.
      if (body.result === undefined) throw new Error(`${method}: reply has no result`);
      return body.result;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

export async function genesisHash(url: string): Promise<string> {
  const g = await rpc<unknown>(url, "getGenesisHash", []);
  if (typeof g !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(g)) {
    throw new Error(`getGenesisHash at ${hostOf(url)} returned ${JSON.stringify(g)}, not a base58 hash`);
  }
  return g;
}

/** Fail closed unless `url` is mainnet-beta: a devnet RPC must never produce or check a "mainnet" pin. */
export async function assertMainnet(url: string = RPC_URL): Promise<void> {
  const g = await genesisHash(url);
  if (g !== MAINNET_GENESIS) {
    throw new Error(`${hostOf(url)} has genesis ${g}, not mainnet-beta (${MAINNET_GENESIS}); refusing`);
  }
}

/** `finalized` for mainnet pins; the local validator passes `confirmed` so fresh state is visible. */
export async function getAccount(
  address: string,
  url: string = RPC_URL,
  commitment: "finalized" | "confirmed" = "finalized",
): Promise<RawAccount | null> {
  const r = await rpc<{
    context: { slot: number };
    value: null | {
      lamports: number;
      owner: string;
      executable: boolean;
      rentEpoch: number;
      space: number;
      data: [string, string];
    };
  }>(url, "getAccountInfo", [address, { encoding: "base64", commitment }]);
  if (!r.value) return null;
  return {
    slot: r.context.slot,
    lamports: r.value.lamports,
    owner: r.value.owner,
    executable: r.value.executable,
    rentEpoch: r.value.rentEpoch,
    space: r.value.space,
    data: Buffer.from(r.value.data[0], "base64"),
  };
}

/** Base58 without a dependency: Pubkeys only (32 bytes). */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export interface FetchedProgram {
  pin: Omit<ProgramPin, "soFile" | "label">;
  elf: Buffer;
}

/**
 * Fetch an upgradeable program's ELF and ProgramData metadata from `url` — mainnet for dump and
 * check, the local validator for exec (which must prove it is running the pinned bytes).
 */
export async function fetchProgram(
  id: string,
  url: string = RPC_URL,
  commitment: "finalized" | "confirmed" = "finalized",
): Promise<FetchedProgram> {
  const program = await getAccount(id, url, commitment);
  if (!program) throw new Error(`${id}: program account not found at ${hostOf(url)}`);
  if (program.owner !== UPGRADEABLE_LOADER) {
    throw new Error(`${id}: owner ${program.owner} is not the upgradeable loader; extend lib.ts`);
  }
  // UpgradeableLoaderState::Program { programdata_address }: u32 tag (2) + Pubkey.
  if (program.data.readUInt32LE(0) !== 2) throw new Error(`${id}: not a Program account`);
  const programdataAddress = base58(program.data.subarray(4, 36));

  const pd = await getAccount(programdataAddress, url, commitment);
  if (!pd) throw new Error(`${id}: programdata ${programdataAddress} not found`);
  if (pd.data.readUInt32LE(0) !== 3) throw new Error(`${id}: not a ProgramData account`);
  const lastDeploySlot = Number(pd.data.readBigUInt64LE(4));
  const upgradeAuthority = pd.data[12] === 1 ? base58(pd.data.subarray(13, 45)) : "none";
  const elf = Buffer.from(pd.data.subarray(PROGRAMDATA_HEADER));

  return {
    elf,
    pin: {
      id,
      loader: UPGRADEABLE_LOADER,
      programdataAddress,
      upgradeAuthority,
      lastDeploySlot,
      readAtSlot: pd.slot,
      soBytes: elf.length,
      sha256: sha256(elf),
      executableSha256: sha256(stripTrailingZeros(elf)),
    },
  };
}

/**
 * Program IDs as Meteora's own SDKs export them. The manifest must agree with every one, so an ID
 * typo cannot be "proven" by the local validator happily loading bytes at the wrong address.
 */
export function sdkProgramIds(): Record<string, string[]> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
  const damm = require("@meteora-ag/cp-amm-sdk");
  const dlmm = require("@meteora-ag/dlmm");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const ids = dlmm.LBCLMM_PROGRAM_IDS ?? dlmm.default?.LBCLMM_PROGRAM_IDS;
  const s = (k: { toBase58(): string } | string) => (typeof k === "string" ? k : k.toBase58());
  return {
    dbc: [s(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID)],
    damm_v2: [s(damm.CP_AMM_PROGRAM_ID), s(dbc.DAMM_V2_PROGRAM_ID)],
    dlmm: [s(ids["mainnet-beta"])],
    token_metadata: [s(dbc.METAPLEX_PROGRAM_ID)],
    jup_locker: [s(dbc.LOCKER_PROGRAM_ID)],
  };
}

/** The JSON shape `solana account --output json` writes and `solana-test-validator --account` reads. */
export function accountJson(address: string, a: RawAccount): string {
  return (
    JSON.stringify(
      {
        pubkey: address,
        account: {
          lamports: a.lamports,
          data: [a.data.toString("base64"), "base64"],
          owner: a.owner,
          executable: a.executable,
          rentEpoch: a.rentEpoch,
          space: a.space,
        },
      },
      null,
      2,
    ) + "\n"
  );
}
