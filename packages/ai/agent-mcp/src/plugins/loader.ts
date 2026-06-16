/**
 * External plugin loader for @adhd/agent-mcp.
 *
 * Discovers and loads plugins from two sources (processed in order):
 *   1. agent-mcp config file — supports per-plugin `config` blocks with schema
 *      validation. Discovered via:
 *        a. AGENT_MCP_CONFIG env var (explicit override)
 *        b. {cwd}/agent-mcp.config.json (project-local)
 *        c. {HOME}/.agent-mcp/config.json (global user config)
 *   2. AGENT_MCP_PLUGINS env var — comma-separated module specifiers, no options
 *      (legacy / CI shorthand).
 *
 * Config file format:
 *   {
 *     "plugins": [
 *       { "module": "@adhd/agent-mcp-metrics" },
 *       { "module": "@adhd/agent-mcp-budget", "config": { "maxUSD": 10 } }
 *     ]
 *   }
 *
 * Plugin packages must export a `createPlugin(ctx): Plugin` factory as their
 * `default` export or as a named `createPlugin` export.
 *
 * Optional schema enforcement: if the plugin module exports `configSchema` with a
 * `.safeParse()` method (Zod-compatible), the server validates the `config` block
 * before calling the factory. The validated (coerced + defaulted) result is passed
 * as `ctx.config`. Validation failure skips the plugin; the server continues.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { logger } from "../logger.js";
import type { IHookRegistry, Plugin, PluginContext, PluginFactory } from "@adhd/agent-mcp-types";

// ── Config file schema ────────────────────────────────────────────────────────

const pluginEntrySchema = z.object({
    /** npm package name or absolute file path */
    module: z.string().min(1, "module must be a non-empty string"),
    /** plugin-specific options validated against the plugin's own configSchema */
    config: z.record(z.string(), z.unknown()).optional().default({}),
});

/** JSON schema for the agent-mcp.config.json file itself. */
export const agentMcpConfigFileSchema = z.object({
    plugins: z.array(pluginEntrySchema).optional().default([]),
});

export type AgentMcpConfigFile = z.infer<typeof agentMcpConfigFileSchema>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;

// ── Plugin module shape ───────────────────────────────────────────────────────

/**
 * Structural interface satisfied by any Zod schema. Typed loosely here because
 * the plugin's Zod version may differ from ours — we only call `safeParse`.
 */
interface SchemaLike {
    safeParse: (
        input: unknown
    ) =>
        | { success: true;  data: Record<string, unknown> }
        | { success: false; error?: { flatten?: () => { fieldErrors: Record<string, unknown> } } };
}

/** What the server expects a plugin module to export. */
interface PluginModule {
    default?:       unknown;
    createPlugin?:  unknown;
    /** Optional Zod-compatible schema for the plugin's `config` block. */
    configSchema?:  SchemaLike;
}

// ── Config file discovery ─────────────────────────────────────────────────────

/**
 * Returns the path to the active agent-mcp config file, or `null` if none is
 * found. Search order:
 *   1. `AGENT_MCP_CONFIG` env var — absolute path to any JSON file
 *   2. `{cwd}/agent-mcp.config.json` — project-local (next to package.json)
 *   3. `{HOME}/.agent-mcp/config.json` — global user config
 */
export function findConfigFile(): string | null {
    const explicit = process.env["AGENT_MCP_CONFIG"];
    if (explicit) {
        if (!existsSync(explicit)) {
            logger.warn(
                { path: explicit },
                "AGENT_MCP_CONFIG points to a file that does not exist — ignoring"
            );
            return null;
        }
        return explicit;
    }

    const local = resolve(process.cwd(), "agent-mcp.config.json");
    if (existsSync(local)) return local;

    const global_ = resolve(homedir(), ".agent-mcp", "config.json");
    if (existsSync(global_)) return global_;

    return null;
}

/**
 * Reads, parses, and validates the agent-mcp config file. Returns
 * `{ plugins: [] }` on any failure so the caller can always destructure safely.
 */
export function loadConfigFile(): AgentMcpConfigFile {
    const configPath = findConfigFile();
    if (!configPath) return { plugins: [] };

    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
        logger.error(
            { configPath, err },
            "Failed to read/parse agent-mcp config file — no config-file plugins will load"
        );
        return { plugins: [] };
    }

    const result = agentMcpConfigFileSchema.safeParse(raw);
    if (!result.success) {
        logger.error(
            { configPath, issues: result.error.flatten().fieldErrors },
            "agent-mcp config file failed schema validation — no config-file plugins will load"
        );
        return { plugins: [] };
    }

    logger.info(
        { configPath, pluginCount: result.data.plugins.length },
        "Loaded agent-mcp config file"
    );
    return result.data;
}

// ── Module resolution ─────────────────────────────────────────────────────────

/**
 * Resolves a module specifier to a `file://` URL string for `import()`.
 *
 * - Absolute/relative paths → converted via `pathToFileURL`.
 * - Package names → resolved via `createRequire` from `process.cwd()` first
 *   (project-local `node_modules`, works for `npx` users), then from the server
 *   binary's directory (monorepo / global installs). Throws if unresolvable.
 */
export async function resolveSpecifier(specifier: string): Promise<string> {
    if (
        specifier.startsWith("/") ||
        specifier.startsWith("./") ||
        specifier.startsWith("../")
    ) {
        return pathToFileURL(resolve(specifier)).href;
    }

    const bases = [
        process.cwd(),
        new URL(".", import.meta.url).pathname,
    ];

    for (const base of bases) {
        try {
            const req = createRequire(base + "/");
            return pathToFileURL(req.resolve(specifier)).href;
        } catch {
            // try next base
        }
    }

    throw new Error(
        `Cannot resolve plugin "${specifier}" from cwd (${process.cwd()}) or server directory. ` +
        `Install it in your project: npm install ${specifier}`
    );
}

// ── Single plugin load ────────────────────────────────────────────────────────

async function loadOnePlugin(
    hooks:    IHookRegistry,
    db:       unknown,
    entry:    PluginEntry,
): Promise<void> {
    const { module: specifier, config: rawConfig } = entry;

    // ── Resolve ───────────────────────────────────────────────────────────────
    let resolved: string;
    try {
        resolved = await resolveSpecifier(specifier);
    } catch (err) {
        logger.error({ specifier, err }, "Plugin resolution failed — skipping");
        return;
    }

    // ── Import ────────────────────────────────────────────────────────────────
    let mod: PluginModule;
    try {
        mod = await import(resolved) as PluginModule;
    } catch (err) {
        logger.error({ specifier, resolved, err }, "Plugin import failed — skipping");
        return;
    }

    // ── Config schema validation ──────────────────────────────────────────────
    let validatedConfig: Record<string, unknown> = rawConfig ?? {};

    if (mod.configSchema && typeof mod.configSchema.safeParse === "function") {
        const result = mod.configSchema.safeParse(rawConfig ?? {});
        if (!result.success) {
            const issues = result.error?.flatten?.() ?? result.error;
            logger.error(
                { specifier, issues },
                "Plugin config failed schema validation — skipping. " +
                "Fix the 'config' block for this plugin in your agent-mcp config file."
            );
            return;
        }
        validatedConfig = result.data;
    }

    // ── Factory ───────────────────────────────────────────────────────────────
    const factory = (mod.createPlugin ?? mod.default) as PluginFactory | undefined;
    if (typeof factory !== "function") {
        logger.error(
            { specifier },
            "Plugin does not export a createPlugin factory (as default or named export) — skipping. " +
            "Expected: export default function createPlugin(ctx): Plugin { ... }"
        );
        return;
    }

    // ── Instantiate + install ─────────────────────────────────────────────────
    let plugin: Plugin;
    try {
        const ctx: PluginContext = { db, config: validatedConfig };
        plugin = await factory(ctx);
    } catch (err) {
        logger.error({ specifier, err }, "Plugin factory threw during instantiation — skipping");
        return;
    }

    try {
        await plugin.install(hooks);
        logger.info({ plugin: plugin.name, specifier }, "External plugin installed");
    } catch (err) {
        logger.error({ specifier, plugin: plugin.name, err }, "Plugin install() threw — skipping");
    }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Discovers and installs all external plugins. Never throws.
 *
 * Processing order:
 *   1. Plugins from the agent-mcp config file (with optional validated `config` blocks).
 *   2. Specifiers from `AGENT_MCP_PLUGINS` env var (comma-separated, no per-plugin
 *      options — legacy shorthand for simple activations or CI environments).
 *
 * All failures (bad config file, unresolvable module, failed schema validation,
 * factory errors) are logged at `error` level and skipped — a broken plugin
 * never prevents the server from starting.
 */
export async function loadExternalPlugins(hooks: IHookRegistry, db: unknown): Promise<void> {
    const configFile = loadConfigFile();

    const legacyEntries: PluginEntry[] = (process.env["AGENT_MCP_PLUGINS"] ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(module => ({ module, config: {} }));

    const allEntries: PluginEntry[] = [...configFile.plugins, ...legacyEntries];
    if (allEntries.length === 0) return;

    for (const entry of allEntries) {
        await loadOnePlugin(hooks, db, entry);
    }
}
