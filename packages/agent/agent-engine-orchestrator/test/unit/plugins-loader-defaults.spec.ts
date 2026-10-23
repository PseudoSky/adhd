import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineLogger } from "../../src/interfaces.js";
import { loadExternalPlugins, type PluginEntry } from "../../src/plugins/loader.js";
import type { IHookRegistry } from "@adhd/agent-base-types";

/**
 * Failure mode guarded: a default plugin entry is dropped, or a user entry fails to override it.
 * Tier: S. Item: backlog 5339c2e5; variance hardening cites qa-variance (dispatch-1014).
 * Red run: pending (variance edit made without running tests, per user).
 * qa-variance: the loader's config discovery (cwd, ~/.adhd/agent-mcp, ~/.agent-mcp) read the
 * developer's REAL home, so duration depended on the machine and the "installs nothing" case
 * failed on any host with a global plugin config. Every call now pins `overrides.configPath` to an
 * empty config file in this file's temp dir, so no path outside it is probed.
 *
 * Backlog 5339c2e5 — `loadExternalPlugins` must install caller-supplied DEFAULT
 * entries (agent-mcp passes the default budget plugin) even with zero config
 * files, and a USER entry naming the same module must override the default
 * (de-duped by module).
 *
 * The probe module is a real ESM file resolved through the same
 * `resolveSpecifier` seam production uses, so this exercises the actual
 * discover→resolve→import→factory→install path, not a mock.
 */

const dir = mkdtempSync(join(tmpdir(), "plugin-loader-defaults-"));
const probePath = join(dir, "probe.mjs");
writeFileSync(
  probePath,
  `export default async function createPlugin(ctx) {
     return {
       name: "probe",
       async install() {
         globalThis.__probeInstalls = (globalThis.__probeInstalls || 0) + 1;
         globalThis.__probeCfg = ctx.config;
       },
     };
   }`,
  "utf8"
);

const emptyConfigPath = join(dir, "agent-mcp.config.json");
writeFileSync(emptyConfigPath, JSON.stringify({ plugins: [] }), "utf8");
const pinned = { configPath: emptyConfigPath };

const globals = globalThis as unknown as {
  __probeInstalls?: number;
  __probeCfg?: unknown;
};

const hooks = {
  register: vi.fn(),
  registerEnforcement: vi.fn(),
  emit: async () => undefined,
  enforce: async () => undefined,
} as unknown as IHookRegistry;

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const DEFAULT_ENTRY: PluginEntry = { module: probePath, config: { fromDefault: true } };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete globals.__probeInstalls;
  delete globals.__probeCfg;
});

describe("loadExternalPlugins — default entries (5339c2e5)", () => {
  it("installs nothing when there are no defaults and no config", async () => {
    await loadExternalPlugins(hooks, {}, pinned, undefined, [], logger, []);
    expect(globals.__probeInstalls).toBeUndefined();
  });

  it("installs a DEFAULT entry even with zero config files", async () => {
    await loadExternalPlugins(hooks, {}, pinned, undefined, [], logger, [
      DEFAULT_ENTRY,
    ]);
    expect(globals.__probeInstalls).toBe(1);
    expect(globals.__probeCfg).toEqual({ fromDefault: true });
  });

  it("lets a USER entry naming the same module override the default (de-duped)", async () => {
    // Same module, supplied as a user env entry (config always {} there).
    await loadExternalPlugins(
      hooks,
      {},
      pinned,
      undefined,
      [probePath],
      logger,
      [DEFAULT_ENTRY]
    );
    expect(globals.__probeInstalls).toBe(1);
    // User entry wins → config is the user's ({}), not { fromDefault: true }.
    expect(globals.__probeCfg).toEqual({});
  });
});
