# Guard sweep

Date: 2026-10-24  
HEAD: b8d3f4591  
Method: sequential whole-state guard (`guard.py <state>`) for every completed non-audit state, in dag order; a red is re-run up to 3 tries.

| state | rc | tries | seconds |
|---|---|---|---|
| productization-hold | 0 | 1 | 0 |
| scaffold | 0 | 1 | 1 |
| entrypoint-parity | 0 | 1 | 6 |
| deps-install | 0 | 1 | 0 |
| mig-foundation | 0 | 1 | 1 |
| mig-cdp | 0 | 1 | 1 |
| mig-chrome-manager | 0 | 1 | 0 |
| mig-domains-storage | 0 | 1 | 1 |
| mig-capture-parsers | 0 | 1 | 2 |
| mig-queries | 0 | 1 | 1 |
| mig-docs | 0 | 1 | 0 |
| surface-api | 0 | 1 | 0 |
| tests-unit-core | 0 | 1 | 3 |
| tests-unit-data | 0 | 1 | 3 |
| tests-unit-extract | 0 | 1 | 3 |
| tests-unit-surface | 0 | 1 | 4 |
| prod-errors | 0 | 1 | 3 |
| prod-examples | 0 | 1 | 2 |
| port-fixes | 0 | 1 | 23 |
| capture-upgrade | 0 | 1 | 3 |
| chrome-lifecycle | 0 | 1 | 4 |
| tests-use-cases | 0 | 1 | 3 |
| cdp-test-harness | 0 | 1 | 2 |
| failsafe-inventory | 0 | 1 | 2 |
| sp-reaper-load-proof | 0 | 1 | 0 |
| sp-link | 0 | 1 | 2 |
| sp-reaper-smoke | 0 | 1 | 3 |
| sp-switch | 0 | 1 | 4 |
| tripwire-scaffold | 0 | 1 | 3 |
| tripwire-core | 0 | 1 | 7 |
| tripwire-interactive | 0 | 1 | 6 |
| tripwire-docs | 0 | 1 | 3 |
| tripwire-pack | 0 | 1 | 0 |
| tripwire-reverse-migrate | 0 | 1 | 0 |
| split-plan-repair | 0 | 1 | 5 |
| core-scaffold | 0 | 1 | 46 |
| core-seam | 0 | 1 | 17 |
| search-scaffold | 0 | 1 | 9 |
| search-inventory | 0 | 1 | 0 |
| search-errors | 0 | 1 | 19 |
| search-port-providers | 0 | 1 | 26 |
| search-port-fetch | 0 | 1 | 28 |
| search-port-engine | 0 | 1 | 64 |
| search-port-guards | 0 | 1 | 34 |
| search-verbs | 0 | 1 | 65 |
| search-tracing | 0 | 1 | 3 |
| search-hosts | 0 | 1 | 71 |
| search-usecases | 0 | 1 | 9 |
| search-examples | 0 | 1 | 9 |
| tracing-log-validation | 0 | 1 | 0 |
| search-cutover | 0 | 1 | 2 |
| main-merge | 0 | 1 | 26 |
| conform-tripwire | 0 | 1 | 18 |
| conform-core | 0 | 1 | 13 |
| conform-search | 0 | 1 | 48 |
| fix-tripwire | 0 | 1 | 60 |
| fix-core-parsers | 0 | 1 | 8 |
| fix-core-lifecycle | 0 | 1 | 9 |
| fix-core-errors | 0 | 1 | 10 |
| fix-search-fetch | 0 | 1 | 20 |
| fix-search-engine | 0 | 1 | 27 |
| fix-search-output | 0 | 1 | 26 |
| search-mcp-iserror | 0 | 1 | 29 |
| fix-search-build | 0 | 1 | 29 |
| search-tracing-fixes | 0 | 1 | 36 |
| plan-notes | 0 | 1 | 0 |
| release-readiness | 0 | 1 | 0 |
| release-gate-fixes | 0 | 1 | 111 |

States: 68; green: 68; red: 0.
