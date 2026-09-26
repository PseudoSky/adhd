/**
 * `layer-files.ts` — loads the (all-optional) YAML config-override files for
 * each root, per ARCHITECTURE.md §2.2.
 *
 * Every layer file is optional: a missing or unreadable/malformed file is
 * treated as an empty layer, never an error — files are purely optional
 * overrides that layer on top of the code-defined spec defaults
 * (ARCHITECTURE.md §0/§2.1).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME } from '@adhd/environment-base-spec';

// `yaml@1.10.3`'s ROOT entry is CommonJS-only (type: "commonjs"; its
// `exports["."]` has no `import` condition — only `./util` and `./types` ship
// `.mjs`). A named import (`import { parse } from 'yaml'`) is therefore emitted
// verbatim into every consumer ESM bundle that externalizes yaml (via
// tools/vite-plugins/externalize.mjs) and inlines this source — e.g.
// `apigen-plugin-ir-cache`. Node cannot statically resolve a named export off a
// CJS module, so that ESM entry throws `SyntaxError: Named export 'parse' not
// found` on load. This package's OWN vite build bundles yaml (`external` is
// `/^node:/` only), so its own dist never carried the bare import — only
// externalizing consumers did. The default import binds `module.exports` and is
// the interop form Node guarantees — destructure off it instead. (Same remedy
// 2ea64778 applied to @adhd/backlog; this is the shared source that fix
// missed.)
const { parse: parseYamlDocument } = yaml;

import type { Roots } from './roots';

/** A single loaded layer's values, flattened to a dot-path map (or
 *  `undefined` when the layer's file does not exist / fails to parse). */
export type LayerValues = Record<string, unknown> | undefined;

/** The four (all-optional) file layers, ordered lowest→highest priority
 *  (env vars, the fifth and highest layer, are read directly from
 *  `process.env` by `resolveConfig` — not a file). */
export interface Layers {
  system: LayerValues;
  global: LayerValues;
  project: LayerValues;
  local: LayerValues;
}

/**
 * Flattens a nested plain-object tree into a flat dot-path map, mirroring
 * the shape of `EnvironmentSpec.config`'s keys (e.g. `{ a: { port: 9 } }` →
 * `{ "a.port": 9 }`). Arrays and non-plain-object leaves are treated as
 * terminal values (not descended into).
 */
export function flattenToPaths(node: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    if (prefix) result[prefix] = node;
    return result;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenToPaths(value, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

/**
 * Reads and parses a single YAML layer file, returning its flattened
 * dot-path map, or `undefined` when the file is absent, unreadable, or
 * fails to parse as a YAML mapping (never throws — every layer is optional).
 */
export function readLayerFile(filePath: string): LayerValues {
  if (!existsSync(filePath)) return undefined;
  try {
    const text = readFileSync(filePath, 'utf8');
    const parsed: unknown = parseYamlDocument(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return flattenToPaths(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Loads every (optional) layer file for the resolved `roots`:
 *   - `system`/`global`/`project` — each root's `config.yaml`.
 *   - `local` — the project root's `config.local.yaml` only (the most
 *     specific layer; there is no system/global `.local` variant, matching
 *     Claude Code's own cascade where only the project layer has a `.local`
 *     override).
 */
export function loadLayerFiles(roots: Roots): Layers {
  return {
    system: readLayerFile(join(roots.system, CONFIG_FILENAME)),
    global: readLayerFile(join(roots.global, CONFIG_FILENAME)),
    project: roots.project ? readLayerFile(join(roots.project, CONFIG_FILENAME)) : undefined,
    local: roots.project ? readLayerFile(join(roots.project, LOCAL_CONFIG_FILENAME)) : undefined,
  };
}
