# X thread

Handles to confirm before posting: Meteora ⟦FILL: confirm handle⟧ · Superteam India ⟦FILL: confirm handle⟧.
Attach the dump-test GIF (`submission/video/dump.gif`) to post 2. Numbers are from the local run of
11 Oct on Meteora's mainnet binaries; update post 6 with the live counts before posting.

**1/**
Every token launch asks you to trust that something is underneath the price.

Ballast is a Meteora launch where the floor is computed on-chain before the first trade, and anyone can check it.

Launch with a floor. 🧵

**2/**
We tested it the hard way: bought a launch to graduation, then sold every token the team held. 72 sells.

Lowest fill: 1.017 × the floor.
The floor ended higher than it started, because every fill is burned.

[GIF]

**3/**
How: at graduation, 85% of the raise migrates into DAMM v2 as two permanently locked, program-owned positions.

The other 15%, the DBC migration fee, rests as ONE DLMM limit order at the floor price F.

DBC + DAMM v2 + DLMM, each carrying part of it. ⟦Meteora handle⟧

**4/**
F is the price at which the locked liquidity plus that bid absorb the entire outstanding supply:

V/F + L·(1/√F − 1/√P_max) = S

One Rust crate computes it. The program, the verifier and the page all call that crate.

**5/**
Don't trust us. One command recomputes it from raw accounts:

curl -fsSL https://raw.githubusercontent.com/SamarthSrivastavaa/ballast/main/install.sh | sh
./ballast check <any Meteora DAMM v2 pool> --cluster mainnet

Try it on a pool you hold.

**6/**
We scanned the 100 newest DBC → DAMM v2 launches on mainnet: 94 had no permanently locked liquidity at all.

⟦FILL with real counts: N people have run the check themselves; M creators asked for a launch⟧

**7/**
What it is not: late buyers can lose about 74%. F is in SOL, not dollars. Selling straight into the DAMM v2 pool can execute below F; the bid and redemption do not. Not audited. Not on mainnet yet.

**8/**
The claim is falsifiable, so there is a challenge: break the floor.

Rules: https://github.com/SamarthSrivastavaa/ballast/blob/main/submission/BREAK_THE_FLOOR.md
Repo: https://github.com/SamarthSrivastavaa/ballast

Built from India for ⟦Superteam India handle⟧.
