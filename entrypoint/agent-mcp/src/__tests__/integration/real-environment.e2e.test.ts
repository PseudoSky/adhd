/**
 * Real-`Environment`-singleton proof (ENV-ADOPT-PROOF-000 / FEAT-ENV-ADOPT-001).
 *
 * Every OTHER integration test in this directory drives `harness.ts`'s
 * `testConfig()` (`harness.ts:141-165`) — a deliberately self-contained mock
 * `EngineConfig` that never touches `../../config.js`, so it can never prove
 * anything about the REAL `@adhd/environment` cascade. This file does the
 * opposite on purpose: it imports the REAL `env` singleton (and
 * `agentMcpEnvironmentSpec`) from `../../config.js` exactly as `index.ts`/
 * `server.ts` do, and drives it through the real
 * `@adhd/environment`/`@adhd/environment-builder` code with real files on
 * disk. `harness.ts` is intentionally left untouched.
 *
 * NOT gated behind `AGENT_MCP_LIVE` — it never calls a paid LLM/provider;
 * only the config/env-resolution layer is under test (AGENTS.md §7 "Live
 * testing is mandatory" — the only legitimate gate is a paid third-party
 * call, which this is not).
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH `HOME` *AND* `ADHD_ENV_SCOPE=global` ARE SET (a real finding, not
 * a guess — confirmed by reading `packages/environment/environment-builder/
 * src/scope.ts` and `.../roots.ts`):
 *
 * The real `env` singleton in `config.ts` is constructed as
 * `new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec,
 * { namespace: 'production' })` — no `scope`/`cwd`/`adhdRoot` override. Scope
 * resolution (`scope.ts`) walks UP from `process.cwd()` looking for a
 * `.git`/`.adhd`/`adhd.environment.yaml` project marker; this repo's own
 * worktree root has both `.git` AND `.adhd`, so with `HOME` alone (and no
 * scope override), the singleton would auto-resolve to `scope: 'project'`
 * and root its `data`/snapshot files under
 * `<this-worktree>/.adhd/agent-mcp/production/…` — INSIDE the repo tree,
 * completely ignoring the `HOME` override (`roots.ts`'s `global`/`system`
 * bases are the only ones `adhdRoot`/`HOME` affect; `project` scope roots
 * under `ctx.projectRoot` instead). `ADHD_ENV_SCOPE=global` is scope.ts's own
 * documented step-2 override (env var, before the marker-walk auto-detect
 * step) — forcing `scope:'global'` is what actually routes storage through
 * `os.homedir()` (i.e. `HOME`) via `roots.ts`'s `globalBase`. Without it,
 * criterion "resolves under the isolated HOME root, not the repo" would be
 * FALSE for the real singleton in ANY test run inside this repo — this was
 * verified as a negative control (see below), not assumed.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS PERFORMED DURING IMPLEMENTATION (not shipped — restored
 * immediately after each observation; see the actual command transcripts in
 * this task's PR/backlog note):
 *
 * 1. (Proves test 2b has teeth.) Temporarily changed
 *    `packages/environment/environment-builder/src/config-resolver.ts` line
 *    `const liveEnvValue = processEnv[envName];` to
 *    `const liveEnvValue = undefined;` (disabling the env-var cascade layer
 *    entirely) and re-ran this file: the "ADHD_AGENT_DEFAULT_MAX_TOKENS env
 *    var overrides…" test went RED (`defaultMaxTokens` stayed `8192` instead
 *    of resolving `12345`). Reverted the line; re-ran — GREEN again.
 * 2. (Proves the `ADHD_ENV_SCOPE=global` finding above is real, not
 *    theoretical.) Temporarily removed the `ADHD_ENV_SCOPE = 'global'`
 *    assignment from this file's tests and re-ran: the "resolves the
 *    zero-config DB file path under the isolated HOME root" test went RED —
 *    `env.files.db` resolved under `<this-worktree>/.adhd/agent-mcp/
 *    production/data/agents.db` (repo tree) instead of under the tmp `HOME`.
 *    Restored the `ADHD_ENV_SCOPE` line; re-ran — GREEN again. (`.adhd/*` is
 *    gitignored — see `.gitignore` — so this never surfaced as an untracked
 *    file, but the directory was still removed by hand afterward.)
 * 3. (Re-run against the fixed, single-import-per-test shape below, per
 *    code review CHANGES_REQUESTED on the first version of this file —
 *    see BUG-AGENTMCP-TEST-ISOLATION-SCOPE-001's sibling review note.)
 *    The original test 2 did TWO `vi.resetModules()` + dynamic
 *    `import('../../config.js')` calls back-to-back inside one `it()`
 *    (baseline-unset import, then override-set import). Under concurrent
 *    system load, vite-node's module cache did not always re-evaluate the
 *    module fresh on the second import within the same test, so the second
 *    import sometimes silently reused the first import's already-
 *    constructed `env` singleton — `defaultMaxTokens` stayed `8192` even
 *    though `ADHD_AGENT_DEFAULT_MAX_TOKENS=12345` had been set before the
 *    second `import(...)` call. Reproduced 8/8 failures under load,
 *    11/11 passes once load subsided — a real non-determinism in the
 *    two-imports-per-test pattern, not a product bug (an isolated `tsx`
 *    script importing `config.ts` directly, one process per resolution,
 *    resolved `12345` correctly every run). Fixed by splitting test 2 into
 *    2a (baseline, one `vi.resetModules()` + one `import()`) and 2b
 *    (override, one `vi.resetModules()` + one `import()`) — matching the
 *    exactly-one-import-per-test shape of tests 1/3/4, none of which ever
 *    exhibited the race in ~20 runs before or after the split. Re-ran the
 *    negative control from (1) above against this fixed shape: 2b went RED
 *    with `liveEnvValue` disabled, GREEN once restored — the assertion
 *    still has teeth after the fix. Also ran 25 consecutive full-file
 *    passes (`for i in $(seq 1 25); do vitest run
 *    real-environment.e2e.test.ts || break; done`) with zero failures,
 *    including runs against an artificially loaded machine (`yes > /dev/null
 *    &` background spinners), to confirm the flake is gone.
 *
 * All three are one-time, documented implementation-time proofs, not part
 * of the shipped suite (a permanently-broken negative-control variant is
 * never committed).
 * ---------------------------------------------------------------------------
 *
 * Isolation: every test gets its own fresh temp `HOME` (`tmp/agent-mcp/
 * env-proof-e2e-home-*`, removed in `afterEach`), `vi.resetModules()` before
 * its single dynamic `import('../../config.js')` so the module-level
 * `loadEnvHierarchy()` call and `env` singleton construction re-run fresh
 * against the current `process.env`, and every touched env var is
 * snapshotted/restored per test so nothing leaks into another test, another
 * file, or the real developer machine's `~/.adhd`.
 *
 * DELIBERATE CONSTRAINT (do not "simplify" this back): every `it()` in this
 * file performs AT MOST ONE `vi.resetModules()` + dynamic
 * `import('../../config.js')` pair. Two dynamic re-imports of the same
 * module specifier inside a single test is exactly the pattern that caused
 * negative control 3 above — do not reintroduce it.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** This worktree's repo root — 5 levels up from
 *  `src/__tests__/integration/`: integration -> __tests__ -> src ->
 *  agent-mcp -> entrypoint -> repo root. */
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

/** Canonical ephemeral-artifacts root (AGENTS.md §10) — never the repo root
 *  or a bare `./data`. */
const TMP_BASE = join(REPO_ROOT, "tmp", "agent-mcp", "env-proof-e2e-home");

/** Every env var any test in this file sets — snapshotted/restored around
 *  EVERY test so nothing leaks across tests, files, or the real machine. */
const ENV_KEYS_UNDER_TEST = [
  "HOME",
  "ADHD_ENV_SCOPE",
  "ADHD_AGENT_DEFAULT_MAX_TOKENS",
  "ADHD_AGENT_REGISTRY_DB_PATH",
  "ADHD_AGENT_DATABASE_PATH",
] as const;

let savedEnv: Record<string, string | undefined> = {};
const cleanupDirs: string[] = [];

/** Fresh, isolated `HOME` directory — real files land under here, never
 *  under the real developer machine's `~/.adhd` or this repo's tree. */
function mkTmpHome(): string {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, "home-"));
  cleanupDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS_UNDER_TEST) savedEnv[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  vi.resetModules();

  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent-mcp real env singleton (config.ts) — end-to-end through the real @adhd/environment cascade", () => {
  it("(test 1) constructs the real env singleton against an isolated HOME without throwing", async () => {
    const tmpHome = mkTmpHome();
    process.env.HOME = tmpHome;
    process.env.ADHD_ENV_SCOPE = "global";
    vi.resetModules();

    const configModule = await import("../../config.js");

    expect(configModule.env).toBeDefined();
    expect(configModule.env.config).toBeDefined();
    expect(configModule.env.scope).toBe("global");
    // Zero-config: even with nothing set, every field still resolves.
    expect(configModule.env.config.server.defaultMaxTokens).toBe(8192);
  });

  // Split into 2a/2b (one `vi.resetModules()` + one dynamic `import()` per
  // test) per code review CHANGES_REQUESTED — see the file header's
  // "negative control 3" note. The original single-`it()` version did two
  // back-to-back dynamic re-imports of `../../config.js` and was flaky
  // under system load (vite-node's module cache did not always evaluate
  // the second import fresh). 2a proves the baseline (unset -> code
  // default); 2b proves the override, independently, against its own fresh
  // module graph — together they still prove the override is a real
  // cascade effect and not a coincidental hardcoded value, without ever
  // importing the module twice inside one test.
  it("(test 2a) baseline: with ADHD_AGENT_DEFAULT_MAX_TOKENS unset, server.defaultMaxTokens resolves to the code default (8192)", async () => {
    const tmpHome = mkTmpHome();
    process.env.HOME = tmpHome;
    process.env.ADHD_ENV_SCOPE = "global";
    delete process.env.ADHD_AGENT_DEFAULT_MAX_TOKENS;
    vi.resetModules();

    const baseline = await import("../../config.js");

    expect(baseline.env.config.server.defaultMaxTokens).toBe(8192);
    expect(baseline.env.get("provenance.server.defaultMaxTokens")).toMatchObject({
      source: "default",
    });
  });

  it("(test 2b) ADHD_AGENT_DEFAULT_MAX_TOKENS env var overrides server.defaultMaxTokens end-to-end through the real Environment", async () => {
    const tmpHome = mkTmpHome();
    process.env.HOME = tmpHome;
    process.env.ADHD_ENV_SCOPE = "global";
    process.env.ADHD_AGENT_DEFAULT_MAX_TOKENS = "12345";
    vi.resetModules();

    const overridden = await import("../../config.js");

    expect(overridden.env.config.server.defaultMaxTokens).toBe(12345);
    expect(overridden.env.get("provenance.server.defaultMaxTokens")).toMatchObject({
      source: "env",
      env: "ADHD_AGENT_DEFAULT_MAX_TOKENS",
    });
  });

  it("(test 3) resolves the zero-config DB file path under the isolated HOME root, never a bare ./data relative path, and leaves real files on disk there", async () => {
    const tmpHome = mkTmpHome();
    process.env.HOME = tmpHome;
    process.env.ADHD_ENV_SCOPE = "global";
    delete process.env.ADHD_AGENT_REGISTRY_DB_PATH;
    delete process.env.ADHD_AGENT_DATABASE_PATH;
    vi.resetModules();

    const { env } = await import("../../config.js");

    const dbPath = env.files.db;
    expect(dbPath.startsWith(tmpHome)).toBe(true);
    expect(dbPath).not.toBe("./data/agents.db");
    expect(dbPath.endsWith(join("data", "agents.db"))).toBe(true);
    // Not the repo's own gitignored `./data/` (the legacy zero-config
    // default this replaces) — this is a real check, distinct from
    // `tmpHome`'s ancestry: `tmpHome` is ITSELF legitimately nested under
    // `REPO_ROOT/tmp/` (AGENTS.md §10's canonical ephemeral root), so a bare
    // `!dbPath.startsWith(REPO_ROOT)` would be false for EVERY correct
    // result and prove nothing.
    expect(dbPath.startsWith(join(REPO_ROOT, "data"))).toBe(false);
    // Not the repo's own `.adhd/` project-scope root either — proves
    // `ADHD_ENV_SCOPE=global` actually routed this through `roots.ts`'s
    // `global` base (HOME) instead of the `project` scope that `cwd`
    // auto-detection would otherwise pick (this worktree root has both
    // `.git` and `.adhd` markers).
    expect(dbPath.startsWith(join(REPO_ROOT, ".adhd"))).toBe(false);

    // Prove the tmp HOME root actually gets populated with real files on
    // disk, not merely a resolved-but-never-touched path string.
    env.ensureDirs();
    const writtenSnapshotPath = env.write();

    expect(existsSync(env.paths.data)).toBe(true);
    expect(existsSync(writtenSnapshotPath)).toBe(true);
    expect(writtenSnapshotPath.startsWith(tmpHome)).toBe(true);

    // And nothing lands in this repo's own gitignored root `./data/`
    // (AGENTS.md §10 / the legacy `./data/agents.db` default this replaces).
    expect(existsSync(join(REPO_ROOT, "data"))).toBe(false);
  });

  it("(test 4) documents the REAL isEnvNameAllowed prefix-only allowlist behavior (ADHD_AGENT_* only — the G1 gap is real and unfixed here, out of scope)", async () => {
    const tmpHome = mkTmpHome();
    process.env.HOME = tmpHome;
    process.env.ADHD_ENV_SCOPE = "global";
    vi.resetModules();

    const { env } = await import("../../config.js");

    expect(env.isEnvNameAllowed("ADHD_AGENT_TEST_SECRET")).toBe(true);
    expect(env.isEnvNameAllowed("OPENAI_API_KEY")).toBe(false);
  });
});
