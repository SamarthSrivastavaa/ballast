# The demo film

`submission/video/ballast-demo.mp4`: 2:58, 1920×1080, H.264, captions burned in. Cut 2 (12 Oct) is built
around the Meteora listing's five judging criteria: the result is on screen inside the first 30
seconds, then how each Meteora product carries part of the floor, the full sell-out, the verifier
(and a real mainnet check), the page, the integration and the engineering, and an honest status.

It is a **replay**, and says so on screen: every line of terminal output, every number and every
address is the recorded output of one real run of the demo runbook (`pnpm demo:all`) on a local
validator running Meteora's mainnet binaries. Nothing in it is typed in by hand. Sources:

| In the film | Comes from |
|---|---|
| Terminal lines, addresses, signatures | `evidence/demo/<run>/terminal.log` |
| The predicted floor and the worst case | `evidence/demo/<run>/prediction.json` |
| The sell-out chart and the worst fill | `evidence/demo/<run>/dump.json` (from the verifier's reading of each sell) |
| The 16 checks and the result line | `evidence/demo/<run>/verify.txt` |
| "94 of 100" | `evidence/scanner/scan-100-2026-10-08.json` |
| The page | `evidence/app/token-page-gate9-launch.png`, a Chrome render of a second launch on the same ledger |
| The mainnet check | `evidence/scanner/check-mainnet-2026-10-12.txt`: real output on two mainnet pools, shown as pool A and pool B |
| The integration code | `docs/INTEGRATE.md` |

## Render it again

```bash
pnpm demo:all                                   # a fresh run; save its terminal output as evidence/demo/<id>/terminal.log
node demo/film/build.mjs [run id]               # → demo/film/data.json
node demo/film/server.mjs &                     # http://localhost:4174
# open http://localhost:4174/film.html          to watch it (space pauses, ←/→ seek, r restarts)
# open http://localhost:4174/film.html?record=1 in Chrome and leave the tab in front for 3 minutes:
#   the page records itself and saves submission/video/ballast-demo.mp4
# http://localhost:4174/film.html?prompter=1    the film with the narration on screen and a countdown: read along to record your voice
# http://localhost:4174/film.html?record=1&audio=vo.mp3   record with demo/film/vo.mp3 as the sound track
# http://localhost:4174/film.html?at=112        one still frame, for checking
# http://localhost:4174/check.html?t=112        the recorded file, seeked to that second
```

No ffmpeg, screen recorder or editor is involved: Chrome's own `MediaRecorder` encodes the canvas.
