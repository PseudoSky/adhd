/**
 * Database path resolution for the `agent-mcp-tail` CLI (backlog c536ce29 / 03be90c3, S8B).
 *
 * The tail reads the SAME operational store the server writes, so it resolves the path through
 * the identical `@adhd/environment` cascade (`operationalEnv`, scope-forced global) instead of a
 * hard-coded `~/.adhd/...` or repo-relative `./data/...` location. `db.path` is fed by
 * `ADHD_AGENT_DATABASE_PATH`, so that override keeps working.
 */
import path from "node:path";

import type { Environment } from "@adhd/environment";

import { operationalEnv, type AgentMcpConfig } from "../config.js";

/**
 * Absolute path of the operational agents DB.
 *
 * @param target the Environment to resolve against (tests pass an isolated instance).
 */
export function resolveTailDbPath(
  target: Pick<Environment<AgentMcpConfig>, "config" | "files"> = operationalEnv
): string {
  return path.resolve(target.config.db.path ?? target.files["db"]);
}
