# Superteam Earn — India track (paste-ready)

Submit once, final. Replace every ⟦FILL⟧ first.

**Project:** Ballast — Launch with a floor.

Every token launch asks buyers to trust the creator. Ballast lets creators launch with a floor anyone can verify before buying.

**Links:** Repo https://github.com/SamarthSrivastavaa/ballast · Demo ⟦FILL⟧ · Pitch ⟦FILL⟧ · Colosseum submission ⟦FILL⟧ · X thread ⟦FILL⟧

## Problem and user

When you buy a token at launch, nobody can tell you the worst that can happen to your money. We measured it: of the 100 newest tokens that graduated from Meteora's bonding curve on mainnet (8 Oct), 94 had no permanently locked liquidity at all. Buyers go in blind, and creators who launch in good faith look exactly like the ones who do not.

- **User 1, creators:** people launching a token who want buyers to be able to check, not trust.
- **User 2, launchpads:** platforms that want a launch class with a verifiable floor to offer.
- **Who benefits:** buyers, who see a worst case before they buy.

## What we built

A Ballast launch locks 85% of the raise as permanent liquidity and rests the other 15% as one limit order at a floor price F. F is computed so the two together can absorb every token in existence, and it is recorded on-chain before the first public trade. We tested it by selling every token holders had: the worst fill was 0.998 × F, fees included. One command lets anyone recompute it from raw chain data.

## Early traction

⟦FILL from `submission/TRACTION.md`, real counts with links: independent verifications, launch requests, break attempts, launchpad replies with permission to quote⟧. The verifier and the forms went public on 11 Oct 2026.

## Growth

- **Through launchpads:** one config and one instruction to integrate (`docs/INTEGRATE.md`); every launch on an integrated launchpad is a Ballast launch.
- **Through creators:** a public request form, and a launch page that shows the floor and how to verify it.
- **For newcomers:** a first launch purchase where the worst case is a number on the page, not a hope.

## Ecosystem impact

- `ballast check` is useful beyond Ballast: it measures the locked-liquidity floor under any Meteora DAMM v2 pool, on mainnet, in one command.
- The launch class, the verifier and the keeper are open source under Apache-2.0.

## Built on Meteora

Three Meteora products carry the floor: the Dynamic Bonding Curve runs the launch and its 15% migration fee funds the vault; DAMM v2 holds the permanently locked liquidity; a DLMM limit order is the bid at F. All of it was built and tested against Meteora's mainnet binaries.

## Status, honestly

Runs end to end on a local validator with Meteora's mainnet binaries. Deployed on devnet, with no launch there. ⟦FILL: "Not on mainnet." or the mainnet mint⟧. Not audited. Built in India by ⟦FILL⟧.
