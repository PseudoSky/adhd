/**
 * Real, end-to-end smoke test for the demoted `@adhd/environment-cli`
 * (`packages/environment/ARCHITECTURE.md` §4/§7.8 verification standard —
 * no mocks: drives the actual `init`/`build`/`set`/`status`/`export`
 * commands from `api.ts` against a real spec module file on disk, a real
 * isolated `adhdRoot`, and the real `@adhd/environment-builder` pipeline).
 *
 * Flow: init scaffolds a spec module → a real spec (2 fields) is written →
 * build resolves + persists a snapshot from the spec defaults → set merges
 * an override into the project-scope config.yaml layer → a second build
 * picks up the override (proving `set` actually wrote a cascade layer the
 * builder reads, not a side-channel) → status/export read back the
 * persisted state.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as api from '../api';

const REPO_TMP_ROOT = join(__dirname, '..', '..', '..', '..', 'tmp', 'environment-cli');

const cleanupDirs: string[] = [];

/** Isolated `adhdRoot` under this repo's canonical `tmp/` (AGENTS.md §10). */
function mkAdhdRoot(): string {
  mkdirSync(REPO_TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(REPO_TMP_ROOT, 'root-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Isolated spec-module directory OUTSIDE the repo's git tree — this repo
 *  itself has a `.git` marker, which would spuriously flip scope
 *  resolution to `'project'` via `cwd`-marker auto-detection. Not used as
 *  `cwd` directly here (tests pass `scope: 'global'` explicitly), but kept
 *  outside the tree anyway so the spec module + written artifacts never
 *  touch the real working copy. */
function mkSpecDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-env-cli-spec-'));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  // `verify`/`doctor` set `process.exitCode` as a real side effect (so a
  // real generated CLI process exits non-zero on drift/failure) — reset it
  // after every test so a negative-control assertion never leaks into the
  // vitest process's own exit code.
  process.exitCode = 0;
});

const PROJECT = 'cli-smoke-test';

const REAL_SPEC_MODULE = `export const spec = {
  namespaces: ["default"],
  dirs: { data: { kind: "data" } },
  config: {
    "server.port": { type: "integer", default: 8080 },
    "logging.level": { type: "string", default: "info" },
  },
};
`;

describe('@adhd/environment-cli — real end-to-end command flow', () => {
  it('init scaffolds a starter spec module on disk', async () => {
    const dir = mkSpecDir();
    const result = await api.init(true, dir);

    expect(result.success).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, 'utf8')).toContain('export const spec');
  });

  it('init with generateConfig=false does NOT write anything (preview only)', async () => {
    const dir = mkSpecDir();
    const result = await api.init(false, dir);

    expect(result.success).toBe(false);
    expect(existsSync(result.path)).toBe(false);
    expect(result.template).toContain('export const spec');
  });

  it('build resolves the real spec defaults and persists a real snapshot to disk', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');

    const adhdRoot = mkAdhdRoot();

    const result = await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.fieldCount).toBe(2);
    expect(result.scope).toBe('global');
    expect(result.configHash).toMatch(/^sha256-/);
    expect(existsSync(result.snapshotPath)).toBe(true);

    const persisted = JSON.parse(readFileSync(result.snapshotPath, 'utf8'));
    expect(persisted.config.server.port).toBe(8080); // spec default — nothing overridden yet
    expect(persisted.config.logging.level).toBe('info');
  });

  it('set merges a real override into config.yaml, and a REBUILD picks it up — proves set writes an actual cascade layer, not a side-channel', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');

    const adhdRoot = mkAdhdRoot();

    // 1. Baseline build — confirm the pre-override value first (so the
    //    post-override assertion below has teeth: if `set` were a no-op,
    //    this test would still see 8080 the second time too).
    const before = await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);
    expect(before.success).toBe(true);
    const beforeSnapshot = JSON.parse(readFileSync(before.snapshotPath, 'utf8'));
    expect(beforeSnapshot.config.server.port).toBe(8080);

    // 2. set — merge an override.
    const setResult = await api.set(PROJECT, specPath, 'server.port', '9090', 'default', 'global', adhdRoot, false);
    expect(setResult.success).toBe(true);
    expect(existsSync(setResult.filePath)).toBe(true);
    expect(setResult.filePath.endsWith('config.yaml')).toBe(true);
    const layerContents = readFileSync(setResult.filePath, 'utf8');
    expect(layerContents).toContain('port: 9090');

    // 3. Rebuild — the override must now be reflected in the resolved config.
    const after = await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);
    expect(after.success).toBe(true);
    const afterSnapshot = JSON.parse(readFileSync(after.snapshotPath, 'utf8'));
    expect(afterSnapshot.config.server.port).toBe(9090);
    expect(afterSnapshot.config.server.port).not.toBe(8080);
    // The untouched sibling field is preserved (merge, not clobber).
    expect(afterSnapshot.config.logging.level).toBe('info');
    // configHash must differ from the pre-override build (content actually changed).
    expect(after.configHash).not.toBe(before.configHash);
  });

  it('status reports snapshotExists=false before any build, then true after', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');

    const adhdRoot = mkAdhdRoot();

    const beforeBuild = await api.status(PROJECT, specPath, 'default', 'global', adhdRoot);
    expect(beforeBuild.snapshotExists).toBe(false);
    expect(beforeBuild.fieldCount).toBe(2);

    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    const afterBuild = await api.status(PROJECT, specPath, 'default', 'global', adhdRoot);
    expect(afterBuild.snapshotExists).toBe(true);
    expect(afterBuild.configHash).toMatch(/^sha256-/);
  });

  it('export returns the fully-resolved snapshot (and writes it to a file when output is given)', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');

    const adhdRoot = mkAdhdRoot();
    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    const inline = await api.exportSnapshot(PROJECT, specPath, 'default', 'global', adhdRoot, '', true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((inline.snapshot as any).config.server.port).toBe(8080);

    const outFile = join(mkSpecDir(), 'exported.json');
    const toFile = await api.exportSnapshot(PROJECT, specPath, 'default', 'global', adhdRoot, outFile, true);
    expect(toFile.snapshot).toBe(outFile);
    expect(existsSync(outFile)).toBe(true);
    const written = JSON.parse(readFileSync(outFile, 'utf8'));
    expect(written.config.server.port).toBe(8080);
  });

  it('negative control: build against a spec module that fails to export a valid EnvironmentSpec reports success:false with a real error — never a silent default', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'not-a-spec.mjs');
    writeFileSync(specPath, 'export const somethingElse = 42;\n', 'utf8');

    const adhdRoot = mkAdhdRoot();
    const result = await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('EnvironmentSpec');
  });

  // -------------------------------------------------------------------
  // verify (DEBT-ENV-CLI-001)
  // -------------------------------------------------------------------

  it('verify reports verified:false (no snapshot yet) before a build, then verified:true immediately after', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    const beforeBuild = await api.verify(PROJECT, specPath, 'default', 'global', adhdRoot);
    expect(beforeBuild.verified).toBe(false);
    expect(beforeBuild.snapshotExists).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    const afterBuild = await api.verify(PROJECT, specPath, 'default', 'global', adhdRoot);
    expect(afterBuild.verified).toBe(true);
    expect(afterBuild.snapshotExists).toBe(true);
    expect(afterBuild.drift).toEqual([]);
    expect(process.exitCode).not.toBe(1);
  });

  it('verify goes non-zero (verified:false, real drift entries, exitCode=1) when the persisted snapshot is stale — negative control proves the check has teeth', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    // Persist a snapshot with the original spec (server.port default 8080).
    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    // Simulate drift between the persisted snapshot and what the live
    // cascade would now resolve to (e.g. someone edited config.yaml / the
    // spec default changed upstream and nobody re-ran `build`) by pointing
    // `verify` at a DIFFERENT spec module file with a different default,
    // resolving to the SAME project/namespace/scope (and therefore the SAME
    // persisted snapshot on disk). Deliberately a distinct file path, not an
    // in-place rewrite of `specPath` — Node's ESM `import()` cache is keyed
    // by resolved file URL, so re-`import()`ing the same path after
    // rewriting its content on disk returns the STALE cached module within
    // one process (proven empirically: an in-place rewrite here made this
    // negative control wrongly pass).
    const driftedSpec = REAL_SPEC_MODULE.replace('default: 8080', 'default: 9999');
    expect(driftedSpec).not.toBe(REAL_SPEC_MODULE); // sanity: the replace actually took effect
    const driftedSpecPath = join(specDir, 'adhd.environment.spec.drifted.mjs');
    writeFileSync(driftedSpecPath, driftedSpec, 'utf8');

    const result = await api.verify(PROJECT, driftedSpecPath, 'default', 'global', adhdRoot);

    expect(result.verified).toBe(false);
    expect(result.snapshotExists).toBe(true);
    expect(result.drift.length).toBeGreaterThan(0);
    const portDrift = result.drift.find((d) => d.field === 'server.port');
    expect(portDrift).toBeDefined();
    expect(portDrift?.kind).toBe('changed');
    expect(portDrift?.before).toBe(8080);
    expect(portDrift?.after).toBe(9999);
    expect(process.exitCode).toBe(1);
  });

  // -------------------------------------------------------------------
  // diff (DEBT-ENV-CLI-001)
  // -------------------------------------------------------------------

  it('diff (default mode: fresh build vs. persisted snapshot) reports identical:true right after a build, then real changes once the spec default changes', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);

    const noDrift = await api.diff(PROJECT, specPath, 'default', 'global', adhdRoot);
    expect(noDrift.identical).toBe(true);
    expect(noDrift.changes).toEqual([]);
    expect(noDrift.left.source).toBe('build');
    expect(noDrift.right.source).toBe('snapshot');

    // Distinct file path, not an in-place rewrite of `specPath` — see the
    // ESM `import()` cache note in the `verify` negative-control test above.
    const driftedSpec = REAL_SPEC_MODULE.replace('default: "info"', 'default: "debug"');
    expect(driftedSpec).not.toBe(REAL_SPEC_MODULE); // sanity: the replace actually took effect
    const driftedSpecPath = join(specDir, 'adhd.environment.spec.drifted.mjs');
    writeFileSync(driftedSpecPath, driftedSpec, 'utf8');

    const withDrift = await api.diff(PROJECT, driftedSpecPath, 'default', 'global', adhdRoot);
    expect(withDrift.identical).toBe(false);
    expect(withDrift.changes).toHaveLength(1);
    // `diff`'s `before`/`after` are positional (left-side value / right-side
    // value), not chronological — in default mode left=fresh build (the new
    // "debug" default), right=persisted snapshot (the old "info" on disk).
    expect(withDrift.changes[0]).toMatchObject({ field: 'logging.level', kind: 'changed', before: 'debug', after: 'info' });
  });

  it('diff (explicit two-snapshot-file mode) compares two exported snapshots directly, without touching the live cascade', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    const outDir = mkSpecDir();
    const snapshotA = join(outDir, 'a.json');
    const snapshotB = join(outDir, 'b.json');

    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);
    await api.exportSnapshot(PROJECT, specPath, 'default', 'global', adhdRoot, snapshotA, true);

    // Same underlying state re-exported — identical.
    const identical = await api.diff(PROJECT, specPath, 'default', 'global', adhdRoot, snapshotA, snapshotA);
    expect(identical.identical).toBe(true);
    expect(identical.left.source).toBe('snapshot');
    expect(identical.right.source).toBe('snapshot');

    // Override a field, rebuild+export to snapshotB — a real, verifiable change.
    await api.set(PROJECT, specPath, 'server.port', '4242', 'default', 'global', adhdRoot, false);
    await api.build(PROJECT, specPath, 'default', 'global', adhdRoot, false);
    await api.exportSnapshot(PROJECT, specPath, 'default', 'global', adhdRoot, snapshotB, true);

    const changed = await api.diff(PROJECT, specPath, 'default', 'global', adhdRoot, snapshotA, snapshotB);
    expect(changed.identical).toBe(false);
    const portChange = changed.changes.find((c) => c.field === 'server.port');
    expect(portChange).toMatchObject({ kind: 'changed', before: 8080, after: 4242 });
  });

  it('diff against a nonexistent explicit snapshot path throws a real, descriptive error — never a silent empty diff', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    const missingPath = join(mkSpecDir(), 'missing.json');
    await expect(api.diff(PROJECT, specPath, 'default', 'global', adhdRoot, missingPath)).rejects.toThrow(
      /not found or unreadable/,
    );
  });

  // -------------------------------------------------------------------
  // configGet (DEBT-ENV-CLI-001)
  // -------------------------------------------------------------------

  it('configGet returns the resolved value + provenance for a field left at its spec default', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    const result = await api.configGet(PROJECT, specPath, 'server.port', 'default', 'global', adhdRoot);
    expect(result.found).toBe(true);
    expect(result.value).toBe(8080);
    expect(result.provenance).toMatchObject({ source: 'default' });
  });

  it('configGet reflects a real override (source flips to the writing scope) after `set`, and reports found:false for an undeclared field', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    // `set`/`configGet` both explicitly resolve scope: 'global' here, so the
    // override lands in — and is read back from — the 'global' scope layer
    // (ProvenanceSource shares its vocabulary with Scope: 'default' |
    // 'system' | 'global' | 'project' | 'local' | 'env').
    await api.set(PROJECT, specPath, 'server.port', '5150', 'default', 'global', adhdRoot, false);

    const result = await api.configGet(PROJECT, specPath, 'server.port', 'default', 'global', adhdRoot);
    expect(result.value).toBe(5150);
    expect(result.provenance?.source).toBe('global');

    const missing = await api.configGet(PROJECT, specPath, 'does.not.exist', 'default', 'global', adhdRoot);
    expect(missing.found).toBe(false);
    expect(missing.value).toBeUndefined();
    expect(missing.provenance).toBeNull();
  });

  // -------------------------------------------------------------------
  // doctor (DEBT-ENV-CLI-001)
  // -------------------------------------------------------------------

  it('doctor reports healthy:true with every check passed against a real, valid spec + a fresh adhdRoot', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'adhd.environment.spec.mjs');
    writeFileSync(specPath, REAL_SPEC_MODULE, 'utf8');
    const adhdRoot = mkAdhdRoot();

    const result = await api.doctor(PROJECT, specPath, 'default', 'global', adhdRoot);

    expect(result.healthy).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(5);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['spec-loads', 'scope-resolves', 'builds', 'validates', 'snapshot-writable', 'snapshot-readable']),
    );
    expect(result.summary).toBe(`${result.checks.length}/${result.checks.length} checks passed`);
    expect(process.exitCode).not.toBe(1);
  });

  it('doctor goes non-zero (healthy:false, exitCode=1) against a spec module that fails to load — negative control proves the aggregate check has teeth', async () => {
    const specDir = mkSpecDir();
    const specPath = join(specDir, 'not-a-spec.mjs');
    writeFileSync(specPath, 'export const somethingElse = 42;\n', 'utf8');
    const adhdRoot = mkAdhdRoot();

    const result = await api.doctor(PROJECT, specPath, 'default', 'global', adhdRoot);

    expect(result.healthy).toBe(false);
    const specLoadsCheck = result.checks.find((c) => c.name === 'spec-loads');
    expect(specLoadsCheck?.passed).toBe(false);
    // Every downstream check is reported (never silently dropped), and
    // recorded as failed/skipped rather than throwing and losing the rest
    // of the report.
    expect(result.checks.find((c) => c.name === 'builds')?.passed).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
