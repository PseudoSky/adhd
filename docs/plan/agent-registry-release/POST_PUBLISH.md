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
