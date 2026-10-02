/**
 * server.tracing-six-tags.spec.ts — the SIX-TAG CO-OCCURRENCE proof.
 *
 * `@adhd/backlog` is the reference consumer of `@adhd/apigen-plugin-tracing`. A
 * merge-gating review returned merge-after-X, where X was: "the durable record
 * has no `parent_span_id`". `@adhd/sox-telemetry@0.4.1` stamps it (from
 * `span.parentSpanContext`), so this suite proves the WHOLE demanded tag set
 * lands together on ONE emitted JSONL record — not scattered across records,
 * and not asserted from source strings.
 *
 * ## What is driven
 *
 * The CONFIGURED `adhd` layer (from `src/tracing.ts`, `serviceName: 'adhd'`)
 * is invoked for a REAL backlog operation (`backlog/get`, the first mounted
 * verb in `BACKLOG_VERBS`), with a real sox-telemetry file sink. The layer call
 * is wrapped in an OUTER `withSpan('proof.outer', …)` from sox-telemetry, so the
 * plugin's `adhd.<op>` span is a CHILD — its `parent_span_id` is the outer
 * span's id, not `null`. (A root span also carries `parent_span_id`, but as
 * `null`; the outer wrapper is what makes the value proved here NON-null.)
 *
 * ## The six demanded tags, asserted on ONE record
 *
 *   1. `session_id`            — equality to the env we pin.
 *   2. `trace_id`              — the plugin's own correlation id (non-empty).
 *   3. `parent_span_id`        — present AND non-null (nested span), plus a
 *                                root-record control showing `null`.
 *   4. `worktree`              — one of `main` | `linked` | `none`.
 *   5. `role`                  — equality to the role we configured (`cli`).
 *   6. `release.version` / `release.git_sha` / `release.artifact_sha256` —
 *                                DOTTED keys, the shape the plugin actually
 *                                emits (see `plugin.ts` lines 365-373: a nested
 *                                `release` object would be dropped by
 *                                `toOtelAttributes`, so it is flat).
 *
 * `release.version` comes from `npm_package_version`, which is unset under a
 * bare vitest/nx run, so this suite pins it (and `ADHD_SESSION_ID`) in
 * `beforeEach` BEFORE the first `processIdentity()` call. `release.git_sha`
 * (`git rev-parse HEAD` in cwd) and `release.artifact_sha256`
 * (`sha256(process.argv[1])`) resolve naturally in a checkout.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Call, Result } from '@adhd/apigen-core-client';
import {
  initTelemetry,
  _resetTelemetryForTest,
  withSpan,
  type TelemetryHandle,
} from '@adhd/sox-telemetry';
import { tracingPlugin } from './tracing.js';
import { BACKLOG_VERBS } from './vocabulary.js';

interface Recorded {
  event: string;
  level: string;
  trace_id?: string | null;
  parent_span_id?: string | null;
  worktree?: unknown;
  role?: unknown;
  session_id?: unknown;
  [key: string]: unknown;
}

const PINNED_SESSION_ID = 'six-tag-proof-session';
const PINNED_PACKAGE_VERSION = '9.9.9-six-tag-proof';

let logDir: string;
let handle: TelemetryHandle;

beforeEach(async () => {
  // Pinned BEFORE the first layer call so `processIdentity()` (cached on first
  // use, module-level) resolves these exact values.
  process.env['ADHD_SESSION_ID'] = PINNED_SESSION_ID;
  process.env['npm_package_version'] = PINNED_PACKAGE_VERSION;
  _resetTelemetryForTest();
  logDir = mkdtempSync(join(tmpdir(), 'backlog-six-tags-'));
  handle = initTelemetry({
    service: 'backlog',
    role: 'cli',
    logSink: 'file',
    logDir,
    otel: true,
  });
  await handle.otelReady();
});

afterEach(() => {
  handle.close();
  _resetTelemetryForTest();
  rmSync(logDir, { recursive: true, force: true });
});

function sinkPath(): string {
  const path = handle.currentLogFilePath();
  if (path === null) throw new Error('expected a file sink for this suite');
  return path;
}

function readRecords(): Recorded[] {
  const path = sinkPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

/** Minimal ctx token map a `Call` carries — supports `set`/`get` keyed by a class token. */
class TestExtensions {
  private readonly map = new Map<unknown, unknown>();
  set<T>(key: new (...args: never[]) => T, value: T): void {
    this.map.set(key, value);
  }
  get<T>(key: new (...args: never[]) => T): T | undefined {
    return this.map.get(key) as T | undefined;
  }
}

function makeCall(id: string): Call {
  return {
    operation: { id },
    data: {},
    envelope: {},
    ctx: new TestExtensions(),
    transport: 'mcp',
    signal: new AbortController().signal,
  } as unknown as Call;
}

describe('FEAT-APIGEN-TRACING: SIX demanded tags co-occur on ONE durable record', () => {
  it('drives a real backlog op through a NESTED adhd span and proves all six tags on one record', async () => {
    const opId = `backlog/${BACKLOG_VERBS[0]}`; // 'backlog/get' — a real mounted verb
    const call = makeCall(opId);

    // Wrap the configured layer in an OUTER span so the plugin's span is a
    // CHILD (non-null parent_span_id). Without this, every span the plugin
    // opens is a root and `parent_span_id` is legitimately null.
    await withSpan('proof.outer', {}, async () => {
      await (tracingPlugin.capabilities.layer!.layer(
        call,
        async () => 'ok'
      ) as Promise<Result>);
    });

    const records = readRecords();
    const record = records.find((r) => r.event === `adhd.${opId}.start`);
    expect(record, `no adhd.${opId}.start record`).toBeDefined();

    // ---- 1. session_id ------------------------------------------------------
    expect(record!['session_id']).toBe(PINNED_SESSION_ID);

    // ---- 2. trace_id --------------------------------------------------------
    expect(typeof record!['trace_id']).toBe('string');
    expect((record!['trace_id'] as string).length).toBeGreaterThan(0);

    // ---- 3. parent_span_id — present AND non-null (nested) ------------------
    expect('parent_span_id' in record!).toBe(true);
    expect(record!['parent_span_id']).not.toBeNull();
    expect(typeof record!['parent_span_id']).toBe('string');
    expect((record!['parent_span_id'] as string).length).toBeGreaterThan(0);

    // ---- 4. worktree --------------------------------------------------------
    expect(['main', 'linked', 'none']).toContain(record!['worktree']);

    // ---- 5. role ------------------------------------------------------------
    expect(record!['role']).toBe('cli');

    // ---- 6. release.* (DOTTED keys, the emitted shape) ----------------------
    expect(record!['release.version']).toBe(PINNED_PACKAGE_VERSION);
    expect(typeof record!['release.git_sha']).toBe('string');
    expect((record!['release.git_sha'] as string).length).toBeGreaterThan(0);
    expect(typeof record!['release.artifact_sha256']).toBe('string');
    expect(record!['release.artifact_sha256'] as string).toMatch(/^sha256:[0-9a-f]{64}$/);

    // CONTROL: the outer ROOT span also carries parent_span_id, but as null —
    // proving the non-null assertion above is not vacuous.
    const root = records.find((r) => r.event === 'proof.outer.start');
    expect(root, 'no proof.outer.start record').toBeDefined();
    expect(root!['parent_span_id']).toBeNull();

    // THE PROOF RECORD — printed for the dispatch evidence.
    // eslint-disable-next-line no-console
    console.log(
      '\n=== SIX-TAG PROOF RECORD (one JSONL line) ===\n' +
        JSON.stringify(record, null, 2) +
        '\n=== END SIX-TAG PROOF RECORD ===\n'
    );
  });
});
