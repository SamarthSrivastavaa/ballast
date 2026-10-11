# Integrate Ballast in a launchpad

A Ballast launch is a normal Meteora DBC launch with one extra instruction. You keep your own UI,
your own token metadata and your own fee split outside the pool.

**What you add:** one instruction, `register_launch`, in the transaction that creates the pool.
**What you use:** a DBC config that is already registered as a Ballast class (10 SOL or 25 SOL
threshold). **What you run, or let anyone run:** the open-source keeper, which sends six
permissionless cranks.

Status: the program runs on Meteora's mainnet binaries on a local validator and is deployed on
devnet; it is not on mainnet. The code below is the code the repository's own tests use
([`tests/integration/program/src/launch.ts`](../tests/integration/program/src/launch.ts)).

## The launch transaction

One transaction, five parts. Parts 1 to 4 are Meteora's own instructions; part 5 is Ballast's.

```ts
// Addresses are all derived; nothing is chosen by the caller.
const pool        = deriveDbcPoolAddress(WSOL, baseMint.publicKey, classConfig);
const launchPda   = pdas.launch(baseMint.publicKey);   // ["launch", mint]
const creatorAuth = pdas.creator(launchPda);           // ["creator", launch]
const vault       = pdas.vault(launchPda);             // ["vault", launch]
const [lbPair]    = deriveCustomizablePermissionlessLbPair(baseMint.publicKey, WSOL, DLMM_ID);

// 1. Meteora DBC: create the pool from the class's config.
const createPool = (await dbcClient.creator.createPool({
  name, symbol, uri, payer: payer.publicKey, poolCreator: creator.publicKey,
  config: classConfig, baseMint: baseMint.publicKey,
})).instructions;

// 2. Meteora DBC: a dust buy, so the launcher holds the base tokens the DLMM pair needs.
const buy = [
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(baseMint.publicKey, payer.publicKey), payer.publicKey, baseMint.publicKey),
  await dbc.methods.swap({ amountIn: bn(CLASS_DUST), minimumAmountOut: bn(0) }).accountsPartial({ /* pool, vaults, mints */ }).instruction(),
];

// 3. Meteora DLMM: the pair the vault's bid will rest in (bin step 10, 1 bps base fee).
const pair = await dlmm.methods.initializeCustomizablePermissionlessLbPair2({
  activeId, binStep: 10, baseFactor: 1000, activationType: 0, hasAlphaVault: false, activationPoint: null,
  creatorPoolOnOffControl: false, baseFeePowerFactor: 0, concreteFunctionType: 0, collectFeeMode: 1, padding,
}).accountsPartial({ lbPair, tokenMintX: baseMint.publicKey, tokenMintY: WSOL, /* reserves, oracle, funder */ }).instruction();

// 4. Meteora DBC: hand the pool-creator role to a Ballast PDA, so the migrated position
//    it will receive can never be split or withdrawn by a person.
const transfer = await dbc.methods.transferPoolCreator()
  .accountsPartial({ virtualPool: pool, config: classConfig, creator: creator.publicKey, newCreator: creatorAuth })
  .instruction();

// 5. Ballast: register the launch. This records the predicted floor on-chain.
const register = await ballast.methods
  .registerLaunch(creatorBeneficiary)          // where the creator's fee income is forwarded
  .accountsPartial({
    class: pdas.class(classConfig), launch: launchPda, virtualPool: pool, baseMint: baseMint.publicKey,
    creatorAuth, partnerAuth: pdas.partner(classConfig), vault, quoteMint: WSOL, dlmmPair: lbPair,
    creator: creator.publicKey, payer: payer.publicKey, instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  })
  .instruction();

const ixs = [...createPool, ...buy, pair, transfer, register];   // one transaction
```

`register_launch` reads the instructions sysvar and refuses unless the pool was created earlier in
the same transaction, the creator role already belongs to `creator_auth`, and nothing but the dust
buy has traded. That is what makes "the floor was predicted before the first public trade" a fact
about the chain rather than a claim.

## After the launch: six permissionless cranks

Anyone can send these; the keeper in [`keeper/`](../keeper) does it for you.

| When | Instruction | What it does |
|---|---|---|
| The curve completes | `settle_graduation` | Claims the 15% migration fee and partner fees into the launch's vault |
| After Meteora migrates the pool (their keeper, or anyone) | `burn_leftover` | Burns the unsold supply |
| Once | `open` | Checks both migrated positions are permanent and PDA-owned; places the vault as one DLMM limit order at F's bin; requires realised F ≥ predicted F |
| When the bid has fills or F moved | `refresh_floor` | Cancels the order, burns the tokens it bought, re-places the vault at the new F's bin |
| On a schedule | `harvest` | Claims the partner position's LP fees: 90% to the vault, 10% to the treasury |
| On a schedule | `pay_creator` | Forwards the creator's fee income to the beneficiary |

```bash
pnpm exec tsx keeper/src/main.ts --rpc <url> --keypair <path> [--launch <addr>...]
```

Holders call `redeem(amount, min_out)` themselves; `floor()` is a read-only view that returns F and
its inputs as return data, so your UI can show the floor without ours.

## Showing the floor in your UI

```ts
import { BallastClient } from "sdk/typescript/src/client";
const client = new BallastClient(connection, idl);
const view   = await client.view(launchAddress);
const report = await client.readFloor(view, view.partnerAuth);   // { s, F, V, S, L, bin, … } from the program's own view
```

`s` is `⌊√F · 2^64⌋`; F in quote units per base unit is `s² / 2^128`. To recompute it yourself, use
the floor crate's WebAssembly build ([`sdk/typescript/src/floor.ts`](../sdk/typescript/src/floor.ts));
do not re-derive F in your own code, so that your number and the chain's can never disagree.

## What a creator gives up, and gets

- The migrated liquidity is permanently locked and owned by the program: 85% of the raise.
- 15% of the raise funds the vault's bid instead of going to the pool.
- The creator's trading-fee income is unchanged and forwarded to the beneficiary wallet.
- In return, buyers can see and verify a worst case before they buy.

## Checking an integration

```bash
ballast verify <mint> --cluster <cluster>     # every check must pass
```
