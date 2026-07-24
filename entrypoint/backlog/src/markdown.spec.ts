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
import { getItem, importFromMarkdown, listItems, renderToMarkdown } from './client.js';
import type { BacklogCtx } from './client.js';
import { buildBacklogEnv } from './env.js';
import {
  TERMINAL_STATUSES,
  type BacklogStatus,
} from './model.js';
import { normalizeLegacyStatus, parseBacklogMarkdown, parseBacklogMarkdownWithDiagnostics } from './markdown.js';

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

describe('parseBacklogMarkdownWithDiagnostics — malformed id headers (DEBT-BACKLOG-IMPORT-SILENT-DROP-001)', () => {
  // The exact negative control from the BACKLOG entry: a valid id header
  // corrupted from hyphens to underscores, which fails `HEADER_RE` but still
  // reads as an attempted id, not a narrative section heading.
  const CORRUPTED_ID = 'DEBT_ENV_CLI_002';
  const fixtureText = [
    '### DEBT-ENV-CLI-001 — first real item',
    '',
    '**Status:** OPEN',
    '',
    'first body.',
    '',
    `### ${CORRUPTED_ID} — corrupted from DEBT-ENV-CLI-002`,
    '',
    '**Status:** OPEN',
    '',
    'second body — must not silently vanish.',
    '',
  ].join('\n');

  it('surfaces the corrupted header in malformedHeaders instead of silently dropping it', () => {
    const { items, malformedHeaders } = parseBacklogMarkdownWithDiagnostics(fixtureText);
    expect(items.map((i) => i.id)).toEqual(['DEBT-ENV-CLI-001']);
    expect(malformedHeaders).toHaveLength(1);
    expect(malformedHeaders[0]?.headerLine).toContain(CORRUPTED_ID);
    expect(malformedHeaders[0]?.line).toBe(7);
  });

  it('never flags real narrative section headings (only id-shaped tokens)', () => {
    const narrativeText = [
      '## Bugs',
      '',
      '### `@adhd/backlog` design (session notes)',
      '',
      '### Leak fixes — RESOLVED 2026-07-02',
      '',
      '### DEBT-REAL-001 — a genuine item',
      '',
      '**Status:** OPEN',
      '',
      'body.',
      '',
    ].join('\n');
    const { items, malformedHeaders } = parseBacklogMarkdownWithDiagnostics(narrativeText);
    expect(items.map((i) => i.id)).toEqual(['DEBT-REAL-001']);
    expect(malformedHeaders).toHaveLength(0);
  });

  it('the legacy parseBacklogMarkdown export still silently drops the corrupted item (proves the diagnostic is genuinely new information)', () => {
    const legacyParsed = parseBacklogMarkdown(fixtureText);
    expect(legacyParsed).toHaveLength(1);
    expect(legacyParsed.map((i) => i.id)).not.toContain(CORRUPTED_ID);
  });
});

describe('importFromMarkdown — diagnostics + provenance (real store)', () => {
  let tmp: TmpStore;
  let ctx: BacklogCtx;
  let workDir: string;
  const REPO_PROV = 'PseudoSky/backlog-provenance-test';

  beforeEach(() => {
    tmp = openTmpStore('markdown-provenance-spec');
    ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
    workDir = mkdtempSync(join(tmpdir(), 'backlog-provenance-'));
  });

  afterEach(() => {
    tmp.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('ImportResult.malformedHeaders surfaces a corrupted id header on a real import (DEBT-BACKLOG-IMPORT-SILENT-DROP-001)', async () => {
    const fixturePath = join(workDir, 'malformed-header.md');
    writeFileSync(
      fixturePath,
      ['### DEBT-ENV-CLI-001 — first real item', '', '**Status:** OPEN', '', 'first body.', '', '### DEBT_ENV_CLI_002 — corrupted', '', 'second body.', ''].join(
        '\n'
      ),
      'utf8'
    );

    const result = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
    expect(result.parsed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.malformedHeaders).toHaveLength(1);
    expect(result.malformedHeaders[0]?.headerLine).toContain('DEBT_ENV_CLI_002');
  });

  it('importFromMarkdown attaches plan + records importedFrom provenance (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001)', async () => {
    const fixturePath = join(workDir, 'provenance-fixture.md');
    writeFileSync(fixturePath, ['### BUG-PROV-001 — provenance fixture', '', '**Status:** OPEN', '', 'body text.', ''].join('\n'), 'utf8');

    const result = await importFromMarkdown(ctx, {
      path: fixturePath,
      repo: REPO_PROV,
      plan: 'my-plan-slug',
      sourcePath: 'docs/plan/my-plan-slug/BACKLOG.md',
    });
    expect(result.created).toBe(1);

    const item = await getItem(ctx, REPO_PROV, 'BUG-PROV-001');
    expect(item?.plan).toBe('my-plan-slug');
    expect(item?.importedFrom).toBe('docs/plan/my-plan-slug/BACKLOG.md');

    // Plan attribution must also be queryable via the filtered-projection
    // scope model (MIGRATION.md §2.2), not just stamped on metadata — this is
    // what makes the previous `attachToPlan`-per-id workaround unnecessary.
    const filtered = await listItems(ctx, { repo: REPO_PROV, plan: 'my-plan-slug' });
    expect(filtered.map((i) => i.humanId)).toContain('BUG-PROV-001');
  });

  it('defaults importedFrom to the source path when sourcePath is omitted', async () => {
    const fixturePath = join(workDir, 'default-provenance-fixture.md');
    writeFileSync(fixturePath, ['### BUG-PROV-002 — default provenance fixture', '', '**Status:** OPEN', '', 'body text.', ''].join('\n'), 'utf8');

    await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
    const item = await getItem(ctx, REPO_PROV, 'BUG-PROV-002');
    expect(item?.importedFrom).toBe(fixturePath);
  });

  // BUG-BACKLOG-IMPORT-INSERT-ONLY-NO-UPDATE-001 — importFromMarkdown used to
  // be pure INSERT-ONLY: re-importing an already-live humanId was a permanent
  // no-op regardless of whether the SOURCE markdown had actually changed
  // since the first import, so a status/body edit made directly in a
  // `BACKLOG.md` file could never converge into the graph short of a full
  // re-seed. These three tests pin the corrected upsert semantics.
  describe('importFromMarkdown — upsert-on-reimport (BUG-BACKLOG-IMPORT-INSERT-ONLY-NO-UPDATE-001)', () => {
    it('re-importing an UNCHANGED item is a true no-op (created:0, updated:0)', async () => {
      const fixturePath = join(workDir, 'noop-fixture.md');
      writeFileSync(fixturePath, ['### BUG-NOOP-001 — noop fixture', '', '**Status:** OPEN', '', 'original body, never touched.', ''].join('\n'), 'utf8');

      const first = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      expect(first.created).toBe(1);
      expect(first.updated).toBe(0);

      // Re-import the byte-identical file — nothing in the graph should move.
      const second = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      expect(second.created).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.skippedDuplicates).toBe(1);

      const item = await getItem(ctx, REPO_PROV, 'BUG-NOOP-001');
      expect(item?.status).toBe('OPEN');
      // `body` is the raw markdown between headers (including the
      // `**Status:**` field line itself) — see `markdown.ts`'s `flush()` —
      // so assert the sentinel substring, not exact equality.
      expect(item?.body).toContain('original body, never touched.');
    });

    it('re-importing a CHANGED item (status + body + priority) updates the LIVE graph node', async () => {
      const fixturePath = join(workDir, 'update-fixture.md');
      writeFileSync(fixturePath, ['### BUG-UPDATE-001 — update fixture', '', '**Status:** OPEN', '', 'original body.', ''].join('\n'), 'utf8');

      const first = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      expect(first.created).toBe(1);
      expect(first.updated).toBe(0);

      // Mutate the SOURCE markdown as if the underlying bug had progressed
      // (e.g. fixed + prioritized) directly in BACKLOG.md since the first
      // import — the exact scenario the bug report describes.
      writeFileSync(
        fixturePath,
        ['### BUG-UPDATE-001 — update fixture', '', '**Status:** FIXED', '', '**Priority:** HIGH', '', 'updated body reflecting the actual fix.', ''].join(
          '\n'
        ),
        'utf8'
      );

      const second = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
      expect(second.skippedDuplicates).toBe(1);

      // Assert through the REAL consumer surfaces, not the internal patch —
      // getItem (point lookup) AND listItems (the query path a consumer
      // actually drives) must both reflect the refreshed graph node.
      const item = await getItem(ctx, REPO_PROV, 'BUG-UPDATE-001');
      expect(item?.status).toBe('FIXED');
      expect(item?.priority).toBe('HIGH');
      expect(item?.body).toContain('updated body reflecting the actual fix.');
      expect(item?.body).not.toContain('original body.');

      const listed = await listItems(ctx, { repo: REPO_PROV });
      const listedItem = listed.find((i) => i.humanId === 'BUG-UPDATE-001');
      expect(listedItem?.status).toBe('FIXED');
      expect(listedItem?.priority).toBe('HIGH');
    });

    it('a THIRD re-import of the now-converged item is a no-op again (upsert settles, does not oscillate)', async () => {
      const fixturePath = join(workDir, 'settle-fixture.md');
      writeFileSync(fixturePath, ['### BUG-SETTLE-001 — settle fixture', '', '**Status:** OPEN', '', 'v1 body.', ''].join('\n'), 'utf8');

      await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      writeFileSync(fixturePath, ['### BUG-SETTLE-001 — settle fixture', '', '**Status:** BLOCKED', '', 'v2 body.', ''].join('\n'), 'utf8');
      const updateRun = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      expect(updateRun.updated).toBe(1);

      // Re-import the SAME v2 content again — must converge to a no-op.
      const settleRun = await importFromMarkdown(ctx, { path: fixturePath, repo: REPO_PROV });
      expect(settleRun.created).toBe(0);
      expect(settleRun.updated).toBe(0);
    });
  });
});
