/**
 * The production {@link WireSeams} (backlog c536ce29, TRC-AC2/3/5/6/9; 49cec55e): the traced `fetch`,
 * `spawn`, `http(s).request` (engine-native web_fetch) and MCP-transport wrapper that every engine egress site uses through `EngineConfig.wire`.
 *
 * Built ONCE per process. The wrappers resolve the process-wide `agent-mcp.api` channel lazily
 * (`getLogChannels().api`), so the same seams are inert before `initLogChannels()` and after
 * `closeLogChannels()`, and become live the moment the channel is installed — no ordering
 * constraint between seam construction and channel creation. With an inert channel every wrapper
 * is a pass-through (P1-AC-B).
 *
 * `tempDir` is the `@adhd/environment`-resolved namespaced temp root (`resolveLogRoots().temp`, pure -
 * creates nothing); the claudecli provider requires it and creates it on demand (S8B, 03be90c3).
 */
import { spawn } from "node:child_process";

import type { WireSeams } from "@adhd/agent-engine-orchestrator";
import { withLogContext } from "@adhd/agent-plugin-tracing";

import { resolveLogRoots, toEngineConfig } from "../config.js";
import { tracedFetch } from "./traced-fetch.js";
import { tracedRequest, type WireRequestFn } from "./traced-request.js";
import { tracedSpawn } from "./traced-spawn.js";
import { TracedTransport } from "./traced-transport.js";

let seams: WireSeams | undefined;

/** Builds a fresh {@link WireSeams} over `globalThis.fetch` / `node:child_process` `spawn` / `node:http(s).request`. */
export function createWireSeams(
    base: { fetch?: typeof fetch; spawn?: typeof spawn; request?: WireRequestFn; tempDir?: string } = {}
): WireSeams {
    return {
        // `base` undefined => `globalThis.fetch` resolved per call (a replaced global is honoured).
        fetch: tracedFetch(undefined, base.fetch),
        // The engine-native web_fetch connects to a validated, pinned IP, so it cannot use `fetch`.
        request: tracedRequest(undefined, base.request),
        spawn: tracedSpawn(undefined, base.spawn ?? spawn),
        wrapTransport: (t, meta) => new TracedTransport(t, meta),
        withContext: (ctx, fn) => withLogContext(ctx, fn),
        tempDir: base.tempDir ?? resolveLogRoots().temp,
    };
}

/** The process-wide seams, created on first use. */
export function getWireSeams(): WireSeams {
    seams ??= createWireSeams();
    return seams;
}

/**
 * The `EngineConfig` agent-mcp hands the engine: `toEngineConfig()` plus the process-wide
 * {@link WireSeams}. Use this (never bare `toEngineConfig()`) wherever the config reaches a task
 * dispatch, so every provider / MCP-client egress is traced.
 */
export function engineConfig(): ReturnType<typeof toEngineConfig> {
    return { ...toEngineConfig(), wire: getWireSeams() };
}
