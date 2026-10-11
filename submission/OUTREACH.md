# Outreach — ready to send

**Send tonight (Sun), in this order:**

| # | Where | Which message |
|---|---|---|
| 1 | Superteam India Discord or Telegram (builders or showcase channel) | "Superteam India post" |
| 2 | Meteora developer Telegram or Discord | "Meteora dev post" |
| 3 | 5 to 10 launchpad operators you can reach by DM | "Launchpad operators" |
| 4 | 5 to 10 token creators or community leads you know | "Creators" |
| 5 | Monday midday, to anyone who has not replied | "Follow-up" |

Replace the first line of each with something personal. Every message is under 80 words. Nothing
here claims users, a mainnet launch or an audit, because none of those exist yet.

Install line used below:
`curl -fsSL https://raw.githubusercontent.com/SamarthSrivastavaa/ballast/main/install.sh | sh`

---

## Superteam India post

> ⟦one personal line⟧
>
> I built a one-command check for any Meteora pool: it tells you the price at which the permanently locked liquidity alone absorbs the whole supply. Most pools return "NO FLOOR".
>
> Takes 2 minutes:
> `curl -fsSL https://raw.githubusercontent.com/SamarthSrivastavaa/ballast/main/install.sh | sh`
> `./ballast check <any DAMM v2 pool> --cluster mainnet`
>
> If you run it, post the output here: https://github.com/SamarthSrivastavaa/ballast/issues/new?template=i-verified.yml

## Meteora dev post

> ⟦one personal line⟧
>
> Ballast is a DBC launch class with a floor: 85% migrates to DAMM v2 as two permanently locked, program-owned positions; the 15% migration fee rests as one DLMM limit order at F. On your mainnet binaries (local validator) we sold the whole supply; the lowest fill was 1.017 × F.
>
> Repo and verifier: https://github.com/SamarthSrivastavaa/ballast
> I'd value feedback on the DLMM limit-order handling.

## Launchpad operators

> ⟦one personal line about their launchpad⟧
>
> I built Ballast: a Meteora DBC launch class where the buyer's worst case is computed before the first trade and anyone can verify it. Integration is one DBC config and one instruction in your launch transaction.
>
> Would you offer a launch class like this? A yes or no is enough. May I quote you?
>
> https://github.com/SamarthSrivastavaa/ballast

## Creators

> ⟦one personal line⟧
>
> Would you launch a token with a floor buyers can verify before they buy? Ballast locks 85% of the raise as permanent liquidity and rests the other 15% as a bid at a floor price that is computed on-chain.
>
> It is not on mainnet yet. If you would use it, a 30-second request here helps a lot:
> https://github.com/SamarthSrivastavaa/ballast/issues/new?template=request-launch.yml

## Follow-up

> Quick nudge on Ballast. If you have 2 minutes, running `./ballast check <pool> --cluster mainnet` on any Meteora pool and posting the output is the most useful thing: https://github.com/SamarthSrivastavaa/ballast/issues/new?template=i-verified.yml
>
> A one-word reply on whether you would use a launch with a verifiable floor works too.
