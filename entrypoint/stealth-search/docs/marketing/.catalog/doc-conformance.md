# Doc conformance: @adhd/stealth-search

Assessed at `3537748eb` (2026-10-24T14:27:31-04:00), BEFORE state. Yardstick: a CLI + MCP-server entrypoint is expected to carry README (what/why, install, operations, examples), CHANGELOG, an error reference, an observability reference, a configuration reference, a responsible-use statement and an agent-facing AGENTS.md / llms.txt. Recorded decisions applied: ADR-0003 (CJS only), ADR-0018 (MCP isError results).

Scope surface assessed: README.md, AGENTS.md, CHANGELOG.md, docs/ERRORS.md, docs/OBSERVABILITY.md (requested), plus docs/CONFIGURATION.md, docs/EXAMPLES.md, docs/RESPONSIBLE-USE.md and llms.txt (present, read for cross-checks).

## Headline proportions (by doc file, 9 files)

- JUNK: 0 of 9 (0%)
- REDUNDANT: 0 of 9 whole files; partial overlap only (see below)
- UNDOCUMENTED: 10 of 25 root runtime exports (40%); 1 of 11 operations lacks a documented example of output (see metrics.md)

## Per-doc assessment

### README.md: KEEP, REVISE (minor)
- Operation list, bins, flags, install, result-size, fetch outcomes, safe defaults: all match source. Verified: `dist/bin/cli.js --help` lists the same 11 operations and the same flags; MCP `tools/list` lists the same 11 `stealth_*` names. README block verification is enforced by test/unit/examples/examples.spec.ts (15 pass) and test/unit/docs/readme-contract.spec.ts (5 pass).
- OVERCLAIM check: none. The "What stealth means" section limits the claim to two concrete choices (no `--enable-automation`, no `Runtime.evaluate`) and explicitly disclaims guarantees. The words undetectable / bypass / evade / anti-bot do not appear in README.md.
- Borderline wording: README.md:165 contains "no CAPTCHA or ban evasion" (describing docs/RESPONSIBLE-USE.md). The token is "evasion", not one of the four banned words, and it is used negatively. If the ban is meant to be a stem match, reword to "no CAPTCHA solving or ban circumvention".
- BURIED: the library surface. Programmatic use shows only `api.search`. The wiring entry `configureSearch` / `createSearchService` / `createSearchHostConfig` / `InteractionPort` and the library exports `PROVIDER_NAMES`, `isSearchError`, `isSearchErrorCode`, `SEARCH_REMEDIATION`, `DEFAULT_*` constants are exported from the package root (src/index.ts) and appear in no doc. A reader wanting to inject a human-in-the-loop prompter must open src/index.ts and src/lib/config.ts.
- CONFUSING: no sample output for operations other than `search`. A reader cannot see the JSON shape of `listProviders`, `describeProvider`, `tripwireStatus` or `clearTripwire` without running them. Verified shapes (this run): `listProviders` -> `{"providers":[{"id","name","help","strategies"}]}`; `tripwireStatus` -> `{}` when nothing is locked; `clearTripwire` -> `{"provider":"google","cleared":false}`.

### AGENTS.md: REVISE
- INCORRECT-risk wording: line 10 uses the word "undetectable" ("It does not mean undetectable by sites."). Negated, but the word must not appear in docs prose; reword to "It makes no promise that a site will not notice or block you." (matches README).
- Facts verified against source: 11 operations; 12 providers (PROVIDER_NAMES: duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch); 13 error codes; defaults 127.0.0.1:9222, data dir `~/.adhd/reverse/data` (src/lib/config.ts:89-90); transport stdio; gates exist in project.json (typecheck, build-bin, verify-dist-load, lint, typecheck-spec, test, build via the inferred build target).
- Google provisional note present and accurate.
- Spec path `docs/plan/stealth-browser/SPEC-stealth-search.md` exists at the repo root. KEEP.
- The "Docs" list names `docs/marketing/.catalog/capabilities.json`, which this run now creates.

### CHANGELOG.md: REVISE (minor)
- `[0.1.0]` has no release date and `[Unreleased]` is empty although package.json is 0.1.0 and the project uses git-tag versioning; the 0.1.0 compare link is a tree URL, not a tag or compare range. Not incorrect, but the entry reads as an unreleased scaffold with a version heading.
- Content matches source: 11 operations, 12 providers, 13 codes, google provisional.
- "Telemetry records ... on both hosts" is verified by search-tracing specs (8 tests pass across three files).

### docs/ERRORS.md: REVISE (one INCORRECT sample)
- Code table matches `SEARCH_ERROR_CODES` and `exitCodeFor` exactly: 13 codes, exits 70 71 33 2 72 73 74 75 76 77 78 79 12. Verified at runtime: `search --provider nope` exits 70.
- INCORRECT: the CLI rendering sample and the MCP JSON sample show the message `provider "nope" is not registered — Use one of the registered provider ids ...`. The real stderr (captured this run) is `UNKNOWN_PROVIDER: Unknown provider "nope". Available: duckduckgo, google, arxiv, npm, github, maven, wikipedia, crates, pypi, mdn, stackoverflow, fetch — Use one of the registered provider ids (see the providers list), then retry.` (src/lib/providers.ts:479). Both samples should carry the real message.
- Remedy column is shorter than `SEARCH_REMEDIATION` for several codes (for example `UNKNOWN_PROVIDER` omits "(see the providers list)", `PDF_EXTRACT_FAILED` omits "or fetch it as raw content", `HOST_TRANSPORT_UNSUPPORTED` says "a supported transport" where source names "stdio for MCP, or the CLI"). Paraphrase, not contradiction; align if the table is meant to be canonical.
- Does not mention that `HITL_ABORTED` and `SELECTOR_TIMEOUT` are in the registry but are emitted by the core/engine, nor that `PROVIDER_STATE_IO`/`TRIPWIRE_*` surface only through guard paths. Optional.
- Words undetectable / bypass / evade / anti-bot: absent.

### docs/OBSERVABILITY.md: KEEP
- Matches src/tracing.ts (`makeTracingPlugin({ serviceName: 'adhd' })`) and the record names `adhd.<op>.start|finish|error`. The `adhd.op.error` twin and the "rejected flag is traced" claims are backed by search-tracing-single-error.spec.ts and search-tracing-rejected-flag.spec.ts (all pass).
- "`--help` is not a dispatch": consistent with `--help` runs this session (exit 0).
- Not independently re-verified at runtime: the telemetry file location default and the `role` values (`cli`, `live-service`). They are asserted by the specs only through fakes.
- Verified this run: the MCP bin writes nothing but JSON-RPC to stdout under stdio (2 stdout lines, both valid JSON; logs on stderr).

### Other docs (read for cross-check)
- docs/CONFIGURATION.md: KEEP. Defaults (tripwire 7200000, cooldowns 30000/20000/60000, concurrency 2, siblings 4, audit cap 5242880) equal DEFAULT_SEARCH_HOST_CONFIG in src/lib/config.ts:92-102.
- docs/EXAMPLES.md: KEEP; each listed example file exists.
- docs/RESPONSIBLE-USE.md: KEEP. Contains "No CAPTCHA or ban evasion" heading (line 32), same borderline token as above.
- llms.txt:12 same "ban evasion" phrase.

## Redundancy
- The 13-code list appears in ERRORS.md (canonical), CHANGELOG, AGENTS.md (count only) and llms.txt (full list). Canonical home: docs/ERRORS.md; llms.txt copy must be kept in sync (currently in sync).
- The "two concrete choices" definition of stealth appears in README, AGENTS.md and RESPONSIBLE-USE.md (three copies). Canonical home: docs/RESPONSIBLE-USE.md.
- Host-default tables appear in README "Safe defaults" and CONFIGURATION.md. Canonical home: CONFIGURATION.md.

## Extracted orphans (correct information not yet represented in docs)
- Every MCP tool input is wrapped as `{ "data": { ...fields } }` (tools/list schema property `data`; required for search, describeProvider, clearTripwire, getPageContext, launchChrome). No doc says this; an MCP client author must call tools/list.
- `listProviders` for `github` reports `strategies: ["network","network"]` (primary and fallback both network, src/lib/providers.ts:195); looks like a duplicate rather than a distinct fallback.
- `Required inputs may also be given as operands in order: stealth-search search duckduckgo "typescript generics"` is printed by `--help` but README only shows the flag form.
- Root runtime exports with no doc: configureSearch, createSearchService, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS, createSearchHostConfig, DEFAULT_SEARCH_HOST_CONFIG, SEARCH_REMEDIATION, isSearchError, isSearchErrorCode, PROVIDER_NAMES.

## Recommendations summary

| Doc | Action | One-line rationale |
| --- | --- | --- |
| README.md | KEEP | Verified against CLI help and tools/list; add library-wiring and per-operation sample outputs |
| AGENTS.md | REVISE | Remove the word "undetectable" |
| CHANGELOG.md | REVISE | Date/tag the 0.1.0 entry |
| docs/ERRORS.md | REVISE | Replace the wrong UNKNOWN_PROVIDER sample message in both rendering samples |
| docs/OBSERVABILITY.md | KEEP | Matches tracing source and specs |
| docs/CONFIGURATION.md | KEEP | Equals source defaults |
| docs/EXAMPLES.md | KEEP | Files exist |
| docs/RESPONSIBLE-USE.md | KEEP | Canonical stealth definition; optional rewording of "evasion" |
| llms.txt | KEEP | In sync |
