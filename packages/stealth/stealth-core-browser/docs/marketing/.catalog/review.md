# Doc review — stealth-core-browser — worktree stealth-browser
VERDICT: FAIL

## Lens 1 — closed loop
metric_1: 7 -> 1 (improved; remaining point is the ported docs/reference/README.md quickstart on port 9222)
undocumented%: 48% -> 46% (59 -> 57 of 124 exports; weak, lifecycle 37 and recording 15 members still unnamed anywhere); junk%: 0% -> 0%
contradictions: 1 (see fix 1). README line 3 sells "a lower footprint than the usual automation drivers"; no capabilities.json receipt supports a comparison with other drivers, and docs/RESPONSIBLE-USE.md says the package does not make a program invisible. All other present-tense claims map to shipped capabilities; Google parsers are marked provisional in README, AGENTS.md, llms.txt.
After block appended to metrics.md.

## Lens 2 — conformance
- README.md: structure is value-prop, install, quickstart, features/namespaces, links. Defect: the unbacked comparative claim above (an unbacked feature claim fails the doc). The second README snippet runs against the default port 9222, which AGENTS.md says never to connect to in tests; mark it as illustrative or switch it to a dedicated port.
- AGENTS.md: factual only, no marketing adjectives; targets listed exist. Pass.
- llms.txt: factual only. Pass.
- CHANGELOG.md: Keep-a-Changelog headings, 0.0.1 migration entry present. Pass.
- Link resolver (executed, relative to each doc directory) over all owned docs and docs/reference: 0 misses.
- docs/EXAMPLES.md: all 14 listed example files exist (6 verbs, 8 namespaces).
- Banned words (undetectable, bypass, evade, anti-bot, evasion) in README, AGENTS, llms.txt, CHANGELOG, docs/*.md outside reference and .catalog: none. No AI attribution found.
- Spot-checks against src (5 of 5 match): default host/port (src/lib/endpoint.ts:22,24); profile name Chrome-CDP (src/lib/cdp/browser.ts:29,82); manager defaults 120_000/30_000/30_000/port-occupant/checkHistory true/keepAlive false (src/lib/chrome-manager.ts:165-172); state dir pattern (src/lib/lifecycle/state-dir.ts:33); chromeStatus returns running false rather than throwing (src/api.ts:165) and foreign-profile reason (src/lib/cdp/browser.ts:178); withinMinutes default 2 (src/lib/queries/activity.ts:8).
missing bundle docs: none.

## Lens 3 — consumer test
consumer.md: task 1 was partial before fixes (no return shapes); docs/VERBS.md now supplies input, return shape and errors per verb. Tasks 2 and 3 sufficient after reconciliation. One remaining reader-search point: docs/reference/README.md quickstart (ported, light scrutiny).

## Required fixes (ordered)
1. README.md line 3: remove "with a lower footprint than the usual automation drivers" (no receipt, comparative). Replace with the two backed facts, e.g. "Chrome is launched without --enable-automation and pages are read without Runtime.evaluate."
2. README.md second quickstart snippet: it targets default port 9222; either note it is illustrative and the developer's Chrome must not be used in tests, or use port 9333 as the first snippet does.
3. Recommended: name the lifecycle and recording namespace members (or state they are internal/experimental with a pointer) so undocumented drops well below 46%; and update docs/reference/README.md quickstart off ensureChromeRunning on 9222 to remove the last reader-search point.
Re-review after fixes 1 and 2; fix 3 is advisory.
