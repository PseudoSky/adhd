/**
 * Operational-store resolution (backlog de046157 BK6 / AC6.1-AC6.2).
 *
 * The operational SQLite store has exactly one unconfigured answer — the production store in the
 * user home (`~/.adhd/agent-mcp/production/data/agents.db`) — and exactly one way to point somewhere
 * else: an explicit ABSOLUTE path. There is no mode toggle and no "looks like a dev DB" heuristic;
 * a development database is simply a path outside the production root.
 *
 * Resolution order (highest wins):
 *   1. `ADHD_AGENT_DATABASE_PATH` in the real process environment (this includes values that
 *      `utils/load-env.ts` lifted from `~/.adhd/.env`, which it has already anchored to that file's
 *      directory). MUST be absolute; a relative value is rejected, never resolved against the cwd.
 *   2. `db.path` from a system/global `config.yaml`. A relative value is anchored to the directory
 *      of the file that supplied it (the global root); a relative system value cannot be anchored
 *      and is rejected.
 *   3. The production default.
 *
 * The result is also what the server logs at startup, `store=<abs> mode=<..> source=<..>`, where
 * `mode` is DERIVED (`production` iff the default or a path under the production root, else
 * `custom`) and never configured. Every store, including a custom one, is parallel-process enabled
 * (ADR-0012): several processes may hold write connections to it concurrently.
 */
import path from "node:path";

import type { ProvenanceEntry } from "@adhd/environment-base-spec";

/** Which layer supplied the store path. */
export type StoreSource = "env" | "cascade" | "default";
/** Derived (never configured): whether the store lives under the production root. */
export type StoreMode = "production" | "custom";

/** The resolved operational store. */
export interface IResolvedStore {
  /** Absolute path of the SQLite file. */
  readonly path: string;
  readonly source: StoreSource;
  readonly mode: StoreMode;
}

/** Thrown when a configured store path cannot be resolved unambiguously. */
export class StorePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorePathError";
  }
}

/** The slice of an `Environment<AgentMcpConfig>` the resolver reads (tests pass isolated instances). */
export interface IStoreEnvironment {
  readonly config: { readonly db: { readonly path: string | undefined } };
  readonly files: Record<string, string>;
  readonly paths: Record<string, string>;
  readonly provenance: Record<string, ProvenanceEntry>;
}

function isUnder(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves the operational store path, source and derived mode.
 *
 * @param target the (scope-forced) Environment to resolve against
 * @throws {StorePathError} on a relative path from the process environment, a relative path from a
 *   system config file, an empty value, or an unreadable provenance layer
 */
export function resolveStore(target: IStoreEnvironment): IResolvedStore {
  const defaultPath = path.resolve(target.files["db"] as string);
  const productionRoot = path.dirname(path.resolve(target.paths["data"] as string));
  const configured = target.config.db.path;
  const prov = target.provenance["db.path"];

  if (configured === undefined || prov?.source === "default") {
    return { path: defaultPath, source: "default", mode: "production" };
  }

  let resolved: string;
  let source: StoreSource;
  if (prov === undefined || prov.source === "env") {
    source = "env";
    if (configured.length === 0 || !path.isAbsolute(configured)) {
      throw new StorePathError(
        `ADHD_AGENT_DATABASE_PATH=${JSON.stringify(configured)} (source: process environment) must be an ` +
          `absolute path. A relative value would depend on the launch directory. Use an absolute path ` +
          `(a development store is just an explicit absolute path outside ${productionRoot}) or unset it ` +
          `to use the production store ${defaultPath}.`
      );
    }
    resolved = path.normalize(configured);
  } else {
    source = "cascade";
    if (configured.length === 0) {
      throw new StorePathError(`db.path in the ${prov.source} config.yaml is empty; remove it or give an absolute path.`);
    }
    if (path.isAbsolute(configured)) {
      resolved = path.normalize(configured);
    } else if (prov.source === "global") {
      resolved = path.resolve(productionRoot, configured);
    } else {
      throw new StorePathError(
        `db.path=${JSON.stringify(configured)} (source: ${prov.source} config.yaml) is relative and cannot be ` +
          `anchored to that file's directory; use an absolute path.`
      );
    }
  }

  const mode: StoreMode = isUnder(productionRoot, resolved) ? "production" : "custom";
  return { path: resolved, source, mode };
}

/** The one-line startup banner: `store=<abs> mode=<production|custom> source=<env|cascade|default>`. */
export function formatStoreLine(store: IResolvedStore): string {
  return `store=${store.path} mode=${store.mode} source=${store.source}`;
}
