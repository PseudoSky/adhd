import { describe, it, expect } from "vitest";
import { validateDagJson } from "../lib/validate.js";
import { readFileSync } from "fs";

describe("plan", () => {
  it("validates dispatch-production dag.json", () => {
    const dag = JSON.parse(readFileSync("docs/plan/dispatch-production/dag.json", "utf-8"));
    const r = validateDagJson(dag);
    if (!r.valid) console.log(JSON.stringify(r.errors));
    expect(r.valid).toBe(true);
  });
});
