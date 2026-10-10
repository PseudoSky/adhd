/**
 * Hermetic-environment setup for the agent-mcp unit lane.
 *
 * `nx` loads the repo-root `.env` (gitignored, developer-local) into the process
 * environment of every task. That file may legitimately hold dev config such as a
 * RELATIVE `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`, which the
 * product (BK6, `config-store-path.ts`) deliberately REJECTS when it arrives via
 * the real process environment. A unit run must not depend on what a developer's
 * `.env` happens to contain, so every `ADHD_AGENT_*` variable inherited from the
 * parent environment is dropped before any test file loads. Tests that need a
 * value set it themselves inside the test body, which is unaffected: this runs
 * once per test file, before the file is imported.
 *
 * Exception: the explicit paid-model GATE flags below are test-selection switches, not
 * product configuration, so they must survive (a gate wiped here could never be turned on).
 * Each is documented with its owner in README.md / AGENTS.md ("Live tests") and in its test
 * header: `ADHD_AGENT_LIVE_CACHE` (8ecaa160 AC1, owner pseudosky).
 */
const KEEP_GATES = new Set(['ADHD_AGENT_LIVE_CACHE']);
for (const key of Object.keys(process.env)) {
  if (/^ADHD_AGENT_/.test(key) && !KEEP_GATES.has(key)) delete process.env[key];
}
