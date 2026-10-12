# Voice-over

`ballast-demo.mp4` is already narrated. The voice is generated: Kokoro, an open-source neural speech
model (Apache-2.0), voice `af_heart`, run locally in the browser by `demo/film/tts.html`. No account or key.
The clips are in `demo/film/vo/`; the film retimes each scene to its clip. `ballast-demo-silent.mp4` is the
same film without sound.

**Listen once for mispronounced words** (the product names are the likeliest). To fix one, tell Claude the
word and how it should sound; one scene regenerates in under a minute.

To use your own voice instead: open `http://localhost:4174/film.html?prompter=1`, read along into a
recorder, and send the audio file.

Total 2:52.

| Time | Scene | Narration | Clip |
|---|---|---|---|
| 0:00–0:08 | Hook | Ninety-four of the last hundred tokens that graduated from Meteora's bonding curve locked none of their liquidity. | 7.1 s |
| 0:08–0:17 | Title | Ballast is a Meteora launch with a floor: computed on-chain before the first public trade, and verifiable by anyone. | 7.7 s |
| 0:17–0:28 | The result, first | We tested it the hard way. We sold every token holders had. The worst fill of the entire sell-out was point nine nine eight of the floor. | 9.7 s |
| 0:28–1:05 | How it works | Here is how. Buyers trade on the Dynamic Bonding Curve. At graduation, eighty-five percent of the raise migrates into DAMM v2, as two positions that are permanently locked and owned by the program. The other fifteen percent, the bonding curve's migration fee, goes into a program vault and rests as one DLMM limit order at the floor price, F. F is the price at which that bid, plus the locked liquidity, absorbs every token in existence. Remove any one of the three, and there is no floor. | 35.3 s |
| 1:05–1:18 | The floor before anyone buys | The floor is recorded on-chain in the launch transaction itself, before anyone else can trade. So the worst case is a number you know before you buy, instead of unknown, and possibly everything. | 11.8 s |
| 1:18–1:38 | The whole sell-out | Here is the whole sell-out, fill by fill. Each sell goes to whichever venue pays more. The price slides down the pool's curve, lands on the floor, and the bid absorbs the rest. Every fill is burned, so the floor ends higher than it started. | 15.8 s |
| 1:38–1:59 | Don't trust us | Don't trust our app. One command reads the raw accounts and recomputes everything: sixteen checks, down to a ledger that closes to the lamport. And a second command works on mainnet today. Point it at any Meteora pool, and it tells you whether a floor exists. | 18.5 s |
| 1:59–2:11 | The page | The page shows your worst case before you buy, verifies the floor in your browser, and lets any holder redeem with the program at F, less half a percent. | 8.9 s |
| 2:11–2:28 | For launchpads, and underneath | For a launchpad, it is one config and one instruction. Underneath: one implementation of the floor in exact integers, a hundred-thousand-case property gate, and a hundred and sixty-seven tests against Meteora's own mainnet binaries. | 16.3 s |
| 2:28–2:43 | Where it stands | Where it stands, honestly. It runs end to end on Meteora's mainnet binaries. It is not on mainnet yet, and it is not audited. Late buyers can still lose about seventy-four percent. | 13.0 s |
| 2:43–2:52 | Close | A launch whose worst case is a fact, not a promise. Ballast. Launch with a floor. | 6.5 s |
