import type { ILayerInput, IPolicyDocument, IPolicyIssue } from '../../spec';

/**
 * BA-5 / ADR-0017 D3: an operation id joins its segments with `/`
 * (`<source>/<tool>`, e.g. `files/read`). Before BA-5 a wrapped MCP tool's id
 * was `<source>.<tool>`, so a policy `tool:` value written then reads
 * `files.read` (or `files.*`).
 *
 * A value is in the old form when it contains a `.` and no `/`: no id rendered
 * with the `/` separator lacks a `/` while carrying a `.` (rendered segment
 * words never contain `.`), and a value that already has a `/` is in the new
 * form even when the tool part itself contains a `.` (`files/read.v2`; with a
 * `canonicalToolId` seam that value is then reported non-canonical, since the
 * apigen tokenizer splits on `.` and renders `files/read-v2`). Only
 * the FIRST `.` was the separator (the old id was `${source}.${tool}`), so only
 * it is replaced: `fs.read.file` becomes `fs/read.file`. A trailing `*` is kept
 * (`files.*` becomes `files/*`). A `.` at either end of the value is not a
 * separator (no old id had an empty source or tool), so such a value is left
 * alone.
 *
 * Only `tool:` values are ever examined: dotted attribute and context paths
 * (`child.read_roots`, `runtime.calls`) are field paths, not operation ids.
 *
 * @param tool - One `tool:` value of a policy permission.
 * @returns The `/` form when `tool` uses the old `.` separator, else `undefined`.
 */
export function toolIdForOldSeparator(tool: string): string | undefined {
  if (tool.includes('/')) return undefined;
  const dot = tool.indexOf('.');
  if (dot <= 0 || dot === tool.length - 1) return undefined;
  return `${tool.slice(0, dot)}/${tool.slice(dot + 1)}`;
}

/**
 * Renders an operation id in canonical form (ADR-0017 D3: every segment
 * tokenized, words joined by `-`, segments by `/`, so `fs/read_file` is
 * `fs/read-file`). Injected by the host (apigen-core-client's
 * `canonicalOperationId`); this package never depends on apigen and never
 * copies its tokenizer. Must be idempotent and keep `*` segments verbatim.
 */
export type CanonicalToolId = (id: string) => string;

/** The optional canonical-id seam accepted by `compile`, `loadCompiled`, `draftPolicy` and `normalizeToolId`. */
export interface IToolIdOptions {
  /**
   * When set, every `tool:` value must be a canonical operation id: an old
   * `.`-form value is reported naming `canonicalToolId(<the / form>)`, and a
   * `/` value that differs from `canonicalToolId(value)` is reported naming the
   * canonical id. When absent, only the `.` separator is checked.
   */
  readonly canonicalToolId?: CanonicalToolId;
}

/**
 * The `/` form of a `tool:` value: the value itself when it already is one,
 * else its old-separator rewrite ({@link toolIdForOldSeparator}). With
 * `canonicalToolId`, a value containing `/` (as written or after the separator
 * rewrite) is also rendered canonical (`fs.read_file` and `fs/read_file` both
 * become `fs/read-file`); a value with no `/` (`*`, `bash`) is never changed.
 *
 * @param tool            - One `tool:` value (or an operation id) in either form.
 * @param canonicalToolId - Optional canonical-id renderer (see {@link IToolIdOptions}).
 */
export function normalizeToolId(tool: string, canonicalToolId?: CanonicalToolId): string {
  const slashed = toolIdForOldSeparator(tool) ?? tool;
  if (canonicalToolId === undefined || !slashed.includes('/')) return slashed;
  return canonicalToolId(slashed);
}

/** The loader message for an old-separator `tool:` value. */
export function oldSeparatorMessage(tool: string, replacement: string): string {
  return `tool "${tool}" uses the old separator; use "${replacement}"`;
}

/** The loader message for a `/` `tool:` value that is not in canonical form. */
export function nonCanonicalMessage(tool: string, canonical: string): string {
  return `tool "${tool}" is not a canonical operation id; use "${canonical}"`;
}

/**
 * The problem with one `tool:` value, or `undefined` when it is acceptable.
 * `old-separator` names the replacement (canonical when `canonicalToolId` is
 * set); `non-canonical` is reported only with `canonicalToolId`, for a value
 * that contains `/` and differs from its canonical form.
 */
export function toolIdProblem(
  tool: string,
  canonicalToolId?: CanonicalToolId
): { readonly kind: 'old-separator' | 'non-canonical'; readonly replacement: string; readonly message: string } | undefined {
  const separated = toolIdForOldSeparator(tool);
  if (separated !== undefined) {
    const replacement = canonicalToolId === undefined ? separated : canonicalToolId(separated);
    return { kind: 'old-separator', replacement, message: oldSeparatorMessage(tool, replacement) };
  }
  if (canonicalToolId === undefined || !tool.includes('/')) return undefined;
  const canonical = canonicalToolId(tool);
  if (canonical === tool) return undefined;
  return { kind: 'non-canonical', replacement: canonical, message: nonCanonicalMessage(tool, canonical) };
}

/**
 * Reports every permission `tool:` value written with the old `.` separator
 * (and, with `canonicalToolId`, every `/` value not in canonical form) as a
 * `schema` issue at `/<layer>/permissions/<n>/tool` (`.../tool/<i>` for a list
 * entry) whose message names the id to use ({@link toolIdProblem}). Every
 * offending value is reported (D-05); nothing is rewritten here.
 */
export function checkToolIds(
  ordered: readonly ILayerInput[],
  documents: readonly IPolicyDocument[],
  canonicalToolId?: CanonicalToolId
): readonly IPolicyIssue[] {
  const issues: IPolicyIssue[] = [];
  ordered.forEach((layer, li) => {
    documents[li].permissions.forEach((permission, n) => {
      const values = typeof permission.tool === 'string' ? [permission.tool] : permission.tool;
      values.forEach((tool, i) => {
        const problem = toolIdProblem(tool, canonicalToolId);
        if (problem === undefined) return;
        const at = typeof permission.tool === 'string' ? '' : `/${i}`;
        issues.push({
          code: 'schema',
          layer: layer.name,
          path: `/${layer.name}/permissions/${n}/tool${at}`,
          message: `${layer.source}: ${problem.message} (\`adhd-policy migrate <file>\` rewrites the file)`,
        });
      });
    });
  });
  return issues;
}
