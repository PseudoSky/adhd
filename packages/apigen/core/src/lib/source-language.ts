/**
 * Source-language routing helpers for apigen's `serve` command.
 *
 * When `apigen serve` watches a directory it may contain source files written
 * in multiple host languages (TypeScript, Python, Rust, …).  These helpers
 * allow the harness to route each file to the plugin(s) that declared a
 * matching `language` — preventing a Python source being fed into a TypeScript
 * extractor, and vice-versa.
 *
 * @module source-language
 */

import * as path from 'node:path'
import type { PluginLanguage } from './types'

// ---------------------------------------------------------------------------
// Extension → language mapping
// ---------------------------------------------------------------------------

/**
 * Map from lowercased file extension (including the leading dot) to the
 * canonical {@link PluginLanguage} tag.
 *
 * New host languages should be registered here and in the `PluginLanguage`
 * union type (`types.ts`).
 */
const EXTENSION_MAP: ReadonlyMap<string, PluginLanguage> = new Map([
  // TypeScript variants
  ['.ts', 'ts'],
  ['.tsx', 'ts'],
  ['.mts', 'ts'],
  ['.cts', 'ts'],
  // Python
  ['.py', 'py'],
  // Rust
  ['.rs', 'rust'],
  // Go
  ['.go', 'go'],
  // Java / Kotlin (both are JVM host languages for the purposes of routing)
  ['.java', 'java'],
])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the canonical {@link PluginLanguage} tag for a source file from its
 * extension.
 *
 * Returns `undefined` when the extension is not recognised — callers should
 * treat an unknown extension as "no plugin will consume this file" rather than
 * guessing.
 *
 * @example
 * ```ts
 * languageOfSource('src/api.ts')   // → 'ts'
 * languageOfSource('src/api.tsx')  // → 'ts'
 * languageOfSource('src/api.py')   // → 'py'
 * languageOfSource('src/api.go')   // → 'go'
 * languageOfSource('README.md')    // → undefined
 * ```
 */
export function languageOfSource(file: string): PluginLanguage | undefined {
  const ext = path.extname(file).toLowerCase()
  return EXTENSION_MAP.get(ext)
}

// ---------------------------------------------------------------------------
// Plugin-level helpers
// ---------------------------------------------------------------------------

/**
 * The minimal plugin shape that the routing helpers need to inspect.
 *
 * Both the v1 `OutputPlugin` and the v2 `Plugin` satisfy this interface
 * because `language` is defined on both (as an optional field).
 */
export interface LanguageAwarePlugin {
  /** @see {@link PluginLanguage} */
  language?: PluginLanguage
}

/**
 * Return the effective language for a plugin — the declared `language` if set,
 * or `'ts'` as the documented default for back-compat.
 *
 * @param plugin - Any plugin that may declare `language`.
 */
export function effectiveLanguage(plugin: LanguageAwarePlugin): PluginLanguage {
  return plugin.language ?? 'ts'
}

/**
 * Returns `true` when the given plugin should consume `file`.
 *
 * A plugin consumes a file when:
 *   1. The file's extension maps to a known {@link PluginLanguage}, AND
 *   2. That language matches the plugin's effective language (declared or
 *      defaulting to `'ts'`).
 *
 * Files with unrecognised extensions are never routed to any plugin.
 *
 * @param plugin - The plugin to test.
 * @param file   - Absolute or relative path to the source file.
 *
 * @example
 * ```ts
 * pluginConsumesSource({ language: 'ts' }, 'src/api.ts')  // → true
 * pluginConsumesSource({ language: 'ts' }, 'src/api.py')  // → false
 * pluginConsumesSource({ language: 'py' }, 'src/api.py')  // → true
 * pluginConsumesSource({},                 'src/api.ts')  // → true  (default 'ts')
 * ```
 */
export function pluginConsumesSource(
  plugin: LanguageAwarePlugin,
  file: string,
): boolean {
  const lang = languageOfSource(file)
  if (lang === undefined) return false
  return lang === effectiveLanguage(plugin)
}

/**
 * Filter `files` to the subset whose language matches the given plugin.
 *
 * This is the primary entry-point for the `serve` command's dispatch loop:
 * call once per plugin to obtain the slice of changed/watched files it should
 * re-process.
 *
 * @param plugin - The plugin to route for.
 * @param files  - All candidate source files.
 * @returns        The subset of `files` the plugin should consume (may be empty).
 *
 * @example
 * ```ts
 * const all = ['src/api.ts', 'src/api.py', 'src/utils.mts', 'README.md']
 * sourcesForPlugin({ language: 'ts' }, all)
 * // → ['src/api.ts', 'src/utils.mts']
 *
 * sourcesForPlugin({ language: 'py' }, all)
 * // → ['src/api.py']
 * ```
 */
export function sourcesForPlugin(
  plugin: LanguageAwarePlugin,
  files: readonly string[],
): string[] {
  return files.filter((f) => pluginConsumesSource(plugin, f))
}
