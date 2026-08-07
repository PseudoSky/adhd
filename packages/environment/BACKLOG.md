### DEBT-ENV-CLI-002 — `environment-cli` has no runnable CLI executable — only an `api.ts`/`core.ts` library surface

**Status:** OPEN

- **Discovered:** 2026-07-18, `environment-redesign` worktree, Wave 3, while closing `DEBT-ENV-CLI-001` (re-adding `verify`/`diff`/`config-get`/`doctor`).
- **Detail:** `entrypoint/environment-cli/project.json` has no `generate-cli` target (verified: `npx nx show project environment-cli --json` lists only `lint`/`test`/`build`), unlike its sibling `entrypoint/dispatch-cli`, which wires `generate-cli` (`@adhd/apigen-generator-nx:generate`, `type: "cli"`) into `test`'s `dependsOn` and drives the generated `dist/entrypoint/dispatch-cli/cli/cli.ts` in a real smoke test. `environment-cli`'s `package.json` has no `bin` field either. Grepping the whole repo tree confirms no `bin/cli.ts` (hand-written, as `dispatch-cli` has as a documented fallback) or generated `cli.ts` was ever produced for this package. Consequently all 9 commands (`init`/`build`/`set`/`status`/`export`/`verify`/`diff`/`config-get`/`doctor`) are reachable today only via direct `import { ... } from '@adhd/environment-cli'` — there is no `adhd-env <command>` terminal invocation a human or script can actually run, despite `ARCHITECTURE.md` §4 and every doc comment in `api.ts`/`core.ts` describing CLI invocation syntax (`adhd-env verify <project> <specPath> ...`) as if one existed.
- **Impact:** Low — `ARCHITECTURE.md` §4 explicitly demotes this CLI to "thin, optional wrapper... never required for a consumer to run" (the real `Environment<T>` class is the primary, self-sufficient API), so nothing depends on a terminal entrypoint existing. But the package's own name (`environment-cli`) and its doc comments promise one, and currently deliver none.
- **Fix direction:** either (a) add a `generate-cli` target mirroring `dispatch-cli`'s (`@adhd/apigen-generator-nx:generate`, `source: src/api.ts`, `type: cli`, wired into `test`'s `dependsOn`) plus a real driving smoke test against the generated binary, or (b) hand-write a thin `commander` wrapper (`bin/cli.ts`) over the same `api.ts` surface if the apigen generator hits the same schema-resolution class of bug `dispatch-cli`'s own `bin/cli.ts` header documents (`BUG-APIGEN-CLI-001`-adjacent), or (c) if a terminal entrypoint is never actually wanted, drop the `-cli` naming/CLI-syntax doc comments so the package doesn't advertise a capability it doesn't have.
- **Status:** OPEN — not blocking (per `ARCHITECTURE.md` §4, this CLI is optional/non-required tooling; every command is fully exercised and tested via its `api.ts` function surface, per `DEBT-ENV-CLI-001`'s closure in `CHANGELOG.md`).

### ENV-SEC-004 — REPO — `check-no-credentials.js --all` reports 7 pre-existing secrets in git history

**Status:** OPEN

- **Where:** committed git history (1696 commits), surfaced by `gitleaks` in the hook's `--all` audit mode. NOT introduced by any `@adhd/environment` work — `gitleaks dir packages/environment` over the full working tree reports "no leaks found".
- **Description:** `--all` runs `gitleaks git` over the whole commit history and finds 7 historical leaks (the backlog the `48ab824f` "add credential pre-commit gate" commit was created to stop growing). The pre-commit `--staged`/`--range` modes only scan new changes and are unaffected; only the audit/backfill `--all` mode surfaces the historical backlog.
- **Status:** OPEN (repo-wide, out of scope for `packages/environment`) — remediate via history scrub / documented allowlist of the 7 known findings. **Explicitly left open per instruction — do not touch git history.**

---
