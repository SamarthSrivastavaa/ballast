# Demo video script — target 2:50, hard maximum 3:00

Numbers are from the corrected run of 11 Oct on a local validator running Meteora's mainnet binaries.
Keep "local validator · Meteora mainnet binaries" on screen from scene 3 to scene 6. Voice calm and
slow. Never say "1.017".

| # | Time | Screen | Caption | Voice-over |
|---|---|---|---|---|
| 1 | 0:00–0:10 | `cards/cold-open.html`: a thin price line climbs, then falls to zero | Most launches have no bottom. | "Every token launch asks you to trust that something is underneath the price. Usually, nothing is." |
| 2 | 0:10–0:20 | `cards/title.html` | Launch with a floor. | "This is Ballast: a Meteora launch with a floor you can see before the first public trade, and verify yourself." |
| 3 | 0:20–0:45 | Terminal `pnpm demo:launch`, then the token page's hero | F = 6.7019e-9 SOL/token · recorded at launch · worst case from the top −74% | "When a creator launches, Ballast computes the floor, F, from the launch parameters alone, and records it on-chain before anyone else can trade. Every buyer sees their worst case up front. Here: seventy-four percent below the curve's final price, down to the floor." |
| 4 | 0:45–1:15 | Terminal `pnpm demo:buy` → `demo:graduate` → `demo:floor`; cut to the token page timeline | DBC → DAMM v2 → DLMM | "Buyers trade on Meteora's Dynamic Bonding Curve. At graduation, eighty-five percent of the raise migrates into DAMM v2 as two positions locked for good, owned by our program. The other fifteen percent, the migration fee, goes into a program vault and becomes a single DLMM limit order resting at F. Three Meteora products, one invariant." |
| 5 | 1:15–1:55 | `cards/break.html` for 2 s, then `pnpm demo:dump` beside `http://localhost:4173/demo-chart.html` | Selling straight into the DAMM v2 pool can execute below F. | "Now we sell everything. Every token holders have. The price slides down the pool's curve, lands on the floor, and the bid absorbs the rest. The worst fill of the whole sell-out: zero point nine nine eight of F, fees included. This isn't a promise from a team. It's liquidity and a limit order, and the program has no instruction that withdraws them." |
| 6 | 1:55–2:20 | Fresh terminal: `pnpm demo:verify`; then 2 s of `PROPTEST_CASES=100000 cargo test -p ballast-floor --test properties` passing | RESULT: FLOOR VERIFIED ✓ | "Don't trust our app. One command reads the raw accounts, recomputes F with the same tested library, and checks it against the vault, the bid and the locked liquidity. Sixteen checks. Same answer, for anyone, every time." |
| 7 | 2:20–2:38 | `cards/traction.html` with the live badge counts | ⟦FILL: real counts⟧ | ⟦FILL, real numbers only. If any count is above zero: "In ⟦N⟧ hours, ⟦A⟧ people outside our team ran the check themselves, and ⟦B⟧ creators asked to launch with Ballast."⟧ ⟦If all are zero: "The verifier and the launch form went public this week. Run the check on any Meteora pool: it takes two minutes."⟧ "And the challenge is open: break the floor." |
| 8 | 2:38–2:55 | `cards/close.html`, then repo and challenge links | Launch with a floor. | "Buyers know their worst case before they buy. Creators launch without being called a rug. Any DBC launchpad can offer it with one config and one instruction. Ballast. Launch with a floor." |

Say somewhere in scenes 5 to 8, or show as a caption for 3 seconds: "Late buyers can lose about 74%.
F is in SOL. Not audited. Not on mainnet yet."
