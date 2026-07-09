/**
 * `field-merge.ts` — Pipeline step 4 (three-tier scope cascade).
 *
 * `mergeFieldDefinitions(system, global, project)` implements
 * `[def:scope-cascade]` (see `contexts/_shared.md`): `project` overrides
 * `global`, `global` overrides `system`, at the level of individual
 * JSON-Schema validation keywords — not whole-field replacement. A field
 * declared only partially at a higher scope (e.g. `project` overrides just
 * `default`) still inherits every keyword (`minimum`, `enum`, ...) it did not
 * itself redeclare from the lower scope(s) that defined them.
 *
 * Pure — no I/O, no shared mutable state.
 */

import type { ConfigFieldDefinition, ConfigScope, YamlFieldDefinition } from '@adhd/environment-base-spec';

/**
 * Merges the three scope-tiered field definition maps from a parsed YAML spec
 * into a single flat map of `ConfigFieldDefinition`, keyed by dot-path field
 * name.
 *
 * For each field path present in any of the three maps:
 *  - Keyword-level merge: `{ ...system[key], ...global[key], ...project[key] }`
 *    — a keyword set at a higher scope replaces the same keyword from a lower
 *    scope; keywords *not* redeclared at a higher scope are inherited as-is.
 *  - `sourceScope` — the highest-priority scope tier that declares this key
 *    at all (`project` if present there, else `global`, else `system`).
 *  - `scope` — the field's *effective* scope: the field definition's own
 *    (rare) `scope` override if any layer set one, otherwise `sourceScope`.
 *  - `env` — the explicit `env:` override if any layer set one, otherwise the
 *    empty string `""` as a sentinel meaning "not explicitly set" (env var
 *    *inference* — `[def:inferEnvVar]` — happens later, in
 *    `config-resolver.ts`, once the project's env prefix is known).
 *
 * Every one of the three maps may be omitted or empty — an empty scope is
 * valid and simply contributes no keys.
 */
export function mergeFieldDefinitions(
  system: Record<string, YamlFieldDefinition> = {},
  global: Record<string, YamlFieldDefinition> = {},
  project: Record<string, YamlFieldDefinition> = {},
): Record<string, ConfigFieldDefinition> {
  const keys = new Set<string>([
    ...Object.keys(system),
    ...Object.keys(global),
    ...Object.keys(project),
  ]);

  const merged: Record<string, ConfigFieldDefinition> = {};

  for (const key of keys) {
    const sys = system[key];
    const glob = global[key];
    const proj = project[key];

    const combined: YamlFieldDefinition = {
      ...(sys ?? {}),
      ...(glob ?? {}),
      ...(proj ?? {}),
    } as YamlFieldDefinition;

    if (combined.type === undefined) {
      throw new Error(
        `Field "${key}" has no "type" defined in any scope (system/global/project) — "type" is required.`,
      );
    }

    let sourceScope: ConfigScope;
    if (proj !== undefined) {
      sourceScope = 'project';
    } else if (glob !== undefined) {
      sourceScope = 'global';
    } else {
      sourceScope = 'system';
    }
    const scope: ConfigScope = combined.scope ?? sourceScope;

    merged[key] = {
      type: combined.type,
      default: combined.default,
      scope,
      // Sentinel: "" means "no explicit override in any scope" — see
      // `config-resolver.ts`'s `inferEnvVar` step for how this is resolved.
      env: combined.env ?? '',
      sourceScope,
      description: combined.description,
      secret: combined.secret,
      noEnv: combined.noEnv,
      minimum: combined.minimum,
      maximum: combined.maximum,
      enum: combined.enum,
      pattern: combined.pattern,
      minLength: combined.minLength,
      maxLength: combined.maxLength,
      items: combined.items,
    };
  }

  return merged;
}
