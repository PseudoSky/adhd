/**
 * The unit lane must be hermetic against the repo-root `.env` that `nx` exports
 * into every task (e.g. a relative `ADHD_AGENT_DATABASE_PATH`, which BK6 rejects
 * when it arrives via the real process environment). `vitest.setup.mjs` drops every
 * inherited `ADHD_AGENT_*` variable before a test file loads; tests that need a
 * value set it themselves inside the test body. The BK6 rejection of a relative
 * env path stays covered by bk6-store-path.test.ts (unchanged).
 *
 * Teeth: with `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db` exported in the
 * parent shell, removing `setupFiles` from vite.config.ts turns the first test red
 * (and registry-prompt-resolver.test.ts fails to load with StorePathError).
 */
import { describe, expect, it } from "vitest";

describe("hermetic unit-test environment", () => {
  it("has no ADHD_AGENT_* variable inherited from the parent environment", () => {
    const leaked = Object.keys(process.env).filter((k) => k.startsWith("ADHD_AGENT_"));
    expect(leaked).toEqual([]);
  });
});
