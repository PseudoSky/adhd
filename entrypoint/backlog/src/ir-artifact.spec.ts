/**
 * ir-artifact.spec.ts — the freshness-gate teeth for the bake-at-build
 * artifact reader (design doc Revision 3). Every case drives the REAL
 * `readBakedIrArtifact`/`writeBakedIrArtifact` against a real temp `dist/`
 * tree; nothing is mocked.
 *
 * The load-bearing case is SOURCE-HASH-MISMATCH: if `api.d.ts` changes after
 * the artifact was baked, the reader MUST return `undefined` (never serve
 * stale operations) so `server.ts` falls back to a live extraction. A reader
 * that returned the artifact unconditionally would keep this test green while
 * shipping stale schemas — which is exactly why the mismatch case exists.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operation } from '@adhd/apigen-core-client';
import { CURRENT_FORMAT_VERSION } from '@adhd/apigen-plugin-ir-cache';
import {
  BACKLOG_IR_ARTIFACT_FILENAME,
  EXPECTED_EXTRACTOR_VERSION,
  bakedIrArtifactPath,
  readBakedIrArtifact,
  writeBakedIrArtifact,
} from './ir-artifact.js';

function op(id: string): Operation {
  const [namespace, ...rest] = id.split('/');
  return {
    id,
    host: 'ts',
    namespace: { raw: namespace, words: [namespace] },
    path: rest.map((p) => ({ raw: p, words: [p] })),
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: {}, required: [] },
    output: { type: 'object' },
    envelope: {},
    typeText: null,
  } as Operation;
}

const OPS: Operation[] = [op('backlog/get'), op('backlog/create')];

let distDir: string;
let apiDts: string;
let artifactPath: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'backlog-ir-artifact-spec-'));
  apiDts = join(distDir, 'api.d.ts');
  artifactPath = bakedIrArtifactPath(distDir);
  writeFileSync(apiDts, 'export declare function get(): Promise<void>;\n');
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

async function bake(): Promise<void> {
  await writeBakedIrArtifact({
    apiDts,
    outFile: artifactPath,
    extractorVersion: EXPECTED_EXTRACTOR_VERSION,
    operations: OPS,
  });
}

describe('ir-artifact — filename + path', () => {
  it('names the artifact api.ir.json beside api.d.ts', () => {
    expect(BACKLOG_IR_ARTIFACT_FILENAME).toBe('api.ir.json');
    expect(artifactPath).toBe(join(distDir, 'api.ir.json'));
  });
});

describe('ir-artifact — readBakedIrArtifact freshness gate', () => {
  it('missing artifact → undefined', () => {
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('writes then reads back the operations (round-trip)', async () => {
    await bake();
    expect(readBakedIrArtifact(distDir)).toEqual(OPS);
  });

  it('corrupt JSON → undefined (never throws)', () => {
    writeFileSync(artifactPath, '{ not json');
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('format-version mismatch → undefined', async () => {
    await bake();
    const entry = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      artifactPath,
      JSON.stringify({ ...entry, formatVersion: CURRENT_FORMAT_VERSION + 999 })
    );
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('extractor-version mismatch → undefined', async () => {
    await bake();
    const entry = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      artifactPath,
      JSON.stringify({ ...entry, extractorVersion: 'other-extractor@0.0.0' })
    );
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('SOURCE-HASH-MISMATCH (api.d.ts changed after bake) → undefined — never serve stale', async () => {
    await bake();
    // Sanity: it is a hit before the source drifts.
    expect(readBakedIrArtifact(distDir)).toEqual(OPS);

    appendFileSync(apiDts, '// a later edit the artifact does not describe\n');
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('missing api.d.ts → undefined even when the artifact exists', async () => {
    await bake();
    rmSync(apiDts);
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('an artifact with no artifactSource provenance → undefined', async () => {
    writeFileSync(
      artifactPath,
      JSON.stringify({
        formatVersion: CURRENT_FORMAT_VERSION,
        extractorVersion: EXPECTED_EXTRACTOR_VERSION,
        operations: OPS,
        createdAt: new Date().toISOString(),
      })
    );
    expect(readBakedIrArtifact(distDir)).toBeUndefined();
  });

  it('records provenance (path, sha256, bytes) matching the source it baked', async () => {
    await bake();
    const entry = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      artifactSource: { path: string; sha256: string; bytes: number };
    };
    expect(entry.artifactSource.path).toBe(apiDts);
    expect(entry.artifactSource.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.artifactSource.bytes).toBeGreaterThan(0);
  });
});
