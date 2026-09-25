# Rescued work artifacts

This directory holds work whose **only copy was a gitignored file on no git
ref**. Each artifact here was moved to a committed path so a `git clean -fdx`
or a `tmp/` wipe cannot destroy it. Nothing here is a build input; it is a
preservation record.

---

## `worktree-dirty-BUG-050.patch`

**What it is.** A verbatim rescue copy of
`tmp/backlog-main-reconcile/worktree-dirty.patch` (gitignored — `.gitignore:5`),
captured during the 2026-09-23 main-reconcile. It was on **no git ref**: its
distinctive added symbol `IListCandidatesResult` returns zero commits under
`git log --all -S`, and `git apply --check` against the then-current tree no
longer succeeded. A byte-identical twin,
`tmp/backlog-main-reconcile/worktree-dirty.pre-reset.patch`, sits in the same
gitignored directory.

- sha256: `cfe23ccadb72a4e510a4e28f1c2a90d08bed59e67ef1b07bc556ffc4f07011d6`
- diffstat: **7 files, 286 insertions(+), 30 deletions(-)**
- 13 mentions of `BUG-050` in the body

**Contents — it is a MIX of two unrelated workstreams.**

Four files are the real BUG-050 (`duplicate_candidate` carries empty
`details` — the caller is told to "resolve one" but not _which_):

| file                                                     | role                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entrypoint/backlog/src/client.ts`                       | `duplicateAction:'list'` dry-run; scored candidates; `threshold` propagation                                                                                |
| `entrypoint/backlog/src/model.ts`                        | `duplicateCandidateDetails`, `IListCandidatesResult`, `details.candidates`/`threshold`, corrected `action:'file'`→`duplicateAction:'file'` remediation text |
| `entrypoint/backlog/src/store/crud.ts`                   | `DedupeScanHit` + `toDuplicateCandidateCards` — keeps the similarity score the scan already computed                                                        |
| `packages/apigen/apigen-base-logical/src/lib/runmode.ts` | `encodeNode` passthrough for undeclared keys — the ENCODE-side mirror of `BUG-APIGEN-DECODE-UNKNOWN-KEY-STRIP-001`                                          |

Three files are **reconcile worktree noise**, not BUG-050:
`.githooks/pre-commit` (BUG-GATE-001 diagnostics — the target hunk text no
longer exists), `.mcp.json` (an absolute `backlog-cutover` path — the live
file now uses a portable relative path), and `AGENTS.md` (which _reverts_ the
`adhd-backlog` rename back to the stale bare `backlog`).

**Reproducibility / applicability verdict (2026-09-23, vs `origin/main`
== `9df2a5c7`): NOT applicable as-is; the motivating defect is RESOLVED.**

1. `git apply --check` fails on every hunk (layout drift) — the patch would
   not apply even to the line it was cut from.
2. The three BUG-050 backlog files (`client.ts`, `model.ts`, `crud.ts`) target
   the **pre-1.0.0 surface that PR #9 deleted** — those paths do not exist in
   the current tree at all.
3. The BUG-050 _symptom_ cannot occur on the current tree: the
   `duplicate_candidate` error code has been removed entirely (it is not in
   `BACKLOG_EXIT_CODE`, and `rg duplicate_candidate` hits only comments). The
   abort path now returns `created:false` + `duplicateCandidates` in the
   SUCCESS arm (`write/create-issue.ts:723`), where `duplicateCandidates` is a
   _declared_ outcome field and therefore survives encode. The only keys ever
   placed in `error.details` today are `retryable`/`retryAfterMs`
   (`api.ts:344-351`), both declared in `IOutcomeErrorDetails`, so `encodeNode`
   never drops them.
4. The backlog item for the defect is **RESOLVED**:
   `5efca7e0-25f8-427e-a4b5-a9affd3639e3` — _"create's duplicate_candidate
   error reports a COUNT but returns empty details — the caller is told to
   'resolve one' without being told which"_.

**The one still-live fragment.** `runmode.ts`'s `encodeNode` object arm
(`runmode.ts:122-145`) still projects ONLY declared `properties` and discards
every undeclared key, while its decode mirror (`decodeNode`, `runmode.ts:237-252`)
already passes them through. So `BUG-APIGEN-DECODE-UNKNOWN-KEY-STRIP-001`'s
encode-side asymmetry is a **real, still-unfixed, generic apigen bug** — it is
simply no longer triggered by backlog's own code (see point 3). It is filed
separately (see the repo backlog) rather than fixed here, because a fix that
changes `encodeNode`'s fall-through semantics needs a rebase plus a red→green
test, and this rescue ran under an explicit "do not run `nx build`/`nx test`"
constraint (machine at load ~29 / 90 % swap).

**Why archived, not ported.** 3 of the 4 BUG-050 files are dead code against a
deleted surface; porting them would re-introduce the v1 architecture PR #9
retired. The 4th needs a rebase and a test that this session could not run.
Committing the patch verbatim is the honest, loss-proof action; a real re-port
against the current v2 surface is a separate decision, and this file is the
source material for it.

**Sibling.** `tmp/backlog-main-reconcile/line-b-funnel-unpushed.patch`
(sha256 `f1fc885b…`, 2,107 lines) is **NOT** rescued here: its content is
already durable on a live remote ref — the funnel-line-b work (e.g.
`write/embed-drain.ts`, `write/bootstrap-cache.spec.ts`) resolves on
`origin/fix/live-restore`, which is the same tip as `backup/funnel-line-b`
(`257b146e`). It is therefore not at risk of loss.

**Citations:** [adhd@9df2a5c7, debug, deepseek, task/rescue-bug-050,
1: `tmp/backlog-main-reconcile/worktree-dirty.patch` (sha256 cfe23cca…;
`git apply --check` fails all hunks); 2: `git log --all -S IListCandidatesResult`
(0 commits); 3: `entrypoint/backlog/src/envelope.ts:85-95` (no
`duplicate_candidate` code), `entrypoint/backlog/src/write/create-issue.ts:723-728`
(abort → success arm), `entrypoint/backlog/src/api.ts:344-351` (only declared
detail keys); 4: `packages/apigen/apigen-base-logical/src/lib/runmode.ts:122-145`
vs `:237-252` (encode strips, decode passes through); 5: backlog item
`5efca7e0-25f8-427e-a4b5-a9affd3639e3` (status RESOLVED).]
