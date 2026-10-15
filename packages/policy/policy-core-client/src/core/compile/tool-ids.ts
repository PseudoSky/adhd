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
 * form even when the tool part itself contains a `.` (`files/read.v2`). Only
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
 * The `/` form of a `tool:` value: the value itself when it already is one,
 * else its old-separator rewrite ({@link toolIdForOldSeparator}).
 *
 * @param tool - One `tool:` value (or an operation id) in either form.
 */
export function normalizeToolId(tool: string): string {
  return toolIdForOldSeparator(tool) ?? tool;
}

/** The loader message for an old-separator `tool:` value. */
export function oldSeparatorMessage(tool: string, replacement: string): string {
  return `tool "${tool}" uses the old separator; use "${replacement}"`;
}

/**
 * Reports every permission `tool:` value written with the old `.` separator as a
 * `schema` issue at `/<layer>/permissions/<n>/tool` (`.../tool/<i>` for a list
 * entry) whose message names the `/` id. Every offending value is reported
 * (D-05); nothing is rewritten here.
 */
export function checkToolIds(
  ordered: readonly ILayerInput[],
  documents: readonly IPolicyDocument[]
): readonly IPolicyIssue[] {
  const issues: IPolicyIssue[] = [];
  ordered.forEach((layer, li) => {
    documents[li].permissions.forEach((permission, n) => {
      const values = typeof permission.tool === 'string' ? [permission.tool] : permission.tool;
      values.forEach((tool, i) => {
        const replacement = toolIdForOldSeparator(tool);
        if (replacement === undefined) return;
        const at = typeof permission.tool === 'string' ? '' : `/${i}`;
        issues.push({
          code: 'schema',
          layer: layer.name,
          path: `/${layer.name}/permissions/${n}/tool${at}`,
          message: `${layer.source}: ${oldSeparatorMessage(tool, replacement)} (\`adhd-policy migrate <file>\` rewrites the file)`,
        });
      });
    });
  });
  return issues;
}
