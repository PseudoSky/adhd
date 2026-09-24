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
 * syntax error (reserved word), so the implementation is named `remove` and
 * the module does `export { remove as delete }`. That alias is the ONLY
 * reason the verb mounts under its spec'd name. "Simplifying" it to
 * `export async function remove` compiles cleanly and renames the tool to
 * `backlog_remove` on all four transports at once — which is exactly the
 * negative control below: change the alias and this file goes red.
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
 * registry CRUD verbs, and the three §5 stats/rollup reads
 * (`priority-matrix`/`part-of-rollup`/`open-curve`) — with the exact MCP tool
 * name and CLI command each must project to. Written out longhand rather than
 * derived, because a derived expectation would track whatever the code does
 * and assert nothing.
 */
const EXPECTED = [
  { id: 'backlog/get', mcp: 'backlog_get', cli: 'backlog get' },
  { id: 'backlog/query', mcp: 'backlog_query', cli: 'backlog query' },
  { id: 'backlog/lookup', mcp: 'backlog_lookup', cli: 'backlog lookup' },
  { id: 'backlog/create', mcp: 'backlog_create', cli: 'backlog create' },
  { id: 'backlog/update', mcp: 'backlog_update', cli: 'backlog update' },
  {
    id: 'backlog/transition',
    mcp: 'backlog_transition',
    cli: 'backlog transition',
  },
  { id: 'backlog/claim', mcp: 'backlog_claim', cli: 'backlog claim' },
  { id: 'backlog/relate', mcp: 'backlog_relate', cli: 'backlog relate' },
  { id: 'backlog/move', mcp: 'backlog_move', cli: 'backlog move' },
  { id: 'backlog/delete', mcp: 'backlog_delete', cli: 'backlog delete' },
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
] as const;

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

  it('mounts exactly the verbs SPEC §6.7 names, under the names it names', async () => {
    const surface = await mountedSurface();
    const expected = [...EXPECTED].sort((a, b) => a.id.localeCompare(b.id));
    expect(surface).toEqual(
      expected.map((e) => ({ id: e.id, mcp: e.mcp, cli: e.cli }))
    );
  });

  it("mounts `delete` under its spec'd name — the export alias is load-bearing", async () => {
    const surface = await mountedSurface();
    const names = surface.map((s) => s.mcp);
    expect(names).toContain('backlog_delete');
    // The precise failure a refactor to `export async function remove` causes.
    expect(names).not.toContain('backlog_remove');
  });

  it('mounts no verb twice and no verb outside the list', async () => {
    const surface = await mountedSurface();
    expect(new Set(surface.map((s) => s.id)).size).toBe(surface.length);
    expect(surface).toHaveLength(EXPECTED.length);
  });
});
