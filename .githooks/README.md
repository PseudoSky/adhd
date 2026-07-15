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
| `pre-commit` | **1.** `check-no-credentials.js --staged` — blocks credentials from entering the repo. **2.** `nx affected -t lint --fix --files=<staged>` — auto-fixes fixable issues (incl. `@nx/dependency-checks`, which derives each `package.json`'s deps from its imports), re-stages what it rewrote, and blocks on any unfixable lint error. |

Secrets are checked **first** and are cheap. A leaked credential is *unrecoverable*
once pushed — the fix is rotation, not reversion — whereas a lint error is not.
Do not reorder these gates.

Hooks must be executable (`chmod +x .githooks/<hook>`).

## `check-no-credentials.js`

One scanner, two engines, three modes. The **same script** runs locally and in CI
(`.github/workflows/pull-request.yml` → `secret-scan` job), so a commit cannot pass
the hook and then fail differently on a PR.

```bash
node .githooks/check-no-credentials.js              # staged changes (pre-commit)
node .githooks/check-no-credentials.js --range A B  # diff A..B  (CI on a PR)
node .githooks/check-no-credentials.js --all        # every tracked file (audit)
```

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
