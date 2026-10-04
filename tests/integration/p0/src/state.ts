/** Scenario state shared between steps of one validator run (evidence/p0/state.json). */
import { existsSync, readFileSync } from "node:fs";
import { evidencePath, writeEvidence } from "./env";

export type State = Record<string, unknown>;

export function loadState(): State {
  const p = evidencePath("state.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as State) : {};
}

export function saveState(patch: State): State {
  const s = { ...loadState(), ...patch };
  writeEvidence("state.json", s);
  return s;
}

export function need<T = string>(key: string): T {
  const v = loadState()[key];
  if (v === undefined) throw new Error(`state.${key} missing — run the step that creates it first`);
  return v as T;
}
