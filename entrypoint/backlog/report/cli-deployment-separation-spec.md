# CLI Deployment Separation — Implementation Specification

**Status:** SPEC (design only; no code/config/bin/store has been modified by this document).
**Author:** architect, 2026-09-22.
**Scope:** the `@adhd/backlog` CLI/MCP deployment on this machine — bin names, per-host skills,
per-host instruction files, per-host MCP registrations, production relocation, and the
beta / main-local / production tier split via the `@adhd/environment` namespace cascade.
**ADR catalog:** the `adhd` repo has **no** `docs/decisions/`. The governing catalog is
`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (17 ADRs, 0001–0017, all read for this spec).
Load-bearing for this design: **ADR-0004** (data root vs. sandbox switch; placement targets the real
host; `[inv:data-root-never-reroutes]`), **ADR-0002** (host registry / `install-skill` placement),
**ADR-0011** (the backlog tool is the write destination), **ADR-0012** (multi-process write invariant —
concurrent sessions on one store are sanctioned), **ADR-0013** (feature switches are typed config,
**never** env vars), **ADR-0003/0005** (content-addressed identity; npm version selects bytes only),
**ADR-0014** (snapshot retention is report-first, never automatic), **ADR-0015** (PROPOSED, never
accepted — **do not adopt**). This spec violates none of them.

---

## 0. Diagnosis — why agents report "completely broken"

Five independent fault lines, each sufficient on its own to break an agent. Verified from disk.

**F1 — The canonical bin does not exist; the ambiguous one is live and points into a worktree.**
`entrypoint/backlog/package.json` declares `bin: { "adhd-backlog": "./dist/index.js" }`
(`entrypoint/backlog/package.json:4-6`) — the collision-avoiding name. But the only backlog shim on
`PATH` is **`~/Library/pnpm/backlog`**, whose body execs
`/Users/nix/dev/node/adhd/.worktrees/backlog-cutover/entrypoint/backlog/dist/index.js`
(`~/Library/pnpm/backlog:18-20`; the shell's own snapshot confirms `backlog=/Users/nix/Library/pnpm/backlog`
and no `adhd-backlog` entry — `~/dot/etc/shell-manager/golden.snap:7747`). So:
`adhd-backlog …` → **command not found**; `backlog …` → **the frozen worktree build**.
`sync-global.mjs` — the release-train's global-CLI currency enforcement — only looks for shims named by
each entrypoint's declared `bin` (`tools/nx-plugins/build/executors/sync-global/sync-global.mjs:233-235,584`),
i.e. `adhd-backlog`; finding none it reports `not-installed` / `verified=null` and **cannot see or fix
the `backlog` shim agents actually invoke**. A structural blind spot.

**F2 — Three divergent command surfaces; the installed skills match none of the deployed one.**
| Surface | Verbs | Identity | Where it is installed/used |
|---|---|---|---|
| **v1** | 36 flat ops (`create-item`, `list-items`, `--repo`/`--human-id`; MCP `backlog_client_d_*`) | `humanId` | `~/.claude/skills/backlog/SKILL.md` |
| **v2** | 6 verbs (`get/query/create/update/relate/admin`) at top level; registry-as-`view:"lookup"` | `humanId` | `~/.config/opencode/skills/backlog/SKILL.md`; `entrypoint/backlog/skill/SKILL.md` (main checkout, 0.2.0) |
| **v3** | 14 verbs under a **`backlog` CLI namespace** (`adhd-backlog backlog get …`); `lookup`/`upsert-project`/`upsert-component`/`upsert-location`/`rm-location` as first-class verbs | `uid` | **the frozen cutover build (live production)** — `.worktrees/backlog-cutover/entrypoint/backlog/skill/SKILL.md`; `.worktrees/backlog-v2/entrypoint/backlog/skill/SKILL.md` |

So claude agents follow v1 → `exit 4` (unknown command); opencode agents follow v2 → v3 rejects
(`backlog query` is not a v3 top-level command; v3 requires the `backlog` segment); and even the v3
skill instructs `adhd-backlog`, which does not exist (F1). `~/.config/opencode/skills/backlog/extension.json`
declares `"version": "1.0.0"` while its sibling `SKILL.md` documents the 0.2.0 (v2) surface — the two
disagree in the same directory.

**F3 — Production lives in a git worktree, pinned by absolute path in three places.**
`~/Library/pnpm/backlog:18`, `~/.claude.json` `mcpServers.backlog.args[0]` (line 3373), and the
committed repo `.mcp.json:21` all hardcode
`/Users/nix/dev/node/adhd/.worktrees/backlog-cutover/entrypoint/backlog/dist/index.js`. A
`git worktree remove` / cleanup deletes production.

**F4 — Per-host MCP registrations diverge.**
claude: `~/.claude.json` `mcpServers.backlog` = stdio `node <cutover dist> serve --transport mcp`.
repo: `.mcp.json` `backlog` = the same cutover dist. opencode: `~/.config/opencode/opencode.json` has
`mcp` entries for `agent`, `search`, `memory-server`, `gitnexus` — and **no `backlog` server at all**
(`~/.config/opencode/opencode.json:53-84`). opencode agents therefore have no `mcp__backlog__*` tools;
claude agents get tools from the frozen v3 build while their skill tells them to call v1 names.

**F5 (hygiene, not a cause) — production store dir carries legacy + churn debris.**
`~/.adhd/backlog/production/data/` holds the live `backlog-v2.db` (+`-wal`/`-shm`) alongside the
legacy `backlog.db` (+`.corrupt-20260814/0817` backups), ~35 `*.tshm.stale-*` / `*-shm.stale-*`
sidecar files, `backlog-v2.db.serve.lock`, and `backlog-v2.db.sox-lease.d/`. Not the cause of
"broken", but a diagnostic signal and a retention item (handle per ADR-0014 — report-first, never
auto-delete).

The single sentence that explains the report: **every installed instruction surface tells an agent to
invoke a bin name that does not exist, and every name that does exist runs a build whose command
surface no installed skill documents.**

---

## 1. Target topology

**Invariant (the thing that makes confusion impossible):**
> **One canonical production path, one canonical name. `adhd-backlog` is the only backlog command on
> the machine's shared `PATH`, and it always runs the bytes under `~/.adhd/backlog/current/` against
> the `production` namespace. Every other build is invoked by an explicit `--namespace` (or an
> explicitly-named, non-default wrapper) and never appears under the bare name `backlog`.**

| Entrypoint class | Where it MUST point in the end-state |
|---|---|
| **Global bin (production)** | `adhd-backlog` → `~/.adhd/backlog/current/dist/index.js` (`current` → `releases/<version>/`). The **only** backlog bin on the shared `PATH`. Never passes `--namespace` ⇒ resolves `production`. |
| **Ambiguous `backlog` shim** | **Does not exist.** Quarantined off `PATH` permanently. |
| **Beta bin (worktree testing)** | `adhd-backlog-beta` (dev-only wrapper, **not** on the shared `PATH`) → `node <worktree>/entrypoint/backlog/dist/index.js --namespace beta`. |
| **Main-local dev** | `node entrypoint/backlog/dist/index.js --namespace test` from the main checkout. The global bin is **never** linked to main-repo source. |
| **Per-host skill (claude)** | `~/.claude/skills/backlog/SKILL.md` = the v3 surface, names `adhd-backlog`, byte-identical to the production package's `skill/SKILL.md`. |
| **Per-host skill (opencode)** | `~/.config/opencode/skills/backlog/SKILL.md` = the same bytes (one source of truth). |
| **Per-host instruction files** | `~/.claude/CLAUDE.md` and `~/.config/opencode/AGENTS.md` (both generated from `~/dot/setup/ai/AGENTS.md`) carry exactly one pointer line naming `adhd-backlog` + the skill path. No command surface, no bare `backlog`. |
| **Per-host MCP (claude)** | `~/.claude.json` `mcpServers.backlog` = stdio `node ~/.adhd/backlog/current/dist/index.js serve --transport mcp`. |
| **Per-host MCP (opencode)** | `~/.config/opencode/opencode.json` `mcp.backlog` = the same command. |
| **Repo MCP (`.mcp.json`)** | `backlog` = the same production path. Never a worktree path. |
| **Store / config root (production)** | `~/.adhd/backlog/production/` — config `config.yaml` pins `db.path = …/production/data/backlog-v2.db`. |
| **Store / config root (beta)** | `~/.adhd/backlog/beta/` (store `data/backlog.db`). |
| **Store / config root (dev)** | `~/.adhd/backlog/test/` (store `data/backlog.db`). |
| **Throwaway probe** | ephemeral per-invocation temp root (`--sandbox`), never a named tier. |

**Name discipline:** `adhd-backlog` is the production command. `backlog` is **never** a command name
again — it is the package's own *CLI namespace segment* (v3) and a historical accident, not a bin.

---

## 2. Tier / namespace mapping

The cascade already gives namespace→root resolution for free. `backlogEnvironmentSpec` declares
`namespaces: ['production', 'test', 'sandbox']` with `production` **first**, and
`buildBacklogEnv` defaults `namespace` to `'production'` (`src/env.ts:34-53,162-178`); `--namespace
<value>` is a real, validated flag (`src/cli.ts:244-385`); config layers resolve per-namespace under
`<adhdRoot>/backlog/<namespace>/`. What is **missing** is a persistent namespace for the beta tier —
`sandbox` is *ephemeral* (per-invocation temp, `src/cli.ts:254-264`), which is useless for a beta soak.

| Tier | Namespace | Config root | Store | How selected |
|---|---|---|---|---|
| **Production** | `production` (default, first-declared) | `~/.adhd/backlog/production/` | `data/backlog-v2.db` (pinned by `config.yaml:1-2`) | **Default** — the global bin passes no flag. |
| **Beta (worktree)** | **`beta`** — *NEW, persistent* | `~/.adhd/backlog/beta/` | `data/backlog.db` (fallback) | explicit `--namespace beta` via the `adhd-backlog-beta` wrapper |
| **Main-local dev** | `test` (persistent, already declared) | `~/.adhd/backlog/test/` | `data/backlog.db` (fallback) | explicit `--namespace test` |
| **Probe** | `sandbox` (ephemeral) | temp (minted) | temp | `--sandbox` / `--namespace sandbox` |

**The one code change the cascade needs:** append `'beta'` to `namespaces` (never reorder —
`production` must stay index 0; `src/env.ts:36-41` documents why). That is the whole feature: a
declared namespace is all the cascade requires to mint `~/.adhd/backlog/beta/`.

**What the cascade gives for free vs. what is missing:**
- *For free:* namespaced config/store roots; the `production` default; `--namespace` validation +
  "did you mean" suggestions; `--sandbox` ephemeral isolation.
- *Missing:* (a) the `beta` namespace declaration; (b) any *guard* preventing a non-production build
  from being run **bare** (no `--namespace`), which resolves `production` and opens the production
  store via its pinned absolute `db.path`. Mitigation is the wrapper + a red→green test (Phase 2), not
  a new mechanism.

**ADR-0013 compliance:** tier selection is namespace (typed config) + an explicit flag — **not** an
env-var toggle. Do **not** add `ADHD_BACKLOG_TIER` or any `=1`-style switch. `--namespace` is the
sanctioned explicit invocation.

---

## 3. Production relocation

**Proposed stable path:** `~/.adhd/backlog/releases/<version>/`, with `~/.adhd/backlog/current` a
symlink to the active release. Rationale: it sits inside the package's own data root (ADR-0004 D2,
`<dataRoot>/…`), it is **outside the repo tree** so no git/`nx` operation can touch it, and it is the
directory `production/` already lives in. (Alternative `~/.local/share/adhd-backlog` rejected — it
splits the package's state across two roots, against ADR-0004's one-root-per-scope rule.)

**Release dir contents:** `dist/` + a resolved `node_modules/` (the built `@adhd/backlog` declares
runtime `@adhd/sox-*` deps — `entrypoint/backlog/package.json:7-28` — so the release must carry them,
not a symlink to a worktree's `node_modules`).

### Cutover procedure (no store mutation; bytes-identical to the frozen build)

1. **Materialize the artifact (pre-publish staging).** From the frozen cutover worktree, `pnpm pack`
   the built package, then `npm install --prefix ~/.adhd/backlog/releases/<v> <tarball>`. This resolves
   the `@adhd/sox-*` deps from the **registry** (they are published; only `@adhd/backlog` itself is
   human-gated) and produces a self-contained, worktree-independent install.
2. **Prove the artifact runs and is the same surface** — `node ~/.adhd/backlog/releases/<v>/…/dist/index.js --help`
   exits 0 and lists the v3 verb set; compare its normalized content hash to the frozen worktree's
   `dist/` (ADR-0003/0005 content-addressing: identical bytes ⇒ identical behavior, so this is a
   *move*, not an upgrade).
3. **Read-only store probe** against production through the new artifact (a `query`, not a write).
4. `ln -s releases/<v> ~/.adhd/backlog/current` (the single switch).
5. Repoint the bin + all MCP registrations at `~/.adhd/backlog/current/…` (§4 P0.2–P0.3).
6. Quarantine `~/Library/pnpm/backlog` (rename, do not delete).
7. Post-move smoke (real create/query via bin **and** via MCP) — runbook §6.

### Rollback procedure
`current` is the one switch: repoint it at the previous release dir (keep the last N releases), or
restore the quarantined `backlog` shim. **The store is never touched by relocation** (it is pinned by
`production/config.yaml`, independent of the binary), so rollback is instantaneous and data-safe.
Take a `VACUUM INTO` backup of `backlog-v2.db` before the first production write post-move, as a
belt-and-braces gate.

### Do the frozen build's known bugs block relocation?
The three named bugs — **update-rejects-note**, **SIGTERM**, **embed-degradation (hypothesis)** — do
**not** block relocation, because relocation ships the **same bytes** (step 2's hash equality) and
therefore changes *zero* runtime behavior while removing a strictly worse failure mode (worktree
deletion). Blocking relocation on a code fix would keep production hostage in a fragile worktree for
no safety gain. The one qualification: relocation must be paired with (a) the pre-move `VACUUM INTO`
backup and (b) the read-only store-integrity probe, **because** if any of the three bugs is later
proven store-corrupting, we want a clean restore point. Fix them in the remediation branch and promote
a **new** release via `current` — never patch the frozen release dir in place.

---

## 4. PHASE 0 — bleed-stoppers (do today, in this order)

Order is load-bearing: make the stable path exist first, then make the canonical name resolve and the
ambiguous name dead, then fix what agents *read*. Steps 0.1–0.3 touch machine-global state and are
**human-approved** (repo rule: never install/relink globals without approval).

| # | Change | Exact content guidance | Effort | Implementer |
|---|---|---|---|---|
| **0.1** | Relocate the bytes to a stable path (§3 steps 1–4). | Create `~/.adhd/backlog/releases/<v>/`, verify it runs, `ln -s releases/<v> ~/.adhd/backlog/current`. No config/store change. | ~15 min | operator (or `backend` + human approval) |
| **0.2** | Create the canonical bin; kill the ambiguous one. | Write `~/Library/pnpm/adhd-backlog` execing `~/.adhd/backlog/current/dist/index.js`; `mv ~/Library/pnpm/backlog ~/Library/pnpm/backlog.quarantined-<ts>`. Verify `command -v adhd-backlog` resolves and `command -v backlog` fails. | ~5 min | operator |
| **0.3** | Repoint all MCP registrations to `current`; add opencode's missing one. | `~/.claude.json` `mcpServers.backlog.args[0]` → `~/.adhd/backlog/current/dist/index.js`; `.mcp.json` `backlog.args[0]` → the same; **add** `mcp.backlog` to `~/.config/opencode/opencode.json`. All three: `serve --transport mcp`. | ~10 min | operator / `backend` |
| **0.4** | Replace both installed skills with the **deployed v3 surface**, naming `adhd-backlog`. | Prefer the tool's own placement primitive: `adhd-backlog install-skill --host all --scope user` (ADR-0002). Then fix `~/.config/opencode/skills/backlog/extension.json` `version` to match the shipped package. Byte-equality of the two copies is the acceptance. | ~10 min | `backend` |
| **0.5** | Fix the global instruction pointer (one source, both hosts). | Edit `~/dot/setup/ai/AGENTS.md` line 65 so the pointer names **`adhd-backlog`** and the skill path — remove any bare-`backlog` guidance. Both `~/.claude/CLAUDE.md` and `~/.config/opencode/AGENTS.md` are generated from it. Minimum prose, then A/B-test per the repo's CLAUDE.md rule. | ~10 min | `architect`/docs, human-approved |
| **0.6** | Run the verification runbook (§6) and record results. | All pass criteria green before declaring the bleed stopped. | ~10 min | `test` |

**Why this order stops the bleed fastest:** 0.1 removes the worktree fragility; 0.2 makes the command
agents are *told* to use actually exist and removes the one they must never use; 0.3 gives both hosts
a working MCP server (opencode had none); 0.4/0.5 fix the surfaces agents *read*. After 0.2, an agent
that types `adhd-backlog` gets production; an agent that types `backlog` gets "command not found"
instead of a worktree build — a loud, correct failure.

---

## 5. PHASE 1–N — full program

**P1 — Release-path hardening (so the fix cannot rot).**
Teach `sync-global.mjs` about the canonical name + `releases/current` layout (it keys off the declared
`bin`, which now matches `adhd-backlog` — `sync-global.mjs:233-235,584` — so the name blind spot
self-heals once 0.2 lands; the *layout* still needs handling so a future release doesn't `pnpm add -g`
over a `current`-pointing shim). Add a repo check asserting the live `adhd-backlog` resolves **outside**
`.worktrees/`. Gate with a red→green test (delete the `adhd-backlog` shim ⇒ check goes red).

**P2 — Beta worktree workflow.**
Declare the `beta` namespace (`src/env.ts:53`). Add a dev-only `adhd-backlog-beta` wrapper that always
passes `--namespace beta`, pointing at a worktree dist; keep it off the shared `PATH`. Document:
build in the worktree (`npx nx build backlog`), test via the wrapper, promote to production only by
packing a release into `releases/` and repointing `current`. **Red→green guard:** a bare invocation of
a worktree dist must be shown to resolve `production` (the footgun), and the wrapper must be shown to
resolve `beta`.

**P3 — Main-local dev workflow.**
`node entrypoint/backlog/dist/index.js --namespace test`. Explicitly forbid linking the global bin to
main-repo source (PUBLISHING.md's "dev mode" is the anti-pattern this tier replaces,
`PUBLISHING.md:461-490`). Document that main-local dev never touches `production/`.

**P4 — Per-host consistency maintenance (one source of truth).**
Source of truth = the package's `skill/SKILL.md` asset, placed by `install-skill` (ADR-0002's placement
primitive), never hand-edited per host. Add a verification script that asserts (a) the two host
`SKILL.md` copies are byte-identical to the packaged asset, (b) both instruction files name
`adhd-backlog`, (c) no installed file names bare `backlog` as a command. Run it after every release.

**P5 — Post-publish end-state.**
Once PR #9 merges and `@adhd/backlog` publishes (both human-gated), `pnpm add -g @adhd/backlog@<v>`
becomes the production install; `sync-global.mjs` owns currency; the custom shim and the `current`
symlink retire (keep `releases/` as rollback history). The `adhd-backlog` name, the namespace split,
and the one-source-of-truth skill all carry forward unchanged.

---

## 6. Verification runbook — is the active deployment functioning *right now*?

All read-only unless noted. Run these before and after Phase 0.

| # | Check | Exact command | Pass criterion |
|---|---|---|---|
| 1 | Canonical name resolves, ambiguous name does not | `command -v adhd-backlog; command -v backlog` | first prints a path; second prints nothing |
| 2 | The live bin is not a worktree build | `head -20 "$(command -v adhd-backlog)" \| grep -c .worktrees/` | `0` |
| 3 | Surface is the deployed one | `adhd-backlog --help; echo "exit=$?"` | `exit=0`; lists the v3 14-verb set (incl. `upsert-project`, `lookup`) |
| 4 | Production store reachable + healthy (read-only) | `adhd-backlog backlog query --input '{"limit":1}'` then the CLI's doctor/integrity verb (`adhd-backlog --help` to confirm its exact name) | `ok:true`; doctor reports integrity ok |
| 5 | Population matches the parity baseline | `adhd-backlog backlog query --input '{"limit":1}'` and read `meta.total` (or the admin stats action) | ≈1824 items (parity-verified 2026-09-22) |
| 6 | Reads do not mutate the store | `ls -l ~/.adhd/backlog/production/data/backlog-v2.db` before/after #4 | mtime unchanged by reads |
| 7 | claude MCP tools load and answer | call an `mcp__backlog__*` tool | returns items from the production store |
| 8 | opencode MCP tools load and answer | call the backlog tool from opencode | returns items (post-0.3; **currently absent**) |
| 9 | Real write round-trips | `adhd-backlog --sandbox backlog create …` first, then a real `create`+`get` on production; assert read-back | `ok:true` both; the created item is retrievable |
| 10 | Nothing live points at a worktree | `rg -n '\.worktrees/backlog' ~/.claude.json .mcp.json ~/.config/opencode/opencode.json ~/Library/pnpm/adhd-backlog` | **no matches** (after 0.1–0.3) |
| 11 | Nothing live points at the beta worktree | `rg -n 'backlog-v2' ~/.claude.json .mcp.json ~/.config/opencode/opencode.json ~/Library/pnpm/adhd-backlog` | only the store path `backlog-v2.db`, never the worktree dir |

### Answer to the pause question

**No — remediation work in the `backlog-v2` worktree can continue in parallel; the active deployment
must be verified, but the branch work need not pause.** Evidence: every live consumer points at
`.worktrees/backlog-cutover` (bin `~/Library/pnpm/backlog:18`; `~/.claude.json:3373`; `.mcp.json:21`),
**not** `.worktrees/backlog-v2`. The only reference to `backlog-v2` found on disk is
`~/.gitnexus/registry.json:522` — gitnexus's read-only index registry, not a runtime consumer. Editing
`backlog-v2` therefore cannot affect live production.

**What must pause / be sequenced (hard):**
1. **Do not** `git worktree remove` / `prune` `.worktrees/backlog-cutover` until §3 relocation lands —
   that deletes production.
2. **Do not** `pnpm link -g` (or otherwise link the global bin) from **any** worktree or the main
   checkout — that is the mechanism that created F1.
3. **Do not** re-run the ETL/cutover while a write is in flight against the live store.

**What should happen first (cheap, ~5 min):** run checks 1–6 above. They confirm the *current*
production build is serving the *current* store before any Phase 0 change, and they are the baseline
for the post-Phase-0 comparison.

---

## 7. Risks and rollbacks

| Risk | If done wrong | Rollback / mitigation |
|---|---|---|
| Wrong bin name lingers | Agents silently hit a worktree build | Repoint `current`/shim; the store is untouched. Phase 0.2 makes the wrong name *fail loudly*. |
| Namespace default footgun | A worktree/beta build run **bare** resolves `production` and writes the production store | Beta wrapper always passes `--namespace beta`; P2 red→green guard; pre-move `VACUUM INTO` backup. |
| Worktree cleanup deletes production | Total loss of the production binary | Relocate **first** (Phase 0.1); `releases/` + `current` survive any git operation. |
| Skill/AGENTS copies diverge again | The exact F2 failure recurs | One source of truth (packaged `SKILL.md`) placed by `install-skill`; P4 byte-equality check. |
| Global config/bin edits are irreversible | Machine-wide breakage not under git | Back up each file before editing; rename (never delete) the old shim; every edit is a single line, revertible by hand. |
| ADR-0013 violation sneaks in | A feature env-var appears | Tier selection stays namespace + explicit `--namespace`. Reject any `ADHD_BACKLOG_*` toggle in review. |
| ADR-0014 violation sneaks in | Auto-deleting the stale `.tshm`/backup debris | Report-first; explicit `--apply --confirm`; never a scheduled delete. |
| Beta + production on one store | Cross-contamination | Namespace isolation guarantees distinct stores (`production/data/backlog-v2.db` vs `beta/data/backlog.db`). Concurrent sessions on the *same* store remain sanctioned (ADR-0012). |
| Store corruption during relocation | Data loss | Relocation mutates no store file; pre-move backup + integrity probe are the gates; the frozen bugs do **not** block (same bytes). |

---

## Appendix — evidence index (files opened for this spec)

- `entrypoint/backlog/package.json:4-6` (bin = `adhd-backlog`); `.worktrees/backlog-cutover/entrypoint/backlog/package.json:4-6`.
- `~/Library/pnpm/backlog:18-20` (execs the cutover worktree); `~/Library/pnpm/backlog.bak:18`; `~/Library/pnpm/backlog.pre-sync-1786526977567:13-18`.
- `~/dot/etc/shell-manager/golden.snap:7747-7750` (`backlog` on PATH; no `adhd-backlog`).
- `~/.claude.json:3369-3378` (mcpServers.backlog → cutover dist); `~/.mcp.json:18-22` (same).
- `~/.config/opencode/opencode.json:53-84` (no backlog MCP).
- `~/.claude/skills/backlog/SKILL.md:15-92` (v1 surface); `~/.config/opencode/skills/backlog/SKILL.md:15-71` (v2 surface); `~/.config/opencode/skills/backlog/extension.json` (version 1.0.0).
- `.worktrees/backlog-cutover/entrypoint/backlog/skill/SKILL.md:19-40` and `.worktrees/backlog-v2/…/skill/SKILL.md:19-40` (v3 surface); `entrypoint/backlog/skill/SKILL.md:15-19` (main = v2).
- `src/env.ts:34-53,162-178,202-204` (namespaces, default, db-path resolution); `src/cli.ts:244-385` (`--namespace`); `src/cli.ts:254-264` (`--sandbox` ephemeral).
- `~/.adhd/backlog/production/config.yaml:1-2` (db.path pinned to `backlog-v2.db`); `~/.adhd/backlog/production/data/` listing.
- `tools/nx-plugins/build/executors/sync-global/sync-global.mjs:210-249,545-601` (bin-name-only detection).
- `PUBLISHING.md:147,461-490` (sync-global + the "dev mode" link anti-pattern).
- `~/dot/setup/ai/AGENTS.md:65` (global backlog pointer).
- `report/cutover-execution-plan.md` (prior plan; note it assumed the bin was `adhd-backlog`, which F1 disproves).
- ADR catalog: `~/dev/ai/sox-ecosystem/docs/decisions/0001–0017` (all read).
