//! `ballast` — check a Ballast launch from raw chain data (§20), and scan Meteora launches for the
//! floor their locked liquidity holds (the Floor Scanner, D-006/D-019).
//!
//!   ballast verify <mint-or-launch> [--cluster mainnet|devnet|local] [--rpc <url>] [--json]
//!                                   [--sellout <signature>...] [--at-slot <slot>]
//!   ballast check <damm-v2-pool>    [--cluster ...] [--rpc <url>] [--json]
//!   ballast scan [--cluster ...] [--rpc <url>] [--limit <n>] [--cache <path>] [--json]
//!
//! Reads accounts and transaction history over JSON-RPC (`--rpc`, else `--cluster`, else
//! `$BALLAST_RPC`, else mainnet-beta's public endpoint), re-derives every number with the shared
//! floor crate, and exits non-zero on any FAIL. It never calls a Ballast app or API.

use std::process::ExitCode;

use anchor_lang::prelude::Pubkey;
use serde_json::json;
use verifier_core::scan;
use verifier_core::verify::{f_sol, Line};
use verifier_core::{resolve_launch, verify, Options, Rpc, Status};

const USAGE: &str = "usage: ballast verify <mint-or-launch> [--cluster mainnet|devnet|local] [--rpc <url>] [--json] [--sellout <signature>...] [--at-slot <slot>]\n       ballast check <damm-v2-pool> [--cluster mainnet|devnet|local] [--rpc <url>] [--json]\n       ballast scan [--cluster mainnet|devnet|local] [--rpc <url>] [--limit <n>] [--cache <path>] [--json]";

fn rpc_default() -> String {
    std::env::var("BALLAST_RPC").unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".into())
}

/// The public endpoint of a named cluster.
fn cluster_rpc(name: &str) -> Option<&'static str> {
    match name {
        "mainnet" | "mainnet-beta" => Some("https://api.mainnet-beta.solana.com"),
        "devnet" => Some("https://api.devnet.solana.com"),
        "local" | "localnet" => Some("http://127.0.0.1:8899"),
        _ => None,
    }
}

fn cluster_name(rpc: &str) -> &'static str {
    if rpc.contains("devnet") {
        "devnet"
    } else if rpc.contains("mainnet") {
        "mainnet"
    } else if rpc.contains("127.0.0.1") || rpc.contains("localhost") {
        "local validator"
    } else {
        "custom RPC"
    }
}

/// A number in plain decimals when it is readable that way, scientific otherwise.
fn num(x: f64) -> String {
    if x != 0.0 && x.abs() < 1e-4 {
        format!("{x:.4e}")
    } else {
        format!("{x:.6}")
    }
}

/// `ballast check <pool>`: the locked-liquidity floor under any Meteora DAMM v2 pool.
fn check_cmd(args: &[String]) -> ExitCode {
    let Some(Ok(pool)) = args.first().map(|a| a.parse::<Pubkey>()) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let mut rpc_url = rpc_default();
    let mut json_out = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--rpc" if i + 1 < args.len() => {
                rpc_url = args[i + 1].clone();
                i += 1;
            }
            "--cluster" if i + 1 < args.len() => {
                let Some(u) = cluster_rpc(&args[i + 1]) else {
                    eprintln!("unknown cluster {}\n{USAGE}", args[i + 1]);
                    return ExitCode::from(2);
                };
                rpc_url = u.into();
                i += 1;
            }
            "--json" => json_out = true,
            other => {
                eprintln!("unknown argument {other}\n{USAGE}");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }
    let c = match scan::check_pool(&Rpc::new(&rpc_url), &pool) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "FAIL: {e}\n(expected a Meteora DAMM v2 pool address on {})",
                cluster_name(&rpc_url)
            );
            return ExitCode::from(1);
        }
    };
    let price = c.human(c.s_price);
    let floor = c.s_floor.as_ref().ok().map(|s| c.human(*s));
    let ratio = c.floor_over_price_ppm().map(|p| p as f64 / 1e4);
    if json_out {
        let out = json!({
            "cluster": cluster_name(&rpc_url), "pool": c.pool.to_string(), "base_mint": c.base_mint.to_string(),
            "quote_mint": c.quote_mint.to_string(), "permanent_share_ppm": c.permanent_share_ppm(),
            "l_permanent": c.l_permanent.to_string(), "l_pool": c.l_pool.to_string(), "supply": c.supply,
            "mint_authority_present": c.mint_authority, "pool_price": price, "locked_liquidity_floor": floor,
            "floor_over_price_pct": ratio,
            "s_floor": c.s_floor.as_ref().map(|s| s.to_string()).unwrap_or_else(|e| e.clone()),
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    let wsol = "So11111111111111111111111111111111111111112";
    let quote = if c.quote_mint.to_string() == wsol {
        "SOL".to_string()
    } else {
        format!("{} (quote mint)", c.quote_mint)
    };
    println!(
        "Meteora DAMM v2 pool:  {}   cluster: {}",
        c.pool,
        cluster_name(&rpc_url)
    );
    println!("Base token (mint):     {}", c.base_mint);
    println!("Quote:                 {quote}");
    println!("Pool price:            {} per token", num(price));
    println!(
        "Permanently locked:    {:.1}% of the pool's liquidity",
        c.permanent_share_ppm() as f64 / 1e4
    );
    println!(
        "Supply:                {:.0} tokens{}",
        c.supply as f64 / 10f64.powi(i32::from(c.base_decimals)),
        if c.mint_authority {
            "   (the mint authority still exists: supply can grow, and the floor would fall)"
        } else {
            "   (mint authority removed)"
        }
    );
    println!();
    println!(
        "The locked-liquidity floor is the price at which the permanently locked liquidity alone"
    );
    println!("absorbs every token in existence: L·(1/√F − 1/√P_max) = S. Withdrawable liquidity is ignored.");
    println!();
    let result = match (floor, ratio) {
        (Some(f), Some(r)) if c.l_permanent > 0 && f > 0.0 => format!(
            "RESULT: LOCKED-LIQUIDITY FLOOR ✓  F = {} per token = {:.2}% of the pool price (worst case from here: −{:.2}%)",
            num(f), r, (100.0 - r).max(0.0)
        ),
        _ => "RESULT: NO FLOOR ✗  nothing in this pool is permanently locked; its liquidity can be withdrawn".to_string(),
    };
    println!("{result}");
    println!();
    println!("--- paste this into https://github.com/SamarthSrivastavaa/ballast/issues/new?template=i-verified.yml ---");
    println!(
        "command: ballast check {} --cluster {}",
        c.pool,
        cluster_name(&rpc_url)
            .split(' ')
            .next()
            .unwrap_or("mainnet")
    );
    println!("{result}");
    println!("---");
    ExitCode::SUCCESS
}

/// `ballast scan`: the locked-liquidity floor under the newest DBC → DAMM v2 launches.
fn scan_cmd(args: &[String]) -> ExitCode {
    let mut rpc_url = rpc_default();
    let mut limit = 50usize;
    let mut cache_path = "evidence/scanner/cache.json".to_string();
    let mut json_out = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--rpc" if i + 1 < args.len() => {
                rpc_url = args[i + 1].clone();
                i += 1;
            }
            "--cluster" if i + 1 < args.len() && cluster_rpc(&args[i + 1]).is_some() => {
                rpc_url = cluster_rpc(&args[i + 1]).unwrap_or_default().into();
                i += 1;
            }
            "--limit" if i + 1 < args.len() => {
                limit = args[i + 1].parse().unwrap_or(limit);
                i += 1;
            }
            "--cache" if i + 1 < args.len() => {
                cache_path = args[i + 1].clone();
                i += 1;
            }
            "--json" => json_out = true,
            other => {
                eprintln!("unknown argument {other}\n{USAGE}");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }
    let rpc = Rpc::new(&rpc_url);
    let mut cache = scan::Cache::load(&cache_path);
    let rows = match scan::discover(&rpc, &mut cache, limit).and_then(|m| scan::evaluate(&rpc, &m))
    {
        Ok(r) => r,
        Err(e) => {
            let _ = cache.save(&cache_path);
            eprintln!("scan failed: {e}");
            return ExitCode::from(1);
        }
    };
    if let Err(e) = cache.save(&cache_path) {
        eprintln!("cache not saved: {e}");
    }
    let wsol = "So11111111111111111111111111111111111111112";
    if json_out {
        let out: Vec<_> = rows
            .iter()
            .map(|r| {
                json!({
                    "migration": r.m.signature, "slot": r.m.slot, "damm_pool": r.m.damm_pool.to_string(),
                    "base_mint": r.m.base_mint.to_string(), "quote_mint": r.m.quote_mint.to_string(),
                    "permanent_share_ppm": r.permanent_share_ppm(), "floor_over_price_ppm": r.floor_over_price_ppm(),
                    "l_permanent": r.l_permanent.to_string(), "l_pool": r.l_pool.to_string(), "supply": r.supply,
                    "s_floor": r.s_floor.as_ref().map(|s| s.to_string()).unwrap_or_else(|e| e.clone()),
                    "s_price": r.s_price.to_string(),
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({ "rpc": rpc_url, "pools": out }))
                .unwrap_or_default()
        );
        return ExitCode::SUCCESS;
    }
    println!("Locked-liquidity floor under the newest {} DBC → DAMM v2 launches (V = 0: the floor of locked liquidity alone)", rows.len());
    println!("F = the price at which permanently locked liquidity alone absorbs every token; F/price = how far the pool can fall before reaching it.\n");
    println!(
        "{:<46} {:<5} {:>11} {:>10}  base mint",
        "DAMM v2 pool", "quote", "locked LP %", "F/price %"
    );
    let mut sorted: Vec<&scan::Row> = rows.iter().collect();
    sorted.sort_by_key(|r| std::cmp::Reverse(r.floor_over_price_ppm().unwrap_or(0)));
    for r in &sorted {
        let quote = if r.m.quote_mint.to_string() == wsol {
            "SOL"
        } else {
            "other"
        };
        let floor = r
            .floor_over_price_ppm()
            .map(|p| format!("{:.2}", p as f64 / 1e4))
            .unwrap_or_else(|| "n/a".into());
        println!(
            "{:<46} {:<5} {:>11.1} {:>10}  {}",
            r.m.damm_pool.to_string(),
            quote,
            r.permanent_share_ppm() as f64 / 1e4,
            floor,
            r.m.base_mint
        );
    }
    let with_floor: Vec<u64> = rows
        .iter()
        .filter_map(|r| r.floor_over_price_ppm())
        .filter(|&p| p > 0)
        .collect();
    println!(
        "\n{} of {} pools hold a locked-liquidity floor; cached migrations: {}",
        with_floor.len(),
        rows.len(),
        cache.migrations.len()
    );
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("scan") {
        return scan_cmd(&args[1..]);
    }
    if args.first().map(String::as_str) == Some("check") {
        return check_cmd(&args[1..]);
    }
    if args.first().map(String::as_str) != Some("verify") || args.len() < 2 {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let Ok(target) = args[1].parse::<Pubkey>() else {
        eprintln!("not a mint or launch address: {}\n{USAGE}", args[1]);
        return ExitCode::from(2);
    };
    let mut rpc_url = rpc_default();
    let mut json_out = false;
    let mut at_slot: Option<u64> = None;
    let mut opts = Options {
        max_signatures: 20_000,
        ..Default::default()
    };
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--rpc" if i + 1 < args.len() => {
                rpc_url = args[i + 1].clone();
                i += 1;
            }
            "--cluster" if i + 1 < args.len() && cluster_rpc(&args[i + 1]).is_some() => {
                rpc_url = cluster_rpc(&args[i + 1]).unwrap_or_default().into();
                i += 1;
            }
            "--json" => json_out = true,
            "--at-slot" if i + 1 < args.len() => {
                at_slot = args[i + 1].parse().ok();
                i += 1;
            }
            "--sellout" => {
                while i + 1 < args.len() && !args[i + 1].starts_with("--") {
                    opts.sellout.push(args[i + 1].clone());
                    i += 1;
                }
            }
            other => {
                eprintln!("unknown argument {other}\n{USAGE}");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    let rpc = Rpc::new(&rpc_url);
    let launch = match resolve_launch(&rpc, &target) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("FAIL: {e} ({})", cluster_name(&rpc_url));
            return ExitCode::from(1);
        }
    };
    let report = match verify(&rpc, &launch, &opts) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("FAIL: {e}");
            return ExitCode::from(1);
        }
    };
    let n = &report.numbers;
    if json_out {
        let lines: Vec<_> = report
            .lines
            .iter()
            .map(|l: &Line| json!({ "check": l.label, "status": format!("{:?}", l.status).to_uppercase(), "detail": l.text }))
            .collect();
        let out = json!({
            "launch": report.launch, "class": report.class, "state": report.state, "pass": report.passed(),
            "predicted_s": n.predicted_s.to_string(), "s_open": n.s_open.to_string(), "s_now": n.s_now.to_string(),
            "s_last": n.s_last.to_string(), "f_now_sol_per_token": f_sol(n.s_now), "v_lamports": n.v,
            "vault_lamports": n.vault, "bid_committed_lamports": n.committed, "s_supply": n.s_supply,
            "l": n.l.to_string(), "bid_bin": n.bid_bin, "floor_bin": n.floor_bin,
            "pool_share_of_floor_ppm": n.pool_share_ppm,
            "ledger_v_lamports": n.ledger_v, "ledger_excess_lamports": n.ledger_excess,
            "at_slot": at_slot.map(|sl| json!({ "slot": sl, "s": report.s_at(sl).map(|s| s.to_string()) })),
            "history": report.history.iter().map(|(sl, sig, s)| json!({ "slot": sl, "signature": sig, "s": s.to_string() })).collect::<Vec<_>>(),
            "sellout": report.sellout.iter().map(|(sig, ppm)| json!({ "signature": sig, "execution_ppm_of_F": ppm })).collect::<Vec<_>>(),
            "checks": lines,
        });
        println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    } else {
        println!(
            "Launch:            {}   class: {}",
            report.launch, report.class
        );
        println!(
            "Prediction:        {:.4e} SOL/token  (recorded in the pool-creation transaction, before any third-party trade)",
            f_sol(n.predicted_s)
        );
        if n.s_open > 0 {
            println!(
                "Realised at open:  {:.4e} SOL/token  ({:+.2}% vs prediction)",
                f_sol(n.s_open),
                (f_sol(n.s_open) / f_sol(n.predicted_s) - 1.0) * 100.0
            );
            println!(
                "Recomputed F now:  {:.4e} SOL/token  (theoretical floor F)",
                f_sol(n.s_now)
            );
            println!(
                "Backing:           L = {:.4e} (locked pool absorbs {:.1}% of S at F)   V = {:.6} SOL (vault {:.6} + resting bid {:.6})",
                n.l as f64,
                n.pool_share_ppm as f64 / 1e4,
                n.v as f64 / 1e9,
                n.vault as f64 / 1e9,
                n.committed as f64 / 1e9
            );
            println!("Outstanding S:     {:.0} tokens", n.s_supply as f64 / 1e6);
        }
        if let Some(sl) = at_slot {
            match report.s_at(sl) {
                Some(s) => println!("F at slot {sl}:      {:.4e} SOL/token  (s = {s})", f_sol(s)),
                None => println!("F at slot {sl}:      none — the floor did not exist yet"),
            }
        }
        println!();
        for l in &report.lines {
            let tag = match l.status {
                Status::Pass => "PASS",
                Status::Fail => "FAIL",
                Status::Info => "INFO",
            };
            println!("{tag}  {:<22} {}", l.label, l.text);
        }
        println!();
        // The last line a stranger reads, then a block to paste into the "I verified" issue form.
        let result = if !report.passed() {
            "RESULT: FAIL ✗  at least one check above did not pass".to_string()
        } else if n.s_open == 0 {
            format!(
                "RESULT: PREDICTION VERIFIED ✓  predicted F = {:.4e} SOL/token at slot {}; the floor exists from `open` on",
                f_sol(n.predicted_s),
                n.registered_slot
            )
        } else {
            format!(
                "RESULT: FLOOR VERIFIED ✓  F = {:.4e} SOL/token (predicted {:.4e} at slot {})",
                f_sol(n.s_now),
                f_sol(n.predicted_s),
                n.registered_slot
            )
        };
        println!("{result}");
        println!();
        println!("--- paste this into https://github.com/SamarthSrivastavaa/ballast/issues/new?template=i-verified.yml ---");
        println!(
            "command: ballast verify {} --cluster {}",
            report.launch,
            cluster_name(&rpc_url)
                .split(' ')
                .next()
                .unwrap_or("mainnet")
        );
        println!(
            "checks passed: {} of {}",
            report
                .lines
                .iter()
                .filter(|l| l.status == Status::Pass)
                .count(),
            report
                .lines
                .iter()
                .filter(|l| l.status != Status::Info)
                .count()
        );
        println!("{result}");
        println!("---");
    }
    if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
