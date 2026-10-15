import { isAbsolute, resolve } from 'node:path';
import { ApiError } from '@adhd/apigen-base-errors';
import { toolIdForOldSeparator } from '@adhd/policy-core-client';
import yaml from 'yaml';
import { nodeMcpJsonFs, type IMcpJsonFs } from '../mcp-json/io';
import type { IVerbDeps } from './deps';

/** One `tool:` value rewritten from the pre-BA-5 `.` separator to `/`. */
export interface IToolIdChange {
  /** 1-based line of the value in the original text. */
  readonly line: number;
  readonly from: string;
  readonly to: string;
}

/** The YAML 1.x scalar node fields this module reads. */
interface IYamlScalarLike {
  readonly type?: string;
  readonly value?: unknown;
  readonly range?: readonly [number, number] | null;
}

/** The source text a scalar of `type` holding `value` starts with, when it is written without escapes. */
function literalOf(type: string | undefined, value: string): string | undefined {
  switch (type) {
    case 'PLAIN':
      return value;
    case 'QUOTE_SINGLE':
      return `'${value.replace(/'/g, "''")}'`;
    case 'QUOTE_DOUBLE':
      return JSON.stringify(value);
    default:
      return undefined;
  }
}

/** Every scalar under a permission's `tool:` key (a single value or each entry of a list). */
function toolScalars(document: yaml.Document.Parsed): IYamlScalarLike[] {
  const permissions = document.get('permissions', true) as { items?: unknown[] } | undefined;
  const out: IYamlScalarLike[] = [];
  for (const item of permissions?.items ?? []) {
    const tool = (item as { get?: (key: string, keepNode: boolean) => unknown }).get?.('tool', true) as
      | (IYamlScalarLike & { items?: unknown[] })
      | undefined;
    if (tool === undefined || tool === null) continue;
    for (const node of Array.isArray(tool.items) ? tool.items : [tool]) {
      if (node !== null && typeof node === 'object' && typeof (node as IYamlScalarLike).value === 'string') {
        out.push(node as IYamlScalarLike);
      }
    }
  }
  return out;
}

/**
 * BA-5: rewrites every permission `tool:` value written with the pre-BA-5 `.`
 * separator (`files.read`) to its `/` id (`files/read`), using the same rule
 * the loader rejects them by (`toolIdForOldSeparator`). Only `tool:` values are
 * touched; attribute and context paths (`child.read_roots`, `runtime.calls`)
 * and every other byte of the file (comments, quoting, flow maps) are kept: the
 * new value is spliced into the original text at the scalar's offset, with the
 * scalar's own quoting. Throws `ApiError('invalid_argument')` when the text is
 * not YAML or a value to rewrite is written in a form that cannot be spliced
 * safely (an escape sequence or a block scalar), and `ApiError('internal')`
 * when the rewritten text does not re-parse to the expected values (nothing is
 * then written by the caller).
 *
 * @param text   - The policy file's text.
 * @param source - Label for messages (the file path).
 * @returns The rewritten text and one entry per change, in file order.
 */
export function migrateToolIds(text: string, source: string): { text: string; changes: IToolIdChange[] } {
  const document = yaml.parseDocument(text);
  const first = document.errors[0];
  if (first !== undefined) {
    throw new ApiError('invalid_argument', `${source}: not a YAML policy file: ${first.message.split('\n')[0]}`);
  }
  const edits: { start: number; end: number; replacement: string; change: IToolIdChange }[] = [];
  for (const node of toolScalars(document)) {
    const from = node.value as string;
    const to = toolIdForOldSeparator(from);
    if (to === undefined) continue;
    const start = node.range?.[0];
    const literal = literalOf(node.type, from);
    if (start === undefined || literal === undefined || text.slice(start, start + literal.length) !== literal) {
      throw new ApiError(
        'invalid_argument',
        `${source}: tool "${from}" is written in a form that cannot be rewritten in place; change it to "${to}" by hand`
      );
    }
    const line = text.slice(0, start).split('\n').length;
    const replacement = literalOf(node.type, to) as string;
    edits.push({ start, end: start + literal.length, replacement, change: { line, from, to } });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = text;
  for (const edit of [...edits].reverse()) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);

  const expected = toolScalars(document).map((node) => {
    const value = node.value as string;
    return toolIdForOldSeparator(value) ?? value;
  });
  const reparsed = yaml.parseDocument(out);
  const actual = reparsed.errors.length === 0 ? toolScalars(reparsed).map((node) => node.value as string) : undefined;
  if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ApiError('internal', `${source}: the rewritten policy does not read back as expected; the file was not changed`);
  }
  return { text: out, changes: edits.map((edit) => edit.change) };
}

/**
 * `migrate <file>...` rewrites, in place, every permission `tool:` value of each
 * policy file that uses the pre-BA-5 `.` separator to its `/` id, and prints one
 * stdout line per change: `<file>:<line>: tool "files.read" -> "files/read"`. A
 * file with nothing to change is reported on stderr and left untouched. Relative
 * paths resolve against the working directory. Files are written atomically
 * (temporary file + rename) and keep their permission bits. Exit 0 on success;
 * no file, an unknown flag, or a file that is not YAML is `invalid_argument`
 * (2); a missing file is `not_found` (4). Files are processed in order and a
 * failure stops before the next file.
 *
 * @param argv - Arguments after the verb name.
 * @param deps - Verb ports (`cwd`, `stdout`, `stderr`).
 * @param fs   - File port (read and atomic write); the real filesystem by default.
 * @returns The exit code.
 */
export async function migrateVerb(
  argv: readonly string[],
  deps: Pick<IVerbDeps, 'cwd' | 'stdout' | 'stderr'>,
  fs: IMcpJsonFs = nodeMcpJsonFs
): Promise<number> {
  const files: string[] = [];
  for (const token of argv) {
    if (token === '--') continue;
    if (token.startsWith('--')) throw new ApiError('invalid_argument', `unknown argument ${token}`);
    files.push(token);
  }
  if (files.length === 0) {
    throw new ApiError('invalid_argument', 'migrate needs at least one policy file: adhd-policy migrate <file>...');
  }
  for (const file of files) {
    const path = isAbsolute(file) ? file : resolve(deps.cwd, file);
    const text = await fs.read(path);
    if (text === undefined) throw new ApiError('not_found', `${file}: no such file`);
    const { text: rewritten, changes } = migrateToolIds(text, file);
    if (changes.length === 0) {
      deps.stderr(`${file}: no tool values use the old separator\n`);
      continue;
    }
    await fs.write(path, rewritten);
    for (const change of changes) deps.stdout(`${file}:${change.line}: tool "${change.from}" -> "${change.to}"\n`);
  }
  return 0;
}
