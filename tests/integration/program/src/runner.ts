/** Minimal test runner: named cases, recorded results, evidence file, non-zero exit on failure. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REPO } from "../../p0/src/env";

export type Status = "pass" | "fail" | "unreachable";
export interface Result {
  name: string;
  status: Status;
  expected?: string;
  got?: string | null;
  detail?: unknown;
}

export class Suite {
  results: Result[] = [];
  constructor(public name: string) {}

  async case(name: string, fn: () => Promise<Omit<Result, "name">>): Promise<void> {
    try {
      const r = { name, ...(await fn()) };
      this.results.push(r);
      const mark = r.status === "pass" ? "PASS" : r.status === "unreachable" ? "N/A " : "FAIL";
      console.log(`${mark} ${name}${r.status !== "pass" ? `  expected=${r.expected ?? "-"} got=${r.got ?? "-"}` : ""}`);
    } catch (e) {
      this.results.push({ name, status: "fail", detail: String((e as Error).message ?? e).slice(0, 2000) });
      console.log(`FAIL ${name}  threw: ${String((e as Error).message ?? e).split("\n")[0]}`);
    }
  }

  finish(evidence: string): number {
    // `evidence` is relative to evidence/program/.
    const n = (s: Status) => this.results.filter((r) => r.status === s).length;
    const summary = { suite: this.name, ranAt: new Date().toISOString(), pass: n("pass"), fail: n("fail"), unreachable: n("unreachable"), results: this.results };
    // Program evidence lives in evidence/program/ (the P0 harness's writeEvidence is rooted at evidence/p0).
    const path = resolve(REPO, "evidence/program", evidence);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
    console.log(`\n${this.name}: ${n("pass")} pass, ${n("fail")} fail, ${n("unreachable")} unreachable-by-construction`);
    return n("fail");
  }
}
