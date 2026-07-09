# BACKLOG — @adhd/environment family

Findings from the code review of the adopted `contract-base-spec` / `builder-engine` / `runtime-py` / `runtime-rs`
implementations (2026-07-08). Every item below was **reproduced by execution**, not inferred.

Context: `runtime-py` and `runtime-rs` are marked `complete` in `docs/plan/adhd-environment/state.json`. Their
guards and test suites are green. **The suites are pure vector-replay** — each asserts `impl(vector.input) == vector.expected`
against a pinned string, so they stay green against every divergence below. Cross-language equivalence — the product
this plan exists to deliver — does not currently hold.

---

### ENV-CORE-001 — CRITICAL — `generateFieldSchema`: Python and Rust leak adhd metadata that TS strips (secret disclosure)
- **Where:** `environment-base-spec/src/index.ts:525-539` (whitelist) vs `environment-core-py/src/adhd_environment/environment.py:154` (`dict(field_def)`) vs `environment-core-rs/src/lib.rs:724` (`properties.insert(head, definition)`)
- **Description:** TS routes every leaf through `fieldDefinitionToJsonSchema`, an explicit whitelist keeping only `type, default, description, minimum, maximum, enum, pattern, minLength, maxLength, items`, deliberately dropping the adhd-specific keys `env, scope, secret, noEnv`. Python and Rust copy the field definition **verbatim**. Verified: input leaf `{"type":"string","secret":true,"env":"CUSTOM_ENV","scope":"global","noEnv":true,"default":"x"}` → TS emits `{"type":"string","default":"x"}`; Python and Rust emit the full object including `secret:true` and `env:"CUSTOM_ENV"`.
- **Impact:** Both an equivalence break and a **security leak** — any Python/Rust-generated schema that is serialized, published, or shown to a user discloses which fields are secrets and their env-var names. The Python docstring (`environment.py:140-142`, "passed through verbatim") shows this was a conscious divergence from TS, not an oversight.
- **Fix direction:** Port the TS whitelist to both. Add a vector with adhd metadata on the leaf.
- **Status:** OPEN — blocks `runtime-py` / `runtime-rs` being legitimately complete.

### ENV-CORE-002 — CRITICAL — `contentHash`: astral-plane key ordering diverges → different digests per language
- **Where:** `index.ts:418` (`Object.keys().sort()`, UTF-16 code-unit order) vs `environment.py:80` (`sorted()`, code-point order) vs `lib.rs:644` (`str::cmp`, UTF-8 byte order == code-point order)
- **Description:** For BMP keys all three agree. For any key ≥ U+10000, JS orders on the leading surrogate (0xD800–0xDBFF) while Python/Rust order on the full scalar value. Verified by execution with keys `U+FFFF` and `😀 U+1F600`: JS sorts `["😀","￿"]` → `sha256-5c46ab8ff758495e…`; Python sorts `['￿','😀']` → `sha256-51978d06c8121942…`. Rust matches Python, not TS.
- **Impact:** The same config map content-addresses to two different hashes depending on language. This defeats the stated purpose of the cross-language content-addressing primitive.
- **Fix direction:** Define the canonical order in `SPEC.md` (code-point order is the portable choice; TS is the outlier and must sort by code point explicitly, e.g. via `Array.from`/`localeCompare`-free codepoint comparison). Add astral-key vectors.
- **Status:** OPEN — blocks `runtime-py` / `runtime-rs`.

### ENV-CORE-003 — HIGH — `projectEnvPrefix`: Rust folds `.`→`_`; TS and Python do not
- **Where:** `lib.rs:669` `.replace(['-', '.'], "_")` vs `environment.py:95` `.replace("-", "_")` vs `index.ts:437` `.replace(/-/g, '_')`
- **Description:** Verified: `projectEnvPrefix("foo.bar")` → TS `ADHD_FOO.BAR`, Python `ADHD_FOO.BAR`, Rust `ADHD_FOO_BAR`. Rust's own doc comment (`lib.rs:660`) documents the dot-folding, contradicting the other two. Note `inferEnvVar` correctly folds `.` in all three (`index.ts:457`, `environment.py:112`, `lib.rs:684`) — the inconsistency is `projectEnvPrefix`-only. `ADHD_FOO.BAR` is not a legal POSIX env-var name, so TS/Python arguably hold the latent bug and Rust silently "fixed" it — either way the contract is unspecified for dotted names and the three disagree.
- **Fix direction:** Specify the behaviour for dotted project names in `SPEC.md`, then make all three agree. Add a dotted-name vector.
- **Status:** OPEN.

### ENV-CORE-004 — MEDIUM — `contentHash` serialization is non-injective; the plan's own gate vector is a collision point
- **Where:** `index.ts:421`, `environment.py:80`, `lib.rs:647-651` — all three share the `key=value\n` serialization with no escaping.
- **Description:** A key or value containing `=` or `\n` collides with a structurally different map. Verified by execution: `contentHash({"a":"1\nb=2"})` == `contentHash({"a":"1","b":"2"})` == `sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930` — **which is the exact digest the plan pins as its `contentHash` gate vector**. Config values routinely contain newlines (multi-line secrets, PEM keys, paths), so this is reachable, not theoretical. All three languages agree here, so it is a spec defect rather than an equivalence break.
- **Fix direction:** Length-prefix or escape the serialization (e.g. `len(k):k=len(v):v\n`), or document the assumption that keys/values are `=`/`\n`-free and validate it. Choose a non-degenerate gate vector regardless.
- **Status:** OPEN — spec-level defect in `contract-base-spec`, which is marked `complete`.

### ENV-CORE-005 — LOW — lone-surrogate keys: TS substitutes U+FFFD, Python raises
- **Where:** `index.ts:667` (`TextEncoder().encode()`) vs `environment.py:81` (`.encode("utf-8")`, no `surrogatepass`)
- **Description:** A key such as `"\uD800"` yields a hash in TS and a `UnicodeEncodeError` in Python. One produces a value, the other crashes. Not vector-covered.
- **Status:** OPEN.

### ENV-CORE-006 — LOW — `Environment` snapshot path has no traversal guard
- **Where:** `environment.py:224` (`root / self.project / self.namespace / SNAPSHOT_FILENAME`), `lib.rs:410` (`from_snapshot_path`)
- **Description:** `project`/`namespace` are interpolated into the path with no sanitization; `project="../../../etc"` escapes `adhd_root`. Low severity while inputs are trusted; a hazard if they ever originate from user or network input.
- **Status:** OPEN.

### ENV-CORE-007 — TEST-DEBT — the Python and Rust suites cannot fail against any of the above
- **Where:** `environment-core-py/tests/test_cross_language_vectors.py`, `environment-core-rs/src/lib.rs:762-932`
- **Description:** Both suites are 100% vector-replay: every assertion compares an implementation to a pinned string that was itself produced by one implementation. No test drives TS and a port against a **shared adversarial input** and asserts equality. Because the vectors omit astral keys, dotted project names, and adhd leaf metadata, all of ENV-CORE-001/002/003 pass green. `test_content_hash_unsorted_and_presorted_inputs_agree` and `content_hash_is_order_independent` only prove order-independence for `{a,b}`. Per the repo verification standard (§6.2), a test that stays green when the code is broken proves nothing.
- **Fix direction:** Add a conformance harness that generates adversarial inputs (astral keys, dotted names, secret leaves, `\n`/`=` values) and asserts `TS == Python == Rust` — ideally TS emits the vectors the ports consume, so the vectors cannot drift from the source of truth.
- **Status:** OPEN — this is why `runtime-py` and `runtime-rs` reached `complete` on green suites.

### ENV-CORE-008 — GOOD (no action) — the `knownDiscrepancy` guard has teeth
- `test_known_discrepancy_is_documented_and_not_silently_patched` asserts the implementation does **not** emit the fabricated `9f86d081…` placeholder and **does** emit the recomputed `4a73850f…`, with a real negative assertion. Independently reproduced: `sha256("a=1\nb=2\n")` = `4a73850f…`. That part of the work is sound. (See ENV-CORE-004 for why the chosen vector is nonetheless degenerate.)

---

## Credential-handling defects (audit 2026-07-09)

### ENV-CORE-009 — CRITICAL — resolved snapshots persist `secret: true` values in plaintext
- **Where:** `environment-builder/src/snapshot-writer.ts` (`atomicWrite`), `config-resolver.ts`, `environment-base-spec/src/index.ts` (`SnapshotData`)
- **Description:** `SnapshotData` carries `config` ("fully resolved, nested config object") and `raw` ("flat, un-nested config (dot.path → value)"). `config-resolver.ts` never mentions `secret` — there is **no redaction anywhere in the package family** (`grep -rlE 'redact|maskSecret|\[REDACTED\]'` over `packages/environment` + `entrypoint/environment-cli` returns nothing). `atomicWrite` does `JSON.stringify(data)` on the whole object. The repo's own test asserts `raw['providers.openai.secret'] === 'sk-test'`, i.e. the resolved secret value is in the serialized payload. Every `adhd-environment.json` on disk therefore contains plaintext credentials.
- **Fix direction:** Snapshots must store a *reference* for `secret: true` fields (the env-var name), never the value; resolve secrets at read time in `Environment.get()`. If a resolved value must be cached, encrypt at rest and never write it to a repo-adjacent path.
- **Mitigated (not fixed):** `adhd-environment.json` + `.tmp` are now gitignored and blocked by path in `.githooks/check-no-credentials.js`. The plaintext file still exists on disk.
- **Status:** OPEN.

### ENV-CORE-010 — HIGH — snapshot written with default umask (world-readable), no `mode` passed
- **Where:** `snapshot-writer.ts:59-66` — `atomicWrite(filePath, data, opts)`; `opts.mode` is optional and **no caller passes it**, so `writeFileSync` uses the platform default (typically `0644`).
- **Description:** A file containing plaintext credentials (ENV-CORE-009) is created world-readable on a multi-user host.
- **Fix direction:** Default `mode` to `0o600` for the snapshot, and `chmod` the containing directory to `0o700`.
- **Status:** OPEN.

### ENV-CORE-011 — HIGH — `atomicWrite` leaves a plaintext `<file>.tmp` behind on failure
- **Where:** `snapshot-writer.ts:61-66`
- **Description:** `writeFileSync(tmpPath, …)` then `renameSync(tmpPath, filePath)` with no `try/finally` and no `unlink` on error. The module's own doc comment concedes: "at worst a stale `.tmp` is left behind if the process is killed mid-write." That stale `.tmp` holds the same plaintext secrets, at the same default mode, and is not covered by any cleanup.
- **Fix direction:** `try { write; rename } catch (e) { unlinkSync(tmpPath) ; throw e }`, and create the tmp with `0o600` up front (it must never be more permissive than the destination).
- **Status:** OPEN. (Blocked by path in the pre-commit hook as a stopgap.)
