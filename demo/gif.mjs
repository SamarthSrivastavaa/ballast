// The README GIF: renders the dump chart frame by frame in headless Chrome and encodes a GIF.
// No dependencies: a small PNG reader (zlib) and a GIF89a/LZW writer are below.
//   pnpm demo:chart && CHROME=<path to chrome> node demo/gif.mjs [out.gif]
// Needs `vite preview` serving app/dist on :4173 (demo:chart copies the chart there).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const chrome = process.env.CHROME;
if (!chrome) { console.error("set CHROME to a Chrome or Chromium binary"); process.exit(2); }
const out = resolve(process.argv[2] ?? "docs/assets/dump.gif");
const url = process.env.CHART_URL ?? "http://localhost:4173/demo-chart.html";
const [W, H, N] = [Number(process.env.W ?? 960), Number(process.env.H ?? 540), Number(process.env.FRAMES ?? 36)];
const dir = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), "ballast-gif-"));
const winDir = process.env.SHOT_DIR_WIN ?? dir; // a Windows Chrome launched from WSL needs a Windows path
const sep = winDir.includes("\\") ? "\\" : "/";

/** 8-bit RGB or RGBA PNG → { width, height, rgb } (no interlace). */
function readPng(path) {
  const b = readFileSync(path);
  let p = 8, width = 0, height = 0, channels = 3;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0; if (data[8] !== 8 || !channels || data[12]) throw new Error("unsupported PNG"); }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, rgb = new Uint8Array(width * height * 3);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0, up = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) { rgb[(y * width + x) * 3] = cur[x * channels]; rgb[(y * width + x) * 3 + 1] = cur[x * channels + 1]; rgb[(y * width + x) * 3 + 2] = cur[x * channels + 2]; }
    prev.set(cur);
  }
  return { width, height, rgb };
}

/** The 256 most common colours (5 bits per channel) of a frame: the chart uses few, plus text edges. */
function paletteOf(rgb) {
  const count = new Map();
  for (let i = 0; i < rgb.length; i += 3) { const k = ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3); count.set(k, (count.get(k) ?? 0) + 1); }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([k]) => [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4]);
  while (top.length < 256) top.push([0, 0, 0]);
  return top;
}
function indexer(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let i = cache.get(k);
    if (i === undefined) {
      let best = 1e9;
      for (let j = 0; j < 256; j++) { const d = (palette[j][0] - r) ** 2 + (palette[j][1] - g) ** 2 + (palette[j][2] - b) ** 2; if (d < best) { best = d; i = j; } }
      cache.set(k, i);
    }
    return i;
  };
}
/** GIF LZW, 8-bit codes. */
function lzw(indices) {
  const outBytes = [];
  let cur = 0, bits = 0;
  const emit = (code, size) => { cur |= code << bits; bits += size; while (bits >= 8) { outBytes.push(cur & 255); cur >>>= 8; bits -= 8; } };
  const CLEAR = 256, END = 257;
  let size = 9, next = 258, dict = new Map();
  emit(CLEAR, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i], key = (prefix << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(CLEAR, size); dict = new Map(); size = 9; next = 258; }
    prefix = c;
  }
  emit(prefix, size); emit(END, size);
  if (bits > 0) outBytes.push(cur & 255);
  return outBytes;
}

const shot = (name, query) => {
  const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, "--virtual-time-budget=1500",
    ...(process.env.CHROME_ARGS?.split(" ") ?? []), `--screenshot=${winDir}${sep}${name}`, `${url}?${query}`], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0 && !/written/.test(r.stderr ?? "")) { console.error(r.stderr); process.exit(1); }
  return readPng(join(dir, name));
};

const last = shot("last.png", "still=1");
const palette = paletteOf(last.rgb), idx = indexer(palette);
const bytes = [];
const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
bytes.push(...Buffer.from("GIF89a")); u16(last.width); u16(last.height); bytes.push(0xf7, 0, 0);
for (const c of palette) bytes.push(...c);
bytes.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop for ever
for (let k = 0; k <= N; k++) {
  const f = k === N ? last : shot(`f${String(k).padStart(3, "0")}.png`, `frame=${k}&of=${N}`);
  const delay = k === N ? 450 : k === 0 ? 80 : 26; // hundredths of a second
  bytes.push(0x21, 0xf9, 4, 0); u16(delay); bytes.push(0, 0);
  bytes.push(0x2c); u16(0); u16(0); u16(f.width); u16(f.height); bytes.push(0);
  const indices = new Uint8Array(f.width * f.height);
  for (let i = 0; i < indices.length; i++) indices[i] = idx(f.rgb[i * 3], f.rgb[i * 3 + 1], f.rgb[i * 3 + 2]);
  const data = lzw(indices);
  bytes.push(8);
  for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); bytes.push(n); for (let j = 0; j < n; j++) bytes.push(data[i + j]); }
  bytes.push(0);
  process.stdout.write(`\rframe ${k}/${N}`);
}
bytes.push(0x3b);
writeFileSync(out, Buffer.from(bytes));
console.log(`\n${out}  ${(bytes.length / 1e6).toFixed(2)} MB, ${N + 1} frames, ${last.width}×${last.height}`);
