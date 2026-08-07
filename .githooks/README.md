# Git hooks (`core.hooksPath = .githooks`)

Version-controlled git hooks for this repo. No husky dependency — activation is via
`core.hooksPath`, set automatically by the root `package.json` `prepare` script on
install, or manually:

```bash
git config core.hooksPath .githooks
```

## Hooks

| Hook | What it does |
|---|---|
| `pre-commit` | **1.** `nx run @adhd/source:secret-scan --mode=staged` (wraps `check-no-credentials.js --staged`) — blocks credentials from entering the repo. **2.** `nx affected -t lint --files=<staged>` (VERIFY ONLY, never `--fix`, never re-stages) — `lint` `dependsOn: ["sync-deps"]`, which can self-heal stale `@adhd/*` dependency ranges on disk; blocks on any other lint error. |

Secrets are checked **first** and are cheap. A leaked credential is *unrecoverable*
once pushed — the fix is rotation, not reversion — whereas a lint error is not.
Do not reorder these gates.

Hooks must be executable (`chmod +x .githooks/<hook>`).

### Why `pre-commit` never runs `lint --fix` and never auto-stages (incident history)

This hook used to run `nx affected -t lint --fix --skip-nx-cache` and then `git add`
back whatever the fix touched, on the theory that `@nx/dependency-checks`' auto-fix
(deriving `package.json` deps from actual imports) was safe to apply silently on every
commit. Two confirmed incidents proved that model actively dangerous and it was removed:

**`BUG-REPO-PRECOMMIT-PARTIAL-STAGE-001`** — an agent used `git apply --cached` to
stage only 4 of 7 hunks in a shared file (leaving another agent's 3 WIP hunks
deliberately unstaged), then committed with the repo's own explicit-pathspec
convention (`git commit -- <paths>`). This hook's auto-fix ran `eslint --fix` against
the WORKING-TREE copy (all 7 hunks, since only the index was partial) and then blindly
`git add`'d the file WHOLESALE, silently overwriting the deliberately-partial index —
the resulting commit shipped another agent's untested WIP under the wrong message.
`git commit -- <paths>` alone does NOT protect against this: the hook re-stages
*after* the pathspec commit builds its index.

**`BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001`** — `@nx/dependency-checks` in
this repo resolves each npm dependency via Nx's yarn-lockfile parser (`yarn.lock`
shadows `pnpm-lock.yaml` — see `detectPackageManager()` in
`nx/src/utils/package-manager.js`, which checks `yarn.lock` first), which in turn
resolves the "canonical" version of every dependency NOT declared at the monorepo
root by reading `<workspaceRoot>/node_modules/<pkg>/package.json` straight off disk. A
freshly created git worktree (git does not copy/install `node_modules`) has none of
that installed, so this lookup silently fails for nearly every project-level
dependency — and `--fix` deleted real, fully-static, genuinely-used deps (`fs-extra`,
`source-map`, `tough-cookie`, `ajv`, `yaml`) from real `package.json` files as a
result. `git commit -- <paths>` does not protect against this either, since the
corruption happens to `package.json` BEFORE the commit is made, not to the git index.

Both incidents share the same shape: a step that MUTATES tracked files and then
STAGES what it mutated, running inside the commit path, where neither pathspec
commits nor careful manual staging can see it coming. The fix is structural, not "run
it more carefully": THIS HOOK never stages anything, ever, full stop.

### Gate 2 self-healing (`BUILD-TOOLING-VERSION-SYNC-DEPS-001`)

`lint` now `dependsOn: ["sync-deps"]` globally (`nx.json` `targetDefaults`), so that
`@nx/dependency-checks` errors from a stale/undeclared internal `@adhd/*` range
self-heal (get fixed on disk) BEFORE the check runs, instead of hard-failing lint on
every fixable drift. That means running `nx affected -t lint` from the hook can now
mutate a project's `package.json` in the WORKING TREE, mid-hook, as a side effect.

This does NOT get to reintroduce `BUG-REPO-PRECOMMIT-PARTIAL-STAGE-001`. The hook
still never runs `git add`/stages anything. Instead, Gate 2 snapshots every
`package.json`'s working-tree status immediately before running lint and diffs it
against the status immediately after. If `sync-deps` touched ANY `package.json`, the
commit is FAILED (even if lint itself reported clean) — the fix is sitting in the
working tree, unstaged, and the developer must review it,
`git add -- <path>/package.json` themselves, and commit again. This is deliberate:
without this check, the ALREADY-STAGED (stale) `package.json` would otherwise get
silently committed while lint reports green, because dependency-checks now validates
the just-fixed DISK copy, not the index. See `tools/nx-plugins/deps/README.md` and
`tools/nx-plugins/build/README.md` for the full write-up, and `CHANGELOG.md`.

The guard for a not-really-installed `node_modules` (in the hook) is unaffected and
unchanged in spirit: it still hard-fails BEFORE `nx` is even invoked, which remains
the actual enforcement point for the commit path. (A separate, softer no-op+warn guard
also lives inside `sync-deps` itself — `tools/nx-plugins/deps/eslint-check.mjs` — for
callers OTHER than this hook, e.g. a bare `nx affected -t lint` run outside the commit
path; see its header for why that one may no longer be a hard fail.)

## `check-no-credentials.js`

One scanner, two engines, three modes. The **same script** runs locally (via the
`@adhd/nx-secret-scan:scan` executor, `project.json` target `secret-scan` on the root
`@adhd/source` project — declared once, whole-repo, NOT per-project/affected, because a
leaked credential can live in any tracked file, not just inside one project's root) and
in CI (`.github/workflows/pull-request.yml` → `secret-scan` job), so a commit cannot
pass the hook and then fail differently on a PR.

It exports `main(argv)` (returns an exit code, never calls `process.exit` itself) and
only self-invokes when run directly (`require.main === module`), so it can be
`require()`d in-process by the nx executor — see
`tools/nx-plugins/secret-scan/executors/scan/impl.js`.

```bash
node .githooks/check-no-credentials.js              # staged changes (pre-commit)
node .githooks/check-no-credentials.js --range A B  # diff A..B  (CI on a PR)
node .githooks/check-no-credentials.js --all        # every tracked file (audit)

npx nx run @adhd/source:secret-scan --mode=staged            # same as --staged
npx nx run @adhd/source:secret-scan --mode=range --base=A --head=B
npx nx run @adhd/source:secret-scan --mode=all                # same as --all
```

**`--all`/`--mode=all` also runs gitleaks in its default `git` mode, which scans the
FULL commit history, not just the current tree.** A clean working tree does not imply
`--all` exits 0: any not-yet-rotated historical secret anywhere in `git log` still
fires. See `ENV-SEC-001`/`ENV-SEC-002` in `BACKLOG.md` — two such findings are
currently OUTSTANDING (rotation pending, owner: human), so `--all` is expected to
report non-zero until they're rotated. This is the scanner working as designed, not a
bug in it.

**Engines**

1. **Built-in pattern rules** — always run. Zero dependencies. Cover provider-issued
   key shapes (AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, npm, PyPI,
   crates.io), private-key blocks, and repo-specific vectors:
   - `adhd-environment.json` (+ its `.tmp`) — `@adhd/environment` writes these with
     `config` + `raw` **fully resolved**, including fields declared `secret: true`,
     with no redaction anywhere in that package family. Blocked by **path**, because
     the leaked values are arbitrary user config, not provider-shaped tokens, so no
     content rule can catch them.
   - `ADHD_AGENT_*{SECRET,TOKEN,KEY,PASSWORD}` assigned a literal value.
2. **gitleaks** — authoritative when installed (~150 maintained rules), configured by
   [`.gitleaks.toml`](../.gitleaks.toml).

**Installing gitleaks** (recommended locally, **required** in CI):

```bash
brew install gitleaks
```

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | clean |
| `1` | credential detected — blocked |
| `2` | the scan itself could not run (unreadable git state, gitleaks errored, or `SECRET_SCAN_REQUIRE_GITLEAKS=1` with gitleaks absent) |

Exit `2` exists because **a scanner that errored is not a scanner that found nothing.**
Locally, a missing gitleaks degrades to pattern-only with a loud warning. In CI,
`SECRET_SCAN_REQUIRE_GITLEAKS=1` turns that into a hard failure.

## False positives

Append the pragma to the offending line:

```ts
const example = 'AKIA...'; // pragma: allowlist secret
```

`gitleaks:allow` on the line works for the gitleaks engine. For a durable, reviewable
exception, add a scoped rule or allowlist entry to `.gitleaks.toml`.

There is **no blanket directory allowlist** — exempting `__tests__/` or `fixtures/`
wholesale is exactly how real keys end up hiding in fixtures.

The placeholder filter (`changeme…`, `example…`, `your-…`, `${…}`, `process.env.…`)
suppresses the generic-assignment rule only. Provider-shaped keys are **never**
suppressed by it: a string starting with `AKIA` is reported even if the line also
says "example".

## If the hook fires on a real secret

1. **Rotate it.** Immediately. Deleting the line is not enough — assume the value is
   compromised the moment it is written to disk in a repo.
2. Remove it from the change.
3. If it was already committed locally, rewrite that commit before pushing.

## Bypass

```bash
git commit --no-verify   # emergency only; you own the consequences
```

CI does not honour `--no-verify`. The `secret-scan` job still runs on the PR.
