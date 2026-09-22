#!/usr/bin/env node
/**
 * embedding-usage-gate.mjs — enforces the real-vs-fake embedding test policy.
 *
 * The rule (see `src/test/helpers/fake-embedding-provider.ts`'s own header):
 * every spec file that can reach a real embedding-model load falls into
 * exactly one declared bucket —
 *
 *   REAL_BY_DESIGN — named explicitly below, because its own assertions
 *   require a property a deterministic fake cannot honestly provide
 *   (end-to-end proof, or genuine cross-vocabulary semantic similarity).
 *
 *   FAKED — carries the exact marker string `Embeddings mocked here` in a
 *   comment AND a `vi.mock('@adhd/sox-embedding-provider', ...)` call.
 *
 * A spec file that reaches the embedding path and is in NEITHER bucket is
 * an undeclared real-embedding test — exactly the ambiguous middle ground
 * this gate exists to catch before it silently reintroduces multi-minute
 * test cost or an unreviewed "is this real or fake" question.
 *
 * DETECTION SIGNAL. "Reaches the embedding path" means the file contains a
 * genuine, quoted reference to the package specifier — a static import, a
 * dynamic `import(...)`, or a `vi.mock(...)` call — OR imports
 * `bootstrapSemanticStoreMembers` (`write/bootstrap.ts`'s real bootstrap) OR
 * imports from `store/semantic-search.js` (the other real bootstrap; see
 * SPEC.md §5b on why both still exist). This is deliberately narrower than
 * "imports api.ts/query.ts" — nearly every spec in the package imports the
 * verb surface, regardless of whether that test's own env ever turns
 * `embedding.enabled` on, so that broader signal is pure noise (verified:
 * it flagged 21 files, none of which actually load a model). It is also
 * deliberately narrower than "mentions the string sox-embedding-provider
 * anywhere" — a prose comment in backticks (see `rag-optional-deps.spec.ts`,
 * a static package.json/pnpm-lock.yaml manifest check that never loads
 * anything) is not a real reference; only a QUOTED specifier counts.
 *
 * This is a policy gate, not a type-checker: a file that reaches the
 * embedding path through a route this gate doesn't recognize is a real
 * gap — file it and extend the signal, don't bypass this gate.
 *
 * Run: node tools/gate/embedding-usage-gate.mjs   (exit 0 clean, 1 dirty)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PKG = new URL('../..', import.meta.url).pathname;
const ROOT = join(PKG, 'src');

/**
 * Real by design — reviewed and named explicitly, not inferred. Adding a
 * name here is a deliberate policy decision, not a workaround.
 */
const REAL_BY_DESIGN = new Map([
  [
    'src/store/rag-e2e.spec.ts',
    'the one true end-to-end proof against the real model',
  ],
  [
    'src/api.semantic-production-seam.spec.ts',
    'the PRODUCTION semantic seam (bootstrapSemanticStoreMembers + api.ts upsertProject/create/query) ' +
      'proven end-to-end against the REAL fastembed model — no vi.mock of @adhd/sox-embedding-provider. ' +
      'Its assertion is a route-discriminating outcome a fake cannot honestly provide: the query shares no ' +
      'meaningful token with the created item (a grep negative control over the same text asserts it is ' +
      'unfindable), so only the real semantic ranker can surface it.',
  ],
]);

/**
 * A second, equally legitimate way to avoid a real model load: inject a
 * fake `SemanticBackend` directly via `configureSemanticBackend()` rather
 * than mocking the `@adhd/sox-embedding-provider` package. No `vi.mock()`
 * marker applies here because there is nothing to mock — the seam is a
 * plain function parameter. The file's own header must state the
 * no-model-load guarantee in prose for this to count.
 */
const DECLARED_INJECTED_FAKE = new Map([
  [
    'src/store/semantic-search.spec.ts',
    'the injectable-seam describe block injects a fake SemanticBackend via configureSemanticBackend() — no model load. ' +
      'DISCLOSED EXCEPTION (STATE.md A15): the separate bootstrapSemanticBackend diagnostics test calls the REAL ' +
      'bootstrapSemanticBackend with no mock and conditionally loads the real fastembed/onnxruntime model when the ' +
      'optional @adhd/sox-embedding-provider/@adhd/sox-vector-store packages happen to be installed on the host ' +
      '(RAG-SPEC.md §1.6 optional-dependency contract) — machine-dependent by design, not REAL_BY_DESIGN (it is not an ' +
      'end-to-end proof) and not a bug; see the file\'s own header for the full account.',
  ],
]);

const MOCK_MARKER = 'Embeddings mocked here';
const MOCK_CALL = /vi\.mock\(\s*['"]@adhd\/sox-embedding-provider['"]/;

/** A genuine, quoted reference — not a prose mention in backticks. */
const REAL_REFERENCE_PATTERNS = [
  /['"]@adhd\/sox-embedding-provider['"]/, // static/dynamic import or vi.mock specifier
  /\bbootstrapSemanticStoreMembers\b/, // write/bootstrap.ts's real bootstrap entry point
  /from\s+['"][.\w/]*semantic-search(\.js)?['"]/, // the other real bootstrap (relative path varies: '../store/semantic-search.js' vs './semantic-search.js' from within store/ itself)
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const problems = [];
const clean = [];

for (const file of walk(ROOT)) {
  const rel = relative(PKG, file);
  const contents = readFileSync(file, 'utf8');

  const touchesEmbedding = REAL_REFERENCE_PATTERNS.some((re) =>
    re.test(contents)
  );
  if (!touchesEmbedding) continue;

  if (REAL_BY_DESIGN.has(rel)) {
    clean.push({ file: rel, bucket: `REAL_BY_DESIGN — ${REAL_BY_DESIGN.get(rel)}` });
    continue;
  }

  if (DECLARED_INJECTED_FAKE.has(rel)) {
    clean.push({
      file: rel,
      bucket: `INJECTED_FAKE — ${DECLARED_INJECTED_FAKE.get(rel)}`,
    });
    continue;
  }

  const hasMarker = contents.includes(MOCK_MARKER);
  const hasMockCall = MOCK_CALL.test(contents);

  if (hasMarker && hasMockCall) {
    clean.push({ file: rel, bucket: 'FAKED' });
    continue;
  }

  problems.push({ file: rel, hasMarker, hasMockCall });
}

if (problems.length === 0) {
  console.log(
    `embedding-usage-gate: CLEAN — ${clean.length} embedding-touching spec file(s), each a declared REAL_BY_DESIGN file or carrying both the "${MOCK_MARKER}" marker and a matching vi.mock() call:\n`
  );
  for (const c of clean) console.log(`  [${c.bucket}] ${c.file}`);
  process.exit(0);
}

console.log(
  `embedding-usage-gate: DIRTY — ${problems.length} spec file(s) touch the embedding path without a declared bucket.\n`
);
for (const p of problems) {
  console.log(`  ${p.file}`);
  console.log(`      marker present:   ${p.hasMarker}`);
  console.log(`      vi.mock() call:   ${p.hasMockCall}`);
  console.log(
    `      fix: either add to REAL_BY_DESIGN in this gate with a stated reason, or add the "${MOCK_MARKER}" comment + vi.mock('@adhd/sox-embedding-provider', ...) using src/test/helpers/fake-embedding-provider.ts\n`
  );
}
process.exit(1);
