//! `ballast` — check a Ballast launch from raw chain data (§20), and scan Meteora launches for the
//! floor their locked liquidity holds (the Floor Scanner, D-006/D-019).
//!
//!   ballast verify <launch> [--rpc <url>] [--json] [--sellout <signature>...] [--at-slot <slot>]
//!   ballast scan [--rpc <url>] [--limit <n>] [--cache <path>] [--json]
//!
//! Reads accounts and transaction history over JSON-RPC from `--rpc` (default `$BALLAST_RPC`, else
//! mainnet-beta), re-derives every number with the shared floor crate, and exits non-zero on any
//! FAIL. It never calls a Ballast app or API.

use std::process::ExitCode;

use anchor_lang::prelude::Pubkey;
use serde_json::json;
use verifier_core::scan;
use verifier_core::verify::{f_sol, Line};
use verifier_core::{verify, Options, Rpc, Status};

const USAGE: &str = "usage: ballast verify <launch> [--rpc <url>] [--json] [--sellout <signature>...] [--at-slot <slot>]\n       ballast scan [--rpc <url>] [--limit <n>] [--cache <path>] [--json]";

fn rpc_default() -> String {
    std::env::var("BALLAST_RPC").unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".into())
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
    println!("Locked-liquidity floor under the newest {} DBC → DAMM v2 launches (V = 0: Ballast Lite's floor, D-008)", rows.len());
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
    if args.first().map(String::as_str) != Some("verify") || args.len() < 2 {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let Ok(launch) = args[1].parse::<Pubkey>() else {
        eprintln!("not a launch address: {}\n{USAGE}", args[1]);
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
            "Prediction:        {:.4e} SOL/token  (recorded before trade 1)",
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
        println!(
            "{}",
            if report.passed() {
                "RESULT: PASS"
            } else {
                "RESULT: FAIL"
            }
        );
    }
    if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
