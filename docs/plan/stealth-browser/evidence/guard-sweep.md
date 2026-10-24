# Guard sweep

Final HEAD at sweep: `bc014d8a1`. Sequential `guard.py <state>` per completed non-audit state; a red is re-run twice before diagnosis.

| state | rc | tries | note |
|---|---|---|---|
| productization-hold | 0 | 1 |  |
| scaffold | 0 | 1 |  |
| entrypoint-parity | 0 | 1 |  |
| deps-install | 0 | 1 |  |
| mig-foundation | 0 | 1 | green (mig-foundation.1 re-verified) |
| mig-cdp | 0 | 1 |  |
| mig-chrome-manager | 0 | 1 |  |
| mig-domains-storage | 0 | 1 |  |
| mig-capture-parsers | 0 | 1 |  |
| mig-queries | 0 | 1 |  |
| mig-docs | 0 | 1 |  |
| surface-api | 0 | 1 | green (surface-api.3 re-verified) |
| tests-unit-core | 0 | 1 |  |
| tests-unit-data | 0 | 1 |  |
| tests-unit-extract | 0 | 1 |  |
| tests-unit-surface | 0 | 1 |  |
| gates-first | 0 | 1 |  |
| prod-errors | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| prod-examples | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| port-fixes | 0 | 1 |  |
| audit-fixes | 0 | 1 |  |
| capture-upgrade | 0 | 1 |  |
| chrome-lifecycle | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| tests-use-cases | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| cdp-test-harness | 0 | 1 |  |
| failsafe-inventory | 0 | 1 |  |
| sp-reaper-load-proof | 0 | 1 |  |
| sp-link | 0 | 1 |  |
| sp-reaper-smoke | 0 | 1 |  |
| sp-switch | 0 | 1 |  |
| tripwire-scaffold | 0 | 1 |  |
| tripwire-core | 0 | 1 |  |
| tripwire-interactive | 0 | 1 |  |
| tripwire-docs | 0 | 1 |  |
| tripwire-pack | 0 | 1 |  |
| tripwire-reverse-migrate | 0 | 1 |  |
| split-plan-repair | 0 | 1 |  |
| core-scaffold | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| core-seam | 0 | 1 | core-seam.12 measures browser.spec.ts / launch.spec.ts as core-seam committed them (migration_snapshot); accepted |
| search-scaffold | 0 | 1 |  |
| search-inventory | 0 | 1 |  |
| search-errors | 0 | 1 |  |
| search-port-providers | 0 | 1 |  |
| search-port-fetch | 0 | 1 |  |
| search-port-engine | 0 | 1 |  |
| search-port-guards | 0 | 1 |  |
| search-verbs | 0 | 1 |  |
| search-tracing | 0 | 1 |  |
| search-hosts | 0 | 1 |  |
| search-usecases | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| search-examples | 0 | 1 |  |
| tracing-log-validation | 0 | 1 |  |
| search-cutover | 0 | 1 |  |
| main-merge | 0 | 1 |  |
| conform-tripwire | 0 | 1 |  |
| conform-core | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| conform-search | 0 | 1 | fixed in 84bad5e2d / 5e583aee6; green |
| fix-tripwire | 0 | 1 |  |
| fix-core-parsers | 0 | 1 |  |
| fix-core-lifecycle | 0 | 1 |  |
| fix-core-errors | 0 | 1 |  |
| fix-search-fetch | 0 | 1 |  |
| fix-search-engine | 0 | 1 |  |
| fix-search-output | 0 | 1 |  |
| search-mcp-iserror | 0 | 1 |  |
| fix-search-build | 0 | 1 |  |
| search-tracing-fixes | 0 | 1 |  |
| plan-notes | 0 | 1 |  |
| release-readiness | 0 | 1 |  |
| release-gate-fixes | 0 | 1 |  |

Result: 70 green / 70 total.
