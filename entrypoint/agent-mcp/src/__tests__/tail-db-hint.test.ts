/**
 * c536ce29 FIX-L9 — `agent-mcp-tail` resolves its DB through the environment cascade, so a DB an
 * older install left at the pre-cascade `~/.adhd/agent-mcp/agents.db` is no longer read. An empty or
 * missing resolved DB must tell the operator where it looked and where the older file is.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { legacyTailDbPath, tailDbHint } from "../scripts/tail-db-path.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("c536ce29 FIX-L9 tail DB hint", () => {
  it("c536ce29 FIX-L9: the legacy path is <home>/.adhd/agent-mcp/agents.db", () => {
    expect(legacyTailDbPath("/h")).toBe(join("/h", ".adhd", "agent-mcp", "agents.db"));
  });

  it("c536ce29 FIX-L9: an empty resolved DB with a legacy DB on disk names both and the override", () => {
    const home = mkdtempSync(join(tmpdir(), "tail-hint-"));
    dirs.push(home);
    const legacyPath = legacyTailDbPath(home);
    mkdirSync(join(home, ".adhd", "agent-mcp"), { recursive: true });
    writeFileSync(legacyPath, "");
    const dbPath = join(home, ".adhd", "agent-mcp", "production", "data", "agents.db");
    const hint = tailDbHint({ dbPath, state: "empty", legacyPath, legacyExists: existsSync(legacyPath) });
    expect(hint).toContain(`no task events in ${dbPath}`);
    expect(hint).toContain(`ADHD_AGENT_DATABASE_PATH=${legacyPath}`);
  });

  it("c536ce29 FIX-L9: a missing DB says 'no database', and no legacy suggestion is made when none exists or it is the same file", () => {
    const missing = tailDbHint({ dbPath: "/x/agents.db", state: "missing", legacyPath: "/h/agents.db", legacyExists: false });
    expect(missing).toContain("no database at /x/agents.db");
    expect(missing).not.toContain("older install");
    expect(missing).toContain("ADHD_AGENT_DATABASE_PATH");
    const same = tailDbHint({ dbPath: "/h/agents.db", state: "empty", legacyPath: "/h/agents.db", legacyExists: true });
    expect(same).not.toContain("older install");
  });
});
