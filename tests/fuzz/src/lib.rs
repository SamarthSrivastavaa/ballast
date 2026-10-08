//! §14 stateful model fuzzer.
//!
//! A Rust model of one open launch — V (vault + the DLMM bid), S (supply − staging), L and the
//! DAMM v2 pool that L describes — driven through random sequences of the operations the market
//! and the program perform: DAMM buys and sells, sells into the bid, `refresh_floor`, `redeem`,
//! `harvest`, `deposit`, `pay_creator`, base sent to the staging ATA, and third parties pinning or
//! moving the DLMM active bin (D-020/D-021). After every step:
//!
//! 1. **F never falls.** Every program instruction ends at `s ≥ s_last` (§4 rule 3, which the
//!    program enforces with a revert — a failure here would be a stuck instruction); market steps
//!    never lower `s`.
//! 2. **The floor equation holds:** `s` is the exact floor of the root, so
//!    `V/F + L(1/√F − 1/√P_max) ≥ S` (`ballast_floor::invariant_holds`).
//! 3. **No negative balances:** every amount is checked arithmetic; an underflow is a failure.
//! 4. **Conservation** of SOL to the lamport and of base to the unit, burns included.
//! 5. **Pool solvency:** DAMM reserves stay ≥ the formula amounts for L at the current price.
//!
//! Periodically, and at the end of every run, a copy of the state is **sold out completely**: every
//! holder's tokens, chunk by chunk, each to the best of DAMM v2, the DLMM bid and redemption. The
//! lowest execution must be ≥ 0.99·F as F stood before the sell-out (§18 gate 8), and the pool
//! must end at or above that F.
//!
//! Model choices, each conservative for the checks: the DLMM taker fee is 10 bps (the class pair
//! charges 1 bps); DAMM v2 charges 1% in quote with 20% to the protocol; rounding favours the pool
//! and the bid as Meteora's does. F, payouts and bin comparisons come from `ballast-floor`, bin
//! prices from DLMM's vendored price function — the model reimplements neither.

use ballast::dlmm::price_q64;
use ballast_floor::{
    bin_at_or_below, floor_sqrt_q64, invariant_holds, redeem_payout, FloorInputs, S_MAX_DAMM_V2,
};
use ruint::aliases::U256;

pub const S_MIN: u128 = 4_295_048_016;
pub const S_MAX: u128 = S_MAX_DAMM_V2;
pub const DAMM_FEE_BPS: u64 = 100;
pub const PROTOCOL_SHARE_PCT: u64 = 20;
pub const DLMM_FEE_BPS: u64 = 10;
pub const REDEEM_FEE_BPS: u16 = 50;
pub const MIN_PAYOUT: u64 = 1_000_000;
pub const TREASURY_BPS: u64 = 1_000;
pub const BIN_STEP: u16 = 10;
pub const MAX_CAP_DEPTH: i32 = 70;
/// The class pair's `min_bin_id` at bin step 10 (evidence/program/part2/dlmm-bin-range.json).
pub const MIN_BIN: i32 = -35_163;
pub const HOLDERS: usize = 8;
/// DBC's fixed pre-migration supply for the classes (§7): 10^15 base units.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;

/// A failure: an invariant broke or an amount went negative.
pub type R<T> = Result<T, String>;

fn sub(a: u64, b: u64, what: &str) -> R<u64> {
    a.checked_sub(b)
        .ok_or_else(|| format!("negative {what}: {a} − {b}"))
}
fn add(a: u64, b: u64, what: &str) -> R<u64> {
    a.checked_add(b)
        .ok_or_else(|| format!("overflow {what}: {a} + {b}"))
}
fn u(x: u128) -> U256 {
    U256::from(x)
}
fn to_u64(x: U256, what: &str) -> R<u64> {
    u64::try_from(x).map_err(|_| format!("{what} exceeds u64"))
}
fn to_u128(x: U256, what: &str) -> R<u128> {
    u128::try_from(x).map_err(|_| format!("{what} exceeds u128"))
}

/// DAMM v2 base reserve for L at sqrt price `s` (Q64): `L·(s_max − s)/(s·s_max)`, floored.
pub fn amount_a(l: u128, s: u128) -> U256 {
    u(l) * u(S_MAX - s) / (u(s) * u(S_MAX))
}
/// DAMM v2 quote reserve: `L·(s − s_min)/2^128`, floored.
pub fn amount_b(l: u128, s: u128) -> U256 {
    (u(l) * u(s - S_MIN)) >> 128
}

/// `price(id) ≤ F` with the program's convention for bins without a price (the sign decides).
pub fn below(id: i32, s: u128) -> bool {
    match price_q64(id, BIN_STEP) {
        Some(p) => !bin_at_or_below(0, p, s),
        None => id < 0,
    }
}

/// F's bin: the highest bin whose DLMM price is at or below F (§9), found independently of the
/// program's search (float estimate, then exact correction).
pub fn floor_bin(s: u128) -> i32 {
    let f = (s as f64).powi(2) / 2f64.powi(128);
    let mut id = (f.ln() / (1.0 + f64::from(BIN_STEP) / 1e4).ln()).floor() as i32;
    while !below(id, s) {
        id -= 1;
    }
    while below(id + 1, s) {
        id += 1;
    }
    id
}

/// F in Q64.64 lamports per base unit: `s²/2^64`.
pub fn f_q64(s: u128) -> U256 {
    (u(s) * u(s)) >> 64
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Wallet {
    pub base: u64,
    pub quote: u64,
}

/// The one resting DLMM limit order (§9).
#[derive(Clone, Debug)]
pub struct Bid {
    pub bin: i32,
    pub price: u128,
    pub committed: u64,
    pub remaining: u64,
    pub filled: u64,
    pub fees: u64,
}

/// Where the vault rests after a placement (D-020, D-021).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leg {
    Placed,
    Capped,
    Suspended,
    Empty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// `open` / `refresh_floor`: may move the active bin up when nothing pins it.
    Keeper,
    /// `redeem`: never moves the active bin.
    Redeem,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub ops: [u64; 13],
    pub reverted: u64,
    pub refreshes: u64,
    pub redeems: u64,
    pub capped: u64,
    pub suspended: u64,
    pub sellouts: u64,
    /// Lowest execution in any sell-out, as parts per million of F at its start.
    pub min_exec_ppm: u64,
    /// Lowest end-of-sell-out pool price, as parts per million of F at its start.
    pub min_pool_end_ppm: u64,
    /// Largest observed rise of s within a run (ppm of the run's first s).
    pub max_rise_ppm: u64,
    /// Sell-outs that included holders below the §10 redemption minimum, and their lowest
    /// execution (reported, not gated).
    pub dust_sellers: u64,
    pub min_dust_exec_ppm: u64,
}

pub const OP_NAMES: [&str; 13] = [
    "damm_buy",
    "damm_sell",
    "bid_fill",
    "refresh_floor",
    "redeem",
    "harvest",
    "deposit",
    "pay_creator",
    "staging_donation",
    "pin_active_bin",
    "unpin",
    "move_active_up",
    "sellout",
];

#[derive(Clone, Debug)]
pub struct Model {
    pub holders: [Wallet; HOLDERS],
    pub supply: u64,
    pub burned: u64,
    pub staging: u64,
    pub vault: u64,
    pub bid: Option<Bid>,
    pub leg: Leg,
    pub active: i32,
    pub pin: Option<i32>,
    pub l: u128,
    pub pool_s: u128,
    pub pool_base: u64,
    pub pool_quote: u64,
    pub fee_partner: u64,
    pub fee_creator: u64,
    pub protocol: u64,
    pub treasury: u64,
    pub beneficiary: u64,
    pub fill_quote_spent: u64,
    pub s_last: u128,
    quote_total: u128,
    initial_supply: u64,
}

impl Model {
    /// An open launch: holders, a pool at `pool_s` holding its formula reserves (rounded up, as DBC
    /// migrates them), the vault, and the first bid placed by `open` (the keeper moves the active
    /// bin up from the launch's p0 bin).
    pub fn open(
        holders: [Wallet; HOLDERS],
        l: u128,
        pool_s: u128,
        vault: u64,
        p0_bin: i32,
    ) -> R<Self> {
        let pool_base = to_u64(amount_a(l, pool_s) + U256::from(2u8), "pool base")?;
        let pool_quote = to_u64(amount_b(l, pool_s) + U256::from(1u8), "pool quote")?;
        let held: u64 = holders
            .iter()
            .try_fold(0u64, |a, h| add(a, h.base, "holders"))?;
        let supply = add(held, pool_base, "supply")?;
        let mut m = Model {
            holders,
            supply,
            burned: 0,
            staging: 0,
            vault,
            bid: None,
            leg: Leg::Empty,
            active: p0_bin,
            pin: None,
            l,
            pool_s,
            pool_base,
            pool_quote,
            fee_partner: 0,
            fee_creator: 0,
            protocol: 0,
            treasury: 0,
            beneficiary: 0,
            fill_quote_spent: 0,
            s_last: 0,
            quote_total: 0,
            initial_supply: supply,
        };
        m.quote_total = m.quote_sum();
        let s = m.s_now()?;
        m.place(s, Mode::Keeper)?;
        m.s_last = m.s_now()?;
        m.check()?;
        Ok(m)
    }

    fn quote_sum(&self) -> u128 {
        let b = self
            .bid
            .as_ref()
            .map(|b| b.remaining as u128 + b.fees as u128)
            .unwrap_or(0);
        self.holders.iter().map(|h| h.quote as u128).sum::<u128>()
            + self.vault as u128
            + b
            + self.pool_quote as u128
            + self.fee_partner as u128
            + self.fee_creator as u128
            + self.protocol as u128
            + self.treasury as u128
            + self.beneficiary as u128
    }

    pub fn inputs(&self) -> FloorInputs {
        FloorInputs {
            v: self.vault + self.bid.as_ref().map(|b| b.committed).unwrap_or(0),
            s: self.supply - self.staging,
            l: self.l,
            s_max: S_MAX,
        }
    }

    /// `s` from live V, S, L — what `floor()` returns.
    pub fn s_now(&self) -> R<u128> {
        floor_sqrt_q64(&self.inputs()).map_err(|e| format!("floor inputs out of range: {e:?}"))
    }

    pub fn holder_base(&self) -> u64 {
        self.holders.iter().map(|h| h.base).sum()
    }

    /// Invariants 1–5.
    pub fn check(&self) -> R<()> {
        let s = self.s_now()?;
        if s < self.s_last {
            return Err(format!("F fell: s {s} < s_last {}", self.s_last));
        }
        if !invariant_holds(&self.inputs(), s) {
            return Err(format!(
                "floor equation: s {s} is not the floor of the root for {:?}",
                self.inputs()
            ));
        }
        if self.quote_sum() != self.quote_total {
            return Err(format!(
                "SOL not conserved: {} ≠ {}",
                self.quote_sum(),
                self.quote_total
            ));
        }
        let filled = self.bid.as_ref().map(|b| b.filled).unwrap_or(0);
        let held = self.holder_base() as u128
            + self.pool_base as u128
            + filled as u128
            + self.staging as u128;
        if held != self.supply as u128
            || self.supply as u128 + self.burned as u128 != self.initial_supply as u128
        {
            return Err(format!(
                "tokens not conserved: held {held}, supply {}, burned {}",
                self.supply, self.burned
            ));
        }
        if U256::from(self.pool_base) < amount_a(self.l, self.pool_s)
            || U256::from(self.pool_quote) < amount_b(self.l, self.pool_s)
        {
            return Err("pool reserves below the formula amounts".into());
        }
        Ok(())
    }

    // ---- market operations ---------------------------------------------------------------------

    fn damm_fee(&mut self, fee: u64) -> R<()> {
        let protocol = fee * PROTOCOL_SHARE_PCT / 100;
        let lp = fee - protocol;
        let partner = lp / 2;
        self.protocol = add(self.protocol, protocol, "protocol fees")?;
        self.fee_partner = add(self.fee_partner, partner, "partner fees")?;
        self.fee_creator = add(self.fee_creator, lp - partner, "creator fees")?;
        Ok(())
    }

    /// DAMM v2 buy: `q` quote in (1% fee in quote), base out; rounding favours the pool.
    pub fn damm_buy(&mut self, h: usize, q: u64) -> R<bool> {
        if q == 0 || q > self.holders[h].quote {
            return Ok(false);
        }
        let fee = (q * DAMM_FEE_BPS).div_ceil(10_000);
        let q_net = q - fee;
        let ds = to_u128((u(q_net as u128) << 128) / u(self.l), "Δs")?;
        let s1 = self.pool_s.checked_add(ds).ok_or("s overflow")?;
        if s1 >= S_MAX {
            return Ok(false);
        }
        let out = to_u64(
            u(self.l) * u(s1 - self.pool_s) / (u(self.pool_s) * u(s1)),
            "base out",
        )?;
        if out > self.pool_base {
            return Ok(false);
        }
        self.holders[h].quote -= q;
        self.holders[h].base = add(self.holders[h].base, out, "holder base")?;
        self.pool_quote = add(self.pool_quote, q_net, "pool quote")?;
        self.pool_base -= out;
        self.pool_s = s1;
        self.damm_fee(fee)?;
        Ok(true)
    }

    /// DAMM v2 sell: `b` base in, quote out less 1%. Returns the net quote, or None if refused.
    pub fn damm_sell(&mut self, h: usize, b: u64) -> R<Option<u64>> {
        if b == 0 || b > self.holders[h].base {
            return Ok(None);
        }
        let num = u(self.l) * u(self.pool_s);
        let den = u(self.l) + U256::from(b) * u(self.pool_s);
        let s1 = to_u128(num.div_ceil(den), "s1")?;
        if s1 <= S_MIN || s1 > self.pool_s {
            return Ok(None);
        }
        let gross = to_u64((u(self.l) * u(self.pool_s - s1)) >> 128, "quote out")?;
        if gross > self.pool_quote {
            return Ok(None);
        }
        let fee = (gross * DAMM_FEE_BPS).div_ceil(10_000);
        let out = gross - fee;
        self.holders[h].base -= b;
        self.holders[h].quote = add(self.holders[h].quote, out, "holder quote")?;
        self.pool_quote -= gross;
        self.pool_base = add(self.pool_base, b, "pool base")?;
        self.pool_s = s1;
        self.damm_fee(fee)?;
        Ok(Some(out))
    }

    /// A seller fills (part of) the bid at its bin price, paying the taker fee to the maker (Q5).
    /// Offering at least the base the rest of the order buys takes exactly that rest; a fill that
    /// would pay nothing is refused, as DLMM's swap would be. Returns `(base sold, net quote)`.
    pub fn bid_fill(&mut self, h: usize, b: u64) -> R<Option<(u64, u64)>> {
        let Some(bid) = self.bid.as_mut() else {
            return Ok(None);
        };
        if bid.remaining == 0 {
            return Ok(None);
        }
        let b = b.min(self.holders[h].base);
        let rest: U256 = u(bid.remaining as u128) << 64;
        let need = u64::try_from(rest.div_ceil(u(bid.price))).unwrap_or(u64::MAX);
        let (b, gross) = if b >= need {
            (need, bid.remaining)
        } else {
            (
                b,
                to_u64((U256::from(b) * u(bid.price)) >> 64, "bid gross")?,
            )
        };
        if b == 0 || gross == 0 {
            return Ok(None);
        }
        let fee = (gross * DLMM_FEE_BPS).div_ceil(10_000);
        bid.remaining = sub(bid.remaining, gross, "bid remaining")?;
        bid.fees += fee;
        bid.filled += b;
        let out = gross - fee;
        self.holders[h].base -= b;
        self.holders[h].quote = add(self.holders[h].quote, out, "holder quote")?;
        if bid.remaining == 0 {
            // Bin consumed: DLMM's active bin moves below it.
            self.active = self.active.min(bid.bin - 1);
        }
        Ok(Some((b, out)))
    }

    /// Anyone may send base to `partner_auth`'s staging ATA (S excludes it; the next settlement
    /// burns it).
    pub fn donate(&mut self, h: usize, b: u64) -> R<bool> {
        if b == 0 || b > self.holders[h].base {
            return Ok(false);
        }
        self.holders[h].base -= b;
        self.staging += b;
        Ok(true)
    }

    /// A bid rests with quote left in it.
    pub fn bid_live(&self) -> bool {
        self.bid.as_ref().map(|b| b.remaining > 0).unwrap_or(false)
    }

    /// A third party parks a dust order at `to` and moves the active bin there (go_to_a_bin); DLMM
    /// refuses to move it across a resting order, so it cannot pass below a live bid's bin.
    pub fn pin_at(&mut self, to: i32) -> bool {
        let floor = if self.bid_live() {
            self.bid.as_ref().map(|b| b.bin + 1).unwrap_or(MIN_BIN)
        } else {
            MIN_BIN
        };
        let to = to.max(floor).max(MIN_BIN);
        if self.pin.is_some() || to > self.active {
            return false;
        }
        self.active = to;
        self.pin = Some(to);
        true
    }

    pub fn unpin(&mut self) -> bool {
        self.pin.take().is_some()
    }

    /// go_to_a_bin upward by anyone, when nothing pins the active bin.
    pub fn move_up(&mut self, k: i32) -> bool {
        if self.pin.is_some() || k <= 0 {
            return false;
        }
        self.active = self.active.saturating_add(k).min(-MIN_BIN);
        true
    }

    // ---- program instructions ------------------------------------------------------------------

    /// Cancel the resting order (fills to staging, unfilled + fees to the vault), then burn the whole
    /// staging balance (§5, audit 7 Oct).
    fn settle(&mut self) -> R<()> {
        if let Some(bid) = self.bid.take() {
            let back = add(bid.remaining, bid.fees, "returned quote")?;
            self.vault = add(self.vault, back, "vault")?;
            self.staging = add(self.staging, bid.filled, "staging")?;
            self.fill_quote_spent += bid.committed.saturating_sub(back);
        }
        self.supply = sub(self.supply, self.staging, "supply")?;
        self.burned = add(self.burned, self.staging, "burned")?;
        self.staging = 0;
        Ok(())
    }

    /// D-020/D-021 placement of the whole vault for floor `s`.
    fn place(&mut self, s: u128, mode: Mode) -> R<()> {
        let fb = floor_bin(s);
        let (bin, leg) = if self.active >= fb {
            (Some(fb), Leg::Placed)
        } else if mode == Mode::Keeper && self.pin.is_none() {
            self.active = fb; // go_to_a_bin(F's bin)
            (Some(fb), Leg::Placed)
        } else if below(self.active.saturating_add(MAX_CAP_DEPTH + 1), s) {
            (None, Leg::Suspended)
        } else {
            (Some(self.active), Leg::Capped)
        };
        self.leg = leg;
        if let Some(bin) = bin {
            if self.vault == 0 {
                self.leg = Leg::Empty;
                return Ok(());
            }
            let price =
                price_q64(bin, BIN_STEP).ok_or_else(|| format!("no DLMM price at bin {bin}"))?;
            if !below(bin, s) {
                return Err(format!("bid bin {bin} above F"));
            }
            self.bid = Some(Bid {
                bin,
                price,
                committed: self.vault,
                remaining: self.vault,
                filled: 0,
                fees: 0,
            });
            self.vault = 0;
        }
        Ok(())
    }

    /// §4 rule 3 at the end of a program instruction.
    fn monotone(&mut self) -> R<()> {
        let s = self.s_now()?;
        if s < self.s_last {
            return Err(format!(
                "monotone check would revert: s {s} < s_last {}",
                self.s_last
            ));
        }
        self.s_last = s;
        Ok(())
    }

    pub fn refresh_floor(&mut self) -> R<()> {
        self.settle()?;
        let s = self.s_now()?;
        self.place(s, Mode::Keeper)?;
        self.monotone()
    }

    /// §10 atomic redeem. Returns the payout, or None where the program refuses (payout below the
    /// minimum or above the vault).
    pub fn redeem(&mut self, h: usize, t: u64) -> R<Option<u64>> {
        if t == 0 || t > self.holders[h].base {
            return Ok(None);
        }
        let mut m = self.clone();
        m.settle()?;
        let s = m.s_now()?;
        let payout = redeem_payout(t, s, REDEEM_FEE_BPS);
        if payout < MIN_PAYOUT || payout > m.vault {
            return Ok(None);
        }
        m.vault -= payout;
        m.holders[h].quote = add(m.holders[h].quote, payout, "holder quote")?;
        m.holders[h].base -= t;
        m.supply = sub(m.supply, t, "supply")?;
        m.burned = add(m.burned, t, "burned")?;
        let s1 = m.s_now()?;
        if s1 < s {
            return Err(format!("redemption lowered s: {s1} < {s}"));
        }
        m.place(s1, Mode::Redeem)?;
        m.monotone()?;
        *self = m;
        Ok(Some(payout))
    }

    pub fn harvest(&mut self) -> R<()> {
        let claimed = self.fee_partner;
        let to_treasury = claimed * TREASURY_BPS / 10_000;
        self.fee_partner = 0;
        self.treasury = add(self.treasury, to_treasury, "treasury")?;
        self.vault = add(self.vault, claimed - to_treasury, "vault")?;
        self.monotone()
    }

    pub fn deposit(&mut self, h: usize, q: u64) -> R<bool> {
        if q == 0 || q > self.holders[h].quote {
            return Ok(false);
        }
        self.holders[h].quote -= q;
        self.vault = add(self.vault, q, "vault")?;
        self.monotone()?;
        Ok(true)
    }

    pub fn pay_creator(&mut self) -> R<()> {
        self.beneficiary = add(self.beneficiary, self.fee_creator, "beneficiary")?;
        self.fee_creator = 0;
        self.monotone()
    }

    // ---- the sell-out (gate 8) -----------------------------------------------------------------

    /// What a rational seller does with `c` of holder `h`'s base: the best net price per unit of
    /// DAMM v2, the bid and redemption (sized down to fit the vault; settlement happens inside).
    /// Returns `(venue, state after, base sold, net quote)`.
    pub fn best_trade(&self, h: usize, c: u64) -> R<Option<(&'static str, Model, u64, u64)>> {
        let mut best: Option<(&'static str, Model, u64, u64)> = None;
        let mut consider = |venue: &'static str, cand: Option<(Model, u64, u64)>| {
            if let Some((st, b, q)) = cand {
                let better = match &best {
                    None => true,
                    Some((_, _, bb, bq)) => {
                        U256::from(q) * U256::from(*bb) > U256::from(*bq) * U256::from(b)
                    }
                };
                if better && b > 0 {
                    best = Some((venue, st, b, q));
                }
            }
        };
        let mut p = self.clone();
        consider("damm", p.damm_sell(h, c)?.map(|q| (p, c, q)));
        let mut p = self.clone();
        consider("bid", p.bid_fill(h, c)?.map(|(b, q)| (p, b, q)));
        let mut t = c;
        while t > 0 {
            let mut p = self.clone();
            if let Some(q) = p.redeem(h, t)? {
                consider("redeem", Some((p, t, q)));
                break;
            }
            t /= 2;
        }
        Ok(best)
    }

    /// §18 gate 8 on a copy of the state: every holder sells everything, in chunks, each to the
    /// best venue. A holder whose whole balance would redeem for less than §10's 0.001 SOL minimum
    /// is dust and sells last. Every non-dust trade must execute at ≥ 0.99·F as F stood at the
    /// start, and the pool must still be at or above that F when the non-dust holders are done.
    /// Dust executions are reported, not gated: while a third party caps the bid (D-020) dust can
    /// only reach a capped bid or the pool (the disclosure in D-020).
    pub fn sellout(&self, chunks: u64) -> R<Sellout> {
        let mut m = self.clone();
        let s0 = m.s_now()?;
        let f0 = f_q64(s0).max(U256::from(1u8));
        let ppm = |x: U256| (x * U256::from(1_000_000u32) / f0).to::<u128>() as u64;
        let dust = |b: u64| redeem_payout(b, s0, REDEEM_FEE_BPS) < MIN_PAYOUT;
        // The smallest chunk that redeems for ≥ 2·MIN_PAYOUT at F (a power-of-two search).
        let mut min_chunk = 1u64;
        while redeem_payout(min_chunk, s0, REDEEM_FEE_BPS) < 2 * MIN_PAYOUT
            && min_chunk < u64::MAX / 2
        {
            min_chunk *= 2;
        }
        let chunk = (m.holder_base() / chunks.max(1)).max(min_chunk);
        let mut out = Sellout {
            exec_ppm: u64::MAX,
            pool_ppm: 0,
            stranded: 0,
            dust_exec_ppm: None,
        };
        let mut guard = 0u64;
        let mut dust_phase = false;
        loop {
            guard += 1;
            if guard > chunks * 40 + 10_000 {
                return Err("sell-out did not finish".into());
            }
            let live = (0..HOLDERS)
                .filter(|&i| m.holders[i].base > 0 && (dust_phase || !dust(m.holders[i].base)));
            let Some(h) = live.max_by_key(|&i| m.holders[i].base) else {
                if dust_phase {
                    break;
                }
                // Non-dust holders are done. The pool may sit below F only by the price impact of
                // the quote no one could redeem (a remainder under §10's 0.001 SOL minimum, e.g.
                // in a capped bid): absorbing its worth at F, n = V·2^128/s², moves the pool from
                // s to L·s/(L + n·s). Anything lower would mean holders were pushed past F.
                let stranded = m.vault as u128
                    + m.bid
                        .as_ref()
                        .map_or(0, |b| b.remaining as u128 + b.fees as u128);
                let worth: U256 = U256::from(stranded) << 128;
                let n = worth.div_ceil(u(s0) * u(s0));
                let bound = u(self.l) * u(s0) / (u(self.l) + n * u(s0));
                out.pool_ppm = ppm(f_q64(m.pool_s));
                out.stranded = stranded as u64;
                if u(m.pool_s) + U256::from(1u8) < bound {
                    return Err(format!(
                        "sell-out pushed the pool to {} ppm of F (bound {} ppm from {stranded} stranded lamports)",
                        out.pool_ppm,
                        ppm(f_q64(bound.to::<u128>())),
                    ));
                }
                dust_phase = true;
                continue;
            };
            let base = m.holders[h].base;
            let c = if dust_phase || base <= 2 * chunk {
                base
            } else {
                chunk
            };
            let Some((venue, next, b, q)) = m.best_trade(h, c)? else {
                return Err(format!(
                    "no venue takes {c} base (pool s {}, F s {s0})",
                    m.pool_s
                ));
            };
            // Integer settlement costs a seller at most 2 lamports per trade (a floored amount and
            // a ceiled fee); credited so the check measures the mechanism, not the rounding.
            let exec = ppm((U256::from(q + 2) << 64) / U256::from(b));
            if dust_phase {
                out.dust_exec_ppm = Some(out.dust_exec_ppm.map_or(exec, |d| d.min(exec)));
            } else {
                if exec < 990_000 {
                    return Err(format!(
                        "{venue} executed {b} base for {q} lamports at {exec} ppm of F; pool {} → {} ppm, leg {:?}, bid {:?}, vault {}",
                        ppm(f_q64(m.pool_s)),
                        ppm(f_q64(next.pool_s)),
                        m.leg,
                        m.bid.as_ref().map(|x| (x.bin, ppm(U256::from(x.price)), x.remaining)),
                        m.vault,
                    ));
                }
                out.exec_ppm = out.exec_ppm.min(exec);
            }
            m = next;
            m.check()?;
        }
        if out.exec_ppm == u64::MAX {
            out.exec_ppm = 1_000_000;
        }
        Ok(out)
    }
}

/// Gate 8's measurements, in ppm of F at the start of the sell-out.
#[derive(Clone, Copy, Debug)]
pub struct Sellout {
    /// Lowest non-dust execution (≥ 990,000 or the sell-out fails).
    pub exec_ppm: u64,
    /// Pool price once every non-dust holder has sold: at or above F, less at most the price impact
    /// of `stranded`.
    pub pool_ppm: u64,
    /// Quote left in the vault and bid when the non-dust holders are done.
    pub stranded: u64,
    /// Lowest execution of a holder whose whole balance is below the §10 redemption minimum.
    pub dust_exec_ppm: Option<u64>,
}

/// splitmix64: deterministic, dependency-free.
#[derive(Clone)]
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }
    /// Uniform in [lo, hi] (as a float factor).
    pub fn factor(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// A launch like the measured Proof launch at `open` (vault 1.54 SOL, S ≈ 865M tokens of which
/// ≈ 327M in the pool, L ≈ 3.07e31, pool ≈ 3.8× F), every scale perturbed.
pub fn random_launch(rng: &mut Rng) -> R<Model> {
    let mut l = (30_702_214_157_579_652_106_863_560_058_426f64 * rng.factor(0.2, 5.0)) as u128;
    let vault = (1_540_404_041f64 * rng.factor(0.05, 20.0)) as u64;
    let pool_quote = 8_483_000_000f64 * rng.factor(0.3, 3.0);
    let s_of = |l: u128| ((pool_quote * 2f64.powi(128)) / l as f64) as u128 + S_MIN;
    // DBC's supply is fixed at 10^15 (§7): the pool may hold at most half of it here.
    while amount_a(l, s_of(l)) >= U256::from(TOTAL_SUPPLY / 2) {
        l = l / 4 * 3;
    }
    let pool_s = s_of(l);
    let pool_base = to_u64(amount_a(l, pool_s), "pool base")?;
    let held =
        (538_900_000_000_000f64 * rng.factor(0.2, 1.6)).min((TOTAL_SUPPLY - pool_base - 10) as f64);
    let mut holders = [Wallet::default(); HOLDERS];
    let mut left = held as u64;
    for (i, w) in holders.iter_mut().enumerate() {
        let part = if i == HOLDERS - 1 {
            left
        } else {
            (left as f64 * rng.factor(0.05, 0.4)) as u64
        };
        w.base = part;
        left -= part;
        w.quote = (rng.factor(0.0, 60.0) * 1e9) as u64;
    }
    // The launch's p0 bin sits far below F (D-020: open moves it up).
    let p0_bin = floor_bin(pool_s) - 700 - rng.below(200) as i32;
    Model::open(holders, l, pool_s, vault, p0_bin)
}

/// One run: `steps` random operations from a fresh launch, a sell-out every `sellout_every` steps
/// and at the end.
pub fn run(seed: u64, steps: u64, sellout_every: u64, stats: &mut Stats) -> R<()> {
    let mut rng = Rng::new(seed);
    let mut m = random_launch(&mut rng)?;
    let s_first = m.s_now()?;
    for step in 0..steps {
        let op = match rng.below(100) {
            0..=17 => 0,
            18..=31 => 1,
            32..=45 => 2,
            46..=55 => 3,
            56..=67 => 4,
            68..=71 => 5,
            72..=74 => 6,
            75..=77 => 7,
            78..=80 => 8,
            81..=87 => 9,
            88..=93 => 10,
            _ => 11,
        };
        let h = rng.below(HOLDERS as u64) as usize;
        let before = m.clone();
        let res: R<bool> = (|| match op {
            0 => {
                let q = rng.below(m.holders[h].quote / 3 + 1);
                m.damm_buy(h, q)
            }
            1 => {
                let b = rng.below(m.holders[h].base / 3 + 1);
                Ok(m.damm_sell(h, b)?.is_some())
            }
            2 => {
                let b = rng.below(m.holders[h].base / 2 + 1);
                Ok(m.bid_fill(h, b)?.is_some())
            }
            3 => m.refresh_floor().map(|_| true),
            4 => {
                let t = rng.below(m.holders[h].base / 4 + 1);
                Ok(m.redeem(h, t)?.is_some())
            }
            5 => m.harvest().map(|_| true),
            6 => {
                let q = rng.below(m.holders[h].quote / 10 + 1);
                m.deposit(h, q)
            }
            7 => m.pay_creator().map(|_| true),
            8 => {
                let b = rng.below(m.holders[h].base / 50 + 1);
                m.donate(h, b)
            }
            9 => {
                let s = m.s_now()?;
                let shallow = rng.below(2) == 0;
                let depth = rng.below(if shallow { 140 } else { 40_000 }) as i32;
                Ok(m.pin_at(floor_bin(s) - 1 - depth))
            }
            10 => Ok(m.unpin()),
            _ => Ok(m.move_up(1 + rng.below(300) as i32)),
        })();
        match res {
            Ok(true) => stats.ops[op] += 1,
            Ok(false) => {
                stats.reverted += 1;
                m = before.clone();
            }
            Err(e) => return Err(format!("seed {seed} step {step} op {}: {e}", OP_NAMES[op])),
        }
        if op == 3 {
            stats.refreshes += 1;
        }
        if op == 4 && m.s_last != before.s_last {
            stats.redeems += 1;
        }
        match m.leg {
            Leg::Capped => stats.capped += 1,
            Leg::Suspended => stats.suspended += 1,
            _ => {}
        }
        m.check()
            .map_err(|e| format!("seed {seed} step {step} after {}: {e}", OP_NAMES[op]))?;
        if (step + 1) % sellout_every == 0 || step + 1 == steps {
            let so = m
                .sellout(300)
                .map_err(|e| format!("seed {seed} step {step} sell-out: {e}"))?;
            stats.sellouts += 1;
            stats.ops[12] += 1;
            let min0 = |cur: u64, x: u64| if cur == 0 { x } else { cur.min(x) };
            stats.min_exec_ppm = min0(stats.min_exec_ppm, so.exec_ppm);
            stats.min_pool_end_ppm = min0(stats.min_pool_end_ppm, so.pool_ppm);
            if let Some(d) = so.dust_exec_ppm {
                stats.dust_sellers += 1;
                stats.min_dust_exec_ppm = min0(stats.min_dust_exec_ppm, d);
            }
        }
    }
    let rise = (U256::from(m.s_now()? - s_first) * U256::from(1_000_000u32) / U256::from(s_first))
        .to::<u64>();
    stats.max_rise_ppm = stats.max_rise_ppm.max(rise);
    Ok(())
}
