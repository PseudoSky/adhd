/**
 * cli-input-envelope.spec.ts — the `--input` envelope guard at the real
 * consumer seam.
 *
 * Every assertion spawns the REAL BUILT `dist/index.js` as a child process
 * (`src/test/helpers/spawn-isolated-bin.ts`; never an in-process import, which
 * would bypass the mount where the guard lives), against a throwaway
 * `ADHD_BACKLOG_DATABASE_PATH` — never the machine's real backlog graph.
 *
 * The defect: `--input` on this CLI takes the BARE params object
 * (`backlog get --input '{"uid":"…"}'`), while the MCP surface nests params
 * inside an `input`/`data` envelope. Reaching for the MCP shape on the CLI
 * used to fall through to the shared validate-Layer's AJV union dump — a
 * message that never named the mistake, pointed at `/data/input` (a path this
 * CLI has no such wrapper for), and buried the fix under one `must …` clause
 * per union branch. The guard replaces that dump with an actionable rejection
 * naming the bare-params contract, the invoked verb, and the MCP convention.
 *
 * RED-before-green: the "guidance present" assertions fail on unmodified code
 * (no such text exists there), and the "no raw dump" assertions fail too (the
 * AJV dump IS the old output). Both are re-proven by the negative control
 * recorded in the work report (guard reverted → these go red).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let tmpRoot: string;
let dbPath: string;
let seededIssueUid: string;

/** Spawns the REAL built bin. Never imported — an import would skip the mount. */
function runBin(args: string[]): Run {
  return runIsolatedBin(DIST_INDEX, args, tmpRoot, {
    // The ONLY var that redirects the store. `BACKLOG_DB_PATH` is NOT honored
    // — using it silently writes to the real global graph.
    extraEnv: { ADHD_BACKLOG_DATABASE_PATH: dbPath },
  });
}

/** Both streams, joined — the guard and the AJV dump both write to stderr. */
function combined(run: Run): string {
  return `${run.stdout}\n${run.stderr}`;
}

/** The last line on a stream that parses as a JSON object, or `undefined`. */
function lastJsonObject(stream: string): Record<string, unknown> | undefined {
  const lines = stream.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // a non-JSON log line — keep scanning upward
    }
  }
  return undefined;
}

/** The failure/success envelope the CLI emitted, from whichever stream carried it. */
function envelope(run: Run): Record<string, unknown> | undefined {
  return lastJsonObject(run.stdout) ?? lastJsonObject(run.stderr);
}

/**
 * The decoded `error.message` of the emitted failure envelope. The example is
 * JSON-embedded (so its quotes are escaped on the wire); assertions about the
 * concrete example read the DECODED message, exactly as a JSON-parsing
 * consumer would.
 */
function errorMessage(run: Run): string {
  const err = envelope(run)?.['error'] as Record<string, unknown> | undefined;
  return typeof err?.['message'] === 'string'
    ? (err['message'] as string)
    : combined(run);
}

// The old raw path's own unmistakable markers. If the guard is ever removed
// these reappear verbatim, so asserting their ABSENCE has teeth.
const RAW_DUMP_PREFIX = 'Validation failed:';
const RAW_UNION_MARKER = 'must match exactly one schema in oneOf';
// The actionable guidance's stable phrases.
const BARE_CONTRACT_PHRASE = 'bare params object';
const MCP_PHRASE = 'MCP calling convention';
const CLI_NEVER_WRAPS_PHRASE = 'The CLI never wraps params';

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-input-envelope-'));
  dbPath = join(tmpRoot, 'input-envelope.db');

  const project = envelope(
    runBin([
      'upsert-project',
      '--input',
      JSON.stringify({ name: 'input-envelope-project', by: 'cli-envelope:1' }),
    ])
  );
  expect(project?.['ok'], 'seed upsert-project failed').toBe(true);
  const projectUid = (project?.['data'] as Record<string, unknown> | undefined)?.[
    'uid'
  ] as string;

  const issue = envelope(
    runBin([
      'create',
      '--input',
      JSON.stringify({
        title: 'input envelope seam item',
        body: 'b',
        project: projectUid,
        by: 'cli-envelope:1',
        duplicateAction: 'force',
      }),
    ])
  );
  expect(issue?.['ok'], 'seed create failed').toBe(true);
  seededIssueUid = (issue?.['data'] as Record<string, unknown> | undefined)?.[
    'uid'
  ] as string;
  expect(typeof seededIssueUid).toBe('string');
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe('--input envelope guard: bare shape is unaffected', () => {
  it('a bare params object still succeeds (exit 0, {"ok":true,…})', () => {
    const run = runBin([
      'get',
      '--input',
      JSON.stringify({ uid: seededIssueUid }),
    ]);
    expect(run.status, combined(run)).toBe(0);
    const env = envelope(run);
    expect(env?.['ok']).toBe(true);
    expect(
      (env?.['data'] as Record<string, unknown> | undefined)?.['uid']
    ).toBe(seededIssueUid);
    // The guard must never fire on the valid shape.
    expect(combined(run)).not.toContain(BARE_CONTRACT_PHRASE);
    expect(combined(run)).not.toContain(RAW_DUMP_PREFIX);
  });
});

describe('--input envelope guard: the MCP wrapper shapes are rejected loudly', () => {
  it('{input:{…}} exits non-zero with actionable guidance, not a raw union dump', () => {
    const run = runBin([
      'get',
      '--input',
      JSON.stringify({ input: { uid: seededIssueUid } }),
    ]);
    const out = combined(run);
    expect(run.status, out).not.toBe(0);
    expect(run.status).toBe(2);
    // (1) states the CLI's bare-params contract + a concrete example for THIS verb.
    expect(out).toContain(BARE_CONTRACT_PHRASE);
    expect(out).toContain(CLI_NEVER_WRAPS_PHRASE);
    expect(errorMessage(run)).toContain(`backlog get --input '{"uid":"<string>"}'`);
    // (2) names the envelope as the MCP convention, not applicable to the CLI.
    expect(out).toContain(MCP_PHRASE);
    expect(out).toContain('mcp__backlog__*');
    // (3) the guidance is NOT buried under the raw AJV union dump.
    expect(out).not.toContain(RAW_DUMP_PREFIX);
    expect(out).not.toContain(RAW_UNION_MARKER);
    // The emitted envelope is a structured failure with a machine-readable code.
    const env = envelope(run);
    expect(env?.['ok']).toBe(false);
    expect(
      (env?.['error'] as Record<string, unknown> | undefined)?.['code']
    ).toBe('invalid_argument');
  });

  it('{data:{input:{…}}} exits non-zero with actionable guidance, not a raw union dump', () => {
    const run = runBin([
      'get',
      '--input',
      JSON.stringify({ data: { input: { uid: seededIssueUid } } }),
    ]);
    const out = combined(run);
    expect(run.status, out).not.toBe(0);
    expect(run.status).toBe(2);
    expect(out).toContain(BARE_CONTRACT_PHRASE);
    expect(out).toContain(CLI_NEVER_WRAPS_PHRASE);
    expect(errorMessage(run)).toContain(`backlog get --input '{"uid":"<string>"}'`);
    expect(out).toContain(MCP_PHRASE);
    expect(out).not.toContain(RAW_DUMP_PREFIX);
    expect(out).not.toContain(RAW_UNION_MARKER);
  });

  it('the `--input=<json>` inline form is caught identically', () => {
    const run = runBin([
      'get',
      `--input=${JSON.stringify({ input: { uid: seededIssueUid } })}`,
    ]);
    const out = combined(run);
    expect(run.status).toBe(2);
    expect(out).toContain(BARE_CONTRACT_PHRASE);
    expect(out).not.toContain(RAW_DUMP_PREFIX);
  });

  it('a valid-looking bare object that merely lacks required fields is left to normal validation', () => {
    // NOT an envelope — no top-level `input`/`data`. The guard must not
    // hijack this; the ordinary validation path (its own message + exit 2)
    // owns it. This is the control proving the guard keys on the envelope
    // shape, not on "this object is wrong".
    const run = runBin(['get', '--input', JSON.stringify({ wrong: 'shape' })]);
    const out = combined(run);
    expect(run.status).toBe(2);
    expect(out).not.toContain(BARE_CONTRACT_PHRASE);
    expect(out).toContain(RAW_DUMP_PREFIX);
  });
});
