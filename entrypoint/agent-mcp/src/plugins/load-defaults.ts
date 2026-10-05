/**
 * `load-defaults.ts` — the ONE place agent-mcp loads its default + user-
 * configured external plugins.
 *
 * Backlog cc636860: the default budget entry (`@adhd/agent-plugin-budget`,
 * built by `defaultPluginEntries()`) is a REGULAR dependency of agent-mcp
 * (`entrypoint/agent-mcp/package.json`), so it always lives under agent-mcp's
 * own `node_modules` — in the monorepo AND in a published install. The engine
 * loader, however, only resolved a bare specifier from `[process.cwd(), the
 * ORCHESTRATOR's module dir]`; the orchestrator carries the plugin only as an
 * OPTIONAL peer (not auto-installed for a published consumer), so outside the
 * monorepo the default could be silently skipped ("Plugin resolution failed —
 * skipping").
 *
 * The fix (the explicit-resolution-base half of dfb03557's residual): agent-mcp
 * passes ITS OWN package module directory to `loadExternalPlugins` as an extra
 * resolution base, so the default resolves wherever agent-mcp itself is
 * installed. See `packages/agent/agent-engine-orchestrator/src/plugins/loader.ts`
 * `resolveSpecifier()`'s `extraBases`.
 */
import { fileURLToPath } from "node:url";

import type { EngineLogger } from "@adhd/agent-engine-orchestrator";
import { loadExternalPlugins } from "@adhd/agent-engine-orchestrator";
import type { IHookRegistry } from "@adhd/agent-base-types";

import { defaultPluginEntries, env } from "../config.js";

/**
 * agent-mcp's own package module directory (`src/` under source, `dist/src/`
 * when built) — the base node resolves agent-mcp's real dependencies from.
 * `import.meta.url` is restored in the CJS output by the `importMetaUrlCjs()`
 * vite plugin (see `vite.config.ts`), so this is correct under both formats.
 */
export const AGENT_MCP_PLUGIN_RESOLUTION_BASE = fileURLToPath(
  new URL(".", import.meta.url)
);

export interface LoadDefaultPluginsOverrides {
  /**
   * Explicit plugin-config path. `undefined` ⇒ the live cascade
   * (`env.config.plugins.configPath`); tests pass a NON-EXISTENT path to keep
   * the run hermetic (never reading the developer's `~/.adhd` config).
   */
  configPath?: string | null;
  /** Extra module-resolution bases; defaults to agent-mcp's own module dir. */
  resolveBases?: readonly string[];
}

/**
 * Loads the default plugin entries plus any operator-configured entries,
 * resolving bare specifiers from agent-mcp's own module base. Never throws
 * (the underlying loader is best-effort).
 */
export async function loadDefaultPlugins(
  hooks: IHookRegistry,
  db: unknown,
  logger: EngineLogger,
  overrides: LoadDefaultPluginsOverrides = {}
): Promise<void> {
  await loadExternalPlugins(
    hooks,
    db,
    {
      configPath: overrides.configPath,
      resolveBases: overrides.resolveBases ?? [AGENT_MCP_PLUGIN_RESOLUTION_BASE],
    },
    env.config.plugins.configPath,
    env.config.plugins.entries as string[],
    logger,
    defaultPluginEntries()
  );
}
