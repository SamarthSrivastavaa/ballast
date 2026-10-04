/**
 * DBC helpers: the raw Anchor client over the DBC SDK's own IDL (so DBC's on-chain validation —
 * not the SDK's — decides), plus the SDK client for builders that derive many PDAs.
 */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createDbcProgram, DynamicBondingCurveClient, DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn } from "./env";
import { ClassSpec, configParameters, WSOL } from "./config";
import { Pda, PdaKind, pda } from "./proxy";

export const DBC_ID = new PublicKey(DynamicBondingCurveIdl.address);
export const dbc = createDbcProgram(conn, "confirmed").program;
export const dbcClient = new DynamicBondingCurveClient(conn, "confirmed");

export const POOL_CONFIG_DISC = Buffer.from(
  DynamicBondingCurveIdl.accounts.find((a) => a.name === "PoolConfig")!.discriminator,
);
export const VIRTUAL_POOL_DISC = Buffer.from(
  DynamicBondingCurveIdl.accounts.find((a) => a.name === "VirtualPool")!.discriminator,
);

export interface CreatedConfig {
  spec: ClassSpec;
  config: Keypair;
  partner: Pda | null;
  feeClaimer: PublicKey;
  params: ReturnType<typeof configParameters>;
}

/**
 * create_config with fee_claimer = leftover_receiver = the harness partner_auth PDA scoped to the
 * config (§19 step 4). For Lite (no Ballast program) pass an explicit wallet as `feeClaimer`.
 */
export async function createConfigIx(
  spec: ClassSpec,
  payer: PublicKey,
  feeClaimerOverride?: PublicKey,
): Promise<{ ix: TransactionInstruction; created: CreatedConfig }> {
  const config = Keypair.generate();
  const partner = feeClaimerOverride ? null : pda(PdaKind.partnerAuth, config.publicKey);
  const feeClaimer = feeClaimerOverride ?? partner!.address;
  const params = configParameters(spec);
  const ix = await dbc.methods
    .createConfig(params as never)
    .accountsPartial({
      config: config.publicKey,
      feeClaimer,
      leftoverReceiver: feeClaimer,
      quoteMint: WSOL,
      payer,
    })
    .instruction();
  return { ix, created: { spec, config, partner, feeClaimer, params } };
}
