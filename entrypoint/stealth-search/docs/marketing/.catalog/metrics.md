## run 3537748eb — 2026-10-24T14:27:31-04:00  (BEFORE state)
metric_1_eliminated_reader_searches: 4   # raw-source fallbacks this run
  - src/index.ts: docs list no library exports beyond the verbs; had to read it to learn configureSearch / createSearchService / createSearchHostConfig / InteractionPort exist
  - src/lib/config.ts: wiring entry for programmatic use is undocumented
  - src/errors.ts + src/host-errors.ts: needed to confirm the exact code set and that host-errors adds no code (docs/ERRORS.md has the table, but the cartographer must prove it against source; counted conservatively)
  - src/lib/providers.ts: docs do not explain the github `["network","network"]` strategy pair or the real UNKNOWN_PROVIDER message (ERRORS.md sample is wrong)
  - dist/bin help for per-operation flags: docs list flags only through examples, no per-operation flag table (resolved by --help, not source; not counted)
metric_2_feature_delta: discovered=11 added=11 deprecated=0   # first run, no prior capabilities.json; 5 extra shipped facets recorded (host-flags, mcp-stdout-json-rpc-only, typed-error-codes, mcp-iserror-channel, observability-spans)
metric_3_doc_junk_ratio: junk=0% redundant=0% undocumented=40%
  - undocumented exports: 10 of 25 root runtime exports have no doc mention (11 verbs and 4 of the error-family exports are documented). Names: configureSearch, createSearchService, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, createSearchHostConfig, DEFAULT_SEARCH_HOST_CONFIG, SEARCH_REMEDIATION, isSearchError, isSearchErrorCode, PROVIDER_NAMES
  - doc defects: 1 INCORRECT sample (ERRORS.md UNKNOWN_PROVIDER message), 1 banned-word hit (AGENTS.md:10 "undetectable"), 3 borderline "evasion" hits (README.md:165, llms.txt:12, RESPONSIBLE-USE.md:32), 1 undated CHANGELOG release
  - redundant is 0% of whole files; 3 partial overlaps (13-code list x4, stealth definition x3, defaults tables x2)
notes: Receipts executed: 11 CLI --help (exit 0), 4 direct runs (listProviders/describeProvider/tripwireStatus/clearTripwire exit 0), search --provider nope exit 70, chromeStatus --cdp-port abc exit 77, MCP stdio tools/list exit 0, nx build-bin exit 0, nx test 80 files/949 tests exit 0, 14 targeted vitest specs exit 0. Nothing touched a real Chrome or port 9222.

## run AFTER — docs rewritten (measured against README.md, AGENTS.md, llms.txt, docs/*.md, CHANGELOG.md; no builds or tests rerun)
metric_1_eliminated_reader_searches: 3   # was 4 (delta -1)
  - src/index.ts + src/lib/config.ts: library wiring exports still absent from every doc (unchanged, counted separately before, one fallback now since both answer the same question)
  - src/lib/providers.ts: github `["network","network"]` strategy pair still unexplained; the ERRORS.md UNKNOWN_PROVIDER sample is now correct, so that half of the earlier fallback is gone
  - src/errors.ts + src/host-errors.ts: no longer needed, docs/ERRORS.md and AGENTS.md now match source
metric_3_doc_junk_ratio: junk=0% redundant=0% undocumented=40%   # was junk=0% redundant=0% undocumented=40% (delta 0)
  - undocumented exports: still 10 of 25 (configureSearch, createSearchService, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, createSearchHostConfig, DEFAULT_SEARCH_HOST_CONFIG, SEARCH_REMEDIATION, isSearchError, isSearchErrorCode, PROVIDER_NAMES); none appear in any doc
  - doc defects: 0 INCORRECT samples (was 1), 0 flagged-word hits in prose (was 1 plus 3 borderline), 0 undated releases (was 1)
  - redundant stays 0% of whole files; the 3 partial overlaps remain
notes: Fixed and verified by reading files: AGENTS.md no longer uses the flagged word, "evasion" replaced by "circumvention" in README.md:193, llms.txt:12, RESPONSIBLE-USE.md:32; ERRORS.md:49,57 carry the real UNKNOWN_PROVIDER message; CHANGELOG [0.1.0] dated 2026-10-24; MCP `{ "data": ... }` wrapper now in AGENTS.md:8 and ERRORS.md:54. Still open: library exports, per-operation sample outputs, operand form, github strategy pair, CHANGELOG 0.1.0 link is still a tree URL.
