import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Per-AC contract test for e8619fc9 (README must match importable reality).
 * Fails if the README reverts to the old "internal package / Gemini adapter"
 * claims or drops the host-wiring requirement.
 */
describe("e8619fc9 — agent-engine-orchestrator README matches reality", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../../README.md", import.meta.url)),
    "utf8"
  );

  it("AC1: states the package is published and importable", () => {
    expect(readme.toLowerCase()).toContain("published and importable");
    expect(readme).toContain("npm install @adhd/agent-engine-orchestrator");
  });

  it("AC2: documents that a direct consumer must wire provider credentials", () => {
    expect(readme).toContain("No credential for");
    expect(readme).toContain("EngineConfig");
    expect(readme.toLowerCase()).toContain("must wire provider credentials");
  });

  it("AC3: lists the three real provider types and claims no Gemini adapter", () => {
    expect(readme).toContain("anthropic");
    expect(readme).toContain("openai");
    expect(readme).toContain("claudecli");
    // The false "Gemini adapter" claim must be gone.
    expect(readme).not.toContain("Gemini");
  });

  it("AC4: the usage example matches the real no-arg constructor + run() deps", () => {
    expect(readme).toMatch(/new Orchestrator\(\)/);
    expect(readme).toContain("executionContext");
    expect(readme).toContain("provider");
    expect(readme).toContain("policy");
  });
});
