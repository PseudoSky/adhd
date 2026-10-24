# Release decision

DECISION: publish

## Pre-push gates

- `npx nx affected -t lint typecheck test build` — exit 0 (466 tasks, 0 failures)
- Package gates (lint, typecheck, typecheck-spec, test, build, build-bin, verify-dist-load) for `@adhd/stealth-core-browser`, `@adhd/stealth-search` and `@adhd/resilience-core-tripwire` — exit 0 (evidence/gates-rerun.json, all_green)
- Tripwire e2e — exit 0

## Packages

| Package | Version |
| --- | --- |
| `@adhd/resilience-core-tripwire` | 0.1.0 |
| `@adhd/stealth-core-browser` | 0.1.0 |
| `@adhd/stealth-search` | 0.1.0 |

PUBLISH_ORDER: @adhd/resilience-core-tripwire, @adhd/stealth-core-browser, @adhd/stealth-search

`@adhd/apigen-engine-runtime` 0.3.6 publishes before all three (the registry's 0.3.5 lacks `buildApigenPackage`); stealth-search's range is bumped to `^0.3.6` and `pnpm check:release-ranges` runs before the first publish. Dependencies publish before dependents.

## Reverse-apis

Branch `feat/tripwire-adopt` adopts the published tripwire package. tripwire-reverse-migrate is complete; tripwire-reverse-relink follows the publish.

## Consumer

CONSUME: @adhd/stealth-search@0.1.0
