/**
 * extract-live-store.ts (DRY-RUN scratch script — never committed) —
 * dumps every `node`/`edge` row from a READ-ONLY copy of the production
 * store into `corpus.jsonl`/`edges.jsonl`, in exactly the shape
 * `tools/etl/corpus-types.ts`'s `IRawNodeRow`/`IRawEdgeRow` (with `_extract`)
 * expects, so `tools/etl/run-etl.ts`'s `loadCorpus()` can consume it.
 *
 * Read-only: opens `sourceDbPath` with `readonly: true` and never calls any
 * write verb. Reproduces `INodeExtract`/`IEdgeExtract` derivation rules
 * confirmed against the frozen fixtures in `tools/etl/fixtures/*\/corpus.jsonl`:
 *   - state: t_invalid IS NOT NULL -> 'invalidated', else 'live'
 *   - invalidated_reason / invalidated_at_meta: from parsed meta, else null
 *   - tags_parsed: JSON.parse(tags) or []
 *   - meta_parsed: JSON.parse(meta), or {__unparseable__:true,raw} on parse
 *     failure, or null when meta is null
 *   - is_backlog_item / is_backlog_audit_event / is_backlog_plan: tag
 *     membership ('backlog-item' / 'backlog-audit-event' / 'backlog-plan')
 *
 * Usage: npx tsx tools/etl/tmp/extract-live-store.ts <sourceDbPath> <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStoreAdapter } from '@adhd/sox-store-adapter';

function safeParseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable__: true, raw };
  }
}

function tagsOf(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const [sourceDbPath, outDir] = process.argv.slice(2);
  if (!sourceDbPath || !outDir) {
    process.stderr.write('usage: extract-live-store.ts <sourceDbPath> <outDir>\n');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });

  const adapter = await createStoreAdapter({ dbPath: sourceDbPath, readonly: true });
  try {
    const nodeCountRow = await adapter.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM node');
    const edgeCountRow = await adapter.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM edge');
    process.stderr.write(`extract: source node count=${nodeCountRow?.n}, edge count=${edgeCountRow?.n}\n`);

    const nodeCols = [
      'rowid', 'uid', 'kind', 'content', 'name', 'summary', 'topic', 'tags',
      'importance', 'confidence', 'content_hash', 'namespace', 'meta',
      'agent_id', 'session_id', 'source', 'project_path', 'level',
      'resume_state', 't_occurred', 't_expires', 't_created', 't_valid',
      't_invalid', 'is_superseded', 'access_count', 'last_access', 't_updated',
    ];
    const { rows: nodeRows } = await adapter.executeAll<Record<string, unknown>>(
      `SELECT ${nodeCols.join(', ')} FROM node ORDER BY rowid ASC`,
    );

    const nodeOut = nodeRows.map((row) => {
      const tagsParsed = tagsOf(row.tags as string | null);
      const metaParsed = safeParseJson(row.meta as string | null);
      const metaObj = metaParsed && typeof metaParsed === 'object' && !Array.isArray(metaParsed) && !('__unparseable__' in (metaParsed as object))
        ? (metaParsed as Record<string, unknown>)
        : {};
      const state = row.t_invalid !== null ? 'invalidated' : 'live';
      return {
        ...row,
        _extract: {
          state,
          invalidated_reason: (metaObj.invalidatedReason as string | undefined) ?? null,
          invalidated_at_meta: (metaObj.invalidatedAt as string | undefined) ?? null,
          tags_parsed: tagsParsed,
          meta_parsed: metaParsed,
          is_backlog_item: tagsParsed.includes('backlog-item'),
          is_backlog_audit_event: tagsParsed.includes('backlog-audit-event'),
          is_backlog_plan: tagsParsed.includes('backlog-plan'),
        },
      };
    });

    const edgeCols = [
      'rowid', 'src', 'dst', 'rel', 'weight', 'confidence', 'origin', 'meta',
      't_created', 't_expired', 't_valid', 't_invalid',
    ];
    const { rows: edgeRows } = await adapter.executeAll<Record<string, unknown>>(
      `SELECT ${edgeCols.join(', ')} FROM edge ORDER BY rowid ASC`,
    );
    const edgeOut = edgeRows.map((row) => {
      const metaParsed = safeParseJson(row.meta as string | null);
      const state = row.t_invalid !== null ? 'invalidated' : 'live';
      return { ...row, _extract: { state, meta_parsed: metaParsed } };
    });

    writeFileSync(join(outDir, 'corpus.jsonl'), nodeOut.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(outDir, 'edges.jsonl'), edgeOut.map((r) => JSON.stringify(r)).join('\n') + '\n');

    process.stderr.write(`extract: wrote ${nodeOut.length} node rows, ${edgeOut.length} edge rows to ${outDir}\n`);
  } finally {
    await adapter.close();
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(2);
});
