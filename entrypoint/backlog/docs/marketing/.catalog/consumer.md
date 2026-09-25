# Backlog Documentation — Fresh-Consumer Report

**Scope:** `entrypoint/backlog` documentation only. Files read: `README.md`,
`skill/SKILL.md`, `SPEC.md`, `DATA_MODEL.md`, `STATE.md`, `CONTRIBUTING.md`,
plus targeted reads of `CHANGELOG.md`. No source under `src/**` was opened and
no command was run. Method: simulated a first-time user given only these docs,
attempted the three canonical tasks, and logged every point where the docs were
insufficient ("reader-search signal" = the moment a competent reader would open
source or guess).

---

## Task 1 — Register `demo-project` at `/tmp/demo`, file a bug "Login fails" in `auth-service` with git context `main @ abc1234` — **SUFFICIENT**

**Commands a doc-only reader would run:**

```bash
adhd-backlog upsert-project --input '{"name":"demo-project","path":"/tmp/demo","by":"agent:worker-1"}'
adhd-backlog upsert-component --input '{"project":"demo-project","name":"auth-service","by":"agent:worker-1"}'
adhd-backlog create --input '{
  "title": "Login fails",
  "body": "<non-empty — required, must be invented>",
  "project": "demo-project",
  "component": "auth-service",
  "gitContext": "main @ abc1234",
  "by": "agent:worker-1"
}'
```

**Steps taken purely from docs (with citations):**

- `upsert-project` is create-or-update by `name` and mints the reserved `(root)`
  component — `README.md` Quickstart; `skill/SKILL.md` §4.
- `component` is resolve-only and is never auto-created; an unknown component is
  `not_found`, so `auth-service` must be registered before `create` — `SKILL.md`
  §3 (`create`) and §4 (model + `upsert-component` example + "The filing rule").
- `create` requires `title`, `body`, `project`, `by` — `README.md` Quickstart;
  `SKILL.md` §3; `SPEC.md` §6.3.2.
- `gitContext` format is `<branch> @ <sha>`, stored item-level, passed on
  `create` — `README.md` "Citations & git context"; `SKILL.md` §6.

**Gaps / reader-search signals:**

- `create` requires a non-empty `body` (`SPEC.md` §6.3.2 Errors). The task names
  only a title, so the reader must invent content. Not a doc defect — the docs
  are explicit — but worth flagging as an input the prompt omits.
- **Cross-doc dependency for component filing.** `README.md`'s Quickstart files
  its example issue with **no** component (silently landing on `(root)`) while
  the same section warns that a component-less item "is invisible to
  component-scoped queries" (`README.md` lines 30–35; `SKILL.md` §4). The
  `upsert-component` step appears **only** in `SKILL.md` §4. A reader who stops
  at `README.md` would file "Login fails" onto `(root)` and then be unable to
  find it under `auth-service`. Not a blocker (SKILL is linked), but the README
  quickstart pattern actively invites the misfiling it warns about.
- `by` must be `${agentName}:${instanceId}`, never a bare role literal —
  `SKILL.md` §3. Documented; no search needed.

**Verdict: SUFFICIENT.** No source read is required.

---

## Task 2 — List every open bug under `auth-service`, close one with a note, and state exactly what a terminal transition requires — **PARTIAL**

**Commands a doc-only reader would run:**

```bash
adhd-backlog query --input '{"filter":{"component":"auth-service","status":"open"}}'
# or, only if "bug" is a real kind:
adhd-backlog query --input '{"filter":{"component":"auth-service","status":"open","kind":"bug"}}'

adhd-backlog transition --input '{
  "uid": "<uid-from-the-query>",
  "by": "agent:worker-1",
  "toStatus": "closed",
  "note": "<required by default>"
}'
```

**What a terminal transition requires — fully documented:**

- `by` — required on every mutating verb, `${agent}:${instanceId}` — `SKILL.md` §3.
- `note` — required by default (`project_policy.transitionRequiresNote` defaults
  `true`) — `SPEC.md` §2; `DATA_MODEL.md` §3/§6; `SKILL.md` §6.
- `citations` (≥1) — required **only** when the project's `citationRequired` is
  on (default `false`) **and** `toStatus` is terminal — `SKILL.md` §3/§6;
  `README.md` "Citations & git context"; `SPEC.md` §6.3.4.
- Citation verifiability — with `citationRequired` on and a project `path`,
  cited files must resolve inside that path (`citationRequiresSha` default
  `true`); otherwise `precondition_failed` — `SKILL.md` §6; `SPEC.md` §2.
- Claim guard — a live claim held by another agent blocks the transition
  (`ClaimHeldError` / `conflict`) unless stale (`claimStaleAfterMin` default 30)
  or held by you — `SPEC.md` §6.3.4; `README.md` "Leased claims for multi-agent
  work"; `SKILL.md` §3.
- `closedAt` is stamped **iff** the target status is terminal — `SPEC.md`
  §6.3.4; `DATA_MODEL.md` §3/§6.
- Terminality is the `status.terminal` flag, not the name — `SPEC.md` §2;
  `DATA_MODEL.md` §2/§6.

**Steps taken purely from docs:**

- Filter shape is `IIssueFilter`; `component` and `status` (incl. `'open'`) are
  valid and AND-composed — `SPEC.md` §6.5. Component- vs project-scoped
  visibility and the `(root)` misfiling trap — `SKILL.md` §4.
- `toStatus` is an open catalog: an **unresolved NAME mints a new status with
  `terminal:false`** and the transition succeeds, silently leaving the set
  `filter.status:"open"` returns — `SKILL.md` §3 (an explicit, well-placed
  warning).

**Gaps / reader-search signals (why PARTIAL):**

1. **"bug" is not a documented `kind`.** `README.md`'s intro says the tool is
   for "bugs, debt, features, and investigations", but no doc lists the node
   *kinds*. Every worked example uses `"kind":"issue"`; `defaultKind` falls back
   to `'issue'` (`DATA_MODEL.md` §2). `filter.kind` values are validated against
   live catalog rows and an unmatched value throws `BacklogValidationError`
   (`SPEC.md` §6.5 rule 3; `CHANGELOG.md`). So the reader cannot know whether
   `kind:"bug"` is valid, whether the task means "issues", or whether to omit
   `kind` entirely. Fixing it needs **source** (`src/write/catalog.ts` seed
   rows) or an undocumented discovery call. **Reader-search signal: HIGH.**
2. **Is `"closed"` terminal?** Docs repeatedly say `status.terminal` drives
   closedness and that an unknown status name mints `terminal:false`
   (`SPEC.md` §2/§6.3.4; `SKILL.md` §3) — but the seeded status rows and their
   `terminal` flags are never listed. Nothing lets a reader *prove* that
   `toStatus:"closed"` closes rather than minting a non-terminal "closed".
   `README.md`/`SKILL.md` examples imply it, but do not state it.
   **Reader-search signal: would open source to confirm.**
3. **The full `filter` key set exists only in `SPEC.md` §6.5** (`assignee`,
   `claimedBy`, `closedAt`/`createdAt`/`updatedAt` ranges, etc.), not in the
   agent-facing `SKILL.md`, which calls itself "the ONLY place the command
   surface and calling convention are documented" (`SKILL.md` line 11). A reader
   obeying that framing will never find these filters. **Signal: MEDIUM.**
4. Does `filter.component` require `filter.project` for disambiguation?
   `SPEC.md` calls component filters "scoped within project" but never says
   whether a bare component name is legal in an issue query. **Signal: LOW.**

**Verdict: PARTIAL.** Terminal-transition mechanics are complete and
well-documented; the "list every open bug" half is not answerable with
confidence because the kind vocabulary is undocumented.

---

## Task 3 — Resolve which project/component owns `packages/auth/src/index.ts`, then register it as a location owned by `auth-service` — **PARTIAL**

**Commands attempted:**

```bash
# 1) resolve — only works if the location is ALREADY registered
adhd-backlog lookup --input '{"q":"packages/auth/src/index.ts"}'

# 2) register
adhd-backlog upsert-location --input '{
  "component": "auth-service",
  "project": "demo-project",
  "locType": "path",
  "value": "packages/auth/src/index.ts",
  "by": "agent:worker-1"
}'

# 3) now lookup resolves
adhd-backlog lookup --input '{"q":"packages/auth/src/index.ts"}'
```

**Steps taken purely from docs:**

- `lookup` classifies `q` as tool/url/path, matches a registered `location`,
  and walks location → component → project, returning
  `{project, component, location}` — `README.md` "A registry that answers…";
  `SKILL.md` §4; `SPEC.md` §3a; `DATA_MODEL.md` §7.
- `upsert-location` is create-or-update by `(component, locType, value)`; a bare
  component NAME requires `project` to disambiguate — `SKILL.md` §4 and the
  `--help` schema line; `SPEC.md` §3a.

**Gaps / reader-search signals:**

1. **The task's order is impossible doc-only.** `lookup` resolves **only**
   against locations already registered via `upsert-location` — it never
   resolves a bare project/component name and never searches the filesystem
   (`SKILL.md` §4: "it only resolves against LOCATIONS already registered …
   never against a bare project/component name"; `DATA_MODEL.md` §7). For an
   unregistered file it returns `not_found` (exit 4). There is **no documented
   verb that answers "which project/component owns this file?" for an
   unregistered path.** The registry is manually seeded by design; the docs are
   honest about the limitation but offer no discovery path. So "resolve, then
   register" can only be executed in reverse (register, then lookup); the first
   half is BLOCKED from docs alone. **Reader-search signal: HIGH.**
2. **Documentation contradiction — `view:"lookup"`.** `SPEC.md` §3a (line 326)
   and again near §6.5 (line 953) document resolution as
   `query --input '{"view":"lookup","lookup":"<tool|file|url>"}'`. `SKILL.md`'s
   live `--help` view union (`list|ready|graph|order|stale|similar|overlap|projects|components|locations`)
   has **no** `lookup` view, and `README.md`'s command table lists `lookup` as a
   standalone verb taking `{"q": …}`. A reader following `SPEC.md` gets a
   `validation` error. **Signal: MEDIUM.**
3. `locType` for a file is `"path"`; the example value is repo-relative
   (`packages/auth/src/index.ts`) while `SPEC.md` §3a says paths normalize to
   absolute via the project path. No doc states which form is canonical for
   storage. **Signal: LOW.**

**Verdict: PARTIAL.** Registration is fully documented; resolving the owner of
an unregistered file is not achievable from docs.

---

## Overall

- **A doc-only newcomer can complete 1 of 3 canonical tasks end-to-end
  (Task 1).** Tasks 2 and 3 are PARTIAL: the write-side mechanics
  (`upsert-project`/`upsert-component`/`create`/`transition`,
  `upsert-location`, `lookup`-once-registered) are richly and accurately
  documented, but two vocabulary/behaviour facts a newcomer needs most are
  absent from the docs.

- **Top doc gaps to fix:**
  1. **No default catalog vocabulary.** Enumerate the seeded `kind`, `status`
     (with their `terminal` flags), and `priority` rows. This one omission
     blocks "list open bugs" (is `bug` a kind?) and undermines "close this"
     (is `closed` terminal?). — Task 2.
  2. **`lookup` cannot answer "who owns this file?" for an unregistered path,
     and `SPEC.md` documents a `view:"lookup"` surface the live CLI does not
     have.** Reconcile `SPEC.md` §3a/§953 with `SKILL.md`/`README.md`, and either
     document the intended discovery workflow for an unregistered file or state
     plainly that the registry is seed-only. — Task 3.
  3. **The `query.filter` schema lives only in `SPEC.md` §6.5,** not in the
     agent-facing `SKILL.md`, which claims to be the single source for the
     command surface. Promote the filter keys into `SKILL.md`. — Task 2.

- **Consolidated reader-search moments:** kind vocabulary (Task 2); the
  `terminal` flag of `closed` (Task 2); the full `filter` key set (Task 2);
  owner-of-an-unregistered-file (Task 3); the `view:"lookup"` contradiction
  (Task 3).

*Method note: this report was produced without opening `src/**` or running the
tool; every command above is what the docs say to run, not a transcript.*
