# Productization catalog - @adhd/stealth-browser (plan 8468f7b1-8adc-4237-9986-21ea1e27c537)

Every productization item raised by the product review (`PRODUCT-REVIEW.md`, tasks P1-P11, out-of-scope candidates O1-O8, plan defects X1-X6) and by later user direction, with its decision and where the plan delivers it. The default for every item is product's verdict; a line says `decided by user: override` when the user changed it.

Verbatim user decisions that override or widen product:

- "Do unit tests instead of e2e tests but make the unit tests actually simulate real use cases"
- "Do the agent search migration as a substitute for e2e"
- "100% implement typed errors"
- "100% implement readme examples and genuine use cases for users"
- "I dont fully understand what Mig manager is, but there will not be a v3 that actually gets done so it should be built now"
- "Why would you be creating legacy packages on a brand new publically available module ... this implementation should be considered greenfield in terms of consumers."

## Items

| Id | Item | Priority | Decision | Delivered by |
|---|---|---|---|---|
| P1 | Host input allowlist (no arbitrary exec over MCP/CLI): `launchChrome` exposes only `port` and `userDataDir` | P0 | decided by user: product's verdict | `surface-api.7`, `surface-hosts.7`, `tests-unit-surface.4` |
| P2 | Redact cookie values from `getPageContext` on the hosts | P0 | decided by user: product's verdict | `surface-api` (claim evidence), `surface-hosts.8`, `tests-unit-surface.4`, `tests-use-cases` |
| P3 | Public API surface and stability tiers | P0 | decided by user: override (greenfield; no `./legacy` subpath, no deprecation tags, root namespaces plus six flat verbs, `SearchResultSource` becomes `PageSource`, `getSearchSessionId` dropped) | `surface-api.3`, `surface-api.10`, `prod-errors.7`; `prod-public-api` retired |
| P4 | MCP/CLI ergonomics: TSDoc descriptions, help, naming | P1 | decided by user: product's verdict | `surface-api.9`, `surface-hosts.10`, `surface-hosts.11` |
| P5 | Structured errors with remediation text | P1 | decided by user: override (widened to 100% of failures: 29 design-neutral codes = 4 host, 14 library, 6 capture, 5 lifecycle, plus any code the sink and lifecycle designs add; typed errors replace the legacy messages) | `prod-errors.1-8`, `surface-hosts.12` |
| P6 | Configuration story: typed options plus host flags, documented defaults | P1 | decided by user: product's verdict | `surface-hosts.13`, `docs-marketing-run.6` |
| P7 | First-run experience: examples | P1 | decided by user: override (a runnable example per verb and per namespace tied to real use cases, and every example embedded in the README) | `prod-examples.1-6`, `docs-marketing-run.10`, `readme-rewrite.9` |
| P8 | Responsible-use docs and honest positioning (stealth is two concrete flags) | P1 | decided by user: product's verdict | `docs-marketing-run.7-8`, `readme-rewrite.6-7` |
| P9 | Observability: tracing docs, `--verbose` to stderr only | P2 | decided by user: product's verdict | `tracing-plugin.7`, `docs-marketing-run.9` |
| P10 | Publish readiness and versioning | P1 | decided by user: product's verdict (state `prod-publish-readiness` retired; its checks moved into the gates) | `gates-first.7-9`, `audit-final.9`, `readme-rewrite.8` |
| P11 | Feedback loop: learnings after cutover | P2 | decided by user: product's verdict (not in the DAG) | backlog follow-up |
| O1 | Doctor/preflight verb (7th verb) | - | decided by user: product's verdict (not built) | `DEFERRED.md` |
| O2 | Change default port/profile away from 9222 and Chrome-CDP | - | decided by user: product's verdict (not built) | `DEFERRED.md` |
| O3 | Linux/Windows support for profile paths, history, cookies | - | decided by user: product's verdict (not built) | `DEFERRED.md` |
| O4 | Headless mode and profile-isolation option on `launchChrome` | - | decided by user: product's verdict (not built) | `DEFERRED.md` |
| O5 | Extract search-specific parsers/capture (Google SERP) into agent-search | - | decided by user: product's verdict (not built) | `DEFERRED.md` |
| O6a | Self-reaping Chrome singleton, backlog `19dfb641` | - | decided by user: override (moved from out of scope to "build now"); backbone recorded in EVALUATIONS.md E2 (in-package engine, default reaper launcher over @adhd/sox-service-proxy) | `chrome-lifecycle.1-27` |
| O6b | FEAT-AGENT-TRACING, backlog `5b98d3b2` | - | decided by user: product's verdict (unchanged: out of scope) | none |
| O7 | Publishing to npm | - | decided by user: product's verdict (the dispatcher's call at `merge-readiness`) | `merge-readiness.2`, `hb-release-decision` |
| O8 | CI without Chrome | - | decided by user: override (no Chrome is needed anywhere: the unit lane and the use-case suites are pure) | `cdp-test-harness`, `tests-use-cases` |
| X1 | Cycles | - | none found; `gap-check.js` run | validators |
| X2 | Barrel criterion versus P3 | - | resolved by the greenfield decision | `surface-api.3` |
| X3 | `dist/` in the merged main checkout before `link:` consumption | - | decided by user: product's verdict | `merge-readiness.4`, `agent-search-relink` |
| X4 | `docs-marketing-run` and `readme-rewrite` both touch README.md | - | decided by user: product's verdict (sequential; later overwrite is intentional) | ordering |
| X5 | `tests-unit-surface` depended only on `surface-api` | - | decided by user: product's verdict | `tests-unit-surface` depends on `surface-hosts` |
| X6 | `check-disjoint.py` after the insertions | - | decided by user: product's verdict | validators |

## Added by user direction (not in the product review)

| Id | Item | Decision | Delivered by |
|---|---|---|---|
| U1 | Unit tests that simulate real use cases replace the e2e lane; `tests-e2e` and `hb-chrome-binary` removed | decided by user: override | `cdp-test-harness`, `tests-use-cases` |
| U2 | The agent-search migration substitutes for e2e and runs before the audit, against a tarball packed from this worktree (no committed link into `.worktrees`, no main-checkout lockfile change); the post-release consumption is a second gated step | decided by user: override | `agent-search-cutover`, `agent-search-relink` |
| U3 | Capture upgrade: one `NetworkRecorder` pipeline, real response status, ExtraInfo merge, redirect chain, optional store-adapter sink (EVALUATIONS.md E1) | decided by user: build now; sink design B'' recorded | `capture-upgrade.1-28` |
| U4 | Pre-review audit and its fixes before the one blind review; the final audit is script-only | decided by user | `audit-pre-review`, `audit-fixes`, `audit-final` |

## Backlog items touched

- `19dfb641` (self-reaping Chrome singleton): moved to "user: build now". Built in the package without a sox-service-proxy dependency; re-cited to the new package paths by `agent-search-cutover`.
- `5b98d3b2` (FEAT-AGENT-TRACING): unchanged, out of scope.
- `7f881aa7` (`ensureChromeRunning` attaches to any Chrome on the port; `killChrome` fallback kills the port occupant): partly mitigated (the idle reaper closes only a Chrome this package launched); remains open (`DEFERRED.md`, FU-8).

| U5 | No feature or failsafe of the runner is removed; legacy code, names and tests are not preserved (greenfield); a feature inventory is built first and re-checked by the pre-review audit, the blind-review gate and the final audit | decided by user | `failsafe-inventory`, `port-fixes.8,.11`, `*.14`, `review-prep.5`, `audit-pre-review.5`, `audit-final.4,.12` |

## Feature-preservation review of this catalog

Verdicts that could remove a FEATURE, and how each is preserved or flagged:

- P1 (hosts do not expose `chromePath` and `extraArgs`): the library keeps both options; only the host projection is narrower, which is new surface, not a runner feature. Preserved.
- P2 (cookie values redacted on the hosts): the library result is unchanged; the redaction is new host behavior. Preserved.
- P3 / greenfield renames (`SearchResultSource` to `PageSource`, `getSearchSessionId` dropped, no `./legacy`): names, not features. Not a removal.
- Removal of `tests-e2e` and `hb-chrome-binary`: the e2e-only failsafe checks (the developer's Chrome on 9222 is never touched, shutdown kills only the PID it launched, MCP stdout stays JSON-RPC-clean) are preserved as feature-level unit and use-case tests (`tests-use-cases`, `surface-hosts`, inventory rows).
- CU8 (`extraWaitMs` default 500 ms to 0, so an explicit 0 can mean no wait): changes a default wait, flagged for the user to approve.
- `capture/dom.ts` Google-SERP walker: kept; the inventory flags it for the user if it is only a search-provider leftover. Not decided here.
