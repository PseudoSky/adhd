# Changelog — `@adhd/apigen-*`

All notable changes to the apigen toolchain (`@adhd/apigen-cli`, `-core`, `-runtime`,
`-logical`, plugins, and generators). Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

Open/actionable work lives in [`/BACKLOG.md`](../../BACKLOG.md); plan-level design in
[`docs/plan/apigen-logical-types/DESIGN.md`](../../docs/plan/apigen-logical-types/DESIGN.md).

---

## [Unreleased] — extraction performance + memory (2026-07-02)

> 5x cold / >1000x warm extraction speedup and leak fixes across `-core`, `-cli`,
> `-runtime`, plus the new `@adhd/apigen-python-env`. Root BACKLOG § *Extraction
> performance + memory-leak work* has the full forensic detail.

### Performance
- **Extraction is 5x faster cold and near-free warm.** `buildDescriptor` (behind
  `generate`/`run`/`serve`) went 37.4s → 7.4s cold and → **6–11ms** on warm re-runs
  (6 files × 10 fns; `npx nx run apigen-cli:bench`). Mechanism: a shared per-run
  `ExtractionSession` (one ts-morph Project per tsconfig instead of ~2 per source; one
  schema generator per file; every `(file, typeText)` schema computed once) plus a
  bounded persistent tier reused across runs in the same process (watch/serve/test
  loops). The apigen-core test suite dropped 64.6s → 8.4s as a side effect.
- New public API in `@adhd/apigen-core`: `createExtractionSession()` /
  `clearPersistentProjectCache()`, and an optional `session` field on
  `ExtractOptions`, `GenerateSchemasOptions`, `ExtractClassesOptions`.

  ```ts
  import { createExtractionSession, extract, generateSchemas } from '@adhd/apigen-core'

  const session = createExtractionSession()
  try {
    const ops = await extract({ sourceFile, tsconfig, session })
    const gen = await generateSchemas({ sourceFile, tsconfig, session }) // cache hits
  } finally {
    session.dispose()
  }
  ```

### Fixed (memory)
- **Generator cache no longer grows per file edit.** The module-global
  ts-json-schema-generator cache was keyed on mtime and never evicted — each edit in
  watch/serve retained another ~100–200MB program forever. Now entries are replaced on
  version change and the persistent tier is LRU-capped (`APIGEN_PROGRAM_CACHE`,
  default 8; `0` disables persistence).
- **EventBus handlers are removable** (`@adhd/apigen-runtime`): `off()`/`clear()`
  added, `on()` returns an unsubscribe fn, `createApiPackage()` results gained
  `dispose()`.
- **`serve` gRPC proxy sessions** idle-evict after 60s and `unref()`; the builtin
  default-tsconfig temp file is created once per process instead of per call.

### Added
- **`@adhd/apigen-python-env`** — the Python hosts are now self-provisioning. py-grpc /
  py-flask (and the conformance gate) resolve their interpreter through a managed venv
  built from `apigen-python`'s own `pyproject.toml` extras
  (`pip install apigen-python[grpc]` → `~/.adhd/apigen/pyvenv`, content-hash stamped,
  cross-process locked, monotonic-union extras). `apigen serve` pre-provisions before
  spawning Python hosts and pins children via `APIGEN_PYTHON`. Overrides:
  `APIGEN_PYTHON` (explicit interpreter), `APIGEN_PYENV_HOME` (venv root).
- `npx nx run apigen-cli:bench` — extraction benchmark against generated fixtures under
  `tmp/apigen/bench`, printing cold/warm timings + retained heap.

### Fixed
- `packages/apigen/python/pyproject.toml` declared a non-existent build backend
  (`setuptools.backends.legacy:build`) — every `pip install` of the package failed.
  Now `setuptools.build_meta`.

---

## [Unreleased] — apigen-logical-types (PENDING)

> Cross-language serialization of non-JSON-native types and custom classes. Tracked by the
> `apigen-logical-types` plan-state-machine plan (DESIGN.md §1–§18). **Not yet released** —
> gated on the plan reaching its Definition of Done + publishing the apigen v2 packages.

### Added
- **Rich types now round-trip through `run`/`generate` with no new flags.** Functions whose
  signatures use **`Date`, `int64`/`BigInt`, `Decimal`, `bytes`, `UUID`, `Map`, `Set`,
  tuples**, or **user-defined classes** are exposed and (de)serialized correctly across
  MCP / HTTP / CLI. Previously these silently broke (e.g. `Date` extracted as `{}`, inputs
  never rehydrated). *(dod.1/dod.2)*
- **Custom-class round-trips, including cross-host.** A `User` class survives
  `TS → wire → Python → wire → TS` and is reconstructed as a **real instance on both hosts**
  (not a prototype-stripped object). Discriminated unions (`Dog | Cat`) dispatch by wire
  discriminator. *(dod.3/dod.4)*
- **Meaningful MCP/OpenAPI schemas.** `tools/list` and the OpenAPI emitter now carry proper
  `format` (`date-time`, `int64`, `uuid`, `byte`, …) and named `$ref` for classes instead of
  empty `{}` — so MCP clients (and the driving model) and generated OpenAPI clients in any
  language get real, validatable types.
- **Idiomatic generated clients.** Generated TS clients emit `Date`, Python clients emit
  `datetime` (via `x-apigen-*` codegen hints) — consumers get typed values, not raw ISO
  strings to hand-parse.
- **Cross-host interop for rich types.** Expose a TS function, call it from a Python client
  (or vice versa), with Date/Decimal/classes preserved — guaranteed **byte-equal** by a
  conformance-vector matrix (a TCK every host must pass). *(dod.5)*
- **New developer tooling:** an `apigen-nx` **`host` generator** to scaffold a new host
  language (a template column + conformance harness), and a workspace
  **`nx run …:conformance`** target that verifies the cross-host matrix.
- **New package `@adhd/apigen-logical`** — the single source of truth: canonical wire table +
  per-language native-hook template columns + generate-time emitter + run-mode closure builder.
- **Optional knob `--opt logical.decimal=branded|lib`** — zero-dependency branded-string mode
  vs a real `Decimal` runtime type.

### Changed
- `generate` emits a **standalone-runnable** `package.json`: rich-type deps (e.g. `decimal.js`)
  are added per-surface (only the types actually used), so generated output runs after a plain
  `npm install` — `--link-workspace` no longer required for the publish path.
  *(dod.10 — resolves BUG-APIGEN-002 dep-manifest slice)*
- Validation actually enforces formats — the validate-Layer wires `ajv-formats`, so a malformed
  `date-time` (`2099-02-30`) is rejected instead of silently passing. *(dod.6)*

### Fixed
- **BUG-APIGEN-005** — language-specific serializable types (`Date → {}`, lost precision,
  un-rehydrated inputs) and custom-class identity loss. *(this feature)*
- **BUG-APIGEN-004** — `run`/`generate` now **fail fast** with an actionable message on 0
  extracted functions and on a used rich type whose optional dependency is missing
  (e.g. *"function `quote` takes a Decimal; install `decimal.js`"*), instead of a cryptic
  `ERR_MODULE_NOT_FOUND`. *(dod.9)*

### Engineering notes
- Codegen-first design: encode uses each language's **native hook**
  (`toJSON` / `JSONEncoder.default` / serde / Jackson / `MarshalJSON`); decode is schema-driven
  glue emitted once by the generator — **no per-host runtime interpreter**.
- Languages with native-hook mappings resolved: **TypeScript/JS, Python, Rust, Go, Java**.
  3rd-party deps introduced: Python 0, Java 1, TS 1, Go 2, Rust ~6 (all pinned, minimal-per-surface).

---

## [1.0.0] — apigen v2 (released to disk, publish pending)

### Added
- apigen v2 — an 18-package TypeScript→API toolchain. Takes any unmodified `.ts` file and
  exposes its exports as an **MCP server, HTTP API, or CLI** without source changes
  (`apigen-cli run/generate`). Canonical Operation descriptor (JSON-Schema-2020-12 IR),
  symbol/class extractor (ts-morph), v2 plugin interface, Layer harness + streaming + single
  canonical dispatch path, `mcp`/`api-fastify`/`api-express`/`cli` plugins, `apigen-nx`
  generator, and a real Python host passing the conformance vectors.
  Plan: `docs/plan/apigen-client-generation` (46/46 states, final audit 117/117, DoD confirmed).

### Fixed
- **BUG-APIGEN-001** — ctx-param functions returned wrong results via generated servers
  (`hasCtx` now threaded through extraction→dispatch).
- **BUG-APIGEN-002** — generated output portability via the Option-A publish model + default-off
  `--link-workspace` (dep-manifest extension for rich types tracked in Unreleased above).
- **BUG-APIGEN-003** — MCP SSE transport reachable (stdio + streaming-http + sse); probe
  hardened (`waitForPort` 15s→60s for cold compiles).
