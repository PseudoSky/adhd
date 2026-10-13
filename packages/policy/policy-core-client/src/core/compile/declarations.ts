import type {
  AttributeKind,
  ICompiledDefaultsRule,
  ICompiledPermission,
  ILayerInput,
  IPolicyDocument,
  IPolicyIssue,
  IRuntimeDecl,
  LayerName,
} from '../../spec';
import { valueMatchesKind } from '../attributes/kinds';
import { setOwn } from '../canonical/clone';
import { validateExpression } from '../engine/validate';
import {
  ATTRIBUTE_PLACEHOLDER,
  collectFieldPaths,
  collectStringLeaves,
} from './expr-walk';

const idIndex = (id: string): number => Number(id.slice(id.lastIndexOf(':') + 1));

function absoluteStrings(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('/');
  if (Array.isArray(value)) return value.some(absoluteStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(absoluteStrings);
  }
  return false;
}

/**
 * Merges the `attributes:` / `runtime:` blocks across layers (the same name
 * with a different kind is a `schema` issue; an attribute named `runtime` or
 * starting with `$` is a reserved-name `schema` issue), then checks, collecting EVERY
 * issue (D-05):
 * - every attribute named by `where`, `context`, `$attributes.*` placeholders
 *   and `defaults[].set` is declared (`undeclared-attribute`), with a value of
 *   its declared kind (`schema`);
 * - every `runtime.` read is declared (`undeclared-runtime`);
 * - `runtime` never appears in `defaults` `set`/`where` (`layer-violation`, RT-01);
 * - a `project` layer sets no absolute path in `defaults[].set` or a
 *   permission `set` (`layer-violation`, LY-05);
 * - every expression passes `validateExpression` (`unknown-operator`, with the
 *   offending JSON path);
 * - `$`-prefixed strings other than `$attributes.<name>` in `args`, and any
 *   placeholder in `context`/`where`, are `unsupported-placeholder`;
 * - duplicate ids are `duplicate-id`;
 * - every permission reading `runtime` yields a `runtime-without-provider`
 *   warning (always emitted here; `verify` filters it by provider presence).
 */
export function checkDeclarations(input: {
  ordered: readonly ILayerInput[];
  documents: readonly IPolicyDocument[];
  defaults: readonly ICompiledDefaultsRule[];
  permissions: readonly ICompiledPermission[];
}): {
  attributes: Readonly<Record<string, AttributeKind>>;
  runtime: IRuntimeDecl;
  errors: readonly IPolicyIssue[];
  warnings: readonly IPolicyIssue[];
} {
  const errors: IPolicyIssue[] = [];
  const warnings: IPolicyIssue[] = [];
  const err = (code: IPolicyIssue['code'], layer: LayerName, sub: string, message: string): void => {
    errors.push({ code, layer, path: `/${layer}${sub}`, message });
  };

  const attributes: Record<string, AttributeKind> = {};
  const runtime: Record<string, 'number' | 'name'> = {};
  input.ordered.forEach((layer, li) => {
    const doc = input.documents[li];
    for (const [name, kind] of Object.entries(doc.attributes ?? {})) {
      if (name === 'runtime' || name.startsWith('$')) {
        err('schema', layer.name, `/attributes/${name}`,
          `attribute name "${name}" is reserved (\`runtime\` is the provider-supplied row; names starting with "$" are internal)`);
      }
      if (Object.prototype.hasOwnProperty.call(attributes, name) && attributes[name] !== kind) {
        err('schema', layer.name, `/attributes/${name}`,
          `attribute "${name}" is declared as ${kind} here but as ${attributes[name]} in another layer`);
      } else setOwn(attributes, name, kind);
    }
    for (const [name, kind] of Object.entries(doc.runtime ?? {})) {
      if (Object.prototype.hasOwnProperty.call(runtime, name) && runtime[name] !== kind) {
        err('schema', layer.name, `/runtime/${name}`,
          `runtime field "${name}" is declared as ${kind} here but as ${runtime[name]} in another layer`);
      } else setOwn(runtime, name, kind);
    }
  });
  const hasAttr = (name: string): boolean => Object.prototype.hasOwnProperty.call(attributes, name);
  const hasRuntime = (name: string): boolean => Object.prototype.hasOwnProperty.call(runtime, name);

  const checkOperators = (layer: LayerName, expression: ICompiledPermission['args'], sub: string): void => {
    if (expression === undefined) return;
    for (const bad of validateExpression(expression, '')) {
      const leaf = bad.slice(bad.lastIndexOf('/') + 1);
      err('unknown-operator', layer, `${sub}${bad === '/' ? '' : bad}`,
        bad === '/' || !leaf.startsWith('_')
          ? 'expression rejected by the query engine'
          : `unknown or unsupported operator "${leaf}"`);
    }
  };
  const noPlaceholders = (layer: LayerName, expression: unknown, sub: string): void => {
    for (const leaf of collectStringLeaves(expression, sub)) {
      if (leaf.value.startsWith('$')) {
        err('unsupported-placeholder', layer, leaf.jsonPath,
          `placeholder "${leaf.value}" is not supported here; placeholders are only substituted in \`args\``);
      }
    }
  };

  const seenIds = new Set<string>();
  const dup = (id: string, layer: LayerName, sub: string): void => {
    if (seenIds.has(id)) err('duplicate-id', layer, sub, `duplicate id "${id}"`);
    seenIds.add(id);
  };

  for (const rule of input.defaults) {
    const n = idIndex(rule.id);
    const base = `/defaults/${n}`;
    dup(`defaults:${rule.id}`, rule.layer, base);
    if (rule.where !== undefined) {
      for (const ref of collectFieldPaths(rule.where, `${base}/where`)) {
        const head = ref.segments[0];
        if (head === 'runtime') {
          err('layer-violation', rule.layer, ref.jsonPath, '`runtime` cannot be read by a `defaults` rule (RT-01)');
        } else if (!hasAttr(head)) {
          err('undeclared-attribute', rule.layer, ref.jsonPath, `attribute "${head}" is not declared in \`attributes\``);
        }
      }
      noPlaceholders(rule.layer, rule.where, `${base}/where`);
      checkOperators(rule.layer, rule.where, `${base}/where`);
    }
    for (const [key, value] of Object.entries(rule.set)) {
      const at = `${base}/set/${key}`;
      if (key === 'runtime' || key.startsWith('runtime.')) {
        err('layer-violation', rule.layer, at, '`runtime` cannot be set by a `defaults` rule (RT-01)');
      } else if (!hasAttr(key)) {
        err('undeclared-attribute', rule.layer, at, `attribute "${key}" is not declared in \`attributes\``);
      } else if (!valueMatchesKind(attributes[key], value)) {
        err('schema', rule.layer, at, `attribute "${key}" is ${attributes[key]}; the value has the wrong type`);
      }
      if (rule.layer === 'project' && absoluteStrings(value)) {
        err('layer-violation', rule.layer, at,
          'a project layer cannot set an absolute path; set it in the global or local layer (LY-05)');
      }
    }
  }

  for (const permission of input.permissions) {
    const n = idIndex(permission.id);
    const base = `/permissions/${n}`;
    dup(`permission:${permission.id}`, permission.layer, base);
    if (permission.context !== undefined) {
      for (const ref of collectFieldPaths(permission.context, `${base}/context`)) {
        const [head, second] = ref.segments;
        if (head === 'runtime') {
          if (second === undefined || !hasRuntime(second)) {
            err('undeclared-runtime', permission.layer, ref.jsonPath,
              `runtime field "${second ?? ''}" is not declared in \`runtime\``);
          }
        } else if (!hasAttr(head)) {
          err('undeclared-attribute', permission.layer, ref.jsonPath, `attribute "${head}" is not declared in \`attributes\``);
        }
      }
      noPlaceholders(permission.layer, permission.context, `${base}/context`);
      checkOperators(permission.layer, permission.context, `${base}/context`);
    }
    if (permission.args !== undefined) {
      for (const leaf of collectStringLeaves(permission.args, `${base}/args`)) {
        if (!leaf.value.startsWith('$')) continue;
        const hit = ATTRIBUTE_PLACEHOLDER.exec(leaf.value);
        if (hit === null) {
          err('unsupported-placeholder', permission.layer, leaf.jsonPath,
            `placeholder "${leaf.value}" is not supported; only $attributes.<name> is substituted`);
        } else if (!hasAttr(hit[1])) {
          err('undeclared-attribute', permission.layer, leaf.jsonPath, `attribute "${hit[1]}" is not declared in \`attributes\``);
        }
      }
      checkOperators(permission.layer, permission.args, `${base}/args`);
    }
    if (permission.layer === 'project' && permission.set !== undefined && absoluteStrings(permission.set)) {
      err('layer-violation', permission.layer, `${base}/set`,
        'a project layer cannot force an absolute path; set it in the global or local layer (LY-05)');
    }
    if (permission.readsRuntime) {
      warnings.push({
        code: 'runtime-without-provider',
        layer: permission.layer,
        path: `/${permission.layer}${base}`,
        message: `permission ${permission.id} reads \`runtime\`; without a runtime provider or runtime values it denies with runtime-unavailable (RT-09)`,
      });
    }
  }

  return { attributes, runtime, errors, warnings };
}
