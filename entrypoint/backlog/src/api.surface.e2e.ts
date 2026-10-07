/**
 * api.surface.e2e.ts — the mounted surface is exactly SPEC §6.7's verb list.
 *
 * Drives the REAL extractor (`@adhd/apigen-core-client`'s `extract`) over the
 * REAL built `dist/api.d.ts` and the REAL projector
 * (`@adhd/apigen-engine-naming`'s `project`) — the same two functions
 * `server.ts` mounts through, no mocks, no re-implementation of the naming
 * rules. `project.json`'s `test` target `dependsOn: ["^build","build","assets"]`,
 * so `dist/` is built before this runs.
 *
 * **Why this asserts names and not shapes.** A test that checked "api.ts
 * exports ten functions" would pass while the mounted TOOL names were all
 * wrong, and tool names are the consumer seam: a host loads `mcp__backlog__*`
 * by name, and an agent's whole vocabulary for this package is that list.
 * The failure this file exists to catch is a rename that compiles, tests
 * green, and silently breaks every caller.
 *
 * **The load-bearing row is `delete`.** `export async function delete` is a
 * syntax error (reserved word), so the implementation is named `softDelete`
 * and the module does `export { softDelete as delete }`. That alias is the
 * ONLY reason the verb mounts under its spec'd name. "Simplifying" it to
 * `export async function delete` will not compile, and mis-aliasing it renames
 * the tool on all four transports at once — which is exactly the negative
 * control below: break the alias and this file goes red. `remove`/`restore`
 * (S02 AC14) are DISTINCT lifecycle verbs mounted alongside `delete`.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { extract } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';

const API_DTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'api.d.ts'
);

/**
 * SPEC §6.7's mounted surface — the nine issue verbs, §3a's `lookup` and
 * registry CRUD verbs, the three §5 stats/rollup reads
 * (`priority-matrix`/`part-of-rollup`/`open-curve`), and the
 * `embedding-status` health read — with the exact MCP tool name and CLI
 * command each must project to. Written out longhand rather than derived,
 * because a derived expectation would track whatever the code does and assert
 * nothing.
 */
const EXPECTED = [
  { id: 'backlog/get', mcp: 'backlog_get', cli: 'backlog get' },
  { id: 'backlog/query', mcp: 'backlog_query', cli: 'backlog query' },
  { id: 'backlog/lookup', mcp: 'backlog_lookup', cli: 'backlog lookup' },
  { id: 'backlog/create', mcp: 'backlog_create', cli: 'backlog create' },
  { id: 'backlog/update', mcp: 'backlog_update', cli: 'backlog update' },
  {
    id: 'backlog/add-citation',
    mcp: 'backlog_add_citation',
    cli: 'backlog add-citation',
  },
  {
    id: 'backlog/remove-citation',
    mcp: 'backlog_remove_citation',
    cli: 'backlog remove-citation',
  },
  {
    id: 'backlog/transition',
    mcp: 'backlog_transition',
    cli: 'backlog transition',
  },
  { id: 'backlog/attest', mcp: 'backlog_attest', cli: 'backlog attest' },
  { id: 'backlog/recheck', mcp: 'backlog_recheck', cli: 'backlog recheck' },
  {
    id: 'backlog/obligate',
    mcp: 'backlog_obligate',
    cli: 'backlog obligate',
  },
  {
    id: 'backlog/unobligate',
    mcp: 'backlog_unobligate',
    cli: 'backlog unobligate',
  },
  {
    id: 'backlog/spec-append',
    mcp: 'backlog_spec_append',
    cli: 'backlog spec-append',
  },
  {
    id: 'backlog/spec-check',
    mcp: 'backlog_spec_check',
    cli: 'backlog spec-check',
  },
  { id: 'backlog/timeline', mcp: 'backlog_timeline', cli: 'backlog timeline' },
  { id: 'backlog/claim', mcp: 'backlog_claim', cli: 'backlog claim' },
  { id: 'backlog/relate', mcp: 'backlog_relate', cli: 'backlog relate' },
  { id: 'backlog/move', mcp: 'backlog_move', cli: 'backlog move' },
  { id: 'backlog/delete', mcp: 'backlog_delete', cli: 'backlog delete' },
  // S02 AC14 / cluster backlog-lifecycle-model 0b0df8f3 — the item lifecycle.
  { id: 'backlog/remove', mcp: 'backlog_remove', cli: 'backlog remove' },
  { id: 'backlog/restore', mcp: 'backlog_restore', cli: 'backlog restore' },
  {
    id: 'backlog/upsert-project',
    mcp: 'backlog_upsert_project',
    cli: 'backlog upsert-project',
  },
  {
    id: 'backlog/upsert-component',
    mcp: 'backlog_upsert_component',
    cli: 'backlog upsert-component',
  },
  {
    id: 'backlog/upsert-location',
    mcp: 'backlog_upsert_location',
    cli: 'backlog upsert-location',
  },
  {
    id: 'backlog/rm-location',
    mcp: 'backlog_rm_location',
    cli: 'backlog rm-location',
  },
  {
    id: 'backlog/merge-project',
    mcp: 'backlog_merge_project',
    cli: 'backlog merge-project',
  },
  {
    id: 'backlog/rm-project',
    mcp: 'backlog_rm_project',
    cli: 'backlog rm-project',
  },
  {
    id: 'backlog/priority-matrix',
    mcp: 'backlog_priority_matrix',
    cli: 'backlog priority-matrix',
  },
  {
    id: 'backlog/part-of-rollup',
    mcp: 'backlog_part_of_rollup',
    cli: 'backlog part-of-rollup',
  },
  {
    id: 'backlog/open-curve',
    mcp: 'backlog_open_curve',
    cli: 'backlog open-curve',
  },
  {
    id: 'backlog/report',
    mcp: 'backlog_report',
    cli: 'backlog report',
  },
  {
    id: 'backlog/embedding-status',
    mcp: 'backlog_embedding_status',
    cli: 'backlog embedding-status',
  },
] as const;

/**
 * `mountedSurface()` runs the REAL ts-json-schema-generator extraction over
 * `dist/api.d.ts` — a cold extraction measured at 20–100s depending on host
 * load (observed 19s idle → 70s+ under a loaded box). The suite's inherited
 * 30s default (`vite.config.ts`, the cluster-48 test-harness defect that e2e
 * inherits) sits below that, so these tests carry an explicit, realistic bound
 * rather than flaking red. The ASSERTION is unchanged; only the clock is.
 */
const EXTRACT_TIMEOUT_MS = 180_000;

async function mountedSurface(): Promise<
  { id: string; mcp: string; cli: string }[]
> {
  const ops = await extract({
    sourceFile: API_DTS,
    namespace: 'backlog',
    dropFileSegment: true,
  });
  return ops
    .filter((op) => op.kind === 'action')
    .map((op) => {
      const proj = project(op);
      return { id: op.id, mcp: proj.mcp.name, cli: proj.cli.path.join(' ') };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('api.ts — the mounted surface (SPEC §6.7)', () => {
  it('has a built api.d.ts to extract from', () => {
    // Fails loudly rather than skipping: an absent .d.ts means the mount
    // itself would throw at startup, which is the bug, not a reason to pass.
    expect(
      existsSync(API_DTS),
      `${API_DTS} missing — nx build backlog must run first`
    ).toBe(true);
  });

  it('mounts exactly the verbs SPEC §6.7 names, under the names it names', { timeout: EXTRACT_TIMEOUT_MS }, async () => {
    const surface = await mountedSurface();
    const expected = [...EXPECTED].sort((a, b) => a.id.localeCompare(b.id));
    expect(surface).toEqual(
      expected.map((e) => ({ id: e.id, mcp: e.mcp, cli: e.cli }))
    );
  });

  it("mounts `delete` under its spec'd name — the export alias is load-bearing", { timeout: EXTRACT_TIMEOUT_MS }, async () => {
    const surface = await mountedSurface();
    const names = surface.map((s) => s.mcp);
    // The alias `export { softDelete as delete }` is the ONLY reason `delete`
    // mounts under its spec'd (reserved-word) name. `remove` is now a DISTINCT
    // verb (S02 AC14 permanent retire), so both must be present and separate —
    // deleting the alias (or collapsing the two) turns this red.
    expect(names).toContain('backlog_delete');
    expect(names).toContain('backlog_remove');
    expect(
      surface.find((s) => s.cli === 'backlog delete')?.id
    ).toBe('backlog/delete');
    expect(
      surface.find((s) => s.cli === 'backlog remove')?.id
    ).toBe('backlog/remove');
  });

  it('mounts no verb twice and no verb outside the list', { timeout: EXTRACT_TIMEOUT_MS }, async () => {
    const surface = await mountedSurface();
    expect(new Set(surface.map((s) => s.id)).size).toBe(surface.length);
    expect(surface).toHaveLength(EXPECTED.length);
  });

  /**
   * NEGATIVE CONTROL (teeth) — the retired `annotate` verb is gone from the
   * mounted surface on BOTH consumer seams (the MCP tool name and the CLI
   * command). Re-adding the `api.ts` export (or its `EXPECTED` row) turns the
   * exact-equality case above RED; this case states the retirement directly so
   * the intent is legible rather than implied by a list diff. The capability it
   * used to expose — commenting on a spec revision — is retained through
   * `attest` with a `SPEC` subject + a `revision:` anchor, and is proven
   * behaviorally in `write/spec-revision.spec.ts`.
   */
  it('does NOT mount the retired `annotate` verb (negative control)', { timeout: EXTRACT_TIMEOUT_MS }, async () => {
    const surface = await mountedSurface();
    expect(surface.map((s) => s.id)).not.toContain('backlog/annotate');
    expect(surface.map((s) => s.mcp)).not.toContain('backlog_annotate');
    expect(surface.map((s) => s.cli)).not.toContain('backlog annotate');
  });
});
