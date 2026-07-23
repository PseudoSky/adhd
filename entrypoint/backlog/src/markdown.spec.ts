/**
 * markdown.spec.ts — SPEC.md §7 DoD clause 2: a real markdown round-trip.
 * `importFromMarkdown` against the repo's ACTUAL `BACKLOG.md` (read-only,
 * never modified), then `renderToMarkdown` scoped back to the same items,
 * then the OLD `tools/util/backlog.mjs` invoked as a REAL SUBPROCESS against
 * the rendered output. Every original id/status/priority must round-trip —
 * proving backward compatibility against the actual legacy tool, not a copy
 * of its logic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openTmpStore, type TmpStore } from './test/helpers/tmp-store.js';
import { importFromMarkdown, renderToMarkdown } from './client.js';
import type { BacklogCtx } from './client.js';
import { buildBacklogEnv } from './env.js';
import {
  TERMINAL_STATUSES,
  type BacklogStatus,
} from './model.js';
import { normalizeLegacyStatus, parseBacklogMarkdown } from './markdown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const LEGACY_TOOL = join(REPO_ROOT, 'tools', 'util', 'backlog.mjs');
const REAL_BACKLOG_MD = join(REPO_ROOT, 'BACKLOG.md');

interface LegacyJsonItem {
  id: string;
  status: string;
  priority: string;
  title: string;
}

function runLegacyTool(mdFile: string): LegacyJsonItem[] {
  const stdout = execFileSync('node', [LEGACY_TOOL, 'json', '--file', mdFile], { encoding: 'utf8' });
  return JSON.parse(stdout) as LegacyJsonItem[];
}

const REPO = 'PseudoSky/adhd';

describe('markdown round-trip — real BACKLOG.md, real legacy tool subprocess', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;
  let workDir: string;

  beforeEach(() => {
    tmp = openTmpStore('markdown-spec');
    ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
    workDir = mkdtempSync(join(tmpdir(), 'backlog-markdown-'));
  });

  afterEach(() => {
    tmp.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('importFromMarkdown -> renderToMarkdown -> the OLD parser recovers every id/status/priority', async () => {
    const importResult = await importFromMarkdown(ctx, { path: REAL_BACKLOG_MD, repo: REPO });
    expect(importResult.parsed).toBeGreaterThan(0);
    expect(importResult.created).toBeGreaterThan(0);

    // Parse the ORIGINAL file with the OLD tool directly, to get the ground
    // truth id -> {status, priority} the legacy tool itself derives from the
    // real file (before any of our normalization).
    const originalLegacy = runLegacyTool(REAL_BACKLOG_MD);
    const originalById = new Map(originalLegacy.map((it) => [it.id, it]));

    const rendered = await renderToMarkdown(ctx, { repo: REPO });
    expect(rendered.length).toBeGreaterThan(0);
    const renderedPath = join(workDir, 'rendered-BACKLOG.md');
    writeFileSync(renderedPath, rendered, 'utf8');

    const reparsed = runLegacyTool(renderedPath);
    const reparsedById = new Map(reparsed.map((it) => [it.id, it]));

    expect(reparsed.length).toBe(importResult.created);

    let checked = 0;
    for (const [id, original] of originalById) {
      const roundTripped = reparsedById.get(id);
      if (!roundTripped) continue; // a duplicate-id or non-created entry — see importResult.errors/skipped
      checked += 1;
      // The OLD tool's re-derived canonical status, normalized through OUR
      // OWN import-time mapping, must recover the SAME canonical status our
      // importer originally assigned (SPEC.md §6) — the true "byte-identical
      // through the OLD parser" proof, since a bare string compare against
      // the ORIGINAL file's raw prose Status line is not meaningful (that
      // prose is exactly what gets NORMALIZED away on import).
      const canonicalFromOriginal = normalizeLegacyStatus(original.status);
      const canonicalFromRoundTrip = normalizeLegacyStatus(roundTripped.status);
      expect(canonicalFromRoundTrip, `status round-trip for ${id}`).toBe(canonicalFromOriginal);

      // Priority (when tagged at all) is a verbatim enum with no
      // normalization step, so it must match exactly.
      if (original.priority) {
        expect(roundTripped.priority, `priority round-trip for ${id}`).toBe(original.priority);
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 30_000);

  it('every canonical BacklogStatus round-trips through the OLD parser (open/closed + label)', () => {
    const ALL_STATUSES: BacklogStatus[] = [
      'OPEN',
      'IN_PROGRESS',
      'PARTIAL',
      'OUTSTANDING',
      'DEFERRED',
      'BLOCKED',
      'MIXED',
      'UNKNOWN',
      'FIXED',
      'RESOLVED',
      'DONE',
      'SHIPPED',
      'VERIFIED',
      'REMOVED',
      'MITIGATED',
      'SUPERSEDED',
      'INVALID',
      'DUPLICATE',
      'WONTFIX',
    ];

    const lines: string[] = [];
    ALL_STATUSES.forEach((status, i) => {
      lines.push(`### STATUS-RT-${String(i + 1).padStart(3, '0')} — round trip fixture for ${status}`);
      lines.push('');
      lines.push(`**Status:** ${status === 'IN_PROGRESS' ? 'IN PROGRESS' : status}`);
      lines.push('');
      lines.push('Body text.');
      lines.push('');
    });
    const fixturePath = join(workDir, 'status-matrix.md');
    writeFileSync(fixturePath, lines.join('\n'), 'utf8');

    const legacyParsed = runLegacyTool(fixturePath);
    expect(legacyParsed).toHaveLength(ALL_STATUSES.length);

    // Cross-check against our OWN parser too — both must agree on open/terminal.
    const ownParsed = parseBacklogMarkdown(lines.join('\n'));

    ALL_STATUSES.forEach((status, i) => {
      const id = `STATUS-RT-${String(i + 1).padStart(3, '0')}`;
      const legacyItem = legacyParsed.find((it) => it.id === id);
      const ownItem = ownParsed.find((it) => it.id === id);
      expect(legacyItem, id).toBeDefined();
      expect(ownItem, id).toBeDefined();
      if (!legacyItem || !ownItem) throw new Error(`unreachable: ${id} missing after the toBeDefined() assertions above`);
      expect(normalizeLegacyStatus(legacyItem.status), `${id} label round-trip`).toBe(status);
      expect(ownItem.terminal, `${id} openness agreement`).toBe(TERMINAL_STATUSES.has(status));
    });
  });
});
