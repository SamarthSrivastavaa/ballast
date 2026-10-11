# Shot list and recording settings

## Before recording

```bash
source ~/.ballast-env && cd ~/ballast
solana slot --url http://127.0.0.1:8899 || (pnpm localnet --quiet & sleep 60; bash tests/integration/p0/up.sh)
anchor build && cargo build --release -p ballast-verifier
pnpm -F app build && (cd app && pnpm exec vite preview --host 0.0.0.0 --port 4173 &)
pnpm demo:reset          # off camera: wallets, config, class
```

Rehearse the whole sequence twice (`pnpm demo:all`) before the take. Each run makes a new launch;
the take uses its own.

## Shots

| # | Scene | Source | Exact command or URL |
|---|---|---|---|
| 1 | Cold open | Browser, full screen | `submission/video/cards/cold-open.html` |
| 2 | Title | Browser | `submission/video/cards/title.html` |
| 3a | Floor before anyone buys | Terminal | `pnpm demo:launch` |
| 3b | The page | Browser | `http://localhost:4173/?launch=<Launch account from 3a>&rpc=http://localhost:8899` (opens once `demo:floor` has run; film it after 4c and cut it in here) |
| 4a | Buys | Terminal | `pnpm demo:buy` |
| 4b | Graduation | Terminal | `pnpm demo:graduate` |
| 4c | The bid | Terminal | `pnpm demo:floor` |
| 4d | Explorer cuts | Browser | the vault, pair and limit-order links printed by 4c |
| 5a | Card | Browser | `submission/video/cards/break.html` |
| 5b | The dump | Terminal, left half | `pnpm demo:dump` |
| 5c | The chart | Browser, right half | `pnpm demo:chart`, then `http://localhost:4173/demo-chart.html` (space replays; `?speed=0.5` slows it) |
| 6a | Verify | Fresh terminal | `pnpm demo:verify` |
| 6b | Property gate | Terminal, 2 s | `PROPTEST_CASES=100000 cargo test -p ballast-floor --test properties` |
| 7 | Traction | Browser | `submission/video/cards/traction.html` (edit the numbers in the file first; real counts only) |
| 8 | Close | Browser | `submission/video/cards/close.html` |

The dump takes about three minutes of real time. Cut the wait and label it on screen
("⏩ 3 minutes later"); do the same for the buys and for `demo:verify`.

## Recording settings

- 1920×1080 at 60 fps. Terminal font at least 22 pt, dark theme, window maximised.
- Browser zoom 125% for the token page; 100% for the cards and the chart (they are drawn at 1920×1080: press F11).
- Cursor highlight on. Notifications off. Bookmarks bar and other tabs hidden.
- Voice-over recorded separately in a quiet, soft-furnished room, then synced to the picture.
- Every cut wait labelled on screen. Captions burned in (`CAPTIONS_DEMO.srt`, `CAPTIONS_PITCH.srt`).
- Music: none, or at −28 dB.
- Export H.264, upload to YouTube as unlisted, paste the links into `submission/CHECKLIST.md`.
- Keep "local validator · Meteora mainnet binaries" visible in scenes 3 to 6.

## The README GIF

Already rendered: `docs/assets/dump.gif` (960×540, 37 frames, 0.75 MB), by
`CHROME=<chrome> node demo/gif.mjs` with no ffmpeg. To make one from a screen recording instead:

```bash
ffmpeg -i dump-clip.mp4 -t 15 -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" -loop 0 docs/assets/dump.gif
```

Check it is at most 15 s and 8 MB: `ls -l docs/assets/dump.gif`.
