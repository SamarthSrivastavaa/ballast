# Questions a judge will ask

Answers come from the code and the 11 Oct run. Prices are in SOL per token.

**1. Why is the floor below the graduation price, and how far below?**
F is the price at which the locked liquidity plus the vault's bid can absorb every outstanding token, and most tokens were bought along a rising curve well under its final price. On the 10 SOL class the predicted F is 6.70e-9 against a final curve price of 2.60e-8: about 26%, so the worst case from the very top is about −74%. Raising F means putting more of the raise in the vault and less in the pool.

**2. What if nobody arbitrages between DAMM v2 and DLMM?**
The floor does not need an arbitrageur: the bid is a resting DLMM order any holder can sell into directly, and redemption pays F less 0.5% from the vault whatever the pool price is. A seller who uses only the pool can execute below F, which we state everywhere. In our full sell-out, routing each sell to the better venue gave a worst fill of 0.998 × F.

**3. What stops the team from pulling the bid or the liquidity?**
Both migrated positions are permanently locked by DAMM v2 itself and their NFTs are held by program PDAs; the vault is a PDA-owned account whose only two exits in the code are its own DLMM order and a redeemer burning tokens in the same instruction. The program has no withdraw or cancel-and-keep instruction. It is upgradeable by a single project key until an audit, and we say so.

**4. What happens after the bid fills?**
Anyone can call `refresh_floor`: it cancels the order, burns the tokens the bid bought, and re-places what is left of the vault at the new F's bin. Burning lowers the supply, so F rises for everyone who remains. When the vault is spent, F is held by the locked liquidity alone, and the on-chain check still requires that F did not fall.

**5. Who effectively pays for the floor?**
The buyers on the curve: 15% of the raise funds the vault instead of pool depth, so the pool is thinner and trades move it more. Nothing is subsidised and there are no emissions.

**6. Why not just lock 100% of the liquidity?**
You can, and `ballast check` measures exactly that floor for any Meteora pool. The vault turns 15% of the raise into a bid at one price: at open it absorbs about 26% of the supply at F, on top of what the locked pool absorbs. It also makes redemption possible, which pays a holder without touching the pool.

**7. Is it audited?**
No. Two internal reviews found no critical or high issue, 167 program tests run on Meteora's mainnet binaries, and a model fuzzer ran 10 million steps with no failure. An external audit is the first roadmap item.

**8. How does this make money?**
The code sends 10% of the LP fees earned by the program's own locked position to a treasury account when `harvest` runs; the other 90% goes into the vault and raises F. There is no token and no fee on buyers beyond Meteora's own.

**9. Why would a launchpad adopt it?**
It is a launch class they can offer with one DBC config and one extra instruction in their launch transaction; the cranks are permissionless and the keeper is open source. Their buyers get a worst case they can verify without trusting the launchpad.

**10. What is on mainnet versus devnet?**
Mainnet: nothing deployed; `ballast check` and `ballast scan` read it. Devnet: the program is deployed, but no launch exists, because devnet's DBC writes a config version the program refuses. The full lifecycle runs on a local validator with Meteora's mainnet binaries, and anyone can reproduce it.
