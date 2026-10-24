## run 2b8320c8e — 2026-10-24T14:23:54-04:00
metric_1_eliminated_reader_searches: 7   # raw-source fallbacks needed to answer consumer questions the baseline docs did not
metric_2_feature_delta: discovered=15 added=15 deprecated=0   # first catalog; 6 verbs + 8 namespaces + 1 error model; all 15 receipts executed, verified=true
metric_3_doc_junk_ratio: junk=0% redundant=~23% undocumented=48%
notes: Baseline docs = README.md(65) AGENTS.md(21) CHANGELOG.md(5) docs/ERRORS.md(76) docs/reference/** (16 files, 4,231 lines at commit 2b8320c8e). Google SERP parsers are provisional (synthetic fixtures).

### Baseline detail
- Public runtime exports: 124 (6 verbs, StealthCoreBrowserError, exitCodeFor, ERROR_CODES, 115 namespace members: lifecycle 42, cdp 27, recording 18, endpoint 8, storage 6, capture 5, parsers 5, chromeManager 4).
- Mentioned by name in baseline docs: 65 of 124 (52%); not mentioned: 59 (lifecycle 38, recording 15, cdp 3, chromeManager 2, chromeStatus 1). Name match is an upper bound.
- Shipped capabilities: 15 of 15, all receipts exit 0 (tests passed: 24, 64, 29, 72, 18, 18, 228, 173, 246, 52, 47, 37, 288, 39, 132; specs overlap).
- Redundant share: of 4,231 reference lines, cdp-connection.md (156) and the cdp/ files other than history-db.md (737) and domains.md (503) (838 lines: README, api-reference, usage, monitoring, protocol-overview, target-domain, target-timing) duplicate cdp.md: 994 lines, ~23%. Share is by lines of the reference set.
- Junk share: 0% outright wrong files; INCORRECT spots: docs/reference/parsers.md lines 74 and 126 (nonexistent '/types' subpath), CHANGELOG missing 0.1.0 entry.
- Reader-search proxy (7): (1) default profile dir per OS -> src/lib/helpers.ts; (2) lifecycle state dir pattern -> src/lib/lifecycle/state-dir.ts; (3) chromeManager option defaults -> src/lib/chrome-manager.ts; (4) verb input defaults/launchChrome restrictions -> src/api.ts; (5) which OS code paths exist -> src/lib/cdp/browser.ts; (6) lifecycle/recording exports -> src/lib/lifecycle/index.ts, src/lib/recording/index.ts; (7) chromeStatus verb semantics -> src/api.ts.
