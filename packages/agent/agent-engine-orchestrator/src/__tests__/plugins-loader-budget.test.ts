import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineLogger } from "../interfaces.js";
import { loadExternalPlugins, resolveSpecifier } from "../plugins/loader.js";
import type { IHookRegistry } from "@adhd/agent-base-types";

/**
 * Backlog dfb03557 — the default budget entry agent-mcp passes to
 * `loadExternalPlugins` is the BARE specifier `@adhd/agent-plugin-budget`, but
 * the loader resolves from [process.cwd(), the orchestrator's own module dir].
 * The plugin was not an engine dependency, so neither base resolved it in the
 * pnpm monorepo and the default was silently skipped ("Plugin resolution failed
 * — skipping") — 5339c2e5's "load budget by default" had no default-running
 * proof.
 *
 * Fix: `@adhd/agent-plugin-budget` is now an (optional) peer dependency of the
 * orchestrator, so the engine's own module base resolves it — the exact base
 * the loader consults. This drives the REAL loader through resolve → import →
 * factory → install against the REAL built budget plugin (no mock): the
 * assertions fail if the dependency is removed (resolution fails) or the
 * default is no longer loaded.
 *
 * The budget plugin is the caller-supplied DEFAULT here (mirroring
 * `defaultPluginEntries()` in agent-mcp/src/config.ts); it is the only default,
 * so any registration observed is its `install()`.
 */

/** Mirrors `DEFAULT_BUDGET_PLUGIN_MODULE` in agent-mcp/src/config.ts (cannot be
 * imported — agent-mcp depends on this package, not the reverse). */
const DEFAULT_BUDGET_PLUGIN_MODULE = "@adhd/agent-plugin-budget";
const BUDGET_PLUGIN_NAME = "agent-mcp-budget";

function capturingHooks(): {
  hooks: IHookRegistry;
  registered: Array<{ hook: string; kind: "register" | "enforcement" }>;
} {
  const registered: Array<{ hook: string; kind: "register" | "enforcement" }> = [];
  const hooks = {
    register: (hook: string) => {
      registered.push({ hook, kind: "register" });
    },
    registerEnforcement: (hook: string) => {
      registered.push({ hook, kind: "enforcement" });
    },
    emit: async () => undefined,
    enforce: async () => undefined,
  } as unknown as IHookRegistry;
  return { hooks, registered };
}

interface LogLine {
  msg: unknown;
  args: unknown[];
}

function capturingLogger(): { logger: EngineLogger; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const push = (msg: unknown, args: unknown[]) => {
    logs.push({ msg, args });
  };
  const logger: EngineLogger = {
    info: (msg, ...args) => push(msg, args),
    warn: (msg, ...args) => push(msg, args),
    error: (msg, ...args) => push(msg, args),
    debug: () => undefined,
  };
  return { logger, logs };
}

describe("default budget plugin resolution (dfb03557)", () => {
  it("resolves the bare default specifier from the engine's own module base", async () => {
    const resolved = await resolveSpecifier(DEFAULT_BUDGET_PLUGIN_MODULE);
    expect(resolved.startsWith("file:")).toBe(true);
    expect(resolved).toContain("agent-plugin-budget");
  });

  it("installs the default budget plugin with zero config files present", async () => {
    const { hooks, registered } = capturingHooks();
    const { logger, logs } = capturingLogger();

    // A non-existent explicit config path = zero config files loaded (the same
    // "no operator-authored config" state the default is meant to cover).
    const noConfig = join(tmpdir(), "dfb03557-no-such-config.json");
    const defaultEntries = [
      {
        module: DEFAULT_BUDGET_PLUGIN_MODULE,
        config: {
          defaults: { mode: "block", caps: [{ field: "calls", maximum: 500 }], scope: "global" },
        },
      },
    ];

    await loadExternalPlugins(
      hooks,
      {},
      { configPath: noConfig },
      undefined,
      [],
      logger,
      defaultEntries
    );

    // The budget plugin's install() ran: it registers ordinary hooks and two
    // enforcement hooks. `pre:model_request` enforcement is uniquely its own.
    expect(registered).toContainEqual({ hook: "task:start", kind: "register" });
    expect(registered).toContainEqual({ hook: "pre:model_request", kind: "enforcement" });
    expect(registered).toContainEqual({ hook: "pre:tool_call", kind: "enforcement" });

    // The loader logged a SUCCESSFUL install for the budget plugin, not a skip.
    const installed = logs.find(
      (l) =>
        l.args[0] === "External plugin installed" &&
        (l.msg as Record<string, unknown> | undefined)?.["plugin"] === BUDGET_PLUGIN_NAME
    );
    expect(installed).toBeDefined();

    const resolutionFailure = logs.find(
      (l) => l.args[0] === "Plugin resolution failed — skipping"
    );
    expect(resolutionFailure).toBeUndefined();
  });
});
