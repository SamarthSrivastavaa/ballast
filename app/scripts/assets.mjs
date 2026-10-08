// Copies the two build inputs the page needs from the workspace: the program IDL (anchor build) and
// the floor crate compiled to WebAssembly (cargo build -p floor-wasm --target wasm32-unknown-unknown
// --release). Fails clearly if either is missing rather than shipping a page without the floor crate.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "..");
const inputs = [
  [resolve(repo, "target/idl/ballast.json"), resolve(app, "src/ballast.json"), "anchor build"],
  [resolve(repo, "target/wasm32-unknown-unknown/release/floor_wasm.wasm"), resolve(app, "public/floor_wasm.wasm"), "cargo build -p floor-wasm --target wasm32-unknown-unknown --release"],
];
for (const [from, to, how] of inputs) {
  if (!existsSync(from)) {
    console.error(`missing ${from} — run: ${how}`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
console.log("assets: IDL and floor_wasm.wasm copied");
