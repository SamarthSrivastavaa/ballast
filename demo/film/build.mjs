// Assembles demo/film/data.json from one recorded run of the demo runbook: nothing in the film is
// typed in by hand. Every number, line of terminal output and signature comes from these files:
//   evidence/demo/<id>/{terminal.log, prediction.json, dump.json, verify.txt, signatures.json}
//   evidence/scanner/scan-100-2026-10-08.json   (the mainnet scan)
//   evidence/app/token-page-gate9-launch.png     (the page, as rendered in Chrome)
//   node demo/film/build.mjs [run id]
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const runs = readdirSync(resolve(repo, "evidence/demo")).sort();
const id = process.argv[2] ?? runs.filter((r) => { try { readFileSync(resolve(repo, "evidence/demo", r, "terminal.log")); return true; } catch { return false; } }).pop();
if (!id) throw new Error("no run with a terminal.log under evidence/demo/");
const dir = resolve(repo, "evidence/demo", id);
const read = (f) => readFileSync(resolve(dir, f), "utf8");
const lines = read("terminal.log").split("\n");
const sections = {};
let cur = null;
for (const l of lines) {
  const m = l.replace(/\x1b\[[0-9;]*m/g, "").match(/^━━ (\w+) ━━\s+(.*)$/);
  if (m) { cur = m[1].toLowerCase(); sections[cur] = { title: m[2], lines: [] }; continue; }
  if (cur) sections[cur].lines.push(l);
}
const scan = JSON.parse(readFileSync(resolve(repo, "evidence/scanner/scan-100-2026-10-08.json"), "utf8"));
const scanPools = scan.pools ?? scan;
const dump = JSON.parse(read("dump.json"));
// The real mainnet output of `ballast check` on two pools from the scan. The film calls them pool A
// and pool B: the addresses are in the evidence file, not on screen.
const check = readFileSync(resolve(repo, "evidence/scanner/check-mainnet-2026-10-12.txt"), "utf8").split("\n");
const pick = (from, re) => { const i = check.findIndex((l, k) => k >= from && re.test(l)); return i < 0 ? "" : check[i]; };
const second = check.findIndex((l, k) => k > 3 && l.startsWith("Meteora DAMM v2 pool"));
const pools =2;
const mainnetCheck = [0, second].map((from) => ({ locked: pick(from, /^Permanently locked/).replace(/\s+/g, " "), price: pick(from, /^Pool price/).replace(/\s+/g, " "), result: pick(from, /^RESULT/) }));
// The one instruction a launchpad adds, as written in docs/INTEGRATE.md.
const guide = readFileSync(resolve(repo, "docs/INTEGRATE.md"), "utf8").split("\n");
const gi = guide.findIndex((l) => l.includes("const register = await ballast.methods"));
const integrate = guide.slice(gi, gi + 9);
const data = {
  mainnetCheck, integrate,
  runId: id,
  prediction: JSON.parse(read("prediction.json")),
  dump,
  verify: read("verify.txt").split("\n"),
  signatures: JSON.parse(read("signatures.json")),
  sections,
  scan: { pools: scanPools.length, noLockedLiquidity: scanPools.filter((p) => Number(p.permanent_share_ppm) === 0).length, date: "8 Oct 2026" },
};
writeFileSync(resolve(here, "data.json"), JSON.stringify(data));
copyFileSync(resolve(repo, "evidence/app/token-page-gate9-launch.png"), resolve(here, "page.png"));
console.log(`data.json from run ${id}: ${dump.sells} sells, worst fill ${dump.lowestExecutionOverF.toFixed(4)} × F, scan ${data.scan.noLockedLiquidity} of ${data.scan.pools}`);
