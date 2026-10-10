//! `ballast verify <launch>`: §20's seven steps against raw accounts and transaction history.

use anchor_lang::prelude::Pubkey;
use ballast::dlmm::price_q64;
use ballast::state::{launch_state, Class, Launch};
use ballast_floor::{bin_at_or_below, floor_sqrt_q64, invariant_holds, FloorInputs};
use meteora_types::damm_v2::{Pool as DammPool, Position};
use meteora_types::dbc::{PoolConfig, VirtualPool};
use meteora_types::dlmm::{LbPair, LimitOrder};
use ruint::aliases::U256;

use crate::events::{self, Event};
use crate::layout::{self, pk, WSOL};
use crate::ledger::{event_totals_match, EventTotals, QuoteLedger};
use crate::predict;
use crate::rpc::{Rpc, Tx};
use crate::Error;

const DAMM: Pubkey = ballast::damm::DAMM_PROGRAM_ID;
const DLMM: Pubkey = ballast::DLMM_PROGRAM_ID;
const DBC: Pubkey = ballast::DBC_PROGRAM_ID;
const PROGRAM: Pubkey = ballast::ID;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pass,
    Fail,
    Info,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub label: String,
    pub status: Status,
    pub text: String,
}

#[derive(Clone, Debug, Default)]
pub struct Numbers {
    pub predicted_s: u128,
    pub s_open: u128,
    pub s_now: u128,
    pub s_last: u128,
    pub v: u64,
    pub vault: u64,
    pub committed: u64,
    pub s_supply: u64,
    pub l: u128,
    pub s_max: u128,
    pub bid_bin: Option<i32>,
    pub floor_bin: Option<i32>,
    pub pool_share_ppm: u64,
    /// §10 ledger: the V the launch's counters account for, and live V less that (`None`: missing).
    pub ledger_v: Option<u64>,
    pub ledger_excess: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct Report {
    pub launch: String,
    pub class: String,
    pub state: u8,
    pub lines: Vec<Line>,
    pub numbers: Numbers,
    /// `(slot, signature, s)` for every instruction that set s, oldest first.
    pub history: Vec<(u64, String, u128)>,
    /// `(signature, execution in ppm of F at its slot)` per sell-out transaction.
    pub sellout: Vec<(String, u64)>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.lines.iter().all(|l| l.status != Status::Fail)
    }
    fn push(&mut self, label: &str, ok: bool, text: String) {
        self.lines.push(Line {
            label: label.into(),
            status: if ok { Status::Pass } else { Status::Fail },
            text,
        });
    }
    fn info(&mut self, label: &str, text: String) {
        self.lines.push(Line {
            label: label.into(),
            status: Status::Info,
            text,
        });
    }
    /// The s in force at `slot` (the last instruction at or before it), from the history.
    pub fn s_at(&self, slot: u64) -> Option<u128> {
        self.history
            .iter()
            .rev()
            .find(|(sl, _, _)| *sl <= slot)
            .map(|h| h.2)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub sellout: Vec<String>,
    /// Signatures to page through per address (history depth).
    pub max_signatures: usize,
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

/// F as SOL per token (6-decimal token, 9-decimal SOL): `s²/2^128 · 10^-3`. Display only.
pub fn f_sol(s: u128) -> f64 {
    (s as f64 / 2f64.powi(64)).powi(2) * 1e-3
}

fn below(id: i32, bin_step: u16, s: u128) -> Option<bool> {
    price_q64(id, bin_step).map(|p| !bin_at_or_below(0, p, s))
}

pub fn verify(rpc: &Rpc, launch_key: &Pubkey, opts: &Options) -> Result<Report, Error> {
    let mut r = Report {
        launch: launch_key.to_string(),
        ..Default::default()
    };

    // ---- 1. Launch and Class: owner and seeds ---------------------------------------------------
    let la = rpc.must(launch_key, "launch account")?;
    let launch: Launch = layout::anchor(&la.data, "Launch")?;
    r.state = launch.state;
    r.push(
        "Launch",
        la.owner == PROGRAM
            && pda(&[b"launch", launch.base_mint.as_ref()], &PROGRAM) == *launch_key,
        format!("owner Ballast, seeds [\"launch\", {}]", launch.base_mint),
    );
    let ca = rpc.must(&launch.class, "class account")?;
    let class: Class = layout::anchor(&ca.data, "Class")?;
    let canon = ballast::CLASSES
        .iter()
        .find(|c| c.size_tag == class.size_tag);
    r.class = canon
        .map(|c| {
            format!(
                "{} ({} SOL)",
                c.name,
                c.migration_quote_threshold / 1_000_000_000
            )
        })
        .unwrap_or_else(|| format!("size {}", class.size_tag));
    r.push(
        "Class",
        ca.owner == PROGRAM
            && pda(&[b"class", class.dbc_config.as_ref()], &PROGRAM) == launch.class,
        format!("{}; DBC config {}", r.class, class.dbc_config),
    );
    let partner_auth = pda(&[b"partner", class.dbc_config.as_ref()], &PROGRAM);
    let creator_auth = pda(&[b"creator", launch_key.as_ref()], &PROGRAM);
    let vault_key = pda(&[b"vault", launch_key.as_ref()], &PROGRAM);

    // ---- 2. DBC config: hash and prediction, recomputed; prediction before any third-party trade
    let cfg_acc = rpc.must(&class.dbc_config, "DBC config")?;
    let cfg: PoolConfig =
        layout::meteora(&cfg_acc.data, &PoolConfig::DISCRIMINATOR, "DBC PoolConfig")?;
    r.push(
        "Config hash",
        cfg_acc.owner == DBC && predict::config_hash(&cfg) == class.config_hash,
        "sha256 over the curve fields recomputed from the DBC config (§7 rule 3)".into(),
    );
    r.numbers.predicted_s = launch.predicted_s;
    match predict::lower_bound(&cfg) {
        Some((lo, band_lo, band_hi)) => r.push(
            "Prediction",
            launch.predicted_s <= lo && launch.predicted_s == class.predicted_s_open,
            format!(
                "{:.4e} SOL/token recorded; independent derivation from the config {:.4e} (band {:.4e}…{:.4e}); a lower bound",
                f_sol(launch.predicted_s),
                f_sol(lo),
                f_sol(band_lo),
                f_sol(band_hi)
            ),
        ),
        None => r.push("Prediction", false, "the DBC config's curve cannot be evaluated".into()),
    }
    let pool_acc = rpc.must(&launch.dbc_pool, "DBC pool")?;
    let vp: VirtualPool = layout::meteora(
        &pool_acc.data,
        &VirtualPool::DISCRIMINATOR,
        "DBC VirtualPool",
    )?;
    r.push(
        "DBC pool",
        pool_acc.owner == DBC
            && pk(vp.pool_state.config) == class.dbc_config
            && pk(vp.pool_state.base_mint) == launch.base_mint
            && pk(vp.pool_state.creator) == creator_auth,
        "config, base mint, and pool creator = creator_auth (D-011)".into(),
    );
    let pool_sigs = rpc.signatures(&launch.dbc_pool, opts.max_signatures)?;
    match pool_sigs.first() {
        Some(first) => {
            let tx = rpc.transaction(&first.signature)?.unwrap_or_default();
            let registered = events::parse(&tx.logs, &PROGRAM, launch_key)
                .iter()
                .any(|e| matches!(e, Event::Registered { .. }));
            r.push(
                "Recorded before trade",
                registered && !tx.failed && tx.slot == launch.registered_slot,
                format!(
                    "registered in the pool's first transaction, slot {} ({})",
                    tx.slot,
                    &first.signature[..12.min(first.signature.len())]
                ),
            );
        }
        None => r.info(
            "Recorded before trade",
            "no transaction history for the pool on this RPC".into(),
        ),
    }

    if launch.state != launch_state::OPEN {
        r.info(
            "State",
            format!("{} — the floor exists from `open` on", launch.state),
        );
        return Ok(r);
    }

    // ---- 3. DAMM v2 pool and both positions -------------------------------------------------------
    let dp = rpc.must(&launch.damm_pool, "DAMM v2 pool")?;
    let pool: DammPool = layout::meteora(&dp.data, &DammPool::DISCRIMINATOR, "DAMM v2 Pool")?;
    let (hi, lo) = if launch.base_mint > WSOL {
        (launch.base_mint, WSOL)
    } else {
        (WSOL, launch.base_mint)
    };
    let canonical = pda(
        &[
            b"pool",
            ballast::damm::DAMM_MIGRATION_CONFIG.as_ref(),
            hi.as_ref(),
            lo.as_ref(),
        ],
        &DAMM,
    );
    let fees = pool.pool_fees;
    let (comp, smin, smax, mode) = (
        fees.compounding_fee_bps,
        pool.sqrt_min_price,
        pool.sqrt_max_price,
        pool.collect_fee_mode,
    );
    let pool_ok = dp.owner == DAMM
        && launch.damm_pool == canonical
        && pk(pool.token_a_mint) == launch.base_mint
        && pk(pool.token_b_mint) == WSOL;
    let mode_ok = mode == ballast::damm::COLLECT_FEE_MODE_ONLY_B
        && comp == 0
        && smin == ballast::damm::MIN_SQRT_PRICE
        && smax == ballast::damm::MAX_SQRT_PRICE;
    let mut l = 0u128;
    let mut permanent_ok = true;
    let mut owners_ok = true;
    for (pos_key, nft_acc, holder) in [
        (
            launch.partner_position,
            launch.partner_nft_account,
            partner_auth,
        ),
        (
            launch.creator_position,
            launch.creator_nft_account,
            creator_auth,
        ),
    ] {
        let pa = rpc.must(&pos_key, "DAMM v2 position")?;
        let p: Position = layout::meteora(&pa.data, &Position::DISCRIMINATOR, "DAMM v2 Position")?;
        let (unl, ves, perm) = (
            p.unlocked_liquidity,
            p.vested_liquidity,
            p.permanent_locked_liquidity,
        );
        permanent_ok &= pa.owner == DAMM
            && pk(p.pool) == launch.damm_pool
            && pos_key == pda(&[b"position", &p.nft_mint], &DAMM)
            && unl == 0
            && ves == 0
            && perm > 0;
        l = l.saturating_add(perm);
        let na = rpc.must(&nft_acc, "position NFT account")?;
        let (mint, owner, amount) = layout::token(&na.data)?;
        owners_ok &= (na.owner == layout::TOKEN_2022_PROGRAM || na.owner == layout::TOKEN_PROGRAM)
            && mint == pk(p.nft_mint)
            && owner == holder
            && amount == 1;
    }
    r.numbers.l = l;
    r.numbers.s_max = smax;
    r.push(
        "DAMM pool",
        pool_ok && mode_ok,
        format!(
            "canonical migrated pool {}; OnlyB, no compounding, full range",
            launch.damm_pool
        ),
    );
    r.push(
        "Permanent",
        permanent_ok && l >= launch.l_open,
        format!(
            "L = {l:.4e} (both positions permanent, unlocked = vested = 0; ≥ L at open)",
            l = l as f64
        ),
    );
    r.push(
        "PDA owners",
        owners_ok,
        "partner NFT held by partner_auth, creator NFT by creator_auth".into(),
    );

    // ---- 4–5. V and S -------------------------------------------------------------------------
    let va = rpc.must(&vault_key, "vault")?;
    let (vmint, vowner, vault) = layout::token(&va.data)?;
    r.push(
        "Vault",
        va.owner == layout::TOKEN_PROGRAM && vmint == WSOL && vowner == partner_auth,
        format!(
            "WSOL account of partner_auth, {:.6} SOL on hand",
            vault as f64 / 1e9
        ),
    );
    let v = vault.saturating_add(launch.bid_quote_committed);
    let ma = rpc.must(&launch.base_mint, "base mint")?;
    let mint = layout::mint(&ma.data)?;
    let staging = match rpc.account(&layout::ata(&partner_auth, &launch.base_mint))? {
        Some(a) => layout::token(&a.data)?.2,
        None => 0,
    };
    let s_supply = mint.supply.saturating_sub(staging);
    r.push(
        "Supply",
        ma.owner == layout::TOKEN_PROGRAM
            && mint.mint_authority.is_none()
            && mint.freeze_authority.is_none(),
        format!(
            "S = {:.0} tokens outstanding; mint authority None, freeze authority None",
            s_supply as f64 / 1e6
        ),
    );
    r.numbers.v = v;
    r.numbers.vault = vault;
    r.numbers.committed = launch.bid_quote_committed;
    r.numbers.s_supply = s_supply;

    // ---- 6. s from live V, S, L — and its history -------------------------------------------------
    let inputs = FloorInputs {
        v,
        s: s_supply,
        l,
        s_max: smax,
    };
    let s = floor_sqrt_q64(&inputs).map_err(|e| Error::Layout(format!("floor inputs: {e:?}")))?;
    r.numbers.s_now = s;
    r.numbers.s_last = launch.s_last;
    r.numbers.s_open = launch.s_open;
    r.push(
        "Invariant",
        invariant_holds(&inputs, s) && s >= launch.s_last,
        "V/F + L(1/√F − 1/√P_max) ≥ S at the recomputed F, and F ≥ the last recorded F".into(),
    );
    r.push(
        "Realised ≥ predicted",
        launch.s_open >= launch.predicted_s,
        format!(
            "{:+.2}% vs the prediction",
            (f_sol(launch.s_open) / f_sol(launch.predicted_s) - 1.0) * 100.0
        ),
    );
    // Composition (§21): the share of S the locked pool absorbs at F; the vault bid takes the rest.
    let a_at_f =
        U256::from(l) * U256::from(smax - s.min(smax)) / (U256::from(s.max(1)) * U256::from(smax));
    r.numbers.pool_share_ppm = (a_at_f * U256::from(1_000_000u32) / U256::from(s_supply.max(1)))
        .to::<u128>()
        .min(1_000_000) as u64;

    // The bid: owner, order and bin relative to F.
    let pair_acc = rpc.must(&launch.dlmm_pair, "DLMM pair")?;
    let pair: LbPair = layout::meteora(&pair_acc.data, &LbPair::DISCRIMINATOR, "DLMM LbPair")?;
    let step = pair.bin_step;
    let fb = {
        let f = (s as f64 / 2f64.powi(64)).powi(2);
        let mut id = (f.ln() / (1.0 + f64::from(step) / 1e4).ln()).floor() as i32;
        while below(id, step, s) == Some(false) {
            id -= 1;
        }
        while below(id + 1, step, s) == Some(true) {
            id += 1;
        }
        id
    };
    r.numbers.floor_bin = Some(fb);
    if launch.bid_suspended {
        r.info("Bid", format!("SUSPENDED (D-021): a third party pins the DLMM active bin at {}; the vault rests unplaced, V counts it, redemption pays F", launch.bid_bin_id));
    } else if launch.bid_order == Pubkey::default() {
        r.info(
            "Bid",
            "no resting order (vault exhausted); F is held by the locked pool".into(),
        );
    } else {
        r.numbers.bid_bin = Some(launch.bid_bin_id);
        let oa = rpc.must(&launch.bid_order, "resting order")?;
        let header = 8 + std::mem::size_of::<LimitOrder>();
        let order_ok = oa.owner == DLMM
            && oa.data.len() >= header
            && meteora_types::decode::<LimitOrder>(&oa.data[..header], &LimitOrder::DISCRIMINATOR)
                .map(|o| pk(o.owner) == partner_auth && pk(o.lb_pair) == launch.dlmm_pair)
                .unwrap_or(false);
        let at_or_below = below(launch.bid_bin_id, step, s) == Some(true);
        let price = price_q64(launch.bid_bin_id, step).unwrap_or(0);
        let gap = fb - launch.bid_bin_id;
        let note = if launch.bid_capped {
            format!("CAPPED (D-020): {gap} bins under F's bin while a third party pins the active bin; redemption pays F")
        } else if gap > 0 {
            format!("{gap} bin(s) under F's bin — stale until the next refresh_floor (§9)")
        } else {
            "the highest bin at or below F".into()
        };
        r.push(
            "Bid",
            order_ok
                && at_or_below
                && pk(pair.token_x_mint) == launch.base_mint
                && step == class.bid_bin_step,
            format!(
                "{:.6} SOL resting @ bin {} = {:.4e} SOL/token, owned by partner_auth; {note}",
                launch.bid_quote_committed as f64 / 1e9,
                launch.bid_bin_id,
                price as f64 / 2f64.powi(64) * 1e-3,
            ),
        );
    }

    // History: every instruction that set s, from the launch's transactions (oldest first).
    let sigs = rpc.signatures(launch_key, opts.max_signatures)?;
    let mut prev: Option<u128> = None;
    let mut monotone = true;
    let mut decreases = 0;
    let mut totals = EventTotals::default();
    let mut complete = false;
    for sig in sigs.iter().filter(|s| !s.failed) {
        let Some(tx) = rpc.transaction(&sig.signature)? else {
            continue;
        };
        for e in events::parse(&tx.logs, &PROGRAM, launch_key) {
            match e {
                Event::BackingDecreased { .. } => decreases += 1,
                Event::Registered { .. } => complete = true,
                Event::Settled {
                    migration_fee,
                    partner_fees,
                } => {
                    totals.migration_fee = totals.migration_fee.saturating_add(migration_fee);
                    totals.partner_fees = totals.partner_fees.saturating_add(partner_fees);
                }
                Event::LeftoverBurned { surplus, .. } => {
                    totals.surplus = totals.surplus.saturating_add(surplus)
                }
                Event::Harvested { to_vault, .. } => {
                    totals.harvested = totals.harvested.saturating_add(to_vault)
                }
                Event::Deposited { amount, .. } => {
                    totals.deposited = totals.deposited.saturating_add(amount)
                }
                Event::Redeemed { payout, .. } => {
                    totals.redeemed_lamports = totals.redeemed_lamports.saturating_add(payout)
                }
                _ => {}
            }
            if let Some(sv) = e.s() {
                if prev.map(|p| sv < p).unwrap_or(false) {
                    monotone = false;
                }
                prev = Some(sv);
                r.history.push((tx.slot, sig.signature.clone(), sv));
            }
        }
    }
    let last_ok = r
        .history
        .last()
        .map(|h| h.2 == launch.s_last)
        .unwrap_or(false);
    r.push(
        "History",
        monotone && last_ok && !r.history.is_empty(),
        format!(
            "{} floor updates from program events, never decreasing; the last equals s_last",
            r.history.len()
        ),
    );
    if decreases > 0 || launch.degraded {
        r.push(
            "Backing",
            false,
            format!("{decreases} BackingDecreased event(s); launch degraded (§8 fail-safe)"),
        );
    }

    // ---- §10 ledger: V and the supply against the launch's counters, the counters against events
    let ledger = QuoteLedger::from_launch(&launch);
    let quote = ledger.quote_excess(v);
    let minted = cfg.pre_migration_token_supply;
    let tokens = QuoteLedger::token_excess(minted, mint.supply, launch.burned);
    let events_ok = !complete || event_totals_match(&ledger, &totals);
    r.numbers.ledger_v = ledger.expected_v();
    r.numbers.ledger_excess = quote;
    let sol = |x: u64| x as f64 / 1e9;
    let quote_text = match quote {
        Some(0) => "to the lamport".to_string(),
        Some(x) => format!("plus {x} lamports received outside any instruction"),
        None => "QUOTE MISSING".to_string(),
    };
    let token_text = match tokens {
        Some(0) => "supply = minted − burned exactly".to_string(),
        Some(x) => format!("supply = minted − burned − {x} base units holders burned themselves"),
        None => "SUPPLY ABOVE minted − burned".to_string(),
    };
    let event_text = match (complete, events_ok) {
        (true, true) => "counters = event sums",
        (true, false) => "COUNTERS ≠ EVENT SUMS",
        (false, _) => "event history incomplete on this RPC: counters only",
    };
    r.push(
        "Ledger",
        quote.is_some() && tokens.is_some() && events_ok,
        format!(
            "V = {:.9} in − {:.9} out (fills {:.9}, redemptions {:.9}), {quote_text}; {token_text}; {event_text}",
            sol(ledger.inflows().unwrap_or(u64::MAX)),
            sol(ledger.outflows().unwrap_or(u64::MAX)),
            sol(ledger.fill_quote_spent),
            sol(ledger.redeemed_lamports),
        ),
    );

    // ---- 7. Sell-out replay -----------------------------------------------------------------------
    for sig in &opts.sellout {
        let Some(tx) = rpc.transaction(sig)? else {
            r.push("Sell-out", false, format!("{sig}: not found"));
            continue;
        };
        match execution_ppm(&tx, &launch.base_mint, r.s_at(tx.slot).unwrap_or(s)) {
            Some(ppm) => r.sellout.push((sig.clone(), ppm)),
            None => r.info("Sell-out", format!("{sig}: no base sold by the signer")),
        }
    }
    if let Some(min) = r.sellout.iter().map(|x| x.1).min() {
        r.push(
            "Sell-out",
            min >= 990_000,
            format!(
                "lowest execution {:.4}·F over {} transaction(s) (gate 8: ≥ 0.99·F)",
                min as f64 / 1e6,
                r.sellout.len()
            ),
        );
    }
    Ok(r)
}

/// The signer's execution in a sell transaction, in ppm of F at that slot: quote received (WSOL
/// balance + lamports, fee added back) per base unit sold.
pub fn execution_ppm(tx: &Tx, base_mint: &Pubkey, s: u128) -> Option<u64> {
    let signer = *tx.keys.first()?;
    let bal = |list: &[(usize, Pubkey, Pubkey, u64)], mint: &Pubkey| -> u128 {
        list.iter()
            .filter(|t| t.1 == *mint && t.2 == signer)
            .map(|t| t.3 as u128)
            .sum()
    };
    let sold = bal(&tx.pre_tokens, base_mint).checked_sub(bal(&tx.post_tokens, base_mint))?;
    if sold == 0 {
        return None;
    }
    let wsol = bal(&tx.post_tokens, &WSOL) as i128 - bal(&tx.pre_tokens, &WSOL) as i128;
    let lamports =
        *tx.post_lamports.first()? as i128 - *tx.pre_lamports.first()? as i128 + tx.fee as i128;
    let quote = (wsol + lamports).max(0) as u128;
    let exec: U256 = (U256::from(quote) << 64) / U256::from(sold);
    let f: U256 = (U256::from(s) * U256::from(s)) >> 64;
    let ppm: U256 = exec * U256::from(1_000_000u32) / f.max(U256::from(1u8));
    Some(u64::try_from(ppm).unwrap_or(u64::MAX))
}
