// extractors/param-defaults.ts — BUG-APIGEN-018 support.
//
// Extracts a function parameter's default value so the generated MCP/JSON
// schema can surface it (as both the native JSON-Schema `default` keyword and
// a human-readable note appended to `description`). Two sources, in priority
// order:
//
//   1. The TS initializer itself — `function f(strategy = 'auto')` — the
//      concrete runtime source of truth.
//   2. A JSDoc `@param` bracketed default — `@param {string} [strategy=auto]`
//      — for params whose default lives elsewhere (e.g. documented on a
//      destructured options object) and therefore carry no local initializer.
//
// This module is pure ts-morph text extraction; it does not touch buildSchema
// or JSON-Schema shapes directly (see `applyParamDefault`, which does).

import type { JSDoc, Node, ParameterDeclaration } from 'ts-morph';

/** Minimal structural shape of any ts-morph node that can carry JSDoc comments. */
type JsDocSource = { getJsDocs?: () => JSDoc[] };

/**
 * Extracts the raw source text of a parameter's default value.
 *
 * @param paramDecl - The parameter's own declaration, when resolvable (may be
 *   `null`/`undefined` for parameters reached only through a `Signature`
 *   whose declaration could not be narrowed to a `ParameterDeclaration`).
 * @param paramName - The parameter's name, used to match a JSDoc `@param` tag.
 * @param jsDocSource - The enclosing function-like node (FunctionDeclaration,
 *   VariableStatement, ExportAssignment, …) whose leading JSDoc comment may
 *   carry a bracketed default for this parameter.
 * @returns The raw default-value text (e.g. `"'auto'"`, `"0"`, `"false"`), or
 *   `undefined` when no default could be found.
 */
export function extractParamDefault(
  paramDecl: ParameterDeclaration | null | undefined,
  paramName: string,
  jsDocSource?: Node | null
): string | undefined {
  if (paramDecl?.hasInitializer()) {
    const init = paramDecl.getInitializer();
    if (init) return init.getText();
  }
  return extractJsDocDefault(jsDocSource, paramName);
}

/**
 * Scans a JSDoc-carrying node's `@param` tags for a bracketed default of the
 * form `[paramName=value]` (the standard JSDoc "optional with default"
 * syntax), returning the raw `value` text.
 */
function extractJsDocDefault(
  node: Node | null | undefined,
  paramName: string
): string | undefined {
  const jsDocSource = node as unknown as JsDocSource | null | undefined;
  const jsDocs = jsDocSource?.getJsDocs?.() ?? [];
  const escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bracketDefault = new RegExp(`\\[\\s*${escaped}\\s*=\\s*([^\\]]+)\\]`);
  for (const doc of jsDocs) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() !== 'param') continue;
      const match = tag.getText().match(bracketDefault);
      if (match) return match[1].trim();
    }
  }
  return undefined;
}

/**
 * Coerces a raw TS/JSDoc default-value literal into a properly-typed JSON
 * value so it can be emitted verbatim as a JSON-Schema `default`.
 *
 * Handles quoted string literals (`'auto'`, `"auto"`, `` `auto` ``), the
 * `true`/`false`/`null` keywords, numeric literals, and falls back to
 * `JSON.parse` (array/object literals) before giving up and returning the
 * trimmed raw text (e.g. an enum-member reference apigen can't evaluate
 * statically).
 */
export function coerceDefaultLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(['"`])([\s\S]*)\1$/);
  if (quoted) return quoted[2];
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Applies an extracted default onto a built parameter schema in place:
 * sets the native JSON-Schema `default` keyword and appends a human-readable
 * `(default: <value>)` note to `description` (preserving any existing text).
 *
 * A no-op when the coerced value is `undefined` (an explicit `= undefined`
 * initializer carries no useful default to advertise).
 */
export function applyParamDefault(
  schema: Record<string, unknown>,
  rawDefault: string
): void {
  const value = coerceDefaultLiteral(rawDefault);
  if (value === undefined) return;
  schema['default'] = value;
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  const existing =
    typeof schema['description'] === 'string'
      ? (schema['description'] as string)
      : undefined;
  schema['description'] = existing
    ? `${existing} (default: ${rendered})`
    : `(default: ${rendered})`;
}
