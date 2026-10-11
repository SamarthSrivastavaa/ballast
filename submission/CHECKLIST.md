# Checklist — what only you can do, and what is still open

## Done by Claude (Sun night)
- [x] Audit (`AUDIT.md`), traction engine (forms, labels, release v0.1.0, `ballast check`), challenge, outreach, thread
- [x] Demo runbook (`pnpm demo:*`), three clean runs; dump chart and README GIF
- [x] README rewritten; `docs/INTEGRATE.md`
- [x] Mainnet dry run and decision sheet (`MAINNET.md`): peak 13.55 SOL, 7.77 spent for good
- [x] Submissions (`COLOSSEUM.md`, `EARN_METEORA.md`, `EARN_INDIA.md`), `JUDGE_FAQ.md`, video scripts, shot list, captions, cards
- [x] **Correction:** "1.017 × F" was a measurement error; the real worst fill is 0.9984 × F


Updated by Claude as work lands. ⟦FILL⟧ items need you.

## Do now (Sun night)
- [ ] Send the messages in `submission/OUTREACH.md` and post the two community posts (list at the top of that file).
- [x] GitHub labels `launch-request`, `verified`, `break-attempt`: created by a workflow.
- [ ] **Re-record anything that says "1.017".** The correct line is "the worst fill was 0.998 times the floor, fees included".

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
- [ ] Record demo and pitch videos (`submission/video/SHOTLIST.md`), upload unlisted to YouTube, paste links: ⟦FILL⟧
- [ ] Before filming scene 7: open `submission/video/cards/traction.html` (live counts) and update `TRACTION.md` with the same numbers
- [ ] Repo settings (GitHub → About): description "Launch with a floor: a Meteora DBC launch class with a verifiable, executable buyback floor"; topics `solana meteora dbc dlmm damm-v2 launchpad`
- [ ] Post `submission/THREAD.md` on X after the videos are up (confirm the two handles first)
- [ ] Colosseum: paste from `submission/COLOSSEUM.md` by Mon 21:00 IST
- [ ] Superteam Earn, Meteora: paste from `submission/EARN_METEORA.md` by Tue 09:00 IST (not editable after)
- [ ] Superteam Earn, India: paste from `submission/EARN_INDIA.md` by Tue 09:00 IST (not editable after)

## Known open items
- Mainnet harness mode is not written yet (the harness refuses mainnet by design). It is needed only after `GO MAINNET`.
- Devnet cannot host a launch (devnet's DBC writes a config version the program refuses). All launch evidence is on a local validator running Meteora's mainnet binaries.
- Licence: the repo already carries Apache-2.0. Keep it or change it: ⟦FILL⟧
- No external audit. Upgrade authority is a single project key.
