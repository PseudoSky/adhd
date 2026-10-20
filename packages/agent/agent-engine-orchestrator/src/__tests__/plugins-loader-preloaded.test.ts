/**
 * guards: loadExternalPlugins installs a plugin from the preloaded module map without resolving its specifier, and still fails at the resolve stage for an unresolvable specifier when no map entry exists.
 * tier: S
 * cites: bundled-host AC (preloaded plugin modules), negative control in the same file.
 * red run: with the preloaded branch disabled (`if (false && pre !== undefined)`), test 1 fails with a resolve-stage failure; the negative control stays green.
 */
import { describe, expect, it, vi } from "vitest";
import type { EngineLogger } from "../interfaces.js";
import {
  loadExternalPlugins,
  type PluginEntry,
  type PluginLoadFailure,
} from "../plugins/loader.js";
import type { IHookRegistry } from "@adhd/agent-base-types";

/**
 * Preloaded plugin modules (bundled-host path).
 *
 * A single-file bundle cannot resolve a plugin by name at runtime, so the host
 * imports the default plugins itself and passes them in `preloadedModules`.
 * The specifier used here is deliberately NOT installed anywhere, so the only
 * way it can install is through the preloaded map — the resolve step cannot
 * succeed by accident.
 *
 * Negative control: the same entry without the map must fail at `resolve`.
 */

const SPECIFIER = "@adhd-test/never-installed-preloaded-probe";

function makeHooks(): IHookRegistry {
  return {
    register: vi.fn(),
    registerEnforcement: vi.fn(),
    emit: async () => undefined,
    enforce: async () => undefined,
  } as unknown as IHookRegistry;
}

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const ENTRY: PluginEntry = { module: SPECIFIER, config: { fromHost: true } };

describe("loadExternalPlugins — preloadedModules (bundled host)", () => {
  it("installs an unresolvable specifier from the preloaded map, passing its config", async () => {
    const install = vi.fn(async () => undefined);
    const createPlugin = vi.fn((ctx: { config: unknown }) => ({ name: "preloaded", install, cfg: ctx.config }));
    const failures: PluginLoadFailure[] = [];

    await loadExternalPlugins(
      makeHooks(),
      {},
      {
        preloadedModules: { [SPECIFIER]: { createPlugin } as never },
        onPluginLoadFailed: (f) => failures.push(f),
      },
      undefined,
      [],
      logger,
      [ENTRY]
    );

    expect(failures).toEqual([]);
    expect(createPlugin).toHaveBeenCalledTimes(1);
    expect(createPlugin.mock.calls[0]?.[0]).toMatchObject({ config: { fromHost: true } });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("negative control: the same unresolvable entry without the map fails at the resolve stage", async () => {
    const failures: PluginLoadFailure[] = [];

    await loadExternalPlugins(
      makeHooks(),
      {},
      { onPluginLoadFailed: (f) => failures.push(f) },
      undefined,
      [],
      logger,
      [ENTRY]
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ specifier: SPECIFIER, stage: "resolve" });
  });
});
