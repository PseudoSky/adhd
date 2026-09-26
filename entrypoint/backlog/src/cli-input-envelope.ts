/**
 * cli-input-envelope.ts — turns the natural `--input` envelope mistake into a
 * loud, actionable rejection.
 *
 * `--input` on this CLI takes the BARE params object — what a consumer
 * actually types is `backlog get --input '{"uid":"…"}'` (see `cli.ts`'s
 * `prefixCommand` doc). The MCP surface (`mcp__backlog__*`) uses a different
 * calling convention: params are nested inside an `input`/`data` envelope.
 * Feeding that MCP shape to the CLI previously fell through to the shared
 * validate-Layer's AJV union dump — a message that never names the mistake,
 * points at a JSON path the CLI does not have (`/data/input`), and buries the
 * fix under one `must …` clause per union branch. Worse, the CLI does not
 * accept the shape at all, so the caller got a rejection that read like a
 * field-level typo rather than "you reached for the wrong transport".
 *
 * This module detects exactly that shape and reports what to type instead,
 * with the invoked verb's own synthesized example so the fix is concrete.
 *
 * Scope: this is a REJECTION, never a second accepted shape. The CLI keeps a
 * single input contract; the envelope is never silently unwrapped into it
 * (accepting both would create a second contract to maintain, and would make
 * "which shape did the caller mean?" ambiguous).
 */
import type { ComposedSchemas, Operation } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import {
  synthesizeExample,
  type JsonSchemaLike,
} from '@adhd/apigen-base-logical';

/** The top-level keys whose presence marks the MCP envelope shape. */
export const ENVELOPE_WRAPPER_KEYS = ['input', 'data'] as const;

/** A detected MCP-envelope-shaped `--input`, with everything the message needs. */
export interface ICliInputEnvelopeViolation {
  /** The envelope keys found at the top level of the parsed `--input` value. */
  wrapperKeys: string[];
  /**
   * The exact command a consumer should type, as the CLI's own help renders it
   * (`project(op).cli.path.join(' ')`, e.g. `backlog get`).
   */
  commandLabel: string;
  /**
   * A minimal, schema-derived JSON example of the verb's BARE params, already
   * JSON-encoded (`'{"uid":"<string>"}'`). `undefined` only when the verb's
   * composed schema could not be found (e.g. a synthetic mount command).
   */
  exampleJson: string | undefined;
}

/** The last `--input` value in `argv` (either `--input <v>` or `--input=<v>`), or `undefined`. */
function findInputFlagValue(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--input') {
      const next = argv[i + 1];
      if (next !== undefined) value = next;
    } else if (arg.startsWith('--input=')) {
      value = arg.slice('--input='.length);
    }
  }
  return value;
}

/**
 * Parses `--input`'s raw value into a plain object, or `undefined` when it is
 * not one. Deliberately swallows a JSON syntax error: an unparseable value is
 * a DIFFERENT failure with its own message (`parseArgs` reports the parse
 * error directly), and this guard must not shadow it.
 */
function parseObject(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolves the longest registered command-path prefix of `argv` to its
 * `Operation` — the same longest-prefix walk `apigen-plugin-cli-output`'s
 * `matchCommand` performs, but against the extracted `operations` list so this
 * guard can read the verb's composed schema. Returns `undefined` for an
 * unrecognized command, so an unknown-command invocation keeps its existing
 * `not_found`/exit-4 behavior instead of being reclassified here.
 */
function matchOperation(
  argv: readonly string[],
  operations: readonly Operation[]
): { op: Operation; path: string[] } | undefined {
  let end = 0;
  while (
    end < argv.length &&
    argv[end] !== undefined &&
    !argv[end].startsWith('-')
  )
    end++;
  for (let len = end; len >= 1; len--) {
    const candidate = argv.slice(0, len).join(' ');
    for (const op of operations) {
      const path = project(op).cli.path;
      if (path.join(' ') === candidate) return { op, path };
    }
  }
  return undefined;
}

/** The verb's bare-params schema (`schema.input.properties.data.properties.input`), plus the document root its `$ref`s resolve against. */
function domainSchemaFor(
  op: Operation,
  schemas: ComposedSchemas
): { schema: JsonSchemaLike; root: JsonSchemaLike } | undefined {
  const fnName = op.path[op.path.length - 1]?.raw;
  if (!fnName) return undefined;
  const composed = schemas[fnName];
  if (!composed) return undefined;
  const input = composed.input as JsonSchemaLike;
  const data = input.properties?.['data'] as JsonSchemaLike | undefined;
  const schema = data?.properties?.['input'] as JsonSchemaLike | undefined;
  if (!schema) return undefined;
  return { schema, root: input };
}

/**
 * Detects an `--input` value that carries the MCP envelope shape. `argv` is
 * the FULL, namespace-prefixed argv (what `prefixCommand` produces) so command
 * matching lines up with the operation paths.
 *
 * Returns `undefined` — i.e. no interception — for: a missing `--input`, a
 * non-object value, an unparseable value, a `--help` invocation, an
 * unrecognized command, and a bare object that merely happens to declare a
 * `data`/`input` field the verb's schema actually owns (the check consults the
 * verb's own properties, so a legitimate field of that name is never
 * misflagged).
 */
export function detectCliInputEnvelopeViolation(
  argv: readonly string[],
  operations: readonly Operation[],
  schemas: ComposedSchemas
): ICliInputEnvelopeViolation | undefined {
  // Help short-circuits before dispatch in the cli-output plugin; never
  // reclassify a help invocation as a usage error.
  if (argv.includes('--help') || argv.includes('-h')) return undefined;
  const raw = findInputFlagValue(argv);
  if (raw === undefined) return undefined;
  const parsed = parseObject(raw);
  if (!parsed) return undefined;
  const match = matchOperation(argv, operations);
  if (!match) return undefined;
  const domain = domainSchemaFor(match.op, schemas);
  const domainProps = domain?.schema.properties ?? {};
  const wrapperKeys = ENVELOPE_WRAPPER_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(parsed, key) &&
      !Object.prototype.hasOwnProperty.call(domainProps, key)
  );
  if (wrapperKeys.length === 0) return undefined;
  return {
    wrapperKeys: [...wrapperKeys],
    commandLabel: match.path.join(' '),
    exampleJson: domain
      ? JSON.stringify(synthesizeExample(domain.schema, domain.root))
      : undefined,
  };
}

/**
 * Renders the actionable rejection: names the bare-params contract, shows a
 * concrete correct invocation for the invoked verb, and identifies the
 * envelope as the MCP calling convention. Deliberately a single sentence-run
 * with NO raw AJV output — the guidance must not be buried under a union dump.
 */
export function renderCliInputEnvelopeMessage(
  violation: ICliInputEnvelopeViolation
): string {
  const keys = violation.wrapperKeys.map((key) => `"${key}"`).join(' and ');
  const example = violation.exampleJson ?? '{ …the params… }';
  return (
    `--input expects the CLI's bare params object, but was given the MCP ` +
    `envelope shape (a top-level ${keys} wrapper). The CLI never wraps params ` +
    `in an "input"/"data" object — that envelope is the MCP calling ` +
    `convention (mcp__backlog__*) and does not apply here. ` +
    `Pass the params directly, e.g. ` +
    `${violation.commandLabel} --input '${example}'`
  );
}
