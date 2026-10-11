# Mainnet Proof launch — decision sheet

**Default: NO-GO.** Nothing is sent to mainnet unless you type exactly `GO MAINNET` in chat. Until
then everything stays on the local validator (Meteora's mainnet binaries) and all copy says so.

## What it would cost

Measured by `pnpm mainnet:dryrun` on 11 Oct: the whole launch and sell-out on the local validator
with every wallet's balance recorded (`evidence/mainnet-dryrun/cost.md`). Program rent is read from
mainnet. No mainnet transaction was sent.

| Item | SOL | Comes back? |
|---|---|---|
| Program rent (553,456 bytes) | 2.813 | only if the program is closed |
| Deploy buffer | 2.812 | yes, when the deploy finishes |
| Deploy write transactions (547) | 0.003 | no; priority fees are extra |
| DBC config, class, keeper float | 0.210 | no |
| Launch rents and every crank's fees | 0.419 | no (measured at the local validator's rent, which is not below mainnet's) |
| Buys to the 10 SOL threshold | 10.106 | 5.786 on a full sell-out; the rest stays locked for ever |
| **Peak balance needed** | **13.55** | fund **15 SOL** to leave room for priority fees and a retry |
| **Spent for good after a full sell-out** | **7.77** | 4.95 if the program is later closed |

## What it buys

- Public explorer links for every step, and a mint anyone can run `ballast verify --cluster mainnet` on.
- "Deployed on mainnet" for all three submissions, where judges state a preference for it.
- Meteora's own mainnet keeper migrating the pool (10 SOL threshold), which no local run can show.

## What can go wrong

| Risk | How likely | What happens |
|---|---|---|
| **Outsiders buy the token.** A new DBC pool on mainnet is public; bots buy new pools within seconds | Likely | They hold tokens the team cannot sell. The proof becomes "the team sold everything it held"; outsiders are real people who can lose money. The page says "Experimental and unaudited. Only use what you can afford to lose", and late buyers can lose about 74% |
| The deploy stalls on a public RPC (547 write transactions) | Likely on the free public endpoint | Needs a real RPC URL (a free Helius or Triton key is enough). The buffer is recoverable with `solana program close --buffers` |
| Meteora changed a mainnet program since the binaries were dumped | Low; checked | `pnpm fixtures:check` compares hashes against mainnet and must pass in the same hour |
| A step fails midway | Medium | The runbook is staged and resumable; SOL already in the curve can only leave by graduating (10 SOL) or selling back |
| An unknown bug with real third-party money in it | Unknown | The program is unaudited and its upgrade authority is one key. That key could also fix a bug |
| Someone holds the DLMM bid below F by pinning the active bin | Low | Disclosed; redemption still pays F less 0.5% |
| The video and submissions slip because the launch takes the morning | Medium | The local proof is already complete; the launch is extra, not a dependency |

## What I need from you to proceed

1. The message `GO MAINNET`.
2. A mainnet keypair file **outside the repository** holding 15 SOL, and its path.
3. A mainnet RPC URL that accepts transactions.
4. Token details: name ⟦FILL⟧, symbol ⟦FILL⟧, and a metadata URL ⟦FILL⟧ (or I use `Ballast Proof` / `BLST` and a JSON file in this repository).
5. Confirmation that you are comfortable with the tax and legal side of launching a token.

## What would run

The same staged runbook as the demo (`pnpm demo:*`), on mainnet, with the three team wallets buying
3.5, 3.5 and about 3.1 SOL. Recommended window: **Mon 12 Oct, 09:00–10:00 IST.** Order: deploy →
`initialize_global` → DBC config and `create_class` → launch (prediction recorded) → buys → Meteora's
keeper migrates → `settle_graduation`, `burn_leftover`, `open` → team sells every token it holds →
`ballast verify --cluster mainnet`. Team wallets are listed in `submission/TRACTION.md` and excluded
from every user count.

## Not done yet

The harness refuses mainnet by design. The guarded mainnet mode (cluster check, key path from the
environment, priority fees, the literal `GO MAINNET` gate) is written only after the decision, or
overnight if time allows; it is listed in `CHECKLIST.md` until it exists.
