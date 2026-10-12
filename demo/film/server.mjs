// Serves the film page and receives the recording it produces.
//   node demo/film/server.mjs [port]      then open http://localhost:<port>/film.html?record=1 in Chrome
// GET  /<file>   a file from demo/film/ (film.html, data.json, images)
// POST /upload?name=<file>   the recorded video, written to submission/video/<file>
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../submission/video");
const port = Number(process.argv[2] ?? 4174);
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png", ".js": "text/javascript", ".webm": "video/webm", ".mp4": "video/mp4" };
const held = [];
createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/upload") {
    mkdirSync(out, { recursive: true });
    const name = (url.searchParams.get("name") ?? "ballast-demo.webm").replace(/[^A-Za-z0-9._-]/g, "");
    const file = join(out, name);
    const w = createWriteStream(file);
    req.pipe(w);
    w.on("finish", () => { console.log(`saved ${file} ${(statSync(file).size / 1e6).toFixed(1)} MB`); writeFileSync(join(here, ".done"), name); res.end("ok"); });
    return;
  }
  // /hold answers only once /release is hit: check.html holds the page's load event (and so a headless
  // screenshot) until its <video> has finished seeking.
  if (url.pathname === "/hold") { held.push(res); setTimeout(() => res.writableEnded || res.end(), 25000); return; }
  if (url.pathname === "/release") { for (const r of held.splice(0)) { r.setHeader("content-type", "image/gif"); r.end(Buffer.from("R0lGODlhAQABAAAAACwAAAAAAQABAAA=", "base64")); } res.end("ok"); return; }
  if (req.method === "POST" && url.pathname === "/script") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { writeFileSync(join(here, "script.json"), b); writeFileSync(join(here, ".done"), "script"); res.end("ok"); }); return; }
  if (req.method === "POST" && url.pathname === "/log") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { console.log("page:", b.slice(0, 300)); res.end("ok"); }); return; }
  const base = url.pathname.startsWith("/video/") ? out : here;
  const f = join(base, url.pathname.replace(/^\/video\//, "/").replace(/\.\./g, ""));
  if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end("not found"); return; }
  res.setHeader("content-type", types[extname(f)] ?? "application/octet-stream");
  res.setHeader("accept-ranges", "bytes");
  const body = readFileSync(f), m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m) { // a <video> element seeks with range requests
    const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.statusCode = 206; res.setHeader("content-range", `bytes ${start}-${end}/${body.length}`); res.end(body.subarray(start, end + 1)); return;
  }
  res.end(body);
}).listen(port, "0.0.0.0", () => console.log(`film server on http://localhost:${port}`));
