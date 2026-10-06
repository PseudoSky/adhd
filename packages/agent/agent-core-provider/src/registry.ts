import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { ToolFormatLookup } from './runtime/emit-tools.js';
import { ModelStore } from './store/model-store.js';
import { ProviderStore, type Provider } from './store/provider-store.js';
import { ToolFormatStore } from './store/tool-format-store.js';

/**
 * The one canonical provider/model/tool-format DATA registry (D-G(1)).
 *
 * Read-only facade over the three registry tables (providers, model-platform
 * bindings, provider tool formats). It holds DATA only: selection
 * (`task ?? session ?? agent ?? global`) and provider construction live in
 * `@adhd/agent-engine-orchestrator`, never here.
 */
export interface ProviderRegistry {
  /** Every registered provider row. */
  list(): Provider[];
  /** The provider row for `id`, or `null` when no such provider is registered. */
  get(id: string): Provider | null;
  /**
   * Resolve a canonical model ref (e.g. `claude_sonnet_4_6`) to the string a
   * platform expects (`claude_api` -> `claude-sonnet-4-6`, `claude_code` ->
   * `sonnet`). Throws `ModelStoreError('MODEL_BINDING_NOT_FOUND')` when the
   * (ref, platform) pair has no binding — it never falls back to another
   * platform's string.
   */
  resolveModelRef(ref: string, platform: string): string;
  /**
   * The `provider_tool_formats` row for (providerId, canonicalTool), or `null`
   * when the tool is a plain custom function definition. Signature-compatible
   * with `ToolFormatLookup`, so it can be handed straight to
   * `emitToolsForProvider`.
   */
  toolFormatLookup: ToolFormatLookup;
}

/** Drizzle handle the registry stores are built on. */
export type ProviderRegistryDb = BetterSQLite3Database<Record<string, never>>;

/**
 * Build a {@link ProviderRegistry} over an already-migrated registry database.
 * The stores are thin (stateless) wrappers, so this is cheap to call per use.
 */
export function createProviderRegistry(db: ProviderRegistryDb): ProviderRegistry {
  const providerStore = new ProviderStore(db);
  const modelStore = new ModelStore(db);
  const toolFormatStore = new ToolFormatStore(db);

  return {
    list: () => providerStore.list(),
    get: (id) => providerStore.list().find((p) => p.id === id) ?? null,
    resolveModelRef: (ref, platform) => modelStore.resolveModelId(ref, platform),
    toolFormatLookup: (providerId, canonicalTool) =>
      toolFormatStore.getShape(providerId, canonicalTool),
  };
}
