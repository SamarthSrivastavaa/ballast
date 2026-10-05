/** Minimal test runner: named cases, recorded results, evidence file, non-zero exit on failure. */
import { writeEvidence } from "../../p0/src/env";

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
    const n = (s: Status) => this.results.filter((r) => r.status === s).length;
    const summary = { suite: this.name, ranAt: new Date().toISOString(), pass: n("pass"), fail: n("fail"), unreachable: n("unreachable"), results: this.results };
    writeEvidence(evidence, summary);
    console.log(`\n${this.name}: ${n("pass")} pass, ${n("fail")} fail, ${n("unreachable")} unreachable-by-construction`);
    return n("fail");
  }
}
