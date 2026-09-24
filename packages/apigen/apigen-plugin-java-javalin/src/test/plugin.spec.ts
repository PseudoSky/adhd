/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING tests live in the
 * sibling `plugin.e2e.ts`.
 *
 * Resource lane: proc — it spawns a real `mvn` (extraction) + `javac` compile
 * + a real Javalin `java` server bound to an ephemeral (`:0`) port, then fires
 * real HTTP requests.
 *
 * Those cases were moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * them. The `it.todo` entries below inventory the moved cases (one per real
 * case in `plugin.e2e.ts`); they are the contract a mocked version must
 * satisfy without touching a subprocess, a port, or the real extraction.
 *
 * The two `describe` blocks below are NOT stubs: `resolveJavaPkgDir` and
 * `selectFatJar` are pure/hermetic (a `fs.existsSync` probe and synthetic
 * `tmp/`-rooted jar dirs — no subprocess, no port), so they correctly stay in
 * the default lane and keep their real coverage here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveJavaPkgDir, selectFatJar } from '../lib/plugin';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

describe('mocked: java-javalin plugin — live two-phase-spawn server', () => {
  it.todo(
    'mocked: GET /_meta/health returns 200 {"status":"ok","host":"orders"}'
  );
  it.todo(
    'mocked: POST /orders/identity-decimal round-trips a BigDecimal byte-identically to canonical wire'
  );
  it.todo(
    'mocked: POST /orders/identity-instant round-trips an Instant byte-identically to canonical wire'
  );
  it.todo(
    'mocked: POST /orders/total-with-tax computes a real BigDecimal result (multi-param dispatch)'
  );
  it.todo(
    'mocked: [TEETH] negative control: decimal wire must be a JSON string, never a bare number'
  );
  it.todo(
    'mocked: unknown operation id is not routed (404 — Javalin default for unmapped path)'
  );
});

describe('resolveJavaPkgDir', () => {
  it('locates the real packages/apigen/java Maven module from this file tree', () => {
    const dir = resolveJavaPkgDir(__dirname);
    expect(fs.existsSync(path.join(dir, 'pom.xml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectFatJar — deterministic shaded-jar selection (backlog 7e3852df).
//
// Pure and hermetic: builds synthetic `packages/apigen/java`-shaped dirs under
// `tmp/`, never spawns mvn. The regression it prevents: the old
// `readdirSync(target).find(f => f.endsWith('-all.jar'))` picked whichever
// candidate the filesystem listed first, so a stale `*-all.jar` could win.
// ---------------------------------------------------------------------------
describe('selectFatJar', () => {
  let scratchRoot: string;

  const POM =
    '<project><build><finalName>apigen-java</finalName>' +
    '<plugins><plugin><configuration>' +
    '<shadedClassifierName>all</shadedClassifierName>' +
    '</configuration></plugin></plugins></build></project>';

  beforeAll(() => {
    const parent = path.join(REPO_ROOT, 'tmp', 'apigen-plugin-java-javalin');
    fs.mkdirSync(parent, { recursive: true });
    scratchRoot = fs.mkdtempSync(path.join(parent, 'select-fat-jar-'));
  });

  afterAll(() => {
    if (scratchRoot) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  function makePkg(opts: {
    pom: string | null;
    jars: Array<{ name: string; mtimeMs: number }>;
  }): string {
    const pkgDir = fs.mkdtempSync(path.join(scratchRoot, 'pkg-'));
    const target = path.join(pkgDir, 'target');
    fs.mkdirSync(target, { recursive: true });
    if (opts.pom !== null) {
      fs.writeFileSync(path.join(pkgDir, 'pom.xml'), opts.pom);
    }
    for (const jar of opts.jars) {
      const jarPath = path.join(target, jar.name);
      fs.writeFileSync(jarPath, 'x');
      const t = new Date(jar.mtimeMs);
      fs.utimesSync(jarPath, t, t);
    }
    return pkgDir;
  }

  it('prefers the jar the pom declares even when another *-all.jar is NEWER (the stale-jar regression)', () => {
    const pkg = makePkg({
      pom: POM,
      jars: [
        { name: 'apigen-java-all.jar', mtimeMs: 1_000 },
        { name: 'apigen-java-0.0.1-all.jar', mtimeMs: 2_000_000 },
      ],
    });
    // Teeth: a naive newest-mtime (or readdir-first) pick would return the
    // stale `apigen-java-0.0.1-all.jar`; only the pom-declared preference
    // yields the current jar deterministically.
    expect(selectFatJar(pkg)).toBe('apigen-java-all.jar');
  });

  it('falls back to the newest by mtime when no pom declares a matching jar', () => {
    const pkg = makePkg({
      pom: null,
      jars: [
        { name: 'apigen-java-all.jar', mtimeMs: 1_000 },
        { name: 'apigen-java-0.0.1-all.jar', mtimeMs: 2_000_000 },
      ],
    });
    expect(selectFatJar(pkg)).toBe('apigen-java-0.0.1-all.jar');
  });

  it('returns undefined when target/ holds no *-all.jar', () => {
    const pkg = makePkg({
      pom: POM,
      jars: [{ name: 'apigen-java.jar', mtimeMs: 1_000 }],
    });
    expect(selectFatJar(pkg)).toBeUndefined();
  });

  it('breaks mtime ties by name, so the result never depends on readdir order', () => {
    const pkg = makePkg({
      pom: null,
      jars: [
        { name: 'b-all.jar', mtimeMs: 5_000 },
        { name: 'a-all.jar', mtimeMs: 5_000 },
        { name: 'c-all.jar', mtimeMs: 5_000 },
      ],
    });
    expect(selectFatJar(pkg)).toBe('a-all.jar');
    expect(selectFatJar(pkg)).toBe('a-all.jar');
  });
});
