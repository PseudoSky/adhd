# BACKLOG — @adhd/environment family

> `ARCHITECTURE.md` in this directory is the authoritative, zero-config-redesigned contract for
> `environment-base-spec`/`environment-builder`/`environment-core-node` (Wave 1, `59b07ec6`) /
> `agent-mcp` + `environment-cli` (Wave 2, `8b462c14`) / the `environment-cli` `verify`/`diff`/
> `config-get`/`doctor` commands + agent-mcp docs closeout (Wave 3, this pass). Do not use this file
> as a spec for the current TS packages — read `ARCHITECTURE.md` instead.
>
> The original cross-language (Python/Rust) code-review findings (`ENV-CORE-001`..`015`), the
> `environment-cli` command-parity debt (`DEBT-ENV-CLI-001`), and the stale plan-doc hash placeholder
> (`ENV-CORE-013`) that previously lived in this file are all now closed (RESOLVED, MOOT-BY-DELETION,
> or MOOT-BY-SUPERSESSION) — see the repo root `CHANGELOG.md` for the full record of what each one
> was, how it was resolved or why it no longer applies, per this repo's disclosure discipline
> (`AGENTS.md` §Disclosure: BACKLOG holds only open work, CHANGELOG is the permanent record). Two
> genuinely open items remain below: `DEBT-ENV-CLI-002` (no runnable CLI executable exists yet) and
> `ENV-SEC-004` (pre-existing git-history secrets).

---

### DEBT-ENV-CLI-002 — `environment-cli` has no runnable CLI executable — only an `api.ts`/`core.ts` library surface
- **Discovered:** 2026-07-18, `environment-redesign` worktree, Wave 3, while closing `DEBT-ENV-CLI-001` (re-adding `verify`/`diff`/`config-get`/`doctor`).
- **Detail:** `entrypoint/environment-cli/project.json` has no `generate-cli` target (verified: `npx nx show project environment-cli --json` lists only `lint`/`test`/`build`), unlike its sibling `entrypoint/dispatch-cli`, which wires `generate-cli` (`@adhd/apigen-generator-nx:generate`, `type: "cli"`) into `test`'s `dependsOn` and drives the generated `dist/entrypoint/dispatch-cli/cli/cli.ts` in a real smoke test. `environment-cli`'s `package.json` has no `bin` field either. Grepping the whole repo tree confirms no `bin/cli.ts` (hand-written, as `dispatch-cli` has as a documented fallback) or generated `cli.ts` was ever produced for this package. Consequently all 9 commands (`init`/`build`/`set`/`status`/`export`/`verify`/`diff`/`config-get`/`doctor`) are reachable today only via direct `import { ... } from '@adhd/environment-cli'` — there is no `adhd-env <command>` terminal invocation a human or script can actually run, despite `ARCHITECTURE.md` §4 and every doc comment in `api.ts`/`core.ts` describing CLI invocation syntax (`adhd-env verify <project> <specPath> ...`) as if one existed.
- **Impact:** Low — `ARCHITECTURE.md` §4 explicitly demotes this CLI to "thin, optional wrapper... never required for a consumer to run" (the real `Environment<T>` class is the primary, self-sufficient API), so nothing depends on a terminal entrypoint existing. But the package's own name (`environment-cli`) and its doc comments promise one, and currently deliver none.
- **Fix direction:** either (a) add a `generate-cli` target mirroring `dispatch-cli`'s (`@adhd/apigen-generator-nx:generate`, `source: src/api.ts`, `type: cli`, wired into `test`'s `dependsOn`) plus a real driving smoke test against the generated binary, or (b) hand-write a thin `commander` wrapper (`bin/cli.ts`) over the same `api.ts` surface if the apigen generator hits the same schema-resolution class of bug `dispatch-cli`'s own `bin/cli.ts` header documents (`BUG-APIGEN-CLI-001`-adjacent), or (c) if a terminal entrypoint is never actually wanted, drop the `-cli` naming/CLI-syntax doc comments so the package doesn't advertise a capability it doesn't have.
- **Status:** OPEN — not blocking (per `ARCHITECTURE.md` §4, this CLI is optional/non-required tooling; every command is fully exercised and tested via its `api.ts` function surface, per `DEBT-ENV-CLI-001`'s closure in `CHANGELOG.md`).

### ENV-SEC-004 — REPO — `check-no-credentials.js --all` reports 7 pre-existing secrets in git history
- **Where:** committed git history (1696 commits), surfaced by `gitleaks` in the hook's `--all` audit mode. NOT introduced by any `@adhd/environment` work — `gitleaks dir packages/environment` over the full working tree reports "no leaks found".
- **Description:** `--all` runs `gitleaks git` over the whole commit history and finds 7 historical leaks (the backlog the `48ab824f` "add credential pre-commit gate" commit was created to stop growing). The pre-commit `--staged`/`--range` modes only scan new changes and are unaffected; only the audit/backfill `--all` mode surfaces the historical backlog.
- **Status:** OPEN (repo-wide, out of scope for `packages/environment`) — remediate via history scrub / documented allowlist of the 7 known findings. **Explicitly left open per instruction — do not touch git history.**

---

## Sox-Ecosystem Adoption Gap Tasks (2026-07-21)

Feature gaps discovered during the sox-ecosystem adoption survey at
`docs/environment/adoption-survey/`. Full specifications in `GAP_SPECS.md`
and `GAPS_TO_ARCHITECT.md` in that directory.

- **SOX-ENV-G1** — Non-`ADHD_*` Env Var Allowlist. `FieldSpec.env` alias for
  config entries backed by external env vars + spec-level `externalEnv` with
  built-in defaults (`HOME`, `PATH`, `TZ`, etc.) for system pass-through.
  Blocks all G1-tagged packages. **SPECIFIED** in `GAP_SPECS.md`.
- **SOX-ENV-G2** — Write Paths Outside Scope Root. `DirSpec.location` escape
  hatch for OS-mandated/legacy dirs, `bundleId` for monorepo path templates,
  `scopeRoots` per-scope overrides. Blocks Phase 3 path schema finalization.
  **SPECIFIED** in `GAP_SPECS.md`.
- **SOX-ENV-G3** — Dynamic / Extension Config via Env Var Auto-Scaffolding.
  Structured env var naming (`ADHD_<PROJECT>__<KEY>`) auto-maps to config tree
  entries. Design questions in `GAPS_TO_ARCHITECT.md`.
- **SOX-ENV-G4** — Extended Directory Kinds. Add `sockets`, `locks`, `stores`,
  `backups` to `DirKind` union. **SPECIFIED** in `GAP_SPECS.md`.
- **SOX-ENV-G5** — Language-Neutral Spec Artifact. `generateSpecArtifact()`
  serializes resolved spec to JSON Schema for non-Node consumers. **SPECIFIED**
  in `GAP_SPECS.md`.
- **SOX-ENV-G6** — Multi-File Merged Config Sources. `sources.files` glob
  pattern for additional config files at different cascade precedence levels.
  **SPECIFIED** in `GAP_SPECS.md`.

> **ID note:** this finding was originally filed as `ENV-SEC-002`; that id was already assigned to the
> leaked `nxCloudAccessToken` in the repo-root `BACKLOG.md`. Renumbered to **ENV-SEC-004**. Its
> substance is correct and has a root-`BACKLOG.md` counterpart: **ENV-SEC-001** (FontAwesome npm token)
> and **ENV-SEC-002** (Nx Cloud token) are two of the seven, both on `origin/main` of a PUBLIC repo, both
> **awaiting rotation**. `--all` mode's exit 1 is that history, not this working tree.
