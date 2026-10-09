/**
 * `tool-arg-coercion.ts` — schema-driven tolerance for a model that
 * stringifies a structured tool argument (backlog 114e014c / BK2; plan
 * 9ed453c1). Observed: Haiku sent the shell tool's argv as the STRING
 * `"[\"adhd-backlog\",...]"` three times in a row, tripping the
 * `consecutiveErrors` budget and failing 2 of 3 OAuth runs.
 *
 * Rules (binding architect verdict Q3):
 * - Runs as a pre-step before `callTool`, driven only by the tool's declared
 *   `input_schema`; TOP-LEVEL properties only; one level (no recursion into
 *   the parsed value).
 * - A property is a candidate only if its declared `type` is exactly `"array"`
 *   or exactly `"object"` (a single string type) and it carries no `anyOf`,
 *   `oneOf`, `allOf`, `$ref` or `not` ambiguity.
 * - Coerce only when the supplied value is a string, `JSON.parse` succeeds and
 *   yields the declared type (array / non-null non-array object). For an array
 *   whose `items.type` is `"string"`, every element must be a string.
 * - `string`, `number`, `boolean`, union-typed and undeclared properties are
 *   never touched.
 * - A candidate string value that does NOT coerce is a mismatch: the call is
 *   not made and {@link ToolArgMismatch} carries a model-facing message naming
 *   the property, the declared type and a worked example.
 *
 * Pure: no I/O, no logging; the orchestrator emits the event and the warning.
 */

/** One applied coercion; the `TOOL_ARG_COERCED` event payload minus task/tool. */
export interface ToolArgCoercion {
  property: string;
  from: 'string';
  to: 'array' | 'object';
}

/** A string supplied for an array/object property that could not be coerced. */
export interface ToolArgMismatch {
  property: string;
  declaredType: 'array' | 'object';
  /** Model-facing text: property, declared type, worked example. */
  message: string;
}

/** Outcome of {@link coerceToolArguments}. */
export interface ToolArgCoercionOutcome {
  /** The (possibly new) arguments object. The input is never mutated. */
  arguments: unknown;
  coercions: ToolArgCoercion[];
  /** First non-coercible mismatch, if any; the caller must not invoke the tool. */
  mismatch?: ToolArgMismatch;
}

type SchemaNode = Record<string, unknown>;

const AMBIGUOUS_KEYS = ['anyOf', 'oneOf', 'allOf', '$ref', 'not'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `'array'`/`'object'` only for an unambiguous single declared type. */
function declaredCandidateType(node: unknown): 'array' | 'object' | null {
  if (!isPlainObject(node)) return null;
  if (AMBIGUOUS_KEYS.some((k) => k in node)) return null;
  const t = node['type'];
  return t === 'array' || t === 'object' ? t : null;
}

const ARRAY_SAMPLES: Record<string, string> = {
  string: '["first", "second"]',
  number: '[1, 2]',
  integer: '[1, 2]',
  boolean: '[true, false]',
  object: '[{"key": "value"}]',
};

function workedExample(property: string, type: 'array' | 'object', node: SchemaNode): string {
  if (type === 'array') {
    const items = isPlainObject(node['items']) ? node['items'] : {};
    const itemType = typeof items['type'] === 'string' ? items['type'] : 'string';
    const sample = ARRAY_SAMPLES[itemType] ?? ARRAY_SAMPLES['string'];
    return `{"${property}": ${sample}}`;
  }
  const props = isPlainObject(node['properties']) ? Object.keys(node['properties']) : [];
  const key = props[0] ?? 'key';
  return `{"${property}": {"${key}": "value"}}`;
}

function mismatch(property: string, type: 'array' | 'object', node: SchemaNode): ToolArgMismatch {
  const items = isPlainObject(node['items']) ? node['items'] : {};
  const of = type === 'array' && typeof items['type'] === 'string' ? ` of ${items['type']}` : '';
  return {
    property,
    declaredType: type,
    message:
      `Invalid argument "${property}": expected a JSON ${type}${of}, but received a string that is not a valid JSON ${type}. ` +
      `Pass "${property}" as a real JSON ${type}, not a quoted string. Example: ${workedExample(property, type, node)}`,
  };
}

/** Parse `value` and return it only if it is the declared type (and string items for `items.type:"string"`). */
function parseAs(value: string, type: 'array' | 'object', node: SchemaNode): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (type === 'array') {
    if (!Array.isArray(parsed)) return undefined;
    const items = isPlainObject(node['items']) ? node['items'] : undefined;
    if (items?.['type'] === 'string' && !parsed.every((e) => typeof e === 'string')) {
      return undefined;
    }
    return parsed;
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

/**
 * Coerce stringified array/object arguments per the tool's declared
 * `inputSchema`. Returns the input untouched (same reference) when nothing
 * applies.
 *
 * @param inputSchema the tool's declared JSON schema (may be undefined)
 * @param args the model-supplied arguments
 */
export function coerceToolArguments(
  inputSchema: unknown,
  args: unknown
): ToolArgCoercionOutcome {
  const none: ToolArgCoercionOutcome = { arguments: args, coercions: [] };
  if (!isPlainObject(inputSchema) || !isPlainObject(args)) return none;
  const properties = inputSchema['properties'];
  if (!isPlainObject(properties)) return none;

  let next: Record<string, unknown> | undefined;
  const coercions: ToolArgCoercion[] = [];
  for (const [property, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;
    const node = properties[property];
    const type = declaredCandidateType(node);
    if (type === null) continue;
    const parsed = parseAs(value, type, node as SchemaNode);
    if (parsed === undefined) {
      return {
        arguments: args,
        coercions,
        mismatch: mismatch(property, type, node as SchemaNode),
      };
    }
    next ??= { ...args };
    next[property] = parsed;
    coercions.push({ property, from: 'string', to: type });
  }
  return next ? { arguments: next, coercions } : none;
}
