# Doc review — @adhd/stealth-search — 3537748eb (working tree)

VERDICT: PASS

## Lens 1 — closed loop
metric_1: 4 -> 3 recorded in metrics.md (not above baseline, met). Two of the three remaining fallbacks (library wiring in src/index.ts and src/lib/config.ts) are closed by docs/LIBRARY.md, which post-dates the recorded after-block.
undocumented: recorded 40% (10 of 25) -> independently re-derived 0 of 10. Each of configureSearch, createSearchService, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, createSearchHostConfig, DEFAULT_SEARCH_HOST_CONFIG, SEARCH_REMEDIATION, isSearchError, isSearchErrorCode, PROVIDER_NAMES (and InteractionPort) appears in docs/LIBRARY.md; the export list matches src/index.ts. Constants checked against source: timeout 30000, attempts 3, TTL 7200000, cooldowns 30000/20000/60000, siblings 4. Junk 0% -> 0%.
contradictions: 0. Eleven operations, twelve providers, 13 error codes and the defaults all match capabilities.json and source. Google parsers are labelled provisional (synthetic fixtures only) in README, AGENTS, llms.txt, CHANGELOG, RESPONSIBLE-USE and hero.
Advisory: metrics.md and doc-conformance.md after-blocks were not refreshed after LIBRARY.md was added and still print 40%; refresh before the next cycle.

## Lens 2 — conformance
- Link resolver (python, executed over README, CHANGELOG, AGENTS, llms.txt, docs/*.md, docs/marketing/*.md): zero misses. LICENSE exists.
- The four overclaim words: zero occurrences in README.md, docs/ (excluding .catalog), AGENTS.md, llms.txt, CHANGELOG.md (rg -i, stem forms included).
- No AI attribution found in any owned doc.
- capabilities.json: 16 entries, all status shipped, the eleven verbs each carry a receipt command and verified_output; the extra five are host-flags, mcp-stdout-json-rpc-only, typed-error-codes, mcp-iserror-channel, observability-spans.
- README: "stealth" scoped to two concrete choices with an explicit non-guarantee; claims map to shipped capabilities. AGENTS.md and llms.txt are factual, no marketing adjectives. CHANGELOG uses Keep-a-Changelog headings with a dated 0.1.0. LIBRARY.md linked from README and llms.txt.
- Live verification: hero.md, positioning.md and the capability notes state that Chrome-dependent operations are verified against fakes and --help, not a live Chrome run. No doc claims live-Chrome or live-Google verification.
- Missing bundle docs: none.
Minor (non-blocking): github strategy pair `["network","network"]` unexplained; CHANGELOG 0.1.0 link is a tree URL.

## Lens 3 — consumer test
Four tasks in consumer.md: MCP search call (gap closed by the README MCP section), typed failure and exit 70, Chrome host/profile/stderr rule, CAPTCHA and meaning of stealth. All completed doc-only. Residual noted gaps are minor (challenge wait timeout beyond challengeWaitMs, per-client MCP config locations, unsupported platform paths).

## Required fixes
None blocking. Recommended: re-run the cartographer so metrics.md records the post-LIBRARY.md figures.
