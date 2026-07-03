import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { EngineLogger } from '../interfaces.js';
import type {
  IHookRegistry,
  Plugin,
  PluginContext,
  PluginFactory,
} from '@adhd/agent-base-types';

// ── Config file schema ────────────────────────────────────────────────────────

const pluginEntrySchema = z.object({
  module: z.string().min(1, 'module must be a non-empty string'),
  config: z.record(z.string(), z.unknown()).optional().default({}),
});

export const agentMcpConfigFileSchema = z.object({
  plugins: z.array(pluginEntrySchema).optional().default([]),
});

export type AgentMcpConfigFile = z.infer<typeof agentMcpConfigFileSchema>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;

// ── Plugin module shape ───────────────────────────────────────────────────────

interface SchemaLike {
  safeParse: (
    input: unknown
  ) =>
    | { success: true; data: Record<string, unknown> }
    | {
        success: false;
        error?: { flatten?: () => { fieldErrors: Record<string, unknown> } };
      };
}

interface PluginModule {
  default?: unknown;
  createPlugin?: unknown;
  configSchema?: SchemaLike;
}

// ── Config file discovery ─────────────────────────────────────────────────────

/**
 * Find the active agent-mcp config file.
 * @param configPathOverride — explicit path; pass null/undefined to skip.
 * @param configPathFromEnv — config.plugins.configPath value (injected instead of importing config).
 * @param logger — injected logger.
 */
export function findConfigFile(
  configPathOverride: string | null | undefined,
  configPathFromEnv: string | undefined,
  logger?: EngineLogger
): string | null {
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
  const explicit =
    configPathOverride !== undefined
      ? configPathOverride
      : configPathFromEnv;
  if (explicit) {
    if (!existsSync(explicit)) {
      log.warn(
        { path: explicit },
        'AGENT_MCP_CONFIG points to a file that does not exist — ignoring'
      );
      return null;
    }
    return explicit;
  }

  const local = resolve(process.cwd(), 'agent-mcp.config.json');
  if (existsSync(local)) return local;

  const nested = resolve(process.cwd(), '.adhd', 'agent-mcp', 'config.json');
  if (existsSync(nested)) return nested;

  const globalAdhd = resolve(homedir(), '.adhd', 'agent-mcp', 'config.json');
  if (existsSync(globalAdhd)) return globalAdhd;

  return null;
}

/**
 * Read, parse, and validate the agent-mcp config file.
 * @param configPathOverride — forwarded to findConfigFile
 * @param configPathFromEnv — config.plugins.configPath injection
 * @param logger — injected logger
 */
export function loadConfigFile(
  configPathOverride: string | null | undefined,
  configPathFromEnv: string | undefined,
  logger?: EngineLogger
): AgentMcpConfigFile {
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
  const configPath = findConfigFile(configPathOverride, configPathFromEnv, logger);
  if (!configPath) return { plugins: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    log.error(
      { configPath, err },
      'Failed to read/parse agent-mcp config file — no config-file plugins will load'
    );
    return { plugins: [] };
  }

  const result = agentMcpConfigFileSchema.safeParse(raw);
  if (!result.success) {
    log.error(
      { configPath, issues: result.error.flatten().fieldErrors },
      'agent-mcp config file failed schema validation — no config-file plugins will load'
    );
    return { plugins: [] };
  }

  log.info(
    { configPath, pluginCount: result.data.plugins.length },
    'Loaded agent-mcp config file'
  );
  return result.data;
}

// ── Module resolution ─────────────────────────────────────────────────────────

export async function resolveSpecifier(specifier: string): Promise<string> {
  if (
    specifier.startsWith('/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    return pathToFileURL(resolve(specifier)).href;
  }

  const bases = [process.cwd(), new URL('.', import.meta.url).pathname];

  for (const base of bases) {
    try {
      const req = createRequire(base + '/');
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
  hooks: IHookRegistry,
  db: unknown,
  entry: PluginEntry,
  logger: EngineLogger
): Promise<void> {
  const { module: specifier, config: rawConfig } = entry;

  let resolved: string;
  try {
    resolved = await resolveSpecifier(specifier);
  } catch (err) {
    logger.error({ specifier, err }, 'Plugin resolution failed — skipping');
    return;
  }

  let mod: PluginModule;
  try {
    mod = (await import(resolved)) as PluginModule;
  } catch (err) {
    logger.error(
      { specifier, resolved, err },
      'Plugin import failed — skipping'
    );
    return;
  }

  let validatedConfig: Record<string, unknown> = rawConfig ?? {};

  if (mod.configSchema && typeof mod.configSchema.safeParse === 'function') {
    const result = mod.configSchema.safeParse(rawConfig ?? {});
    if (!result.success) {
      const issues = result.error?.flatten?.() ?? result.error;
      logger.error(
        { specifier, issues },
        'Plugin config failed schema validation — skipping. ' +
          "Fix the 'config' block for this plugin in your agent-mcp config file."
      );
      return;
    }
    validatedConfig = result.data;
  }

  const factory = (mod.createPlugin ?? mod.default) as
    | PluginFactory
    | undefined;
  if (typeof factory !== 'function') {
    logger.error(
      { specifier },
      'Plugin does not export a createPlugin factory (as default or named export) — skipping. ' +
        'Expected: export default function createPlugin(ctx): Plugin { ... }'
    );
    return;
  }

  let plugin: Plugin;
  try {
    const ctx: PluginContext = { db, config: validatedConfig };
    plugin = await factory(ctx);
  } catch (err) {
    logger.error(
      { specifier, err },
      'Plugin factory threw during instantiation — skipping'
    );
    return;
  }

  try {
    await plugin.install(hooks);
    logger.info(
      { plugin: plugin.name, specifier },
      'External plugin installed'
    );
  } catch (err) {
    logger.error(
      { specifier, plugin: plugin.name, err },
      'Plugin install() threw — skipping'
    );
  }
}

/**
 * Discovers and installs all external plugins. Never throws.
 *
 * @param hooks — hook registry
 * @param db — database handle
 * @param overrides — explicit values for testability
 *   `configPath`    — forwarded to findConfigFile
 *   `pluginEntries` — explicit module list (replaces config.plugins.entries)
 * @param configPathFromEnv — config.plugins.configPath injection
 * @param logger — injected logger
 */
export async function loadExternalPlugins(
  hooks: IHookRegistry,
  db: unknown,
  overrides?: { configPath?: string | null; pluginEntries?: string[] },
  configPathFromEnv?: string,
  pluginEntriesFromEnv?: string[],
  logger?: EngineLogger
): Promise<void> {
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
  const configFile = loadConfigFile(overrides?.configPath, configPathFromEnv, logger);

  const legacyEntries: PluginEntry[] = (
    overrides?.pluginEntries ?? pluginEntriesFromEnv ?? []
  ).map((module) => ({ module, config: {} }));

  const allEntries: PluginEntry[] = [...configFile.plugins, ...legacyEntries];
  if (allEntries.length === 0) return;

  for (const entry of allEntries) {
    await loadOnePlugin(hooks, db, entry, log);
  }
}
