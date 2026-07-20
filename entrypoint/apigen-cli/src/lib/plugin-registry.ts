import type { OutputPlugin } from '@adhd/apigen-core-client';

/**
 * Single source of truth for everything the CLI derives from the `--type`
 * plugin registry: help text, `--list-types` output, and the "unknown
 * --type"/"doesn't support run" errors. Every one of those was previously a
 * hand-maintained string that drifted from the real `plugins` map passed
 * into each command's `registerXCommand()` (FEAT-APIGEN-019) — this module
 * is the only place that reads `Object.keys(plugins)` / `plugin.run` so
 * they can never drift again.
 */

/** All registered `--type` ids, in registration order (includes aliases like `cli`/`cli-output`). */
export function pluginTypeIds(plugins: Record<string, OutputPlugin>): string[] {
  return Object.keys(plugins);
}

/** `--type` ids whose plugin implements `run()` — usable with `run` / `run-registry`. */
export function runCapableTypeIds(plugins: Record<string, OutputPlugin>): string[] {
  return pluginTypeIds(plugins).filter(
    (id) => typeof plugins[id]?.run === 'function'
  );
}

/** `--type` ids whose plugin has no `run()` — generate-only targets. */
export function generateOnlyTypeIds(plugins: Record<string, OutputPlugin>): string[] {
  return pluginTypeIds(plugins).filter(
    (id) => typeof plugins[id]?.run !== 'function'
  );
}

/** Commander help text for `generate` / `generate-registry`'s `--type <plugin-id>` option. */
export function describeTypeOption(plugins: Record<string, OutputPlugin>): string {
  return `Output target — one of: ${pluginTypeIds(plugins).sort().join(' | ')} (see \`apigen list-types\`)`;
}

/** Commander help text for `run` / `run-registry`'s `--type <plugin-id>` option (run-capable subset only). */
export function describeRunTypeOption(plugins: Record<string, OutputPlugin>): string {
  return `Output target — one of: ${runCapableTypeIds(plugins).sort().join(' | ')} (see \`apigen list-types\`)`;
}

/** The error thrown when `--type` isn't a registered plugin id at all. */
export function unknownTypeError(
  type: string,
  plugins: Record<string, OutputPlugin>
): Error {
  return new Error(
    `Unknown --type: ${type}. Available: ${pluginTypeIds(plugins).join(', ')}`
  );
}

/**
 * The error thrown when `--type` names a real, registered plugin that simply
 * has no `run()` (e.g. `jsonschema`, `cli`) — distinct from {@link unknownTypeError}
 * so a typo'd/unrecognized `--type` (e.g. `express` instead of `api-express`)
 * doesn't get misreported as "exists but doesn't support run" (BACKLOG
 * FEAT-APIGEN-019 live field confirmation).
 */
export function unsupportedRunError(
  type: string,
  plugins: Record<string, OutputPlugin>
): Error {
  const runnable = runCapableTypeIds(plugins);
  const generateOnly = generateOnlyTypeIds(plugins);
  return new Error(
    `Plugin ${type} does not support run mode. ` +
      `Generate-only plugins: ${generateOnly.join(', ') || '(none registered)'}. ` +
      `Run-capable plugins: ${runnable.join(', ') || '(none registered)'}.`
  );
}

/** Human-readable multi-line listing for the `list-types` command. */
export function formatTypesList(plugins: Record<string, OutputPlugin>): string {
  const ids = pluginTypeIds(plugins).slice().sort();
  const runnable = new Set(runCapableTypeIds(plugins));
  const idWidth = ids.reduce((w, id) => Math.max(w, id.length), 0);

  const lines = ids.map((id) => {
    const plugin = plugins[id];
    const capability = runnable.has(id) ? 'generate, run' : 'generate';
    return `  ${id.padEnd(idWidth)}  (${capability})  ${plugin.description}`;
  });

  return [
    'Available --type plugins:',
    '',
    ...lines,
    '',
    'Use --type <id> with generate, generate-registry, run, or run-registry.',
    'Plugins marked (generate) only do not support run / run-registry.',
  ].join('\n');
}
