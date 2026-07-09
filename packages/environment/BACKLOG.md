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
- **Status:** RESOLVED (2026-07-09). Ported `fieldDefinitionToJsonSchema` whitelist to Python (`_field_definition_to_json_schema`) and Rust (`field_definition_to_json_schema`). Generated vector `adhd-metadata-stripped-from-leaf` (secret/env/scope/noEnv on the leaf) now graded in all three. Negative control: reverting Python to `dict(field_def)` turns `test_generate_field_schema_vector[adhd-metadata-stripped-from-leaf]` RED (exit 1).

### ENV-CORE-002 — CRITICAL — `contentHash`: astral-plane key ordering diverges → different digests per language
- **Where:** `index.ts:418` (`Object.keys().sort()`, UTF-16 code-unit order) vs `environment.py:80` (`sorted()`, code-point order) vs `lib.rs:644` (`str::cmp`, UTF-8 byte order == code-point order)
- **Description:** For BMP keys all three agree. For any key ≥ U+10000, JS orders on the leading surrogate (0xD800–0xDBFF) while Python/Rust order on the full scalar value. Verified by execution with keys `U+FFFF` and `😀 U+1F600`: JS sorts `["😀","￿"]` → `sha256-5c46ab8ff758495e…`; Python sorts `['￿','😀']` → `sha256-51978d06c8121942…`. Rust matches Python, not TS.
- **Impact:** The same config map content-addresses to two different hashes depending on language. This defeats the stated purpose of the cross-language content-addressing primitive.
- **Fix direction:** Define the canonical order in `SPEC.md` (code-point order is the portable choice; TS is the outlier and must sort by code point explicitly, e.g. via `Array.from`/`localeCompare`-free codepoint comparison). Add astral-key vectors.
- **Status:** RESOLVED (2026-07-09). Canonical order = **code point** (SPEC.md §4.1). TS `contentHash` now sorts via `codePointCompare` (`Array.from` + `codePointAt`), not default `.sort()`. Python `sorted()` / Rust `str::cmp` were already code-point. Generated vector `astral-plane-key-ordering` ({U+FFFF, U+1F600}) graded in all three. Negative control: reverting Python sort to UTF-16 code-unit order turns `test_content_hash_vector[astral-plane-key-ordering]` + `test_content_hash_astral_key_ordering_matches_reference` RED (exit 1).

### ENV-CORE-003 — HIGH — `projectEnvPrefix`: Rust folds `.`→`_`; TS and Python do not
- **Where:** `lib.rs:669` `.replace(['-', '.'], "_")` vs `environment.py:95` `.replace("-", "_")` vs `index.ts:437` `.replace(/-/g, '_')`
- **Description:** Verified: `projectEnvPrefix("foo.bar")` → TS `ADHD_FOO.BAR`, Python `ADHD_FOO.BAR`, Rust `ADHD_FOO_BAR`. Rust's own doc comment (`lib.rs:660`) documents the dot-folding, contradicting the other two. Note `inferEnvVar` correctly folds `.` in all three (`index.ts:457`, `environment.py:112`, `lib.rs:684`) — the inconsistency is `projectEnvPrefix`-only. `ADHD_FOO.BAR` is not a legal POSIX env-var name, so TS/Python arguably hold the latent bug and Rust silently "fixed" it — either way the contract is unspecified for dotted names and the three disagree.
- **Fix direction:** Specify the behaviour for dotted project names in `SPEC.md`, then make all three agree. Add a dotted-name vector.
- **Status:** RESOLVED (2026-07-09). Canonical = fold BOTH `-` and `.` (Rust's behaviour; SPEC.md §4.2). TS `projectEnvPrefix` → `.replace(/[.-]/g, '_')`; Python → `re.sub(r"[.-]", "_", ...)`; Rust unchanged. Generated vector `dotted-project-name` (`foo.bar` → `ADHD_FOO_BAR`) graded in all three. Negative control: reverting Python to `.replace("-", "_")` turns `test_project_env_prefix_vector[dotted-project-name]` RED (`ADHD_FOO.BAR != ADHD_FOO_BAR`, exit 1).

### ENV-CORE-004 — MEDIUM — `contentHash` serialization is non-injective; the plan's own gate vector is a collision point
- **Where:** `index.ts:421`, `environment.py:80`, `lib.rs:647-651` — all three share the `key=value\n` serialization with no escaping.
- **Description:** A key or value containing `=` or `\n` collides with a structurally different map. Verified by execution: `contentHash({"a":"1\nb=2"})` == `contentHash({"a":"1","b":"2"})` == `sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930` — **which is the exact digest the plan pins as its `contentHash` gate vector**. Config values routinely contain newlines (multi-line secrets, PEM keys, paths), so this is reachable, not theoretical. All three languages agree here, so it is a spec defect rather than an equivalence break.
- **Fix direction:** Length-prefix or escape the serialization (e.g. `len(k):k=len(v):v\n`), or document the assumption that keys/values are `=`/`\n`-free and validate it. Choose a non-degenerate gate vector regardless.
- **Status:** RESOLVED (2026-07-09). Adopted injective format **v2**: per sorted key, `<utf8Len(k)>:<k>=<utf8Len(v)>:<v>\n` (SPEC.md §4.1, `CONTENT_HASH_FORMAT_VERSION = 2`). Every pinned digest regenerated by the TS generator (all now v2). Old collision pair now distinct: `contentHash({a:"1\nb=2"})` = `sha256-6a4f8fe0…` vs `contentHash({a:"1",b:"2"})` = `sha256-66e4efeb…`. New gate vector `spec-example-unsorted-input` = `sha256-66e4efeb…464788` (non-degenerate). Injectivity guarded by `test_content_hash_serialization_is_injective` (Py) + `content_hash_serialization_is_injective` (Rs). The stale `9f86d081…` placeholder in `_shared.md`/`contract-base-spec.md`/`criteria.json audit-final.6` is now doubly superseded (v1→v2) and still needs a plan-doc fix — see ENV-CORE-013.

### ENV-CORE-005 — LOW — lone-surrogate keys: TS substitutes U+FFFD, Python raises
- **Where:** `index.ts:667` (`TextEncoder().encode()`) vs `environment.py:81` (`.encode("utf-8")`, no `surrogatepass`)
- **Description:** A key such as `"\uD800"` yields a hash in TS and a `UnicodeEncodeError` in Python. One produces a value, the other crashes. Not vector-covered.
- **Status:** RESOLVED (2026-07-09). All ports now reject lone surrogates with a typed `LoneSurrogateError` (TS `class`, Python `EnvironmentError` subclass). Rust `String` cannot hold a lone surrogate, so it is unreachable there by construction. Generated error-case vector `lone-surrogate-key-rejected` uses `inputKeyCodeUnits` (a literal surrogate is not portably JSON-serializable — `serde_json` rejects `\uD800`); the Rust suite skips it. Guarded by `test_content_hash_rejects_lone_surrogate` (Py). SPEC.md §4.5.

### ENV-CORE-006 — LOW — `Environment` snapshot path has no traversal guard
- **Where:** `environment.py:224` (`root / self.project / self.namespace / SNAPSHOT_FILENAME`), `lib.rs:410` (`from_snapshot_path`)
- **Description:** `project`/`namespace` are interpolated into the path with no sanitization; `project="../../../etc"` escapes `adhd_root`. Low severity while inputs are trusted; a hazard if they ever originate from user or network input.
- **Status:** RESOLVED (2026-07-09). Added a traversal guard (`_validate_path_segment` in Python, `validate_path_segment` + `EnvironmentError::InvalidPathSegment` in Rust) rejecting empty, `.`/`..`, path separators (`/`\`), NUL, and absolute segments — called in `Environment.__init__` / `Environment::new` before the path is derived. Guarded by `test_environment_rejects_traversal_in_{project,namespace}` + `test_traversal_guard_blocks_escape_before_read` (Py) and `environment_rejects_traversal_in_project_or_namespace` + `traversal_guard_blocks_escape_before_read` (Rs).

### ENV-CORE-007 — TEST-DEBT — the Python and Rust suites cannot fail against any of the above
- **Where:** `environment-core-py/tests/test_cross_language_vectors.py`, `environment-core-rs/src/lib.rs:762-932`
- **Description:** Both suites are 100% vector-replay: every assertion compares an implementation to a pinned string that was itself produced by one implementation. No test drives TS and a port against a **shared adversarial input** and asserts equality. Because the vectors omit astral keys, dotted project names, and adhd leaf metadata, all of ENV-CORE-001/002/003 pass green. `test_content_hash_unsorted_and_presorted_inputs_agree` and `content_hash_is_order_independent` only prove order-independence for `{a,b}`. Per the repo verification standard (§6.2), a test that stays green when the code is broken proves nothing.
- **Fix direction:** Add a conformance harness that generates adversarial inputs (astral keys, dotted names, secret leaves, `\n`/`=` values) and asserts `TS == Python == Rust` — ideally TS emits the vectors the ports consume, so the vectors cannot drift from the source of truth.
- **Status:** RESOLVED (2026-07-09). TS `generateCrossLanguageVectors()` (exported from `base-spec/src/index.ts`) now EMITS `cross-language-test-vectors.json` by running the real primitives — the file is generated, never hand-authored. Adversarial vectors added: astral-plane key ordering, dotted project name, secret-leaf metadata stripping, `\n`/`=` collision pair, Unicode case-folding, lone-surrogate error case. Python + Rust suites consume the emitted file. A drift guard in `environment-builder` (`cross-language vectors drift guard`) asserts the committed file deep-equals a fresh generation. **Teeth proven**: negative controls for 001/002/003 each turn the port suite RED (exit 1) — pasted in the executor report. SPEC.md §8.

### ENV-CORE-008 — GOOD (no action) — the `knownDiscrepancy` guard has teeth
- `test_known_discrepancy_is_documented_and_not_silently_patched` asserts the implementation does **not** emit the fabricated `9f86d081…` placeholder and **does** emit the recomputed `4a73850f…`, with a real negative assertion. Independently reproduced: `sha256("a=1\nb=2\n")` = `4a73850f…`. That part of the work is sound. (See ENV-CORE-004 for why the chosen vector is nonetheless degenerate.)

---

## Credential-handling defects (audit 2026-07-09)

### ENV-CORE-009 — CRITICAL — resolved snapshots persist `secret: true` values in plaintext
- **Where:** `environment-builder/src/snapshot-writer.ts` (`atomicWrite`), `config-resolver.ts`, `environment-base-spec/src/index.ts` (`SnapshotData`)
- **Description:** `SnapshotData` carries `config` ("fully resolved, nested config object") and `raw` ("flat, un-nested config (dot.path → value)"). `config-resolver.ts` never mentions `secret` — there is **no redaction anywhere in the package family** (`grep -rlE 'redact|maskSecret|\[REDACTED\]'` over `packages/environment` + `entrypoint/environment-cli` returns nothing). `atomicWrite` does `JSON.stringify(data)` on the whole object. The repo's own test asserts `raw['providers.openai.secret'] === 'sk-test'`, i.e. the resolved secret value is in the serialized payload. Every `adhd-environment.json` on disk therefore contains plaintext credentials.
- **Fix direction:** Snapshots must store a *reference* for `secret: true` fields (the env-var name), never the value; resolve secrets at read time in `Environment.get()`. If a resolved value must be cached, encrypt at rest and never write it to a repo-adjacent path.
- **Mitigated (not fixed):** `adhd-environment.json` + `.tmp` are now gitignored and blocked by path in `.githooks/check-no-credentials.js`. The plaintext file still exists on disk.
- **Status:** RESOLVED (2026-07-09). Added a secret-reference contract (`SECRET_REF_PREFIX = "adhd-secret-ref:"`, `makeSecretRef`/`isSecretRef`/`resolveSecretRef` in base-spec). Write side: `redactSecrets(raw, fields)` in `environment-builder`'s `config-resolver.ts` replaces each `secret:true` field's value with `adhd-secret-ref:<ENV_VAR>` before persistence (so `configHash` is computed over the redacted `raw`). Read side: `Environment.get("config.*")` resolves the reference from the environment at read time in Python (`os.environ`) and Rust (`std::env::var`). Guarded by: `test_secret_reference_resolves_from_environment`, `test_secret_reference_returns_none_when_env_unset`, `test_secret_plaintext_never_on_disk` (Py); `secret_reference_resolves_from_environment`, `secret_plaintext_never_on_disk` (Rs); `redactSecrets` unit tests + the atomicWrite "secret is a reference, never the plaintext" test asserting the value is absent from the file bytes (builder). SPEC.md §7. **NOTE:** the TS runtime reader (`environment-core-node`) was OUT OF SCOPE for this pass and still needs the same read-side resolution — see ENV-CORE-014.

### ENV-CORE-010 — HIGH — snapshot written with default umask (world-readable), no `mode` passed
- **Where:** `snapshot-writer.ts:59-66` — `atomicWrite(filePath, data, opts)`; `opts.mode` is optional and **no caller passes it**, so `writeFileSync` uses the platform default (typically `0644`).
- **Description:** A file containing plaintext credentials (ENV-CORE-009) is created world-readable on a multi-user host.
- **Fix direction:** Default `mode` to `0o600` for the snapshot, and `chmod` the containing directory to `0o700`.
- **Status:** RESOLVED (2026-07-09). `atomicWrite` now defaults `mode` to `0o600` (`DEFAULT_SNAPSHOT_FILE_MODE`) and the parent dir to `0o700` (`DEFAULT_SNAPSHOT_DIR_MODE`), and `chmod`s both explicitly to defeat umask. Guarded by the "creates the snapshot 0o600 and its parent directory 0o700" test (asserts `statSync(...).mode & 0o777`).

### ENV-CORE-011 — HIGH — `atomicWrite` leaves a plaintext `<file>.tmp` behind on failure
- **Where:** `snapshot-writer.ts:61-66`
- **Description:** `writeFileSync(tmpPath, …)` then `renameSync(tmpPath, filePath)` with no `try/finally` and no `unlink` on error. The module's own doc comment concedes: "at worst a stale `.tmp` is left behind if the process is killed mid-write." That stale `.tmp` holds the same plaintext secrets, at the same default mode, and is not covered by any cleanup.
- **Fix direction:** `try { write; rename } catch (e) { unlinkSync(tmpPath) ; throw e }`, and create the tmp with `0o600` up front (it must never be more permissive than the destination).
- **Status:** RESOLVED (2026-07-09). `atomicWrite` creates the tmp at `0o600` up front, wraps write+rename in `try/catch`, and `unlinkSync`es the tmp on any failure before rethrowing. Guarded by the "unlinks the .tmp and rethrows when the rename fails" test (forces a rename failure by making the destination a non-empty directory, then asserts no `.tmp` remains).

---

## Newly discovered during the ENV-CORE-001..011 fix pass (2026-07-09)

### ENV-CORE-012 — LOW — `noEnv` secret fields lose their value at read time under redaction
- **Where:** `environment-builder/src/config-resolver.ts` `redactSecrets`.
- **Description:** A `secret: true` field that is ALSO `noEnv: true` (settable only via the `adhd-env set` store / default, never from an env var) is still redacted to `adhd-secret-ref:<inferred-env-name>`. At read time `Environment.get` resolves that env var, which is by definition never set, so the field reads back as `undefined`/`None` — the store-provided secret value is lost. Redaction correctly never leaks the plaintext (the security goal holds), but the round-trip is broken for this edge case.
- **Fix direction:** Either forbid `noEnv + secret` at validation time, or persist an encrypted-at-rest value for noEnv secrets rather than an env reference. Decide the product behaviour first.
- **Status:** OPEN (edge case; no consumer hits it today — no `noEnv+secret` field exists in-tree).

### ENV-CORE-013 — DOC — plan documents still pin the stale `9f86d081…` contentHash placeholder
- **Where:** `docs/plan/adhd-environment/contexts/_shared.md` (`[def:contentHash]`), `contexts/contract-base-spec.md` (Delta Spec #2), `scripts/criteria.json` (`audit-final.6`).
- **Description:** These pin `contentHash({b:"2",a:"1"}) == sha256-9f86d081…` (the SHA-256 of the literal string `"test"`, a placeholder never computed from the algorithm). It was superseded by the v1 computed value and again by the v2 injective value (`sha256-66e4efeb…`, ENV-CORE-004). The `criteria.json audit-final.6` gate will assert the wrong hash. Out of scope for the `packages/environment` source tree (docs/plan is not editable in this pass).
- **Status:** OPEN — needs a plan-doc fix pass.

### ENV-CORE-014 — HIGH — TS runtime reader (`environment-core-node`) does not resolve secret references
- **Where:** `packages/environment/environment-core-node` (`@adhd/environment`) `Environment.get`.
- **Description:** ENV-CORE-009's read-side secret-reference resolution was implemented in the Python and Rust runtime clients, but `environment-core-node` was OUT OF SCOPE for this pass. A TS consumer reading a redacted snapshot would get the literal `"adhd-secret-ref:<ENV_VAR>"` string back instead of the resolved secret. The base-spec exports `resolveSecretRef` ready to wire in.
- **Status:** OPEN — apply the same `resolveSecretRef` step in `environment-core-node`'s config accessor.

### ENV-SEC-004 — REPO — `check-no-credentials.js --all` reports 7 pre-existing secrets in git history
- **Where:** committed git history (1696 commits), surfaced by `gitleaks` in the hook's `--all` audit mode. NOT introduced by this pass — `gitleaks dir packages/environment` over the full working tree reports "no leaks found", and no commit was made this session.
- **Description:** `--all` runs `gitleaks git` over the whole commit history and finds 7 historical leaks (the backlog the `48ab824f` "add credential pre-commit gate" commit was created to stop growing). The pre-commit `--staged`/`--range` modes only scan new changes and are unaffected; only the audit/backfill `--all` mode surfaces the historical backlog.
- **Status:** OPEN (repo-wide, out of scope here) — remediate via history scrub / documented allowlist of the 7 known findings.

> **ID note:** the pre-existing-history finding above was originally filed as `ENV-SEC-002`; that id was already
> assigned to the leaked `nxCloudAccessToken` in the repo-root `BACKLOG.md`. Renumbered to **ENV-SEC-004**.
> Its substance is correct and now has a root-`BACKLOG.md` counterpart: **ENV-SEC-001** (FontAwesome npm token)
> and **ENV-SEC-002** (Nx Cloud token) are two of the seven, both on `origin/main` of a PUBLIC repo, both
> **awaiting rotation**. `--all` mode's exit 1 is that history, not this working tree.

### ENV-CORE-015 — HIGH — `environment-builder`'s public entrypoint exports only the nx scaffold stub
- **Where:** `packages/environment/environment-builder/src/index.ts`
- **Description:** `require('<dist>/environment-builder')` yields exactly one export: `environmentEnvironmentCoreBuilder`. `redactSecrets`, `atomicWrite`, `build` and the rest of the pipeline are implemented but **unreachable from the package surface**. Consequence: the ENV-CORE-009/010/011 credential fixes cannot be exercised through the consumer seam — only through their unit tests. (Both fixes' tests were negative-controlled and do have teeth: passthrough redaction → exit 1; `0o644` mode → exit 1.)
- **Not a regression:** wiring `src/index.ts` is `builder-snapshot-api`'s declared job and that state is `pending`; its guard is correctly RED for this exact reason.
- **Status:** OPEN — tracked so the export wiring is not forgotten when `builder-snapshot-api` runs.
