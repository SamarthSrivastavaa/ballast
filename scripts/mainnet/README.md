# Mainnet Proof launch — runbook

**Nothing here runs without the owner typing `GO MAINNET`.** The harness refuses to load in mainnet
mode unless `BALLAST_GO_MAINNET` is exactly that string, and it refuses key paths inside the
repository. Read `submission/MAINNET.md` first: cost, risks, what it buys.

## Dry run (no mainnet transaction)

```bash
pnpm mainnet:dryrun                                        # cost table: evidence/mainnet-dryrun/cost.md
DEMO_AMOUNTS=mainnet DEMO_MIGRATE_FIRST=1 pnpm demo:keeper-path   # the mainnet sequence, rehearsed locally:
                                                           # exact amounts, someone else migrates first, the keeper does the rest
```

Both passed on 11 Oct on the local validator running Meteora's mainnet binaries.

## The real thing (only after `GO MAINNET`)

```bash
source ~/.ballast-env && cd ~/ballast
pnpm fixtures:check                                        # Meteora's mainnet programs still match the binaries we tested
anchor build && cargo build --release -p ballast-verifier
sha256sum target/deploy/ballast.so                         # must be the audited binary: fc09a069…5abb

export BALLAST_CLUSTER=mainnet
export BALLAST_GO_MAINNET="GO MAINNET"
export BALLAST_MAINNET_RPC=<an RPC URL that accepts transactions>
export BALLAST_MAINNET_PAYER=<path to the funded keypair, outside this repository: 15 SOL>
export BALLAST_MAINNET_KEYS=<path for the launch wallets' keys, outside this repository>
export BALLAST_TOKEN_NAME="…" BALLAST_TOKEN_SYMBOL="…" BALLAST_TOKEN_URI="https://…/metadata.json"

pnpm demo:reset        # deploys the program if absent (2.81 SOL rent + a refunded buffer), global, DBC config, class, wallets
pnpm demo:launch       # the launch transaction; the predicted floor is on mainnet from here
pnpm demo:buy          # three wallets buy 3.5 + 3.5 + about 3.1 SOL; the curve graduates
pnpm demo:crank        # the keeper: settle, migrate only if Meteora's keeper has not, burn, open
pnpm demo:dump         # the team sells every token it holds
pnpm demo:verify       # ballast verify <mint> against mainnet
pnpm demo:sweep        # what is left in the launch wallets goes back to the payer
```

Each step is resumable: state is kept in `demo/.state/` and every signature in
`evidence/demo/<id>/signatures.json`. On mainnet every transaction is simulated first and is not sent
if the simulation fails. Priority fee: `BALLAST_CU_PRICE` micro-lamports per compute unit (default
20,000).

## What differs from the rehearsal

- **Other people can trade.** The pool is public the moment it exists. Outsiders' tokens cannot be
  sold by the team; the summary will say what share the team sold.
- **Meteora's keeper** migrates 10 SOL pools itself, usually within seconds. `demo:crank` handles
  either order; the rehearsal covered "migrated before settle".
- **The deploy** is 547 write transactions; a free public endpoint will throttle it.
- Not rehearsed, because it cannot be without spending: mainnet congestion, priority-fee levels, and
  the behaviour of a real RPC under the deploy.

## Afterwards

Fill the mint and the team wallets into `submission/TRACTION.md`, `submission/BREAK_THE_FLOOR.md`
and the README's "Where this ran" table; switch the hosted page's default cluster to mainnet
(`app/src/App.tsx`, `rpcFromUrl`).
