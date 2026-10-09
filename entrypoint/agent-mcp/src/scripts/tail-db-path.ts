/**
 * Database path resolution for the `agent-mcp-tail` CLI (backlog c536ce29 / 03be90c3, S8B).
 *
 * The tail reads the SAME operational store the server writes, so it resolves the path through
 * the identical `@adhd/environment` cascade (`operationalEnv`, scope-forced global) instead of a
 * hard-coded `~/.adhd/...` or repo-relative `./data/...` location. `db.path` is fed by
 * `ADHD_AGENT_DATABASE_PATH`, so that override keeps working.
 */
import os from "node:os";
import path from "node:path";

import { operationalEnv } from "../config.js";
import { resolveStore, type IStoreEnvironment } from "../config-store-path.js";

/**
 * Absolute path of the operational agents DB.
 *
 * @param target the Environment to resolve against (tests pass an isolated instance).
 */
export function resolveTailDbPath(
  target: IStoreEnvironment = operationalEnv
): string {
  return resolveStore(target).path;
}

/**
 * Where `agent-mcp-tail` read from before it resolved through the environment cascade
 * (c536ce29 FIX-L9). A DB left there by an older install is not read any more, so an empty or
 * missing resolved DB points at it.
 */
export function legacyTailDbPath(home: string = os.homedir()): string {
  return path.join(home, ".adhd", "agent-mcp", "agents.db");
}

/** Inputs of {@link tailDbHint}. */
export interface ITailDbHintInput {
  /** The DB path the tail resolved and read (or tried to). */
  dbPath: string;
  /** `missing` = no file at `dbPath`; `empty` = file exists but holds no task events. */
  state: "missing" | "empty";
  /** {@link legacyTailDbPath} (injectable for tests). */
  legacyPath: string;
  /** Whether a file exists at `legacyPath`. */
  legacyExists: boolean;
}

/**
 * The one-line operator hint printed when the tail has nothing to show: names the DB it looked at,
 * points at a pre-cascade DB if one exists, and names the override that relocates the read.
 */
export function tailDbHint(i: ITailDbHintInput): string {
  const what = i.state === "missing" ? `no database at ${i.dbPath}` : `no task events in ${i.dbPath}`;
  const legacy =
    i.legacyExists && path.resolve(i.legacyPath) !== path.resolve(i.dbPath)
      ? ` An older install's database exists at ${i.legacyPath}: try ADHD_AGENT_DATABASE_PATH=${i.legacyPath}.`
      : "";
  return `Warning: ${what}.${legacy} Set ADHD_AGENT_DATABASE_PATH to read a different database.`;
}
