# POST_PUBLISH — registry resolution + smoke test

> Confirms each published package resolves on the registry at its bumped version
> and that the USAGE.md consumer journey (install → compose → apply policy →
> compile to platform) works against the published artifacts.

## 1. Registry resolution

```bash
for P in agent-registry agent-tool-registry agent-provider agent-policy agent-compiler agent-mcp; do
  npm view "@adhd/$P" version    # each must print the just-published version
done
# @adhd/agent-mcp MUST print 2.0.0
```

## 2. Smoke test (the USAGE journey against published packages)

Run `scripts/smoke_test.sh`, which installs the published packages into a scratch
project and drives the `USAGE.md` journey end-to-end:

```bash
bash docs/plan/agent-registry-release/scripts/smoke_test.sh
```

It asserts (exit-code gated — never `| grep -q passed`):
- the `agent-registry compile` CLI bin resolves and emits a claude_code agent;
- the compiled output carries the expected frontmatter (tools/model header);
- `@adhd/agent-mcp@2.0.0` imports and its `guide` renders the authoring section.

## 3. Per-package smoke references

See each package's `PUBLISHING.md` / README smoke section (project convention) for
the package-specific post-publish check. Record the run + the resolved versions in
this file's run log below.

## Run log

> Appended by `post-publish-smoke` at execution time: resolved versions + smoke
> exit codes + date.

### 2026-06-28 — OUT-OF-BAND pragmatic publish (NOT via this plan's state machine)

The registry suite was published to npm **out of band** — the `agent-registry-release`
state machine remains `pending` (no baseline pin / back-out gate / `--no-ff` merge /
audit). This followed the **runbook mechanics only** (R3 order, R6 no-`"*"` concrete
pinning, out-of-workspace smoke), per an explicit owner decision to unblock the compiler
chain for consumers. Divergences from the plan as written:

- **`agent-mcp` is `2.0.1`, not `2.0.0`.** An earlier ad-hoc `2.0.0` shipped with `"*"`
  deps + the chain unpublished (install-broken, F-P6-13) and is immutable on npm; `2.0.1`
  supersedes it with concrete pins + the chain published.
- **`@adhd/agent-compiler` is an OPTIONAL dependency of agent-mcp** (dynamic import,
  graceful flat-prompt fallback) so agent-mcp installs standalone; full compiler/registry
  integration when the optional chain is present.

Published versions (all `latest`): `agent-mcp-types@2.0.0`, `agent-registry@0.0.1`,
`agent-tool-registry@0.0.1`, `agent-provider@0.1.0`, `agent-policy@0.0.1`,
`agent-compiler@0.0.1`, `agent-mcp@2.0.1`. dist verified concrete (no `"*"`).

Smoke: out-of-workspace `npm i @adhd/agent-mcp@2.0.1` → **exit 0** (standalone install
fixed). Full-chain resolution re-verified after npm propagation of the 5 new package
names. The plan's full USAGE-journey smoke (`scripts/smoke_test.sh`, compile-CLI) was
NOT run — pragmatic-publish scope.

> If the initiative is later closed out properly, reconcile these already-published
> versions with the plan's version strategy.
