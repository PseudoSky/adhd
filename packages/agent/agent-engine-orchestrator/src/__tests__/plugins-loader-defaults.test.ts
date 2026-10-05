import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineLogger } from "../interfaces.js";
import { loadExternalPlugins, type PluginEntry } from "../plugins/loader.js";
import type { IHookRegistry } from "@adhd/agent-base-types";

/**
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
    await loadExternalPlugins(hooks, {}, undefined, undefined, [], logger, []);
    expect(globals.__probeInstalls).toBeUndefined();
  });

  it("installs a DEFAULT entry even with zero config files", async () => {
    await loadExternalPlugins(hooks, {}, undefined, undefined, [], logger, [
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
      undefined,
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
