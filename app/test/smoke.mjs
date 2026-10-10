// Browser smoke test: the built page, in a real Chrome, renders the launch's floor. The model tests
// run in Node, where `Buffer` exists and nothing is bundled, so they cannot see a page that is blank
// in the browser (both bugs this guards against, 10 Oct: the Buffer global set after the SDKs loaded;
// two bundled copies of wallet-adapter-react).
//
//   pnpm -F app build && pnpm -F app exec vite preview --host 0.0.0.0 --port 4173 &
//   CHROME=<path to chrome> LAUNCH=<launch> [RPC=http://localhost:8899] [SHOT=<png path>] pnpm -F app smoke
import { spawnSync } from "node:child_process";

const chrome = process.env.CHROME;
const launch = process.env.LAUNCH;
if (!chrome || !launch) {
  console.error("set CHROME (path to a Chrome or Chromium binary) and LAUNCH (a launch address)");
  process.exit(2);
}
const rpc = process.env.RPC ?? "http://localhost:8899";
const url = `${process.env.PAGE ?? "http://localhost:4173"}/?launch=${launch}&rpc=${encodeURIComponent(rpc)}`;
const common = ["--headless=new", "--disable-gpu", "--no-first-run", "--virtual-time-budget=40000", ...(process.env.CHROME_ARGS?.split(" ") ?? [])];
const run = (args) => spawnSync(chrome, [...common, ...args, url], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 120_000 });

const dom = run(["--enable-logging=stderr", "--v=0", "--dump-dom"]);
const html = dom.stdout ?? "";
const text = html.replace(/<[^>]+>/g, " ");
const errors = (dom.stderr ?? "").split("\n").filter((l) => /CONSOLE.*(Uncaught|Error:)/.test(l));
const must = [
  "This is an executable buyback floor on Meteora, not a promise about prices elsewhere.",
  "Token:",
  "Floor F (theoretical floor)",
  "Market price (DAMM v2 price)",
  "Redemption (F less 0.5%)",
  "Floor composition at F",
  `ballast verify ${launch}`,
];
const missing = must.filter((m) => !text.includes(m));
const fShown = /Floor F \(theoretical floor\)\s+[\d.]+e-\d+ SOL\/token/.test(text.replace(/\s+/g, " "));
if (process.env.SHOT) run(["--window-size=1100,2300", `--screenshot=${process.env.SHOT}`]);
if (missing.length || errors.length || !fShown) {
  console.error(JSON.stringify({ url, missing, fShown, errors: errors.slice(0, 5) }, null, 2));
  process.exit(1);
}
console.log(`PASS: the page renders F and ${must.length} required elements for ${launch}; no console errors`);
