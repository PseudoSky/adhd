import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 5dff26e6 AC4 — README/AGENTS name the added surface: the plugin, every `tracing.*` config key and
 * env var, the no-toggle rule, the audit script, and the one-provider-per-process behaviour. Each
 * assertion goes red if the documented surface is removed from the doc (revert-failing).
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const KEYS = ["tracing.service", "tracing.logSink", "tracing.logDir", "tracing.captureArgs"];
const ENVS = [
  "ADHD_AGENT_TRACING_SERVICE",
  "ADHD_AGENT_TRACING_LOG_SINK",
  "ADHD_AGENT_TRACING_LOG_DIR",
  "ADHD_AGENT_TRACING_CAPTURE_ARGS",
];

describe("5dff26e6 AC4 — tracing surface documented", () => {
  for (const [label, rel] of [
    ["agent-mcp README", "../../README.md"],
    ["agent-mcp AGENTS.md", "../../AGENTS.md"],
  ] as const) {
    it(`${label} names the plugin, every tracing.* key + env var, the audit script, and the no-switch rule`, () => {
      const doc = read(rel);
      expect(doc).toContain("@adhd/agent-plugin-tracing");
      for (const k of [...KEYS, ...ENVS]) expect(doc, `${label} documents ${k}`).toContain(k);
      expect(doc).toContain("scripts/audit_tracing.py");
      expect(doc).toMatch(/no enable\/disable (switch|field)/i);
    });
  }

  it("the tracing package README documents default-load, provider reuse and the audit script", () => {
    const doc = read("../../../../packages/agent/agent-plugin-tracing/README.md");
    expect(doc).toContain("Default-loaded by agent-mcp");
    expect(doc).toContain("adoptedExistingTelemetry");
    expect(doc).toContain("scripts/audit_tracing.py");
    expect(doc).not.toContain("Not wired by default yet");
  });

  it("the audit script exists where the docs say", () => {
    expect(read("../../../../scripts/audit_tracing.py")).toContain("DECLARED_PATHS");
  });
});
