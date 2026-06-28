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
 * Call this once before taking a `process.env` snapshot (i.e. from `config.ts`).
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
