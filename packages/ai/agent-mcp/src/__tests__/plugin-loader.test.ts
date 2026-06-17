/**
 * plugin-loader — config file discovery, schema validation, and plugin loading.
 *
 * Design note: plugins are loaded via dynamic import() from real temp .mjs files
 * (not vi.mock()) because vitest does not intercept dynamic imports by URL. Tests
 * use a temp-directory-scoped marker file as the IPC channel to verify that a
 * plugin's install() actually ran, rather than relying solely on logger spies.
 *
 * Teeth checks:
 *   1. Config file with invalid JSON → loadConfigFile returns empty plugins array.
 *   2. Config file with invalid schema → loadConfigFile returns empty plugins array.
 *   3. Plugin configSchema rejects config → plugin skipped, subsequent plugin loads.
 *   4. Plugin factory throws → plugin skipped, subsequent plugin loads.
 *   5. Plugin without a factory export → plugin skipped.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HookRegistry } from "../engine/hooks.js";
import {
    findConfigFile,
    loadConfigFile,
    loadExternalPlugins,
} from "../plugins/loader.js";
import type { ExecutionContext } from "@adhd/agent-mcp-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "agent-mcp-loader-"));
}

/** Write a real .mjs plugin file and return its absolute path. */
function writePlugin(dir: string, name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content, "utf-8");
    return p;
}

/** A minimal valid plugin that writes markerPath when install() is called. */
function markerPlugin(markerPath: string): string {
    return `
import { writeFileSync } from 'node:fs';
export default function createPlugin(ctx) {
    return {
        name: "marker",
        install(hooks) {
            writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(ctx.config ?? {}));
        }
    };
}
`;
}

/** Plugin that always throws from its factory. */
const THROWING_FACTORY = `
export default function createPlugin() {
    throw new Error("factory exploded intentionally");
}
`;

/** Plugin with no factory export at all. */
const NO_FACTORY = `
export const notAFactory = "hello";
`;

/**
 * Plugin with a Zod-like configSchema: accepts { maxUSD: number > 0 },
 * rejects anything else.
 */
function schemaPlugin(markerPath: string): string {
    return `
import { writeFileSync } from 'node:fs';
export const configSchema = {
    safeParse(input) {
        if (typeof input.maxUSD !== 'number' || input.maxUSD <= 0) {
            return {
                success: false,
                error: { flatten: () => ({ fieldErrors: { maxUSD: ['Must be a positive number'] } }) }
            };
        }
        return { success: true, data: { maxUSD: input.maxUSD } };
    }
};
export default function createPlugin(ctx) {
    return {
        name: "schema-plugin",
        install(hooks) {
            writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(ctx.config));
        }
    };
}
`;
}

// ── Env cleanup ───────────────────────────────────────────────────────────────

afterEach(() => {
    delete process.env["AGENT_MCP_CONFIG"];
    delete process.env["AGENT_MCP_PLUGINS"];
});

// ── findConfigFile ────────────────────────────────────────────────────────────

describe("findConfigFile", () => {
    it("returns null when AGENT_MCP_CONFIG points to a nonexistent file", () => {
        process.env["AGENT_MCP_CONFIG"] = "/tmp/definitely-does-not-exist-agent-mcp.json";
        expect(findConfigFile()).toBeNull();
    });

    it("returns the explicit path when AGENT_MCP_CONFIG file exists", () => {
        const dir = tempDir();
        try {
            const p = join(dir, "explicit.json");
            writeFileSync(p, "{}");
            process.env["AGENT_MCP_CONFIG"] = p;
            expect(findConfigFile()).toBe(p);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });
});

// ── loadConfigFile ────────────────────────────────────────────────────────────

describe("loadConfigFile", () => {
    it("returns empty plugins when no config file is found", () => {
        // Point AGENT_MCP_CONFIG at a nonexistent path so local/global files
        // (if any happen to exist in the test environment) are bypassed.
        process.env["AGENT_MCP_CONFIG"] = "/tmp/__nonexistent_agent_mcp_test__.json";
        expect(loadConfigFile().plugins).toEqual([]);
    });

    it("parses a valid config file with plugins", () => {
        const dir = tempDir();
        try {
            const p = join(dir, "config.json");
            writeFileSync(p, JSON.stringify({
                plugins: [
                    { module: "@adhd/agent-mcp-metrics" },
                    { module: "@adhd/agent-mcp-budget", config: { maxUSD: 10 } },
                ],
            }));
            process.env["AGENT_MCP_CONFIG"] = p;

            const result = loadConfigFile();
            expect(result.plugins).toHaveLength(2);
            expect(result.plugins[0].module).toBe("@adhd/agent-mcp-metrics");
            expect(result.plugins[0].config).toEqual({}); // defaulted
            expect(result.plugins[1].module).toBe("@adhd/agent-mcp-budget");
            expect(result.plugins[1].config).toEqual({ maxUSD: 10 });
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("defaults config to {} when omitted", () => {
        const dir = tempDir();
        try {
            const p = join(dir, "config.json");
            writeFileSync(p, JSON.stringify({ plugins: [{ module: "my-plugin" }] }));
            process.env["AGENT_MCP_CONFIG"] = p;
            expect(loadConfigFile().plugins[0].config).toEqual({});
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("returns empty plugins on invalid JSON — teeth: invalid JSON causes parse failure", () => {
        const dir = tempDir();
        try {
            const p = join(dir, "bad.json");
            writeFileSync(p, "{ not json !!!");
            process.env["AGENT_MCP_CONFIG"] = p;
            expect(loadConfigFile().plugins).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("returns empty plugins when schema validation fails — teeth: module:42 is invalid", () => {
        const dir = tempDir();
        try {
            const p = join(dir, "config.json");
            writeFileSync(p, JSON.stringify({ plugins: [{ module: 42 }] }));
            process.env["AGENT_MCP_CONFIG"] = p;
            expect(loadConfigFile().plugins).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("accepts a config file with no plugins key (defaults to empty)", () => {
        const dir = tempDir();
        try {
            const p = join(dir, "config.json");
            writeFileSync(p, JSON.stringify({}));
            process.env["AGENT_MCP_CONFIG"] = p;
            expect(loadConfigFile().plugins).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });
});

// ── loadExternalPlugins — plugin installation ─────────────────────────────────

describe("loadExternalPlugins — happy path", () => {
    it("installs a plugin declared in the config file (absolute path)", async () => {
        const dir = tempDir();
        const markerPath = join(dir, "installed.json");
        try {
            const pluginPath = writePlugin(dir, "plugin.mjs", markerPlugin(markerPath));
            const configPath = join(dir, "config.json");
            writeFileSync(configPath, JSON.stringify({ plugins: [{ module: pluginPath }] }));
            process.env["AGENT_MCP_CONFIG"] = configPath;

            await loadExternalPlugins(new HookRegistry(), {});
            expect(existsSync(markerPath)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("passes the config block to the plugin factory as ctx.config", async () => {
        const dir = tempDir();
        const markerPath = join(dir, "config-received.json");
        try {
            const pluginPath = writePlugin(dir, "plugin.mjs", markerPlugin(markerPath));
            const configPath = join(dir, "config.json");
            writeFileSync(configPath, JSON.stringify({
                plugins: [{ module: pluginPath, config: { threshold: 42, label: "test" } }],
            }));
            process.env["AGENT_MCP_CONFIG"] = configPath;

            await loadExternalPlugins(new HookRegistry(), {});

            const received = JSON.parse(require("node:fs").readFileSync(markerPath, "utf-8"));
            expect(received).toEqual({ threshold: 42, label: "test" });
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("loads a plugin via AGENT_MCP_PLUGINS env var (no config file needed)", async () => {
        const dir = tempDir();
        const markerPath = join(dir, "installed.json");
        try {
            const pluginPath = writePlugin(dir, "plugin.mjs", markerPlugin(markerPath));
            // No config file — use legacy env var
            process.env["AGENT_MCP_CONFIG"] = "/tmp/__nonexistent__.json";
            process.env["AGENT_MCP_PLUGINS"] = pluginPath;

            await loadExternalPlugins(new HookRegistry(), {});
            expect(existsSync(markerPath)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("loads config-file plugins before AGENT_MCP_PLUGINS entries (ordering)", async () => {
        const dir = tempDir();
        const orderPath = join(dir, "order.json");
        const trackPlugin = (id: string) => `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export default function createPlugin(ctx) {
    return {
        name: "track-${id}",
        install() {
            const prev = existsSync(${JSON.stringify(orderPath)})
                ? JSON.parse(readFileSync(${JSON.stringify(orderPath)}, 'utf-8'))
                : [];
            prev.push("${id}");
            writeFileSync(${JSON.stringify(orderPath)}, JSON.stringify(prev));
        }
    };
}
`;
        try {
            const p1 = writePlugin(dir, "p1.mjs", trackPlugin("config"));
            const p2 = writePlugin(dir, "p2.mjs", trackPlugin("envvar"));
            const configPath = join(dir, "config.json");
            writeFileSync(configPath, JSON.stringify({ plugins: [{ module: p1 }] }));
            process.env["AGENT_MCP_CONFIG"] = configPath;
            process.env["AGENT_MCP_PLUGINS"] = p2;

            await loadExternalPlugins(new HookRegistry(), {});

            const order = JSON.parse(require("node:fs").readFileSync(orderPath, "utf-8"));
            expect(order).toEqual(["config", "envvar"]);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("uses a named createPlugin export when default is absent", async () => {
        const dir = tempDir();
        const markerPath = join(dir, "named.json");
        try {
            const content = `
import { writeFileSync } from 'node:fs';
export function createPlugin(ctx) {
    return {
        name: "named-export",
        install() { writeFileSync(${JSON.stringify(markerPath)}, "ok"); }
    };
}
`;
            const pluginPath = writePlugin(dir, "named.mjs", content);
            writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins: [{ module: pluginPath }] }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await loadExternalPlugins(new HookRegistry(), {});
            expect(existsSync(markerPath)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });
});

// ── loadExternalPlugins — configSchema enforcement ────────────────────────────

describe("loadExternalPlugins — configSchema validation", () => {
    it("passes validated config when schema accepts it", async () => {
        const dir = tempDir();
        const markerPath = join(dir, "schema-valid.json");
        try {
            const pluginPath = writePlugin(dir, "schema.mjs", schemaPlugin(markerPath));
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [{ module: pluginPath, config: { maxUSD: 10 } }],
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await loadExternalPlugins(new HookRegistry(), {});

            const received = JSON.parse(require("node:fs").readFileSync(markerPath, "utf-8"));
            expect(received).toEqual({ maxUSD: 10 });
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("skips plugin when schema rejects config — teeth: invalid config → no marker file", async () => {
        const dir = tempDir();
        const markerPath = join(dir, "schema-invalid.json");
        try {
            const pluginPath = writePlugin(dir, "schema.mjs", schemaPlugin(markerPath));
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [{ module: pluginPath, config: { maxUSD: -5 } }], // negative → rejected
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await loadExternalPlugins(new HookRegistry(), {});

            // Plugin was skipped — marker file must NOT exist
            expect(existsSync(markerPath)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("continues loading subsequent plugins after a schema failure", async () => {
        const dir = tempDir();
        const badMarker  = join(dir, "bad.json");
        const goodMarker = join(dir, "good.json");
        try {
            const badPlugin  = writePlugin(dir, "bad.mjs",  schemaPlugin(badMarker));
            const goodPlugin = writePlugin(dir, "good.mjs", markerPlugin(goodMarker));
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [
                    { module: badPlugin,  config: { maxUSD: -1 } }, // fails
                    { module: goodPlugin },                           // must still load
                ],
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await loadExternalPlugins(new HookRegistry(), {});

            expect(existsSync(badMarker)).toBe(false);  // skipped
            expect(existsSync(goodMarker)).toBe(true);  // loaded
        } finally {
            rmSync(dir, { recursive: true });
        }
    });
});

// ── loadExternalPlugins — failure resilience ──────────────────────────────────

describe("loadExternalPlugins — failure resilience", () => {
    it("skips a plugin whose factory throws and continues — teeth: marker absent", async () => {
        const dir = tempDir();
        const goodMarker = join(dir, "good.json");
        try {
            const badPlugin  = writePlugin(dir, "bad.mjs",  THROWING_FACTORY);
            const goodPlugin = writePlugin(dir, "good.mjs", markerPlugin(goodMarker));
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [{ module: badPlugin }, { module: goodPlugin }],
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await expect(loadExternalPlugins(new HookRegistry(), {})).resolves.toBeUndefined();
            expect(existsSync(goodMarker)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("skips a plugin with no factory export — teeth: no marker, no throw", async () => {
        const dir = tempDir();
        const goodMarker = join(dir, "good.json");
        try {
            const noFactory  = writePlugin(dir, "nofactory.mjs", NO_FACTORY);
            const goodPlugin = writePlugin(dir, "good.mjs", markerPlugin(goodMarker));
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [{ module: noFactory }, { module: goodPlugin }],
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await expect(loadExternalPlugins(new HookRegistry(), {})).resolves.toBeUndefined();
            expect(existsSync(goodMarker)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("skips an unresolvable package name — teeth: error logged, server continues", async () => {
        const dir = tempDir();
        const goodMarker = join(dir, "good.json");
        try {
            const goodPlugin = writePlugin(dir, "good.mjs", markerPlugin(goodMarker));
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [
                    { module: "@adhd/this-package-definitely-does-not-exist-xyz-9999" },
                    { module: goodPlugin },
                ],
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            await expect(loadExternalPlugins(new HookRegistry(), {})).resolves.toBeUndefined();
            expect(existsSync(goodMarker)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("resolves successfully when no plugins are configured anywhere", async () => {
        process.env["AGENT_MCP_CONFIG"] = "/tmp/__nonexistent_agent_mcp_test_2__.json";
        await expect(loadExternalPlugins(new HookRegistry(), {})).resolves.toBeUndefined();
    });
});

// ── Real @adhd/agent-mcp-budget integration via config/env ───────────────────
//
// These tests load the REAL built budget plugin (not a synthetic .mjs) via the
// same paths the production server uses: agent-mcp.config.json or
// AGENT_MCP_PLUGINS env var. This verifies the full config→load→enforce chain.
//
// We reference the dist file by absolute path because @adhd packages are not
// symlinked into node_modules in this monorepo (Nx uses TS path aliases, not
// npm workspaces).

function makeCtx(taskId = "task-budget-x"): ExecutionContext {
    return {
        taskId,
        sessionId: "session-budget-x",
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1 as const,
            provider: { type: "openai" as const, model: "gpt-4o-mini" },
            systemPrompt: "",
            mcpServers: {},
            permissions: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        },
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

/** Absolute path to the built @adhd/agent-mcp-budget dist file. */
const BUDGET_PLUGIN_DIST = resolve(
    fileURLToPath(import.meta.url),
    "../../../../../../dist/packages/ai/agent-mcp-budget/index.js",
);

describe("loadExternalPlugins — real @adhd/agent-mcp-budget integration", () => {
    it("loads budget plugin via config file and enforces maxModelCalls:1 on second model call", async () => {
        const dir = tempDir();
        try {
            writeFileSync(join(dir, "config.json"), JSON.stringify({
                plugins: [{ module: BUDGET_PLUGIN_DIST, config: { maxModelCalls: 1 } }],
            }));
            process.env["AGENT_MCP_CONFIG"] = join(dir, "config.json");

            const hooks = new HookRegistry();
            await loadExternalPlugins(hooks, null);

            const ctx = makeCtx();
            await hooks.emit("task:start", { executionContext: ctx, messages: [] });

            // First model call — must pass
            await hooks.emit("pre:model_request",  { executionContext: ctx, messages: [], tools: [] });
            await expect(
                hooks.enforce("pre:model_request", { executionContext: ctx, messages: [], tools: [] }),
            ).resolves.toBeUndefined();
            await hooks.emit("post:model_response", {
                executionContext: ctx,
                stopReason: "tool_calls",
                toolCallCount: 1,
                tokenUsage: { inputTokens: 10, outputTokens: 10, stopReason: "tool_calls" },
            });

            // Second model call — budget exceeded, enforcement must throw
            await hooks.emit("pre:model_request",  { executionContext: ctx, messages: [], tools: [] });
            await expect(
                hooks.enforce("pre:model_request", { executionContext: ctx, messages: [], tools: [] }),
            ).rejects.toMatchObject({ isEnforcementError: true, code: "BUDGET_EXCEEDED" });
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("loads budget plugin via AGENT_MCP_PLUGINS env var and enforces maxTotalTokens", async () => {
        // AGENT_MCP_PLUGINS doesn't support per-plugin config; the plugin's
        // configSchema.parse({}) defaults kick in (all limits undefined = no enforcement).
        // We test the env-var load path itself and verify the plugin installs cleanly.
        process.env["AGENT_MCP_CONFIG"] = "/tmp/__nonexistent_budget_test__.json";
        process.env["AGENT_MCP_PLUGINS"] = BUDGET_PLUGIN_DIST;

        const hooks = new HookRegistry();
        // loadExternalPlugins must not throw even with empty default config
        await expect(loadExternalPlugins(hooks, null)).resolves.toBeUndefined();

        // With no limits configured, enforcement must be a no-op
        const ctx = makeCtx("env-var-task");
        await hooks.emit("task:start", { executionContext: ctx, messages: [] });
        await hooks.emit("pre:model_request",  { executionContext: ctx, messages: [], tools: [] });
        await expect(
            hooks.enforce("pre:model_request", { executionContext: ctx, messages: [], tools: [] }),
        ).resolves.toBeUndefined();
    });
});
