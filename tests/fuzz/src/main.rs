//! `ballast-fuzz` — the §14 model fuzzer's gate run.
//!
//!   cargo run -p ballast-fuzz --release -- [--steps 1000000] [--runs 100] [--seed 1] [--sellout-every 2500]
//!                                          [--out evidence/fuzz/model.json]
//!
//! `--steps` is the total across runs; each run starts from its own random launch. Exit code is
//! non-zero on the first failure, which is printed with its seed and step so it replays exactly.

use std::time::Instant;

use ballast_fuzz::{run, Stats, OP_NAMES};

fn arg(name: &str, default: u64) -> u64 {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|v| v.replace('_', "").parse().expect("numeric argument"))
        .unwrap_or(default)
}

fn out_path() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let steps = arg("--steps", 1_000_000);
    let runs = arg("--runs", 100).max(1);
    let seed = arg("--seed", 1);
    let sellout_every = arg("--sellout-every", 2_500).max(1);
    let per_run = steps / runs;
    let started = Instant::now();
    let mut stats = Stats::default();
    let mut failure = None;
    for r in 0..runs {
        let s = seed.wrapping_mul(1_000_003).wrapping_add(r);
        if let Err(e) = run(s, per_run, sellout_every, &mut stats) {
            failure = Some(e);
            break;
        }
    }
    let secs = started.elapsed().as_secs_f64();
    let ops: Vec<String> = OP_NAMES
        .iter()
        .zip(stats.ops.iter())
        .map(|(n, c)| format!("\"{n}\": {c}"))
        .collect();
    let report = format!(
        "{{\n  \"gate\": \"§14 stateful model fuzz: 1M steps, zero failures\",\n  \"steps\": {},\n  \"runs\": {runs},\n  \"seed\": {seed},\n  \"sellout_every\": {sellout_every},\n  \"result\": \"{}\",\n  \"seconds\": {secs:.1},\n  \"applied_ops\": {{ {} }},\n  \"refused_by_program_or_market\": {},\n  \"redemptions\": {},\n  \"steps_with_bid_capped\": {},\n  \"steps_with_bid_suspended\": {},\n  \"sellouts\": {},\n  \"lowest_sellout_execution_ppm_of_F\": {},\n  \"lowest_sellout_pool_end_ppm_of_F\": {},\n  \"sellouts_with_dust_holders\": {},\n  \"lowest_dust_execution_ppm_of_F_reported_not_gated\": {},\n  \"largest_rise_of_s_in_a_run_ppm\": {}\n}}\n",
        per_run * runs,
        failure.as_deref().map(|e| format!("FAIL: {}", e.replace('"', "'"))).unwrap_or_else(|| "PASS".into()),
        ops.join(", "),
        stats.reverted,
        stats.redeems,
        stats.capped,
        stats.suspended,
        stats.sellouts,
        stats.min_exec_ppm,
        stats.min_pool_end_ppm,
        stats.dust_sellers,
        stats.min_dust_exec_ppm,
        stats.max_rise_ppm,
    );
    print!("{report}");
    if let Some(p) = out_path() {
        if let Some(dir) = std::path::Path::new(&p).parent() {
            std::fs::create_dir_all(dir).expect("evidence dir");
        }
        std::fs::write(&p, &report).expect("write report");
    }
    if failure.is_some() {
        std::process::exit(1);
    }
}
