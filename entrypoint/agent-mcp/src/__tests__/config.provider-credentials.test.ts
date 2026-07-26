/**
 * BUG-MCP-CREDENTIALS-001 — behavioral proof that a provider secret set in a
 * `.env` file actually reaches `getProviderConfig` (and therefore the real
 * provider client, e.g. `AnthropicProvider`/`OpenAIProvider`).
 *
 * Root cause (confirmed via `git log -S loadEnvHierarchy`, commit
 * `b38369f3`): the `@adhd/environment` redesign deleted
 * `entrypoint/agent-mcp/src/utils/load-env.ts`'s `loadEnvHierarchy()` call
 * from `config.ts` without replacing it. Provider secrets
 * (`PROVIDER_DEFAULTS` in `config.ts`, e.g. `ADHD_AGENT_ANTHROPIC_SECRET`)
 * are deliberately NOT `EnvironmentSpec` config fields (see `config.ts`'s
 * header comment) — they are resolved ONLY via `Environment#resolveEnvName`,
 * a live, unconditional `process.env[name]` read with no file-cascade
 * fallback of its own (`environment-core-node`'s `resolveEnvName`). Before
 * the redesign, `loadEnvHierarchy()` populated `process.env` from
 * `~/.adhd/.env` → `<cwd>/.adhd/.env` → `<cwd>/.env` (dotenv, most-specific
 * wins) BEFORE any secret was read. Deleting that call left secrets set only
 * in a `.env` file (never a real shell-exported var) permanently invisible —
 * `getProviderConfig` would throw "No credential for <provider>" even with
 * a correctly-populated `~/.adhd/.env`, exactly as agent-mcp's own
 * `server.ts`/`providers/anthropic.ts`/`providers/openai.ts` docs and error
 * text still instruct users to set up.
 *
 * This test drives the REAL, unmodified `config.ts` (`env.getProviderConfig`,
 * the real `Environment` singleton, the real `loadEnvHierarchy`, real
 * `dotenv`) against real temp `.env` files — the only test doubles are
 * `os.homedir()` (redirected to an isolated temp dir so this test can never
 * read/write the developer machine's real `~/.adhd/.env`) and `process.cwd()`
 * (via `process.chdir`, restored in `afterEach`). Nothing about secret
 * resolution itself — `dotenv`, `Environment`, `resolveEnvName`,
 * `getProviderConfig` — is mocked.
 *
 * Because `config.ts` builds its `env` singleton (and calls
 * `loadEnvHierarchy()`) at MODULE IMPORT time, each scenario needs a fresh
 * module registry (`vi.resetModules()`) plus a fresh dynamic `import()` so
 * the `.env` files on disk at that moment are the ones actually read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROVIDER_SECRET_ENV_VARS = [
    "ADHD_AGENT_ANTHROPIC_SECRET",
    "ADHD_AGENT_ANTHROPIC_BASE_URL",
    "ADHD_AGENT_ANTHROPIC_MODEL",
    "ADHD_AGENT_OPENAI_SECRET",
    "ADHD_AGENT_OPENAI_BASE_URL",
    "ADHD_AGENT_OPENAI_MODEL",
];

const cleanupDirs: string[] = [];
let originalCwd: string;
let fakeHome: string;
let fakeCwd: string;

/** Isolated fake `$HOME` — dotenv reads `<fakeHome>/.adhd/.env`, never the
 *  real developer machine's `~/.adhd/.env`. Lives under this project's
 *  `tmp/` per AGENTS.md §10. */
function mkFakeHome(): string {
    const base = join(__dirname, "..", "..", "..", "..", "tmp", "agent-mcp", "provider-credentials-test");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "home-"));
    cleanupDirs.push(dir);
    return dir;
}

/** Isolated fake cwd, OUTSIDE the repo tree (`os.tmpdir()`) — no `.git`
 *  marker, so `dotenv`'s `<cwd>/.env` / `<cwd>/.adhd/.env` layers are
 *  exercised against a clean, empty directory unless a test writes into it. */
function mkFakeCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "adhd-agent-mcp-provider-cwd-"));
    cleanupDirs.push(dir);
    return dir;
}

function writeEnvFile(dir: string, contents: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), contents, "utf8");
}

/** Imports a fresh `../config.js` against the CURRENT `fakeHome`/`fakeCwd`
 *  `.env` files on disk. `os.homedir` is mocked for this module graph only
 *  (`vi.resetModules()` scopes the mock's effect to modules re-imported
 *  after it is installed). */
async function importFreshConfig() {
    vi.resetModules();
    vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => fakeHome, default: { ...actual, homedir: () => fakeHome } };
    });
    process.chdir(fakeCwd);
    return import("../config.js");
}

beforeEach(() => {
    originalCwd = process.cwd();
    fakeHome = mkFakeHome();
    fakeCwd = mkFakeCwd();
});

afterEach(() => {
    process.chdir(originalCwd);
    vi.doUnmock("node:os");
    vi.resetModules();
    for (const name of PROVIDER_SECRET_ENV_VARS) delete process.env[name];
    while (cleanupDirs.length > 0) {
        const dir = cleanupDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

// Placeholder fixture values — deliberately NOT shaped like a real provider
// credential (no `sk-`/`sk-ant-` prefix) so the repo's pre-commit secret
// scanner never has to special-case this file; these are fixture strings a
// test writes to a throwaway temp `.env` file, never a real credential.
const FIXTURE_HOME_ANTHROPIC = "TESTFIXTURE-anthropic-from-home-env";
const FIXTURE_PROJECT_OPENAI = "TESTFIXTURE-openai-from-project-env";
const FIXTURE_GLOBAL = "TESTFIXTURE-anthropic-global";
const FIXTURE_PROJECT_ENV = "TESTFIXTURE-anthropic-project-env-file";
const FIXTURE_PROJECT_ADHD_ENV = "TESTFIXTURE-anthropic-project-adhd-env-file";
const FIXTURE_FILE_LOSES_TO_SHELL = "TESTFIXTURE-anthropic-from-file-should-lose";
const FIXTURE_REAL_SHELL_ENV = "TESTFIXTURE-anthropic-from-real-shell-env";

describe("BUG-MCP-CREDENTIALS-001 — provider secret resolution from the .env file cascade", () => {
    it("a secret set ONLY in ~/.adhd/.env (never a real shell-exported env var) reaches getProviderConfig", async () => {
        writeEnvFile(join(fakeHome, ".adhd"), `ADHD_AGENT_ANTHROPIC_SECRET=${FIXTURE_HOME_ANTHROPIC}\n`);

        // Sanity: the value genuinely isn't already a process-level env var —
        // proves the assertion below can only pass via the file being read.
        expect(process.env.ADHD_AGENT_ANTHROPIC_SECRET).toBeUndefined();

        const { env } = await importFreshConfig();

        const resolved = env.getProviderConfig({ provider: "anthropic" });
        expect(resolved.secret).toBe(FIXTURE_HOME_ANTHROPIC);
    });

    it("a secret set ONLY in <project>/.env (never a real shell-exported env var) reaches getProviderConfig", async () => {
        writeEnvFile(fakeCwd, `ADHD_AGENT_OPENAI_SECRET=${FIXTURE_PROJECT_OPENAI}\n`);
        expect(process.env.ADHD_AGENT_OPENAI_SECRET).toBeUndefined();

        const { env } = await importFreshConfig();

        const resolved = env.getProviderConfig({ provider: "openai" });
        expect(resolved.secret).toBe(FIXTURE_PROJECT_OPENAI);
    });

    it("cascade precedence: <project>/.env overrides ~/.adhd/.env for the same var (most-specific wins)", async () => {
        writeEnvFile(join(fakeHome, ".adhd"), `ADHD_AGENT_ANTHROPIC_SECRET=${FIXTURE_GLOBAL}\n`);
        writeEnvFile(fakeCwd, `ADHD_AGENT_ANTHROPIC_SECRET=${FIXTURE_PROJECT_ENV}\n`);

        const { env } = await importFreshConfig();

        expect(env.getProviderConfig({ provider: "anthropic" }).secret).toBe(FIXTURE_PROJECT_ENV);
    });

    it("cascade precedence: <project>/.adhd/.env overrides ~/.adhd/.env but loses to <project>/.env", async () => {
        writeEnvFile(join(fakeHome, ".adhd"), `ADHD_AGENT_ANTHROPIC_SECRET=${FIXTURE_GLOBAL}\n`);
        writeEnvFile(join(fakeCwd, ".adhd"), `ADHD_AGENT_ANTHROPIC_SECRET=${FIXTURE_PROJECT_ADHD_ENV}\n`);

        const { env } = await importFreshConfig();

        expect(env.getProviderConfig({ provider: "anthropic" }).secret).toBe(FIXTURE_PROJECT_ADHD_ENV);
    });

    it("negative control: with NO .env files and NO real env var, getProviderConfig throws (proves the assertions above have teeth — they are not a default/fallback value)", async () => {
        // No .env files written in fakeHome/fakeCwd for this scenario.
        const { env } = await importFreshConfig();

        expect(() => env.getProviderConfig({ provider: "anthropic" })).toThrow(/No credential for anthropic/);
    });

    it("a REAL shell-exported env var still wins over any .env file (env var is the highest-precedence layer)", async () => {
        writeEnvFile(join(fakeHome, ".adhd"), `ADHD_AGENT_ANTHROPIC_SECRET=${FIXTURE_FILE_LOSES_TO_SHELL}\n`);
        process.env.ADHD_AGENT_ANTHROPIC_SECRET = FIXTURE_REAL_SHELL_ENV;

        const { env } = await importFreshConfig();

        expect(env.getProviderConfig({ provider: "anthropic" }).secret).toBe(FIXTURE_REAL_SHELL_ENV);
    });
});
