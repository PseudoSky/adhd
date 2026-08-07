# `@adhd/environment` Adoption Survey — Synthesis

> Cross-ecosystem survey of which packages would benefit from adopting the zero-config
> `@adhd/environment` package, what they store today, and what the package does **not**
> yet support. Generated 2026-07-20. Method + reproducibility in §5.

## 1. Executive summary

- **89 packages** across 3 roots (`~/dev/node/adhd`, `~/dev/ai/sox-ecosystem`, `~/dev/ai/scratch`) carry at least one runtime-config signal (env read / fs write / logging / config file / DB). Of those, **46 got a full per-package analysis + a proposed `EnvironmentSpec`**; 20 got a fast screen; 19 were auto-screened as build-config-only noise.
- **31 genuine adoption targets** (30 from the deep tier + 1 from the screen): **11 `adopt` as-is**, **20 `adopt-after-gap`**. **35 packages are `skip`** (bedrock/spec/type-only, build/dev tooling, pure libraries, or non-`@adhd` scope).
- **Two gaps dominate and each blocks ~21 packages** — they are the real story of this survey:
  - **G1 — non-`ADHD_` env vars (21×):** packages read `DATABASE_PATH`, `OPENAI_API_KEY`, `PORT`, `CHROME_PATH`, etc. verbatim. The current prefix-guard model (`isEnvNameAllowed` → `ADHD_<PROJECT>_*`) can't express these without a rename.
  - **G2 — writes outside a scope root (21×):** packages write to `./data/*.db`, `cwd`-relative, or hardcoded absolute paths instead of a `.adhd/<project>/` scoped root.
- **The Rust/Python question is answered by demand:** only **5 packages** are non-Node (all Python, all G3), and every one is low/med value. **The data does not justify rebuilding a Python or Rust core** — a documented snapshot-consumer contract covers them more cheaply (§3, G3).

> **⚠️ Proof status — ZERO proven consumers (read before executing any of this).** `@adhd/environment` builds green and has unit tests (incl. a `config.zero-config.test.ts` with a negative control), but **no consumer has been driven end-to-end through its real seam.** agent-mcp is *wired* but **not proven**: its integration harness stubs `testConfig`, and the live-model path is `AGENT_MCP_LIVE`-gated (off by default). By AGENTS.md §7's bar that is unit-level evidence, not proof. **Everything below is a plan against an unproven foundation** — the sequencing in §7 makes proving one real consumer the mandatory Step 0.

## 2. Adoption ranking (the 31 targets)

Sorted by value, then by lowest migration effort. `gaps` are the blockers that must be closed first for `adopt-after-gap`.

### Tier 1 — high value, adopt now / low friction
| package | root | rec | effort | gaps | note |
|---|---|---|---|---|---|
| `@adhd/agent-mcp` | adhd | adopt | **wired, NOT proven** | — | reference consumer — spec is the model, but adoption is **unproven end-to-end** (stubbed harness, live path gated off); see §7 proof gate |
| `@adhd/agent-core-provider` | adhd | adopt | low | — | shared registry DB; clean fit |
| `@adhd/agent-store-tools` | adhd | adopt | low | G2 | shared `registry.db` |
| `@adhd/dispatch-cli` | adhd | adopt | low | G2 | |
| `@adhd/apigen-plugin-logger` | adhd | adopt | low | G2,G8 | owns a log destination |
| `@adhd/sox-task-queue` | sox | adopt | low | G2,G3,G5,G8 | |
| `@adhd/sox-extension-memory-flush` | sox | adopt | med | — | |
| `@adhd/agent-core-policy` | adhd | adopt-after-gap | med | G1 | shared registry DB |
| `@adhd/sox-memory-core` | sox | adopt-after-gap | med | G2,G5 | central memory store |
| `@adhd/sox-host-runtime` | sox | adopt-after-gap | med | G1,G5 | data-paths + log-manager + lock — env's whole feature set |
| `@adhd/sox-mcp-runtime` | sox | adopt-after-gap | med | G1,G2 | |
| `@adhd/sox-extension-memory-cli` | sox | adopt | med | G1,G2,G5,G8 | |

### Tier 2 — high value, higher effort (worth it)
| package | root | rec | gaps |
|---|---|---|---|
| `@adhd/agent-store-prompts` | adhd | adopt-after-gap | G1,G2 — writes `./data/registry.db` (repo-root anti-pattern; 4 dependents share it) |
| `@adhd/agent-engine-compiler` | adhd | adopt-after-gap | G1 |
| `@adhd/sox-cli` | sox | adopt-after-gap | G1,G3,G7 |
| `@adhd/sox-install-engine` | sox | adopt-after-gap | G1,G2,G4,G5,G8 — the widest gap surface in the survey |
| `scratch-refactor` | scratch | adopt | G2,G5 |
| `scratch-agent-search` | scratch | adopt-after-gap | G1,G2 |
| `space-recovery` | scratch | adopt-after-gap | G2,G3 (Python) |

### Tier 3 — medium value
`@adhd/agent-engine-orchestrator` (G1,G2) · `@adhd/apigen-engine-runtime` (G2) · `@adhd/apigen-cli` (G1,G2) · `@adhd/apigen-python-env` (G1,G8) · `@adhd/dispatch-orchestrator` (G2,G8) · `@adhd/sox-embedding-provider` (G1) · `@adhd/sox-extension-tokenguard` (G1,G2,G4,G7,G8) · `@adhd/apigen-plugin-py-flask` (G1,G3) · `@adhd/apigen-plugin-py-grpc` (G1,G3) · `@adhd/apigen-engine-conformance` (G2) · `@adhd/sox-blob-store` · `@adhd/cdp-connection` (screen; `CHROME_PATH` + runtime state)

Per-package proposed `EnvironmentSpec` + file-location table live in each `<root>/<pkg>.md`.

## 2a. Logging audit (across the 31 adoption targets)

Each target report now carries a `logging` frontmatter block + a **Logging audit** section. Aggregate:

| Dimension | Finding |
|---|---|
| **Emits logs** | 22 yes / 9 no |
| **Mechanism** | console 13 · none 9 · pino 4 · custom 4 · custom `LogManager` 1 |
| **Persists log FILES to disk** | **only 7** — `apigen-cli`, `apigen-engine-runtime`, `apigen-plugin-logger`, `sox-cli`, `sox-extension-tokenguard`, `sox-host-runtime`, `scratch-agent-search`. The rest log to stdout/stderr only. |
| **Structured (JSON)** | 5 yes · 4 partial · 22 plaintext — **most logging is unstructured** |
| **Error handling** | 18 robust · 12 adhoc · 1 none |
| **Would benefit from `env.paths.logs`** | **12** (kind:`logs`, `share:'per-instance'` so concurrent instances never clobber each other's log files) |

**Takeaways:**
- The **7 file-persisting packages each pick their own log path** — this is the concrete win for `env.paths.logs`: a scoped, per-instance `~/.adhd/<project>/<ns>/logs/` destination instead of ad-hoc paths. `sox-host-runtime` (a custom `LogManager` + `data-paths` + `lock`) is the strongest single case — it hand-rolls almost the entire environment feature set.
- The 22 plaintext / stdout-only loggers are lower-urgency but would gain a consistent structured destination for free on adoption.
- 12 targets are flagged `maps_to_env_logs:true` even where they only log to stdout today — i.e. adoption is an opportunity to start persisting structured logs, not just a migration of existing files.

## 2b. File-location corrections (new standard)

Every target report's **file-location table** now maps each current path to its corrected location under the environment scheme: `~/.adhd/<project>/<namespace|default>/<kind>/<file>` (global scope), with the project-scope variant `<projectRoot>/.adhd/<project>/<namespace>/…`. Example (agent-store-prompts): `./data/registry.db` → `~/.adhd/adhd-registry/default/data/registry.db` via `env.files.registryDb`.

> **Path-scheme note:** for the four packages sharing the registry DB (`agent-store-prompts/-tools`, `agent-core-policy/-provider`), the analysts used the **logical shared project id** (`adhd-registry`) in the `<project>` slot rather than each package's own name — which is correct, since a shared store must resolve to ONE path for all four consumers, not four divergent ones. Standalone packages use their own bare package id. This is the intended behavior of the `Environment(project, …)` first argument.

## 2c. Shared-config clusters — packages that should share ONE config

Several packages don't just each *adopt* environment independently — they read the **same env vars and open the same stores**, so they should resolve **one shared config** (all constructing `new Environment(<sharedProjectId>, <sharedSpec>)` against the same project id + namespace, importing one exported spec module rather than each re-declaring the paths). Evidence from the report frontmatter:

| Cluster | Packages | Shared config (evidence) | Strength |
|---|---|---|---|
| **Agent registry** | `agent-store-prompts`, `agent-store-tools`, `agent-core-policy`, `agent-core-provider`, `agent-engine-compiler` (+ host `agent-mcp`) | `DATABASE_PATH` (5×) / `REGISTRY_DATABASE_PATH` (2×); all open the **same `registry.db`** | **Highest** — already a live coordination hazard (change one path, break four). One `agent-registry` config → one `env.files.registryDb`. |
| **SOX host / sandbox** | `sox-cli`, `sox-host-runtime`, `sox-host-registry`, `sox-install-engine` | `SOX_ECOSYSTEM_HOME` (3×), `SOX_SANDBOX_ROOT` (3×) — the base install/sandbox roots | High — one `sox-host` config defines the roots + derived `data`/`run`/`state` dirs. |
| **SOX permission policy** | `sox-extension-memory-server`, `sox-extension-tokenguard`, `sox-mcp-runtime` | `SOX_PERM_ENFORCE`, `SOX_PERM_FS_READ`, `SOX_PERM_FS_WRITE` (3× each) | High — **config-only, zero store to coordinate** → cleanest, lowest-risk consolidation. |
| **SOX memory bundle** | `sox-extension-memory-cli`, `sox-extension-memory-server` (+ `sox-memory-core`, `sox-extension-memory-flush`) | `SOX_CONFIG_DB_PATH` (2×) + same memory store | Medium — one `sox-memory` config for the store path + namespace. |
| **Agent provider credentials** | `agent-mcp`, `agent-engine-orchestrator` | `ADHD_AGENT_ANTHROPIC_SECRET` + the `ADHD_AGENT_<provider>_{SECRET,BASE_URL,MODEL}` family | Medium — a facet of the agent cluster; `agent-mcp/config.ts` already models it. |

**Weaker (shared *field*, not a shared config surface):** `APIGEN_PYTHON` (`apigen-cli` ↔ `apigen-python-env`), `SOX_EMBED_CACHE_DIR` (`sox-cli` ↔ `sox-embedding-provider`), `SOX_PROXY_BACKEND` (`sox-cli` ↔ `sox-extension-memory-server`) — one shared value each, model as a shared field.

**Do first:** the **agent-registry** cluster (highest value + live hazard) and the **sox-permissions** cluster (config-only, near-zero risk).

## 2d. Cross-language sharing — the unsolved half of the original rationale

`@adhd/environment` was conceived as two halves: **(1) a shareable static configuration**, and **(2) language-specific clients that operate on it.** The redesign shipped both — **but only for TypeScript** (the Node-only decision deleted the Py/Rust cores). That leaves a real gap the survey confirms:

**A non-Node package cannot operate on the same env config without re-declaring the spec AND re-implementing resolution.** This is correct, because today:
- The **spec is a TS *code* literal** (`EnvironmentSpec<T>` in each `config.ts`) — not a language-neutral artifact a Python/Rust process can read.
- **Resolution is Node-only** — the cascade, scope detection, dir/share resolution, and env-ref logic exist only in `environment-core-node`.

**Survey evidence this bites already:** `apigen-plugin-py-flask` / `apigen-plugin-py-grpc` **pass raw `process.env` verbatim to the spawned Python subprocess** and hand "configuration ownership" to the generated `apigen_python` server — a passthrough hack, not shared config. `apigen-python` (the Python runtime lib) is `supported_by_env: no` (G3/G2). Standalone Python (`space-recovery`, `dust`, `photo-atlas`) can't touch the system at all.

**What partially bridges it today — the snapshot.** The redesign deliberately kept `env.write()` → a resolved, language-neutral JSON snapshot that *any* language reads with plain JSON parsing (no client, no spec re-declaration). This covers **consuming already-resolved values** cross-language. It does **not** cover: a non-Node package resolving *independently*, `at:'runtime'` live-env fields (a static snapshot is a point-in-time read), env-ref **secret** resolution on the far side, or schema **validation** without the schema. And something (a TS process) must resolve + write the snapshot first.

**The architecture that realizes (1)+(2) without duplication** — spec as data, resolver as the only per-language piece:
1. **Make the spec a language-neutral artifact** (author it as JSON/YAML, or *generate* it from the TS spec via the already-salvaged `generateFieldSchema`). This is the "static configuration that would be shareable" — one source of truth, not one-per-language.
2. **Ship a *thin* resolver per language** that reads the neutral spec + snapshot and resolves the same cascade — the "language-specific client." Only the small, mechanical resolver is per-language; the **configuration is not duplicated**. This is materially less than the deleted full-parity Py/Rust cores (which re-declared the spec + logic + contentHash equivalence vectors).

**Recommendation (revises F5):** the survey's demand (5 low/med Python pkgs) still doesn't justify building full per-language clients *now*. But the **interop contract should be designed in even while Node-only**: treat the **neutral spec artifact + snapshot** as the cross-language seam, and don't let the spec ossify as TS-only code. Then cross-language becomes a *thin-resolver add* later, not a re-architecture — and the passthrough hacks in the apigen Python plugins get a real home. The immediate, zero-new-code option for the apigen case is the **snapshot-consumer** path (TS resolves + writes; the generated Python service reads the snapshot instead of raw `process.env`).

## 3. Environment feature backlog (deduped from all gap tags)

What `@adhd/environment` must add to actually cover the ecosystem, ranked by how many packages each unblocks:

| # | Gap | Pkgs | What's missing | Recommendation |
|---|---|---|---|---|
| **F1** | **G1** | **21** | Reading env vars **not** under the `ADHD_<PROJECT>_` prefix (`DATABASE_PATH`, `OPENAI_API_KEY`, `PORT`, `CHROME_PATH`, provider creds). `isEnvNameAllowed` rejects them. | **Highest priority.** Add an explicit **env-alias / external-env allowlist** on a `FieldSpec` (`env` name that bypasses the prefix guard, plus a spec-level `externalEnv: string[]` passthrough). agent-mcp already needs this for provider creds (it uses `envPrefixOverride` as a workaround). Without F1, 2/3 of the ecosystem stays `adopt-after-gap`. |
| **F2** | **G2** | **21** | Packages write to `./data/…`, `cwd`, or hardcoded absolute paths — outside any `.adhd/<project>/` root. | Mostly a **migration cost, not a missing feature** (env's scoped roots are the fix). Ship: (a) a **migration codemod** that rewrites `./data/x.db` → `env.files.x`, and (b) a documented `legacyPath` escape hatch for the few genuinely-external system paths. Prioritize the shared `./data/registry.db` cluster (agent-store-prompts/-tools, agent-core-policy/-provider) — a **known BACKLOG item** (AGENTS.md §10). |
| **F3** | **G5** | **7** | Config with **dynamic/arbitrary keys** (open maps, user-defined sections) not expressible as fixed dot-path `FieldSpec`s. | Add a **`record`/passthrough section** type: a config key whose value is an open `Record<string,V>` resolved from the same cascade. |
| **F4** | **G8** | **7** | Directory **kinds outside the 7** (`data|logs|cache|state|run|temp|config`) — unix sockets, pid files, plugin-install dirs, downloads. | Either add kinds (`socket`, `pid`, `install`) or allow a **custom `kind` string** with a documented base-dir mapping. Cheap. |
| **F5** | **G3** | **5** | **Non-Node (Python) packages** cannot operate on the same config without re-declaring the spec + re-implementing resolution (see **§2d**). | **Do not rebuild full py/rust cores** on this evidence (5 low/med pkgs). BUT design the **cross-language interop seam now**: (a) a **language-neutral spec artifact** (generate JSON/YAML from the TS spec via `generateFieldSchema`) + (b) the **snapshot** as the resolved-value channel any language reads. Immediate zero-code win: point the apigen py-flask/py-grpc generated servers at the **snapshot** instead of raw `process.env` passthrough. Full per-language *thin resolvers* only if G3 demand crosses ~double. |
| **F6** | **G7** | **2** | Value types beyond JSON-Schema primitives (nested object / union). | Low priority. Model as F3 (`record`) or nested dot-paths where possible. |
| **F7** | **G4** | **2** | Multi-file / globbed / merged config beyond the single-layer-file model. | Low priority; `sox-install-engine` is the main driver (it has a `config-merge` capability of its own). |

**Bottom line:** shipping **F1 + F2** alone converts most of the 20 `adopt-after-gap` targets into straightforward adoptions. F3/F4 are small and unblock the sox `*-runtime`/`install-engine` cluster. F5 (py core) is **not** warranted yet.

## 4. Screened out

- **Tier C (20 weak-signal):** 1 candidate (`@adhd/cdp-connection`), 19 skip — see [`TIER_C_screened.md`](TIER_C_screened.md). Skips are Nx executors, codegen generators, spec/type packages, pure libraries, and parameter-driven servers with a shared (non-owned) logger.
- **Tier D (19 build-config-only):** auto-screened, zero runtime surface — see [`TIER_D_screened.md`](TIER_D_screened.md). Matched only `vite.config.ts`/`vitest.config.ts`/`.babelrc`.

## 5. Method & reproducibility

1. **Inventory** (`manifest.jsonl`) — one deterministic ripgrep pass over the 3 roots; per-package signal detection (env/fs/log/config/db); emits only qualifying packages with their `flagged_files`. Regenerate: `python3 docs/environment/adoption-survey/scripts/inventory_scan.py`.
2. **Tiering** (`tiers.json`) — strong/medium/weak-code/noise by signal-kind count.
3. **Deep analysis** — one haiku subagent per package, all reading the shared contract at [`.claude/agents/env-adoption-analyst.md`](../../../.claude/agents/env-adoption-analyst.md) (fixed capability yardstick + G1–G9 gap taxonomy + output schema, incl. a **logging audit** block and a **file-location table corrected to the new-standard `~/.adhd/<project>/<namespace>/<kind>/` scheme**) so every `<root>/<pkg>.md` is uniform and cache-friendly. Each reads ONLY its flagged files. The 31 adoption targets (§2) were regenerated against this enhanced contract; the 35 `skip` reports retain the original schema (no logging audit / migration paths — they are not adopting).
4. **Screens** — Tier C one batched haiku; Tier D scripted.
5. **Synthesis** — this file, from parsed frontmatter (`.synth.json`).

Re-run any single package by dispatching the `env-adoption-analyst` contract against its `tiers.json` payload.

## 6. Prevention — auto-wiring the sox-ecosystem builders

The survey is the *cure* (retro-auditing 89 packages); wiring env into the scaffolders (`sox-authoring`'s `templates/{bundle,mcp-server,service}`, `writer.ts`) is the *prevention* — new packages born correct. **Advantageous, but only tiered + cluster-aware, not blanket:**

- **Why it helps:** G1 + G2 (21 packages each) are *authoring-time* defaults — a dev reaches for `process.env.X` and `./data/x.db` because that's the path of least resistance. A template that emits a zero-config `Environment` with `env.paths.*`/`env.files.*`/prefixed env makes the correct path the default one. And because env is zero-config, an unused wiring costs ~nothing at runtime.
- **Where NOT to (tier purity, AGENTS.md §8):** only wire templates that produce **runtime artifacts** (`service`, `mcp-server`, `bundle-member`, CLI, `store`/`engine`). Wiring `@adhd/environment` (a core/base family) into a generated `types`/`base`/pure-library template inverts the dependency flow and bloats the 35 `skip`-class packages.
- **Highest-leverage version — cluster-aware templates:** a new memory-bundle member should default into the `sox-memory` shared config; a permission-gated service into `sox-permissions`; a host lib into `sox-host` (§2c). The template imports the shared spec module and constructs `Environment(<sharedProjectId>, sharedSpec)` — so a new package *can't* drift into a fourth divergent registry path. Auto-wiring **without** this just mass-produces isolated configs; **with** it, it operationalizes §2c.
- **Prerequisites:** (1) **reachability** — `@adhd/environment` must be a resolvable dep in the *sox-ecosystem* repo (published to npm or workspace-linked); it currently lives in the adhd repo, unconfirmed as published. (2) **prove first** — see §7; templating an unproven API mass-produces a possibly-broken pattern (the exact §7 failure mode). (3) **Node-only** — templates can't wire env into any Python artifact they emit; those need the §2d snapshot seam.

## 7. Sequencing & the proof gate (do these in order)

The redesign landed days ago with **zero proven consumers** (see §1 callout). The entire adoption effort is gated on fixing that first:

- **Step 0 — PROVE ONE REAL CONSUMER (blocking).** Drive **agent-mcp** end-to-end through its real MCP host seam (`.mcp.json` → `mcp__agent-mcp__*`), with the real `Environment` resolving live — not the stubbed harness. Confirm the behaviors that matter: writes land in `~/.adhd/agent-mcp/…` (not `./data`), a set `ADHD_AGENT_*` var overrides at runtime, provider creds resolve via `resolveEnvName`, and a **live-model** run (`AGENT_MCP_LIVE=1`) exercises the full loop. Gate on **exit codes**, not "tests passed" (AGENTS.md §7). Until this is green, everything below is speculative.
- **Step 1 — migrate the highest-value cluster.** The **agent-registry** shared config (§2c): `agent-store-prompts/-tools`, `agent-core-policy/-provider`, `agent-engine-compiler` → one `agent-registry` spec + `env.files.registryDb`. Highest value, and it retires the live `./data/registry.db` coordination hazard. Prove it end-to-end the same way (second real exercise).
- **Step 2 — ship F1 + F2** (the two gaps blocking ~21 packages each) once the pattern is proven, so the remaining `adopt-after-gap` targets become straightforward.
- **Step 3 — the `sox-permissions` cluster** (§2c) — config-only, near-zero risk — as the first *sox-side* proof.
- **Step 4 — template the builders (§6)** only after ≥2 clusters are proven in the wild. Auto-wiring is **two proofs away, not zero.**

**Standing risk (must be cleared, not assumed):** "agent-mcp env adoption works end-to-end" is currently an *unverified assumption*, not a fact. No item in §2/§3/§6 is "done" while Step 0 is open.
