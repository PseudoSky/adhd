import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { config as dotenvConfig, parse as dotenvParse } from "dotenv";

/**
 * The operational-store variable. It is the one key whose `.env` sourcing is restricted (backlog
 * de046157 BK6): see {@link loadEnvHierarchy}.
 */
export const STORE_PATH_ENV = "ADHD_AGENT_DATABASE_PATH";

/** Injection points for {@link loadEnvHierarchy} (tests; production uses the defaults). */
export interface ILoadEnvOptions {
    /** Receives one human-readable line per ignored store-path assignment. Default: stderr. */
    readonly warn?: (message: string) => void;
}

/** `<dir>/.adhd/.env` — the per-directory file name used by the project and home layers. */
const ENV_FILE = (dir: string): string => path.join(dir, ...ENV_FILE_SEGMENTS);
const ENV_FILE_SEGMENTS = [".adhd", ".env"] as const;

function readDotenv(file: string): Record<string, string> {
    try {
        return dotenvParse(readFileSync(file));
    } catch {
        return {};
    }
}

/**
 * Blank provider-secret env values are treated as UNSET before the hierarchy
 * is loaded.
 *
 * Rationale (backlog 307a36c1): an MCP host that forwards a secret it does not
 * have (e.g. `.mcp.json`'s `"ADHD_AGENT_ANTHROPIC_SECRET": "${...}"` with the
 * var unset in the shell) sets it to the EMPTY STRING. `dotenv` never overrides
 * an already-defined key, so that empty value would shadow a real secret sitting
 * in `~/.adhd/.env` — turning the forwarding change into a silent regression for
 * every user who relies on the `.env` cascade. Clearing empty `*_SECRET` values
 * first lets the file hierarchy fill them, while a genuinely-empty secret stays
 * meaningless (falsy) either way.
 *
 * Exported for direct unit-testing.
 */
export function clearEmptyProviderSecrets(
    env: NodeJS.ProcessEnv = process.env
): void {
    for (const key of Object.keys(env)) {
        if (env[key] === "" && /^ADHD_AGENT_.*_SECRET$/.test(key)) {
            delete env[key];
        }
    }
}

/**
 * Load the `.env` hierarchy into `process.env` with most-specific wins:
 *
 *   0. variables already in `process.env` when this function is called
 *      (explicit process-level env, e.g. `ADHD_AGENT_DATABASE_PATH` set by the
 *      spawning host/shell) — the MOST specific; NO `.env` file overrides them
 *   1. `<cwd>/.env`
 *   2. `<cwd>/.adhd/.env`
 *   3. `~/.adhd/.env`          (lowest precedence)
 *
 * Files may override other files (more-specific file wins), but never a
 * variable that was present in `process.env` before loading (backlog 76950870:
 * a repo `.env` line `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`
 * silently beat an explicit production path in the launch environment). An
 * empty-string `ADHD_AGENT_*_SECRET` is not "present" — see
 * {@link clearEmptyProviderSecrets}.
 *
 * Each file is loaded only if it exists — missing files are silently skipped
 * by dotenv. Already-set vars from a more-specific file are not overridden by
 * a less-specific one (load least-specific first; use `override:true` for each
 * successive, more-specific load).
 *
 * STORE-PATH EXCEPTION (backlog de046157 BK6, F1): `<cwd>/.env` and `<cwd>/.adhd/.env` are DISCOVERED
 * from the launch directory, so letting them select the operational store makes the store depend on
 * where the server was started (the same server opened a dev DB from the repo root and the
 * production DB from anywhere else). They therefore may NOT supply `ADHD_AGENT_DATABASE_PATH`: an
 * assignment there is ignored with a warning naming the file. The store is selected by the process
 * environment (absolute path) or `~/.adhd/.env` (cwd-independent; a relative value is anchored to
 * that file's directory, never the cwd), else the production default. Every other key keeps the
 * cwd-discovered layering above.
 *
 * Call this once, before `config.ts` constructs the `Environment` singleton
 * or resolves any provider credential — see `config.ts`'s top-of-file import.
 *
 * RESTORED for BUG-MCP-CREDENTIALS-001: the `@adhd/environment` redesign
 * (`packages/environment/ARCHITECTURE.md`) intentionally moved ordinary
 * `config` fields onto its own YAML file-cascade
 * (`environment-builder`'s `loadLayerFiles`/`resolveConfig`), which made this
 * loader's job for *declared* fields (`db.path`, `transport.port`, …)
 * redundant — but provider secrets (`ADHD_AGENT_{OPENAI,ANTHROPIC,DEEPSEEK}_SECRET`
 * plus any agent-declared `provider.env.secret` name) are deliberately NOT
 * `FieldSpec`s (see `config.ts`'s header comment) and are resolved only via
 * `Environment#resolveEnvName`, which reads *live* `process.env` and nothing
 * else. Deleting this loader in the refactor (commit b38369f3) left no
 * mechanism to populate `process.env` from a file for those names at all —
 * a secret set only in `~/.adhd/.env` (as agent-mcp's own error messages in
 * `server.ts`/`providers/anthropic.ts`/`providers/openai.ts` still instruct
 * users to do) silently stopped being seen. This loader is the fix: it is
 * `Environment`-agnostic (secrets aren't part of `EnvironmentSpec`), so it
 * runs once at process start, ahead of any `Environment` construction or
 * `getProviderConfig` call, and populates the exact same three files the
 * user-facing docs already reference.
 */
export function loadEnvHierarchy(cwd: string = process.cwd(), options: ILoadEnvOptions = {}): void {
    const warn =
        options.warn ??
        ((message: string): void => {
            // stderr only: stdout is the MCP stdio JSON-RPC channel.
            process.stderr.write(`agent-mcp: ${message}\n`);
        });
    // `quiet: true` on every load is REQUIRED, not cosmetic (backlog a0806529):
    // dotenv >=17 prints `◇ injected env (N) from <file> // tip: …` via
    // `console.log` — i.e. STDOUT — which is the MCP stdio JSON-RPC channel.
    // Any non-JSON byte there corrupts the stream for strict hosts.
    // Blank-out empty forwarded secrets so they cannot shadow a real file value.
    clearEmptyProviderSecrets();
    // Snapshot the explicit process env BEFORE any file is read; it is
    // re-applied after the file layering so no `.env` can override it.
    const explicit = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) explicit.set(key, value);
    }
    // 3. ~/.adhd/.env — lowest precedence, load first without override flag so
    //    POSIX vars already in process.env (PATH, HOME, …) are not disturbed.
    dotenvConfig({ path: path.join(os.homedir(), ".adhd", ".env"), quiet: true });
    // 2. <cwd>/.adhd/.env — project-specific beats global
    dotenvConfig({ path: path.join(cwd, ".adhd", ".env"), override: true, quiet: true });
    // 1. <cwd>/.env — highest precedence
    dotenvConfig({ path: path.join(cwd, ".env"), override: true, quiet: true });
    // 0. Explicit process env is the most specific layer: restore it over
    //    whatever the override:true file loads wrote.
    for (const [key, value] of explicit) {
        process.env[key] = value;
    }
    // Store path: only the process env (restored above) or ~/.adhd/.env may supply it.
    if (!explicit.has(STORE_PATH_ENV)) {
        delete process.env[STORE_PATH_ENV];
        const homeFile = ENV_FILE(os.homedir());
        const fromHome = readDotenv(homeFile)[STORE_PATH_ENV];
        if (fromHome !== undefined && fromHome !== "") {
            process.env[STORE_PATH_ENV] = path.isAbsolute(fromHome)
                ? path.normalize(fromHome)
                : path.resolve(path.dirname(homeFile), fromHome);
        }
        for (const file of [ENV_FILE(cwd), path.join(cwd, ".env")]) {
            if (readDotenv(file)[STORE_PATH_ENV] !== undefined) {
                warn(
                    `ignoring ${STORE_PATH_ENV} in ${file}: a launch-directory .env cannot select the operational ` +
                        `store (it would change with the cwd). Set an absolute ${STORE_PATH_ENV} in the process ` +
                        `environment or in ${homeFile}, or unset it to use the production store.`
                );
            }
        }
    }
}
