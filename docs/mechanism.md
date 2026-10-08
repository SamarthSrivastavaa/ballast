# How the floor works

## The idea in one paragraph

A token launches on a Meteora bonding curve. When the curve completes, 15% of what buyers paid is
taken as the migration fee into a vault Ballast controls; the other 85% becomes a DAMM v2 pool whose
liquidity is permanently locked and owned by Ballast's program accounts. The whole vault then sits as
one buy order on DLMM at the floor price F. F is chosen so that the locked pool and that buy order,
together, can absorb every token outstanding. So a holder can always sell at F or better: to the bid,
to the pool, or by redeeming directly from the vault. Nobody can withdraw the locked liquidity or the
vault except through those two exits, and every event that touches them raises F or leaves it where it
was.

## The lifecycle

1. **Register.** One atomic transaction creates the DBC pool, makes a dust first buy, creates the DLMM
   pair and hands the pool's creator role to a Ballast account. `register_launch` records the
   **predicted floor** in that same transaction — before anyone else can trade.
2. **Bond.** People buy along the curve. Nothing of Ballast's moves.
3. **Graduate.** `settle_graduation` withdraws the 15% migration fee and the partner trading fees into
   the vault. Meteora migrates the rest into DAMM v2 as two permanently locked positions (partner and
   creator, both owned by Ballast PDAs). `burn_leftover` burns the unsold supply.
4. **Open.** `open` checks both positions are fully permanent, computes F from the live vault, supply
   and liquidity, requires it to be at or above the prediction, and places the entire vault as one DLMM
   bid in the highest bin at or below F.
5. **Live.** Sellers fill the bid; `refresh_floor` collects the fills (cancel → burn → re-place) and moves
   the bid up to the new, higher F. Holders can `redeem` any amount for F less 0.5%, in one atomic
   instruction. `harvest` adds the pool's partner fees to the vault (10% to the treasury), `deposit` lets
   anyone add SOL, `pay_creator` forwards the creator's income. Each one ends by checking F did not fall.

## Why F only rises

- A trade on the pool moves tokens between holders and the pool; supply S, vault V and liquidity L do
  not change, so F does not change.
- A fill sells tokens to the bid at a price at or below F; settling it burns those tokens. The vault
  spent less per token than F, so F rises.
- A redemption pays F less 0.5% per token and burns the tokens; the fee stays in the vault, so F rises.
- Harvests and deposits add to V; burns lower S. Both raise F.

The program enforces it anyway: every mutating instruction ends with `s_new ≥ s_last`, or the whole
transaction reverts.

## The six prices (§9)

| Shown as | What it is |
|---|---|
| **Floor** | F, the root of the floor equation (`math.md`) |
| **Bid** | the DLMM bin price, at or below F, within one 0.1% bin (further while a third party caps it, D-020) |
| **You receive at least** | the bid net of DLMM's taker fee |
| **Market price** | the DAMM v2 pool price — can print below F if a seller bypasses the bid |
| **DAMM v2 sell (net)** | the pool's output less its 1% fee |
| **Redeem** | F less 0.5% |

## What a holder should know

F is in SOL, not dollars. Selling directly on DAMM v2 can execute below F; the bid and redemption
don't. Late buyers can lose most of what they paid: as configured, F sits near 26% of the graduation
price (§22/§23), so a buyer at graduation can lose roughly 74% before reaching the floor. This is an
executable buyback floor on Meteora, not a promise about prices elsewhere.
