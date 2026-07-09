/**
 * `yaml-parser.ts` — Pipeline steps 1-3 (parse + resolve org/prefix/namespaces).
 *
 * Reads `adhd.environment.yaml` from disk, validates its shape, and returns a
 * normalized `ParsedYamlSpec`: declared namespaces/dirs/config defaulted, and
 * `orgNamespace` + `envPrefix` eagerly resolved (see `[def:orgNamespace]` /
 * `[def:envPrefix]` in `contexts/_shared.md`).
 *
 * Pure except for the initial file read — no shared mutable state, no
 * network, no writes.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYamlDocument } from 'yaml';
import type {
  ConfigScope,
  DirectoryEntry,
  DirectoryType,
  FieldType,
  ParsedYamlSpec,
  ProjectConfig,
  YamlFieldDefinition,
} from '@adhd/environment-base-spec';

// ============================================================================
// Constants (duplicated locally rather than imported at runtime — see
// module-level note in `config-resolver.ts` for why cross-package runtime
// imports are avoided here).
// ============================================================================

const DEFAULT_ORG_NAMESPACE = 'adhd';
const DEFAULT_NAMESPACE = 'default';

const VALID_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'array',
]);

const VALID_DIR_TYPES: ReadonlySet<DirectoryType> = new Set([
  'state.data',
  'runtime.log',
  'runtime.cache',
  'runtime.temp',
]);

const VALID_SCOPES: ReadonlySet<ConfigScope> = new Set(['system', 'global', 'project']);

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown when `adhd.environment.yaml` fails to parse as YAML, or parses to a
 * document that does not satisfy the `ProjectConfig`/`ParsedYamlSpec` shape.
 * Aggregates every structural problem found (not just the first) so a single
 * `adhd-env build` run surfaces the full list of fixes needed.
 */
export class YamlSpecError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [message],
  ) {
    super(issues.length > 1 ? `${message}:\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'YamlSpecError';
  }
}

// ============================================================================
// Cross-language-adjacent helper — projectEnvPrefix
//
// Duplicated (not imported) from `@adhd/environment-base-spec` so this module
// resolves correctly whether loaded via the Nx/Vite path-aliased build *or*
// via a bare `node -e require(...)` of the raw `.ts` source (no workspace
// symlinks are set up for the latter). Algorithm is pinned identically in
// both places by `[def:envPrefix]` in `contexts/_shared.md`.
// ============================================================================

/** `"agent-mcp"` → `"ADHD_AGENT_MCP"`. See `[def:envPrefix]`. */
export function projectEnvPrefix(projectName: string): string {
  return `ADHD_${projectName.toUpperCase().replace(/-/g, '_')}`;
}

// ============================================================================
// Raw (pre-validation) shape — what `yaml.parse()` hands back before we know
// it is well-formed. Intentionally loose (`unknown` leaves) — validation
// narrows it.
// ============================================================================

interface RawFieldDefinition {
  type?: unknown;
  default?: unknown;
  env?: unknown;
  scope?: unknown;
  description?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  enum?: unknown;
  pattern?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  items?: unknown;
  secret?: unknown;
  noEnv?: unknown;
}

interface RawDirectoryEntry {
  type?: unknown;
  name?: unknown;
  path?: unknown;
  scope?: unknown;
  description?: unknown;
}

interface RawProjectSection {
  name?: unknown;
  orgNamespace?: unknown;
  envPrefixOverride?: unknown;
  description?: unknown;
}

interface RawYamlDocument {
  project?: RawProjectSection;
  namespaces?: unknown;
  dirs?: unknown;
  config?: {
    system?: unknown;
    global?: unknown;
    project?: unknown;
  };
}

// ============================================================================
// Validation
// ============================================================================

function pushIssue(issues: string[], path: string, message: string): void {
  issues.push(`${path}: ${message}`);
}

function validateFieldDefinition(
  path: string,
  raw: unknown,
  issues: string[],
): raw is RawFieldDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    pushIssue(issues, path, 'must be an object with at least a "type"');
    return false;
  }
  const def = raw as RawFieldDefinition;
  if (typeof def.type !== 'string' || !VALID_FIELD_TYPES.has(def.type as FieldType)) {
    pushIssue(
      issues,
      `${path}.type`,
      `must be one of ${[...VALID_FIELD_TYPES].join(', ')} (got ${JSON.stringify(def.type)})`,
    );
  }
  if (def.env !== undefined && typeof def.env !== 'string') {
    pushIssue(issues, `${path}.env`, 'must be a string when present');
  }
  if (def.scope !== undefined && !VALID_SCOPES.has(def.scope as ConfigScope)) {
    pushIssue(issues, `${path}.scope`, `must be one of ${[...VALID_SCOPES].join(', ')} when present`);
  }
  if (def.description !== undefined && typeof def.description !== 'string') {
    pushIssue(issues, `${path}.description`, 'must be a string when present');
  }
  if (def.minimum !== undefined && typeof def.minimum !== 'number') {
    pushIssue(issues, `${path}.minimum`, 'must be a number when present');
  }
  if (def.maximum !== undefined && typeof def.maximum !== 'number') {
    pushIssue(issues, `${path}.maximum`, 'must be a number when present');
  }
  if (def.enum !== undefined && !Array.isArray(def.enum)) {
    pushIssue(issues, `${path}.enum`, 'must be an array when present');
  }
  if (def.pattern !== undefined && typeof def.pattern !== 'string') {
    pushIssue(issues, `${path}.pattern`, 'must be a string when present');
  }
  if (def.minLength !== undefined && typeof def.minLength !== 'number') {
    pushIssue(issues, `${path}.minLength`, 'must be a number when present');
  }
  if (def.maxLength !== undefined && typeof def.maxLength !== 'number') {
    pushIssue(issues, `${path}.maxLength`, 'must be a number when present');
  }
  if (def.secret !== undefined && typeof def.secret !== 'boolean') {
    pushIssue(issues, `${path}.secret`, 'must be a boolean when present');
  }
  if (def.noEnv !== undefined && typeof def.noEnv !== 'boolean') {
    pushIssue(issues, `${path}.noEnv`, 'must be a boolean when present');
  }
  if (def.items !== undefined) {
    const items = def.items as { type?: unknown } | null;
    if (typeof items !== 'object' || items === null || typeof items.type !== 'string') {
      pushIssue(issues, `${path}.items`, 'must be an object of shape { type: string } when present');
    }
  }
  return true;
}

function validateFieldSection(
  path: string,
  raw: unknown,
  issues: string[],
): Record<string, RawFieldDefinition> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    pushIssue(issues, path, 'must be an object mapping dot-path field names to field definitions');
    return {};
  }
  const section = raw as Record<string, unknown>;
  const result: Record<string, RawFieldDefinition> = {};
  for (const key of Object.keys(section)) {
    if (validateFieldDefinition(`${path}.${key}`, section[key], issues)) {
      result[key] = section[key] as RawFieldDefinition;
    }
  }
  return result;
}

function validateDirs(raw: unknown, issues: string[]): DirectoryEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    pushIssue(issues, 'dirs', 'must be an array when present');
    return [];
  }
  const result: DirectoryEntry[] = [];
  raw.forEach((entry: unknown, index: number) => {
    const path = `dirs[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      pushIssue(issues, path, 'must be an object');
      return;
    }
    const dir = entry as RawDirectoryEntry;
    if (typeof dir.type !== 'string' || !VALID_DIR_TYPES.has(dir.type as DirectoryType)) {
      pushIssue(issues, `${path}.type`, `must be one of ${[...VALID_DIR_TYPES].join(', ')}`);
      return;
    }
    if (dir.name !== undefined && typeof dir.name !== 'string') {
      pushIssue(issues, `${path}.name`, 'must be a string when present');
      return;
    }
    if (dir.path !== undefined && typeof dir.path !== 'string') {
      pushIssue(issues, `${path}.path`, 'must be a string when present');
      return;
    }
    if (dir.scope !== undefined && !VALID_SCOPES.has(dir.scope as ConfigScope)) {
      pushIssue(issues, `${path}.scope`, `must be one of ${[...VALID_SCOPES].join(', ')} when present`);
      return;
    }
    if (dir.description !== undefined && typeof dir.description !== 'string') {
      pushIssue(issues, `${path}.description`, 'must be a string when present');
      return;
    }
    result.push({
      type: dir.type as DirectoryType,
      name: dir.name as string | undefined,
      path: dir.path as string | undefined,
      scope: dir.scope as ConfigScope | undefined,
      description: dir.description as string | undefined,
    });
  });
  return result;
}

/**
 * Validates a parsed (but not yet typed) YAML document against the
 * `adhd.environment.yaml` shape. Throws `YamlSpecError` — aggregating every
 * structural problem found — when the document is invalid. Narrows `raw` to
 * `RawYamlDocument` on success.
 */
export function validateYamlSpec(raw: unknown): asserts raw is RawYamlDocument {
  const issues: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new YamlSpecError('adhd.environment.yaml must parse to a YAML mapping (object) at the root');
  }
  const doc = raw as RawYamlDocument;

  if (typeof doc.project !== 'object' || doc.project === null || Array.isArray(doc.project)) {
    pushIssue(issues, 'project', 'is required and must be an object');
  } else {
    const project = doc.project;
    if (typeof project.name !== 'string' || project.name.length === 0) {
      pushIssue(issues, 'project.name', 'is required and must be a non-empty string');
    } else if (!KEBAB_CASE_RE.test(project.name)) {
      pushIssue(issues, 'project.name', `must be kebab-case (got ${JSON.stringify(project.name)})`);
    }
    if (project.orgNamespace !== undefined && typeof project.orgNamespace !== 'string') {
      pushIssue(issues, 'project.orgNamespace', 'must be a string when present');
    }
    if (project.envPrefixOverride !== undefined && typeof project.envPrefixOverride !== 'string') {
      pushIssue(issues, 'project.envPrefixOverride', 'must be a string when present');
    }
    if (project.description !== undefined && typeof project.description !== 'string') {
      pushIssue(issues, 'project.description', 'must be a string when present');
    }
  }

  if (doc.namespaces !== undefined) {
    if (!Array.isArray(doc.namespaces) || doc.namespaces.some((ns) => typeof ns !== 'string' || ns.length === 0)) {
      pushIssue(issues, 'namespaces', 'must be an array of non-empty strings when present');
    }
  }

  validateDirs(doc.dirs, issues);

  if (doc.config !== undefined) {
    if (typeof doc.config !== 'object' || doc.config === null || Array.isArray(doc.config)) {
      pushIssue(issues, 'config', 'must be an object with optional system/global/project sections');
    } else {
      validateFieldSection('config.system', doc.config.system, issues);
      validateFieldSection('config.global', doc.config.global, issues);
      validateFieldSection('config.project', doc.config.project, issues);
    }
  }

  if (issues.length > 0) {
    throw new YamlSpecError('adhd.environment.yaml failed validation', issues);
  }
}

// ============================================================================
// parseYamlSpec
// ============================================================================

/**
 * Reads and parses `adhd.environment.yaml` at `filePath`, validates its
 * shape, and returns a normalized `ParsedYamlSpec`:
 *  - `namespaces` defaults to `["default"]` when absent from the YAML.
 *  - `dirs` defaults to `[]` when absent.
 *  - `config.{system,global,project}` each default to `{}`.
 *  - `orgNamespace` defaults to `"adhd"`.
 *  - `envPrefix` is `project.envPrefixOverride` when present, else
 *    `projectEnvPrefix(project.name)`.
 *
 * Throws `YamlSpecError` on malformed YAML or a document that fails
 * structural validation.
 */
export function parseYamlSpec(filePath: string): ParsedYamlSpec {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new YamlSpecError(
      `Failed to read adhd.environment.yaml at "${filePath}": ${(error as Error).message}`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYamlDocument(text);
  } catch (error) {
    throw new YamlSpecError(`Failed to parse YAML at "${filePath}": ${(error as Error).message}`);
  }

  validateYamlSpec(raw);

  const rawProject = raw.project as RawProjectSection;
  const name = rawProject.name as string;
  const orgNamespace = (rawProject.orgNamespace as string | undefined) ?? DEFAULT_ORG_NAMESPACE;
  const envPrefixOverride = rawProject.envPrefixOverride as string | undefined;
  const envPrefix = envPrefixOverride ?? projectEnvPrefix(name);

  const dirs = validateDirs(raw.dirs, []);
  const namespaces =
    Array.isArray(raw.namespaces) && raw.namespaces.length > 0
      ? [...(raw.namespaces as string[])]
      : [DEFAULT_NAMESPACE];

  const config = {
    system: validateFieldSection('config.system', raw.config?.system, []) as unknown as Record<
      string,
      YamlFieldDefinition
    >,
    global: validateFieldSection('config.global', raw.config?.global, []) as unknown as Record<
      string,
      YamlFieldDefinition
    >,
    project: validateFieldSection('config.project', raw.config?.project, []) as unknown as Record<
      string,
      YamlFieldDefinition
    >,
  };

  const project: ProjectConfig = {
    name,
    orgNamespace,
    envPrefixOverride,
    description: rawProject.description as string | undefined,
    namespaces: Array.isArray(raw.namespaces) ? [...(raw.namespaces as string[])] : undefined,
    dirs: dirs.length > 0 ? dirs : undefined,
    // NOTE: `ProjectConfig.config` is typed (in `environment-base-spec`) as
    // `Record<string, ConfigFieldDefinition>` — the *resolved/merged* shape,
    // not the as-authored `YamlFieldDefinition` shape produced by parsing.
    // The pipeline (interfaces-architect.md §7 steps 2 & 4) only ever reads
    // `yaml.project.{name,orgNamespace,envPrefixOverride}` and the top-level
    // `yaml.config.*` — never `yaml.project.config` — so we deliberately
    // leave this optional field unset rather than fabricate a value that
    // would misrepresent the as-authored YAML.
  };

  return {
    project,
    namespaces,
    dirs,
    config,
    orgNamespace,
    envPrefix,
  };
}

// ============================================================================
// DEFAULT_SPEC_TEMPLATE — starter YAML written by `adhd-env init --generate-config`
// ============================================================================

/**
 * Starter `adhd.environment.yaml` template. Minimal but complete: parses and
 * validates successfully as-is (empty `dirs`/`config` sections are valid —
 * see the `[inv:...]` empty-scope invariant exercised in
 * `yaml-parser.test.ts`). The CLI (`environment-cli`, a later state) writes
 * this verbatim for `adhd-env init --generate-config` and substitutes the
 * real project name.
 */
export const DEFAULT_SPEC_TEMPLATE = `# adhd.environment.yaml — generated by \`adhd-env init --generate-config\`
# This is the single source of truth for this project's environment.
# Edit by hand; re-run \`adhd-env build\` after changes.

project:
  name: my-project                     # Required. kebab-case project name.
  # orgNamespace: adhd                 # Optional. Defaults to "adhd".
  # envPrefixOverride: ADHD_MY_PROJECT # Optional. Inferred from "name" when absent.
  description: ""

# namespaces:                          # Optional. Defaults to ["default"] when absent.
#   - development
#   - production

dirs: []                               # Optional. Directory catalog entries.
# dirs:
#   - type: state.data
#     name: primary
#     scope: project
#     description: Main SQLite database

config:
  system: {}
  global: {}
  project: {}
  # project:
  #   db.path:
  #     type: string
  #     default: \${HOME}/.adhd/my-project/data.db
`;
