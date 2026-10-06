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

  it("AC2: .mcp.json does not carry unexpandable ${VAR} secrets (backlog 263ee45f); resolution is shell-env or the .env cascade", () => {
    const raw = readRepoFile("../../../../.mcp.json");
    const cfg = JSON.parse(raw) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    const entry = cfg.mcpServers["agent-mcp-published"];
    expect(entry).toBeDefined();
    // MCP hosts pass env through verbatim (no expansion), so a `${VAR}` literal
    // would reach the server as garbage — the repo forbids it (see
    // mcpjson-registration.test.ts / backlog 263ee45f). The supported
    // paths are a real shell export or the ~/.adhd/.env cascade (AC1/AC3).
    for (const [key, value] of Object.entries(entry?.env ?? {})) {
      expect(value, `env "${key}" must not contain \${...}`).not.toMatch(/\$\{/);
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

describe("97acef07 / NAT-TOOL-4 — native tooling documented", () => {
  it("AGENTS.md documents task-time native tooling and the precedence", () => {
    const agents = readRepoFile("../../AGENTS.md");
    expect(agents).toContain("Native tooling for dispatched agents");
    expect(agents).toContain("resolveNativeTooling");
    expect(agents).toContain("nativeTooling");
    expect(agents).toContain("@modelcontextprotocol/server-filesystem");
    expect(agents).toMatch(/explicit .*`mcpServers`.*wins/i);
    // NAT-TOOL-4 retired the authored shell fallback and its env var.
    expect(agents).not.toContain("ADHD_AGENT_SHELL_MCP_PATH");
  });

  it("README documents the native toolset", () => {
    const readme = readRepoFile("../../README.md");
    expect(readme).toContain("Native tools for dispatched agents");
    expect(readme).toContain("@modelcontextprotocol/server-filesystem");
    expect(readme).not.toContain("ADHD_AGENT_SHELL_MCP_PATH");
  });
});

describe("6f3cd348 — agent_update row documents openSessionsNotUpdated", () => {
  it("AC1+AC2: the agent_update table row names openSessionsNotUpdated and its meaning", () => {
    const agents = readRepoFile("../../AGENTS.md");
    const row = agents
      .split("\n")
      .find((line) => line.startsWith("| `agent_update`"));
    expect(row, "the agent_update row must exist").toBeDefined();
    expect(row).toContain("openSessionsNotUpdated");
    // The documented return matches AgentUpdateResult
    // (packages/agent/agent-engine-orchestrator/src/tools/agent-crud.ts:126-128):
    // `AgentRecord & { openSessionsNotUpdated: string[] }`.
    expect(row).toMatch(/openSessionsNotUpdated\s*:\s*string\[\]/);
    expect(row).toMatch(/active sessions|open session/i);
  });
});

describe("af567fb8 — ADHD_AGENT_SKIP_LEGACY_MIGRATION documented", () => {
  it("AC: AGENTS.md documents the legacy-migration skip flag and its hermetic purpose", () => {
    const agents = readRepoFile("../../AGENTS.md");
    expect(agents).toContain("ADHD_AGENT_SKIP_LEGACY_MIGRATION");
    expect(agents).toMatch(/hermetic/i);
    expect(agents).toMatch(/flat.*legacy|legacy.*store/i);
  });
});

describe("2cd99264 — gitnexus-singleton concurrency contract", () => {
  it("AC1: the skill documents the one-client kill-and-replace contract", () => {
    // The contract lives in its own skill, outside `.claude/skills/gitnexus/`:
    // that directory is owned by `gitnexus analyze`, which the global
    // PostToolUse hook re-runs after every commit and which rewrites its
    // SKILL.md files back to the stock template, erasing any local additions.
    const skill = readRepoFile(
      "../../../../.claude/skills/gitnexus-singleton/SKILL.md"
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

describe("NAT-TOOL-10 AC4 — task/guide surface stops advertising a sessionless task", () => {
  // NAT-TOOL-6 (ADR-0008 D6) retired the noop-session path: every task is
  // sessioned — a one-shot `agent_name` dispatch creates a REAL session row
  // (retention `ephemeral`, reclaimed on terminal). The source tool
  // descriptions must not keep advertising the old "no session" behavior.
  // Reference: packages/agent/agent-engine-orchestrator/src/tools/task.ts:140-147.
  const server = readRepoFile("../server.ts");

  it("AC4: the guide no longer claims a one-shot task needs no session", () => {
    expect(server).not.toMatch(/no session needed/i);
  });

  it("AC4: the `task` tool description no longer claims no persisted context", () => {
    expect(server).not.toContain("no persisted context");
  });

  it("AC4: the guide and the `task` tool description both state the sessioned behavior", () => {
    // Workflow 0 in USAGE_GUIDE.
    const wf0 = server.indexOf("## Workflow 0");
    const wf1 = server.indexOf("## Workflow 1");
    expect(wf0).toBeGreaterThan(-1);
    expect(wf1).toBeGreaterThan(wf0);
    const guide = server.slice(wf0, wf1);
    expect(guide).toMatch(/creates a real session row/i);

    // The `task` tool description literal (ends at the next MCP tool). There
    // are two `task` descriptors — the early in-process one is terse; the
    // advertised MCP one (the surface AC4 names) carries the long text, so
    // anchor on it and slice from the `name:` that precedes it.
    const descIdx = server.indexOf("run a one-shot ephemeral task");
    const taskIdx = server.lastIndexOf("name: 'task'", descIdx);
    const batchIdx = server.indexOf("name: 'tasks_batch'", descIdx);
    expect(descIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(batchIdx).toBeGreaterThan(taskIdx);
    const taskDesc = server.slice(taskIdx, batchIdx);
    expect(taskDesc).toMatch(/still sessioned/i);
    expect(taskDesc).toMatch(/ephemeral retention/i);
  });
});
