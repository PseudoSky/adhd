# Doc conformance: @adhd/stealth-core-browser

Baseline commit: 2b8320c8e (docs as committed before the docs-marketing-run rewrite). Working-tree docs written afterwards (README, AGENTS, CHANGELOG rewrites, docs/CONFIGURATION.md, EXAMPLES.md, RESPONSIBLE-USE.md, llms.txt) are NOT assessed here.
Scope type: library. Ideal doc set: README (what/install/quickstart), API reference, CONFIGURATION, ERRORS, EXAMPLES, CHANGELOG, AGENTS.

## Coverage proportions (runtime exports, by name mention in baseline docs)
- 124 runtime exports (115 namespace members + 6 verbs + StealthCoreBrowserError, exitCodeFor, ERROR_CODES).
- 65 mentioned by name (52%); 59 not mentioned (48% UNDOCUMENTED): lifecycle 38 of 42, recording 15 of 18, cdp 3 (createIsolatedPageTarget, getSessionId, hideAllWindows), chromeManager 2 (REAP_IF_IDLE_TIMEOUT_MS, RECONNECT_MIN_INTERVAL_MS), verb chromeStatus (flat) 1.
- Name mention is an upper bound on real documentation (launchChrome and listPageTargets match only as cdp.* functions with different signatures than the verbs).
- JUNK/REDUNDANT file-level shares: see metrics.md.

## Per-doc assessment
| Doc | Verdict | Flags | Rationale |
|---|---|---|---|
| README.md (65 lines) | REVISE | BURIED, INCORRECT-by-omission | Never shows the six verbs (the stable surface per capabilities.json); quickstart uses cdp internals on port 9222. Endpoint-policy section appended after Development. Install says pnpm only (fine). Correct Node (22.5) and Chrome requirement. |
| AGENTS.md (21 lines) | REVISE | THIN | Correct (no e2e, 9222 off limits, Node 22.5). Lacks defaults, verbs, platform facts, error model pointer. |
| CHANGELOG.md (5 lines) | REVISE | INCORRECT | Only an Unreleased note; no 0.0.1/0.1.0 entries while package.json version is 0.1.0. |
| docs/ERRORS.md (76 lines) | KEEP | - | Registry of ERROR_CODES (32 codes) in source order; asserted by test/unit/errors/registry.spec.ts and test/unit/docs/agents-md.spec.ts. |
| docs/reference/README.md (190) | REVISE | OVERVALUED/CONFUSING | Mixes overview, design rationale and verb inputs; lines 123-190 endpoint policy and verb inputs are the only place the verbs are documented. Lists lifecycle/recording/endpoint in a single row. |
| docs/reference/cdp.md (480) | REVISE | OVERLAP | Overlaps cdp/*.md and cdp-connection.md. |
| docs/reference/cdp-connection.md (156) | CONSOLIDATE -> docs/reference/cdp.md | REDUNDANT | Same session/target tables as cdp.md. |
| docs/reference/cdp/*.md (9 files, 2,078 lines) | CONSOLIDATE (keep history-db.md, domains.md as appendices) | REDUNDANT, BURIED | Protocol background; api-reference.md/usage.md duplicate cdp.md. |
| docs/reference/capture.md (414) | KEEP | - | Matches capture namespace (5 members). |
| docs/reference/parsers.md (273) | REVISE | INCORRECT | Lines 74 and 126 import from '@adhd/stealth-core-browser/types': no such subpath (package has one entry, `export type *` from root). Must not present Google parsers as verified beyond synthetic fixtures. |
| docs/reference/storage.md (434) | REVISE | MINOR | Line 347 lists Windows profile path; Windows is code-path-only, unverified. |
| docs/reference/chrome-manager.md (206) | REVISE | UNDOCUMENTED members | Omits REAP_IF_IDLE_TIMEOUT_MS, RECONNECT_MIN_INTERVAL_MS; check option defaults against capabilities.json defaults.chromeManagerOptions. |

## Missing docs (UNDOCUMENTED)
- CONFIGURATION (defaults, state dir, platform): all values now in capabilities.json "defaults".
- lifecycle and recording references (38 and 15 unnamed members).
- chromeStatus verb reference; per-verb input/result/error table.
- EXAMPLES index (examples/verbs/*.ts, examples/namespaces/*.ts exist and are covered by test/unit/examples/examples.spec.ts).
- Responsible use / what "stealth" does and does not mean.
- Platform support statement (only macOS verified in practice).

## Extracted orphans (correct facts not represented in baseline docs)
- Verb surface is the stable API; namespaces are experimental (source: AGENTS.md rewritten later, src/api.ts header).
- launchChrome exposes only port and userDataDir; chromePath/extraArgs deliberately excluded (arbitrary command execution over MCP).
- Profile identity: a reachable Chrome is attached to only if its command line carries exactly --user-data-dir=<profileDir>, else LAUNCH_FAILED reason foreign-profile (src/lib/cdp/browser.ts:125-190).
- Loopback-only endpoint policy and assertSameEndpoint redirect refusal.
- ChromeStatus.managed is required boolean because of an apigen oneOf quirk with optional booleans (src/api.ts comment).
- Storage readers open SQLite immutable: WAL rows not yet checkpointed are invisible (src/lib/storage/helpers.ts:6-12).
- Launch circuit breaker 3 failures / 60s window / 30s cooldown.
- Private state dir <tmpdir>/stealth-browser-<uid>-<port>, 0700.
- package.json version 0.1.0 vs CHANGELOG without release entries.

## Recorded findings
- Google SERP parsers (extractWithXpath, extractStructural, extractResultsFromHtml) are synthetic-fixture verified only: PROVISIONAL.
- activity.ts:35 strips the profile dir with a literal '/Default/History' (POSIX separators).
