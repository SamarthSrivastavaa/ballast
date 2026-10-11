// The README GIF: renders the dump chart frame by frame in headless Chrome and encodes a GIF.
//   pnpm demo:chart && CHROME=<path to chrome> node demo/gif.mjs [out.gif]
// Needs `vite preview` serving app/dist on :4173 (demo:chart copies the chart there).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import gifenc from "gifenc";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const chrome = process.env.CHROME;
if (!chrome) { console.error("set CHROME to a Chrome or Chromium binary"); process.exit(2); }
const out = resolve(process.argv[2] ?? "docs/assets/dump.gif");
const url = process.env.CHART_URL ?? "http://localhost:4173/demo-chart.html";
const [W, H, N] = [960, 540, Number(process.env.FRAMES ?? 36)];
const dir = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), "ballast-gif-"));
const winDir = process.env.SHOT_DIR_WIN ?? dir; // a Windows Chrome launched from WSL needs a Windows path

const gif = GIFEncoder();
let palette = null;
for (let k = 0; k <= N; k++) {
  const name = `f${String(k).padStart(3, "0")}.png`;
  const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, "--virtual-time-budget=1500",
    ...(process.env.CHROME_ARGS?.split(" ") ?? []), `--screenshot=${winDir}${winDir.includes("\\") ? "\\" : "/"}${name}`, `${url}?frame=${k}&of=${N}`], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0 && !/written/.test(r.stderr ?? "")) { console.error(r.stderr); process.exit(1); }
  const png = PNG.sync.read(readFileSync(join(dir, name)));
  // One palette for the whole clip, taken from the last frame (it holds every colour the chart uses).
  if (!palette) {
    const last = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, "--virtual-time-budget=1500",
      ...(process.env.CHROME_ARGS?.split(" ") ?? []), `--screenshot=${winDir}${winDir.includes("\\") ? "\\" : "/"}last.png`, `${url}?still=1`], { encoding: "utf8", timeout: 60_000 });
    if (last.status !== 0 && !/written/.test(last.stderr ?? "")) { console.error(last.stderr); process.exit(1); }
    palette = quantize(PNG.sync.read(readFileSync(join(dir, "last.png"))).data, 256);
  }
  gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, { palette, delay: k === N ? 4000 : k === 0 ? 800 : 260 });
  process.stdout.write(`\rframe ${k}/${N}`);
}
gif.finish();
writeFileSync(out, gif.bytes());
console.log(`\n${out}  ${(gif.bytes().length / 1e6).toFixed(2)} MB, ${N + 1} frames, ${W}×${H}`);
