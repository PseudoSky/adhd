# PUBLISH_RUNBOOK — publish the 6 packages via nx release publish

> **NEVER `--skip-nx-cache`.** The nx cache is correct; the flag ships stale dist
> (a published-wrong-artifact bug). Need a clean rebuild? `npx nx reset` then a
> normal cached build. This runbook is audited for the absence of that token.

## Precondition: re-verify the back-out guarantee before publishing

```bash
python3 docs/plan/agent-registry-release/scripts/check_agent_mcp_baseline.py   # must exit 0
```

The back-out gate is a precondition of publish as well as merge (Plan 9 dod.5).

## Version bumps

Bump each package per its actual delta (pinned in `closeout-design`). `agent-mcp`
is **`2.0.0`** (SPEC §11 — the breaking required→optional `systemPrompt` change;
`systemPrompt` remains a permanent compat shim across 2.x). The registry packages
take their first/next minor per their changes.

## Reconcile `@adhd/*` dependency version pins — NO `"*"` may ship (F-P6-13)

`@adhd/agent-mcp@2.0.0`'s `dist` imports `@adhd/agent-compiler`, `@adhd/agent-policy`,
and `@adhd/agent-mcp-types` (transitively `@adhd/agent-registry`,
`@adhd/agent-tool-registry`, `@adhd/agent-provider`, `@adhd/agent-mcp-budget`). These
MUST publish as **real, concrete versions** — never the workspace `"*"`. A published
`"*"` leaves a consumer's install resolving a floating latest (or failing outright),
so the agent-mcp `dist` cannot load its registry/compiler deps. `nx release` writes
the concrete versions from the version plan; **verify none remain `"*"` before
publishing** (this command must print nothing — any leftover `"*"` is a release
blocker, decisions.md R6 `def:runtime-dep-versions`):

```bash
for p in agent-mcp-types agent-registry agent-tool-registry agent-provider \
         agent-policy agent-compiler agent-mcp; do
  node -e "const d={...(require('./packages/ai/$p/package.json').dependencies||{})};
    for (const [k,v] of Object.entries(d)) if (k.startsWith('@adhd/') && v==='*')
      { console.error('$p: '+k+' still \"*\"'); process.exitCode=1; }"
done
```

Runtime resolution is then proven from the PUBLISHED package graph (not workspace
symlinks) by `scripts/smoke_test.sh`, which installs `@adhd/agent-mcp` into a
throwaway project OUTSIDE the workspace and `require()`s it plus its transitive
`@adhd/*` deps. A green smoke is the consumer-outcome proof.

## Build + test (clean, cached)

```bash
npx nx reset
npx nx run-many -t build test lint \
  -p agent-mcp-types agent-registry agent-tool-registry agent-provider agent-policy agent-compiler agent-mcp
```

Prove a cache hit by running the build twice and reading nx's output — do NOT reach
for `--skip-nx-cache`.

## Publish (dependency order — see decisions.md R3)

```bash
# nx release publish runs a clean cached build+test and ships the right artifact.
npx nx release publish -p agent-mcp-types        # if bumped
npx nx release publish -p agent-registry
npx nx release publish -p agent-tool-registry
npx nx release publish -p agent-provider
npx nx release publish -p agent-policy
npx nx release publish -p agent-compiler
npx nx release publish -p agent-mcp              # @adhd/agent-mcp@2.0.0
```

Order matters so a consumer resolving a freshly-published package never hits an
unpublished dependency (`agent-compiler` depends on 2–5; `agent-mcp` on types).

Proceed to `POST_PUBLISH.md` for the registry-resolution + smoke checks.
