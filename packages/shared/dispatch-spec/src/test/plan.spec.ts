import { describe, it, expect } from "vitest";
import { validateDagJson } from "../lib/validate.js";
import { readFileSync } from "fs";

describe("plan", () => {
  it("validates dispatch-production dag.json", () => {
    // __dirname is the test file's directory; resolve to workspace root
    const repoRoot = __dirname.split("packages/shared/dispatch-spec")[0];
    if (!repoRoot) return; // not in workspace
    const planPath = `${repoRoot}docs/plan/dispatch-production/dag.json`;
    const dag = JSON.parse(readFileSync(planPath, "utf-8"));
    const r = validateDagJson(dag);
    if (!r.valid) console.log(JSON.stringify(r.errors));
    expect(r.valid).toBe(true);
  });
});
