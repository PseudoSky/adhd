import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Per-AC contract tests for the docs/config items in Bucket B, per the
 * dispatcher's rule: an item may not be closed by direct-read alone — every
 * acceptance criterion gets a test that fails if the fix/doc is reverted.
 *
 *   - 307a36c1: `.env` cascade restored + `.mcp.json` forwards provider secrets
 *              + README documents the residual; empty-value shadowing guarded.
 *   - 2cd99264: `gitnexus-singleton.sh` concurrency contract documented.
 */

function readRepoFile(relFromTestDir: string): string {
  return readFileSync(fileURLToPath(new URL(relFromTestDir, import.meta.url)), "utf8");
}

describe("307a36c1 — provider secret surfacing", () => {
  it("AC1: load-env.ts loads the three-file .env cascade and exports the empty-secret guard", () => {
    const src = readRepoFile("../utils/load-env.ts");
    expect(src).toMatch(/path\.join\(os\.homedir\(\), "\.adhd", "\.env"\)/); // ~/.adhd/.env
    expect(src).toMatch(/path\.join\(cwd, "\.adhd", "\.env"\)/); // <cwd>/.adhd/.env
    expect(src).toMatch(/path\.join\(cwd, "\.env"\)/); // <cwd>/.env
    expect(src).toContain("export function loadEnvHierarchy");
    // Empty forwarded secrets must be cleared before the cascade, or an empty
    // `${VAR}` would shadow a real ~/.adhd/.env value.
    expect(src).toContain("export function clearEmptyProviderSecrets");
    expect(src).toMatch(/clearEmptyProviderSecrets\(\)/);
  });

  it("AC2: repo-root .mcp.json forwards the three provider secrets", () => {
    const raw = readRepoFile("../../../../.mcp.json");
    const cfg = JSON.parse(raw) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    const entry = cfg.mcpServers["agent-mcp-published"];
    expect(entry).toBeDefined();
    for (const name of [
      "ADHD_AGENT_ANTHROPIC_SECRET",
      "ADHD_AGENT_OPENAI_SECRET",
      "ADHD_AGENT_DEEPSEEK_SECRET",
    ]) {
      expect(entry?.env?.[name]).toBe(`\${${name}}`);
    }
  });

  it("AC3: README documents the residual (no-.env host) and its remedies", () => {
    const readme = readRepoFile("../../README.md");
    expect(readme).toContain("~/.adhd/.env");
    expect(readme).toContain("No credential for");
    // Must state the failure mode is the miss, not a wiring gap, and name the
    // remedies (explicit shell export / claudecli agent).
    expect(readme).toMatch(/export the relevant `ADHD_AGENT_<PROVIDER>_SECRET`/);
  });

  it("AC4: clearEmptyProviderSecrets blanks only empty ADHD_AGENT_*_SECRET keys", async () => {
    const { clearEmptyProviderSecrets } = await import("../utils/load-env.js");
    const env: NodeJS.ProcessEnv = {
      ADHD_AGENT_ANTHROPIC_SECRET: "", // empty → dropped
      ADHD_AGENT_OPENAI_SECRET: "sk-real", // non-empty → kept
      PATH: "", // not a secret → kept even though empty
      OTHER_SECRET: "", // not ADHD_AGENT_ → kept
    };
    clearEmptyProviderSecrets(env);
    expect("ADHD_AGENT_ANTHROPIC_SECRET" in env).toBe(false);
    expect(env["ADHD_AGENT_OPENAI_SECRET"]).toBe("sk-real");
    expect("PATH" in env).toBe(true);
    expect("OTHER_SECRET" in env).toBe(true);
  });
});

describe("2cd99264 — gitnexus-singleton concurrency contract", () => {
  it("AC1: the skill documents the one-client kill-and-replace contract", () => {
    const skill = readRepoFile(
      "../../../../.claude/skills/gitnexus/gitnexus-cli/SKILL.md"
    );
    expect(skill).toContain("gitnexus-singleton.sh");
    expect(skill.toLowerCase()).toContain("kill-and-replace");
    expect(skill).toMatch(/ONE live client/i);
    // The exact pkill that makes it unsafe under N-way fan-out.
    expect(skill).toContain("pkill -f 'node.*gitnexus mcp'");
    // And the safe-pattern guidance.
    expect(skill.toLowerCase()).toContain("isolated");
  });
});
