/**
 * mcp-host.e2e.ts — the C-C claim (QA-STRATEGY.md §1, §2): the MCP server as a
 * HOST loads it.
 *
 * The existing `server.mcp.e2e.ts` proves an MCP mount, but it reaches the
 * library through `test/fixtures/mcp-stdio-entry.js`, which `require()`s the
 * built `dist/index.js` and calls `startBacklogServer(...)` DIRECTLY — it never
 * goes through the CLI `serve` entrypoint `.mcp.json` names. This suite closes
 * that gap: it spawns the UNMODIFIED built server with the documented host
 * command
 *
 *     node entrypoint/backlog/dist/index.js serve --transport mcp
 *
 * and drives it over real stdio JSON-RPC (`initialize` → `tools/list` →
 * `tools/call`) with a real `@modelcontextprotocol/sdk` `Client`. It asserts
 * the consumer-visible payload (`content[0].text` = the flat outcome envelope,
 * ADR-0004) against a REAL store under `tmp/backlog/**`, and proves persistence
 * by REOPENING that store — never by trusting a success envelope.
 *
 * Every assertion trusts the returned payload, never `grep` on stdout.
 *
 * Resource lane: proc — spawns the built server as a real MCP stdio child.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectMcpHost,
  callToolJson,
  DIST_INDEX,
  type IMcpHost,
} from './test/helpers/spawn-mcp-host.js';
import {
  openTestIssueStore,
  seedProject,
} from './test/helpers/open-test-issue-store.js';
import { createIssue } from './write/create-issue.js';
import { getIssue } from './query/get.js';
import type { IIssueCard, IIssueListResult } from './query/types.js';
import type { ICreateIssueResult } from './write/create-issue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const TMP_BACKLOG = join(REPO_ROOT, 'tmp', 'backlog');

interface Case {
  host: IMcpHost;
  root: string;
  dbPath: string;
  projectUid: string;
}

let active: Case | undefined;

async function seedCase(): Promise<Case> {
  mkdirSync(TMP_BACKLOG, { recursive: true });
  const root = mkdtempSync(join(TMP_BACKLOG, 'mcp-host-'));
  const dbPath = join(root, 'mcp-host.db');
  const seedStore = await openTestIssueStore(dbPath);
  const { projectUid } = await seedProject(seedStore, 'mcp-host-project');
  await seedStore.close();
  const host = await connectMcpHost({ root, dbPath });
  const c: Case = { host, root, dbPath, projectUid };
  active = c;
  return c;
}

afterEach(async () => {
  if (active) {
    await active.host.close();
    rmSync(active.root, { recursive: true, force: true });
    active = undefined;
  }
});

describe('MCP host seam — the unmodified built server, driven as .mcp.json drives it', () => {
  it('spawns the documented host command and lists the mounted tools', async () => {
    const c = await seedCase();
    // The exact command is the artifact under test — assert it, do not assume.
    expect(c.host.argv).toEqual([DIST_INDEX, 'serve', '--transport', 'mcp']);
    const tools = (await c.host.client.listTools()).tools.map((t) => t.name).sort();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toEqual(
      expect.arrayContaining([
        'backlog_create',
        'backlog_get',
        'backlog_query',
        'backlog_update',
        'backlog_relate',
      ])
    );
  }, 60_000);

  it('tools/call backlog_query answers with the flat envelope over the REAL store', async () => {
    const c = await seedCase();
    const seedStore = await openTestIssueStore(c.dbPath);
    const seeded = await createIssue(seedStore, {
      project: c.projectUid,
      title: 'seen over mcp host',
      body: 'b',
      by: 'mcp-host-seed',
    });
    await seedStore.close();

    const { envelope, isError } = await callToolJson(c.host.client, 'backlog_query', {
      data: { input: { filter: { project: c.projectUid } } },
    });
    expect(isError).toBeFalsy();
    expect(envelope.ok).toBe(true);
    const data = envelope.data as IIssueListResult;
    expect(data.view).toBe('list');
    expect(data.items.map((i) => i.uid)).toContain(seeded.uid);
    const card = data.items.find((i) => i.uid === seeded.uid) as IIssueCard;
    expect(card.title).toBe('seen over mcp host');
  }, 60_000);

  it('tools/call backlog_create persists — a fresh REOPEN of the store sees it', async () => {
    const c = await seedCase();
    const { envelope, isError } = await callToolJson(c.host.client, 'backlog_create', {
      data: {
        input: {
          title: 'created over mcp host',
          body: 'b',
          project: c.projectUid,
          by: 'mcp-host-client',
        },
      },
    });
    expect(isError).toBeFalsy();
    expect(envelope.ok).toBe(true);
    const created = envelope.data as ICreateIssueResult;
    expect(created.created).toBe(true);
    expect(created.uid).toBeTruthy();

    // Persistence is proven by REOPEN, never by the success envelope.
    const reopened = await openTestIssueStore(c.dbPath);
    try {
      const card = (await getIssue(reopened.graph, {
        uid: created.uid as string,
      })) as IIssueCard;
      expect(card.title).toBe('created over mcp host');
    } finally {
      await reopened.close();
    }
  }, 60_000);

  it('a domain failure over MCP is a typed failure envelope, not a false success', async () => {
    const c = await seedCase();
    const { envelope, isError } = await callToolJson(c.host.client, 'backlog_get', {
      data: { input: { uid: 'definitely-no-such-uid' } },
    });
    expect(isError).toBeFalsy();
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('item_not_found');
  }, 60_000);
});
