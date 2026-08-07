import path from "node:path";
import os from "node:os";
import { config as dotenvConfig } from "dotenv";

/**
 * Load the `.env` hierarchy into `process.env` with most-specific wins:
 *
 *   1. `<cwd>/.env`            (highest precedence)
 *   2. `<cwd>/.adhd/.env`
 *   3. `~/.adhd/.env`          (lowest precedence)
 *
 * Each file is loaded only if it exists — missing files are silently skipped
 * by dotenv. Already-set vars from a more-specific file are not overridden by
 * a less-specific one (load least-specific first; use `override:true` for each
 * successive, more-specific load).
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
export function loadEnvHierarchy(cwd: string = process.cwd()): void {
    // 3. ~/.adhd/.env — lowest precedence, load first without override flag so
    //    POSIX vars already in process.env (PATH, HOME, …) are not disturbed.
    dotenvConfig({ path: path.join(os.homedir(), ".adhd", ".env") });
    // 2. <cwd>/.adhd/.env — project-specific beats global
    dotenvConfig({ path: path.join(cwd, ".adhd", ".env"), override: true });
    // 1. <cwd>/.env — highest precedence
    dotenvConfig({ path: path.join(cwd, ".env"), override: true });
}
