# Checklist — what only you can do, and what is still open

## Done by Claude (Sun night)
- [x] Audit (`AUDIT.md`), traction engine (forms, labels, release v0.1.0, `ballast check`), challenge, outreach, thread
- [x] Demo runbook (`pnpm demo:*`), three clean runs; dump chart and README GIF
- [x] README rewritten; `docs/INTEGRATE.md`
- [x] Mainnet dry run and decision sheet (`MAINNET.md`): peak 13.55 SOL, 7.77 spent for good
- [x] Floor card on the page: "Before you buy", "Verify in your browser", floor history, `/launch/<mint>`
- [x] Submissions (`COLOSSEUM.md`, `EARN_METEORA.md`, `EARN_INDIA.md`), `JUDGE_FAQ.md`, video scripts, shot list, captions, cards
- [x] **Correction:** "1.017 × F" was a measurement error; the real worst fill is 0.9984 × F


Updated by Claude as work lands. ⟦FILL⟧ items need you.

## Do now (Sun night)
- [ ] Send the messages in `submission/OUTREACH.md` and post the two community posts (list at the top of that file).
- [x] GitHub labels `launch-request`, `verified`, `break-attempt`: created by a workflow.
- [ ] **Re-record anything that says "1.017".** The correct line is "the worst fill was 0.998 times the floor, fees included".

- [ ] **Host the page on Vercel** (easier than Pages): vercel.com → Add New → Project → import `SamarthSrivastavaa/ballast` → leave every setting as detected → Deploy. `vercel.json` in the repo sets the build. Paste the URL where the submissions say ⟦FILL: Live app⟧
- [ ] **Enable GitHub Pages** (repo → Settings → Pages → Source: "GitHub Actions"), then re-run the `pages` workflow (Actions → pages → Run workflow). Live app: https://samarthsrivastavaa.github.io/ballast/ — paste it where the submissions say ⟦FILL: Live app⟧

## Decide (Mon 07:00 IST)
- [ ] **GO MAINNET or not.** Read `submission/MAINNET.md` (cost table, risks). Type exactly `GO MAINNET` in chat to approve; anything else is NO-GO.
- [ ] Before typing it: confirm you are comfortable with the tax and legal side of launching a token on mainnet, and that the SOL is money you can afford to lose.
- [ ] ⟦FILL: bounty amount for the Break the Floor challenge, or "no bounty"⟧

## Fill in
- [ ] ⟦FILL: your name, role, background, why you care — pitch script 2:10 and Team sections⟧
- [ ] ⟦FILL: X handle, Telegram handle, contact email⟧
- [ ] ⟦FILL: team members⟧
- [ ] Confirm the exact Colosseum cutoff shown in the portal: ⟦FILL⟧ (plan assumes Mon 12 Oct 21:00 IST)
- [ ] Confirm the X handles for Meteora and Superteam India before posting `THREAD.md` (written as ⟦FILL⟧ there)

## Record and submit
- [x] **Demo video: rendered and narrated for you.** `submission/video/ballast-demo.mp4` (also in your Windows `Videos` folder): 2:52, 1080p, a generated voice (open-source, no account), captions burned in. `ballast-demo-silent.mp4` is the same film without sound
- [ ] **Listen to it once** for any mispronounced word (`submission/video/VOICEOVER.md` has the text) and tell Claude what to fix
- [ ] **Upload `ballast-demo.mp4` to YouTube as unlisted** (drag and drop; thumbnail: `submission/video/poster.png`; subtitles: `CAPTIONS_DEMO.srt`) and paste the link: ⟦FILL⟧
- [ ] Pitch video (face to camera, Colosseum reviews it first): `submission/video/PITCH_SCRIPT.md`. Only you can record this one: ⟦FILL: link, or skipped⟧
- [ ] Before filming scene 7: open `submission/video/cards/traction.html` (live counts) and update `TRACTION.md` with the same numbers
- [ ] Repo settings (GitHub → About): description "Launch with a floor: a Meteora DBC launch class with a verifiable, executable buyback floor"; topics `solana meteora dbc dlmm damm-v2 launchpad`
- [ ] Post `submission/THREAD.md` on X after the videos are up (confirm the two handles first)
- [ ] Colosseum: paste from `submission/COLOSSEUM.md` by Mon 21:00 IST
- [ ] Superteam Earn, Meteora: paste from `submission/EARN_METEORA.md` by Tue 09:00 IST (not editable after)
- [ ] Superteam Earn, India: paste from `submission/EARN_INDIA.md` by Tue 09:00 IST (not editable after)

## Known open items
- Mainnet path: written, guarded and rehearsed locally (`scripts/mainnet/README.md`). It needs from you: `GO MAINNET`, a funded keypair outside the repo (15 SOL), a mainnet RPC URL, token name/symbol/metadata URL.
- Devnet cannot host a launch (devnet's DBC writes a config version the program refuses). All launch evidence is on a local validator running Meteora's mainnet binaries.
- Licence: the repo already carries Apache-2.0. Keep it or change it: ⟦FILL⟧
- No external audit. Upgrade authority is a single project key.
