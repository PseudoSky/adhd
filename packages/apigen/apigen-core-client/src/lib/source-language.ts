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

import * as path from 'node:path';
import type { PluginLanguage } from './types';

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
]);

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
  const ext = path.extname(file).toLowerCase();
  return EXTENSION_MAP.get(ext);
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
  language?: PluginLanguage;
}

/**
 * Return the effective language for a plugin — the declared `language` if set,
 * or `'ts'` as the documented default for back-compat.
 *
 * @param plugin - Any plugin that may declare `language`.
 */
export function effectiveLanguage(plugin: LanguageAwarePlugin): PluginLanguage {
  return plugin.language ?? 'ts';
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
  file: string
): boolean {
  const lang = languageOfSource(file);
  if (lang === undefined) return false;
  return lang === effectiveLanguage(plugin);
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
  files: readonly string[]
): string[] {
  return files.filter((f) => pluginConsumesSource(plugin, f));
}

// ---------------------------------------------------------------------------
// Source-reference resolver (ADR-0017 D4; gap analysis §3a, §5.4, §5.5)
// ---------------------------------------------------------------------------

/** What a source reference points at. */
export type AssetKind = 'code' | 'schema-document' | 'endpoint' | 'executable';

/**
 * Translator id; equals `ExtractCall.host`. Code translators reuse
 * {@link PluginLanguage} values.
 */
export type TranslatorId =
  | PluginLanguage
  | 'argv'
  | 'mcp'
  | 'openapi'
  | 'graphql'
  | 'jsonschema';

/** Where the asset lives: a file path, a URL, or a command name/path. */
export type SourceLocator =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'command'; readonly command: string };

/**
 * How an operation from the source is executed. Pure data: never a URL or
 * command smuggled inside `Operation`.
 */
export type BindingSpec =
  | { readonly kind: 'in-process'; readonly runtime: 'ts' }
  | { readonly kind: 'local-host'; readonly runtime: PluginLanguage }
  | {
      readonly kind: 'process';
      readonly command: string;
      readonly protocol: 'argv' | 'mcp-stdio';
    }
  | {
      readonly kind: 'remote';
      readonly protocol: 'http' | 'mcp' | 'grpc';
      readonly url: string;
    }
  /** Decided by the translator (OpenAPI servers, MCP URL). */
  | { readonly kind: 'from-asset' };

/** The classification of one source reference. */
export interface ISourceResolution {
  /** The reference exactly as given. */
  readonly reference: string;
  /** Where the asset lives. */
  readonly locator: SourceLocator;
  /** What kind of asset the reference names. */
  readonly asset: AssetKind;
  /**
   * Absent only for an executable with no `protocol` option. The resolver is
   * pure and never sees the caller's verb, so the caller fills this in.
   */
  readonly translator?: TranslatorId;
  /**
   * How operations from this source execute. For an executable the protocol
   * is the `argv` default; a caller that selects the `mcp` translator
   * rewrites it to `mcp-stdio`.
   */
  readonly binding: BindingSpec;
  /** Per-source options. Always `{}` until the option grammar is built. */
  readonly options: Readonly<Record<string, string>>;
}

/** Why a reference could not be resolved. */
export type SourceResolutionError = {
  readonly code: 'unsupported' | 'not-found' | 'invalid-reference';
  readonly message: string;
};

/**
 * Filesystem and PATH checks, injected so the resolver stays string-pure and
 * safe for `platform:shared`. The node implementation lives in the gateway.
 */
export interface ISourceProbe {
  /** Path exists and is a regular file. */
  isFile(path: string): boolean;
  /** Path exists and carries an exec bit. */
  isExecutable(path: string): boolean;
  /** The reference names an executable found on PATH. */
  onPath(command: string): boolean;
}

const SCHEMA_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.graphql',
]);

/** Lowercased extension of the last path segment, by string operations only. */
function extensionOf(reference: string): string {
  const slash = Math.max(reference.lastIndexOf('/'), reference.lastIndexOf('\\'));
  const base = reference.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function executableResolution(
  reference: string,
  command: string
): { ok: true; value: ISourceResolution } {
  return {
    ok: true,
    value: {
      reference,
      locator: { kind: 'command', command },
      asset: 'executable',
      binding: { kind: 'process', command, protocol: 'argv' },
      options: {},
    },
  };
}

/**
 * Classify a `--source` reference into locator, asset kind, translator and
 * binding. Pure apart from the injected `probe`; adds no `node:*` import.
 *
 * Detection order (ADR-0017 D4, gap analysis §5.5), each step a function of
 * the string plus the probe:
 *
 * 1. closed-list scheme prefix: `bin:<cmd>` (executable); `remote:` is `unsupported`
 * 2. `http://` / `https://` is `unsupported` (checked before the extension so
 *    `https://x/function.py` is not read as code)
 * 3. code extension (no stat), via {@link languageOfSource}
 * 4. schema-document extension (`.json`, `.yaml`, `.yml`, `.graphql`) is `unsupported`
 * 5. existing file with an exec bit (`probe.isFile` and `probe.isExecutable`)
 * 6. PATH fallback (`probe.onPath`): unguarded and last (decision O-2); a
 *    mistyped bare word can therefore name a real PATH binary
 * 7. anything else is `invalid-reference`, naming every interpretation tried
 *
 * Without a probe, steps 5 and 6 are skipped.
 *
 * @param reference - The `--source` string.
 * @param probe     - Optional filesystem/PATH port.
 * @returns The resolution, or a typed error.
 *
 * @example
 * ```ts
 * resolveSourceReference('src/api.ts')
 * // → { ok: true, value: { asset: 'code', translator: 'ts', binding: { kind: 'in-process', runtime: 'ts' }, … } }
 * resolveSourceReference('bin:git')
 * // → { ok: true, value: { asset: 'executable', translator: undefined, … } }
 * ```
 */
export function resolveSourceReference(
  reference: string,
  probe?: ISourceProbe
): { ok: true; value: ISourceResolution } | { ok: false; error: SourceResolutionError } {
  if (reference.length === 0) {
    return {
      ok: false,
      error: { code: 'invalid-reference', message: 'empty source reference' },
    };
  }

  // 1. closed-list scheme prefix
  if (reference.startsWith('bin:')) {
    const command = reference.slice('bin:'.length);
    if (command.length === 0) {
      return {
        ok: false,
        error: {
          code: 'invalid-reference',
          message: 'bin: source needs a command name or path',
        },
      };
    }
    if (/\s/.test(command)) {
      return {
        ok: false,
        error: {
          code: 'invalid-reference',
          message:
            'bin: source must be a command name or path with no arguments or whitespace; pass arguments separately',
        },
      };
    }
    return executableResolution(reference, command);
  }
  if (reference.startsWith('remote:')) {
    return {
      ok: false,
      error: { code: 'unsupported', message: 'remote sources are not implemented yet' },
    };
  }

  // 2. URL
  if (/^https?:\/\//i.test(reference)) {
    return {
      ok: false,
      error: { code: 'unsupported', message: 'remote sources are not implemented yet' },
    };
  }

  // 3. code extension (no stat)
  const language = languageOfSource(reference);
  if (language !== undefined) {
    return {
      ok: true,
      value: {
        reference,
        locator: { kind: 'path', path: reference },
        asset: 'code',
        translator: language,
        binding:
          language === 'ts'
            ? { kind: 'in-process', runtime: 'ts' }
            : { kind: 'local-host', runtime: language },
        options: {},
      },
    };
  }

  // 4. schema-document extension
  if (SCHEMA_DOCUMENT_EXTENSIONS.has(extensionOf(reference))) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        message: 'schema-document sources are not implemented yet',
      },
    };
  }

  // 5. existing path with an exec bit
  if (probe !== undefined && probe.isFile(reference) && probe.isExecutable(reference)) {
    return executableResolution(reference, reference);
  }

  // 6. PATH fallback: unguarded, last (O-2)
  if (probe?.onPath(reference) === true) {
    return executableResolution(reference, reference);
  }

  // 7. nothing matched
  const unchecked = probe === undefined ? ' (not checked: no probe supplied)' : '';
  return {
    ok: false,
    error: {
      code: 'invalid-reference',
      message:
        `cannot resolve source "${reference}". Interpretations tried: ` +
        'scheme prefix (bin:, remote:); ' +
        'URL (http://, https://); ' +
        'code extension (.ts .tsx .mts .cts .py .rs .go .java); ' +
        'schema extension (.json .yaml .yml .graphql); ' +
        `existing executable path${unchecked}; ` +
        `PATH lookup${unchecked}`,
    },
  };
}
