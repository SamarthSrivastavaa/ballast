# The demo film

`submission/video/ballast-demo.mp4`: 2:54, 1920×1080, H.264, captions burned in, no audio.

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

## Render it again

```bash
pnpm demo:all                                   # a fresh run; save its terminal output as evidence/demo/<id>/terminal.log
node demo/film/build.mjs [run id]               # → demo/film/data.json
node demo/film/server.mjs &                     # http://localhost:4174
# open http://localhost:4174/film.html          to watch it (space pauses, ←/→ seek, r restarts)
# open http://localhost:4174/film.html?record=1 in Chrome and leave the tab in front for 3 minutes:
#   the page records itself and saves submission/video/ballast-demo.mp4
# http://localhost:4174/film.html?at=112        one still frame, for checking
# http://localhost:4174/check.html?t=112        the recorded file, seeked to that second
```

No ffmpeg, screen recorder or editor is involved: Chrome's own `MediaRecorder` encodes the canvas.
