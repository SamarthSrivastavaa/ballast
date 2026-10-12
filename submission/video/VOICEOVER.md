# Voice-over — read this over `ballast-demo.mp4`

Total 2:58. One paragraph per scene; each fits its scene at an easy pace with about a second to spare.
Calm, slow, confident. Say "point nine nine eight", never "one point oh one seven".

**Easiest way to record:** open `http://localhost:4174/film.html?prompter=1` (after `node demo/film/server.mjs`).
The film plays with each line on screen and a countdown; read along into your phone or a voice recorder.
Send me the audio file and I will put it on the video (`film.html?record=1&audio=<file>`).

| Time | Scene | Say | Words |
|---|---|---|---|
| 0:00–0:08 | Hook | Ninety-four of the last hundred tokens that graduated from Meteora's bonding curve locked none of their liquidity. | 17 |
| 0:08–0:16 | Title | Ballast is a Meteora launch with a floor: computed on-chain before the first public trade, and verifiable by anyone. | 19 |
| 0:16–0:28 | The result, first | We tested it the hard way. We sold every token holders had. The worst fill of the entire sell-out was point nine nine eight of the floor. | 27 |
| 0:28–1:02 | How it works | Here is how. Buyers trade on the Dynamic Bonding Curve. At graduation, eighty-five percent of the raise migrates into DAMM v2, as two positions that are permanently locked and owned by the program. The other fifteen percent, the bonding curve's migration fee, goes into a program vault and rests as one DLMM limit order at the floor price, F. F is the price at which that bid, plus the locked liquidity, absorbs every token in existence. Remove any one of the three, and there is no floor. | 87 |
| 1:02–1:18 | The floor before anyone buys | The floor is recorded on-chain in the launch transaction itself, before anyone else can trade. So the worst case is a number you know before you buy, instead of unknown, and possibly everything. | 33 |
| 1:18–1:42 | The whole sell-out | Here is the whole sell-out, fill by fill. Each sell goes to whichever venue pays more. The price slides down the pool's curve, lands on the floor, and the bid absorbs the rest. Every fill is burned, so the floor ends higher than it started. | 45 |
| 1:42–2:06 | Don't trust us | Don't trust our app. One command reads the raw accounts and recomputes everything: sixteen checks, down to a ledger that closes to the lamport. And a second command works on mainnet today. Point it at any Meteora pool, and it tells you whether a floor exists. | 46 |
| 2:06–2:21 | The page | The page shows your worst case before you buy, verifies the floor in your browser, and lets any holder redeem with the program at F, less half a percent. | 29 |
| 2:21–2:36 | For launchpads, and underneath | For a launchpad, it is one config and one instruction. Underneath: one implementation of the floor in exact integers, a hundred-thousand-case property gate, and a hundred and sixty-seven tests against Meteora's own mainnet binaries. | 34 |
| 2:36–2:49 | Where it stands | Where it stands, honestly. It runs end to end on Meteora's mainnet binaries. It is not on mainnet yet, and it is not audited. Late buyers can still lose about seventy-four percent. | 32 |
| 2:49–2:58 | Close | A launch whose worst case is a fact, not a promise. Ballast. Launch with a floor. | 16 |

385 words in 2:58: about 130 words a minute.
