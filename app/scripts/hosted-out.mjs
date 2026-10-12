// On Vercel the project builds from the repository root and looks for its output in ./dist there.
// The page builds into app/dist, so after a hosted build it is copied up. Locally this does nothing.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.VERCEL) {
  const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = resolve(app, "../dist");
  if (existsSync(out)) rmSync(out, { recursive: true });
  cpSync(resolve(app, "dist"), out, { recursive: true });
  console.log(`hosted build: app/dist copied to ${out}`);
}
