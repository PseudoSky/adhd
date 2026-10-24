# doc-ops

Audit log of every create / rewrite / move / delete by the doc steward (2026-10-24).

## create docs/CONFIGURATION.md
reason: missing bundle doc; criterion docs-marketing-run.6 (every default verbatim, macOS-first, untested elsewhere).

## create docs/RESPONSIBLE-USE.md
reason: missing bundle doc; criteria .7 and .8 (stealth defined as two choices; no overclaim vocabulary).

## create docs/EXAMPLES.md
reason: missing bundle doc; criterion .10. `examples/cli.md` and `examples/mcp-config.json` do not exist in this library package (the CLI and MCP hosts are in stealth-search); EXAMPLES.md says so instead of listing files that are absent.

## create llms.txt, rewrite AGENTS.md, rewrite CHANGELOG.md, rewrite README.md
reason: bundle docs; criterion .3. AGENTS.md gained public-surface and gotcha facts; CHANGELOG gained Keep-a-Changelog structure and the 0.0.1 migration entry; README gained the verbs, the two-choice definition of "stealth", the stability policy and links to the new docs.
removed_or_moved (verbatim): CHANGELOG.md previously read:

```
## Unreleased

Initial scaffold of `@adhd/stealth-core-browser`.

- Removed the unimplemented `ProfileClient.getOpenTabs()` stub (it only warned and returned `[]`); use `listPageTargets()` for the open tabs of a running Chrome.
```

(The getOpenTabs removal is kept under `[Unreleased] / Removed`.) README.md previously opened with: "Drive Chrome over the Chrome DevTools Protocol without automation fingerprints: no `Runtime.evaluate`, no `--enable-automation`. Page data comes from network capture and the CDP DOM tree, and is parsed server-side." — replaced by the honest two-choice definition. The previous "One entry, namespaced", "Endpoint policy" and namespace table content is retained in the new README.

## note docs/reference/README.md (not edited)
The ported reference README contains overclaim wording ("without triggering bot detection", "detectable"). docs/reference/ is outside the steward's scope for criterion .8 and was left unchanged; recorded here as a known gap.

## create docs/VERBS.md
reason: consumer test (consumer.md) found no per-verb input/return/error reference.

## revise docs/reference/README.md, docs/RESPONSIBLE-USE.md
reason: consumer test found the reference README contradicting the two-choice definition of "stealth" and the macOS-first support statement, and RESPONSIBLE-USE overstating recorder redaction (opt-in). Replaced wording in six places (verbatim prior text: "without triggering bot detection ... Chrome appears as a normal browser"; "all leave detectable fingerprints (`navigator.webdriver`, automation flags, characteristic timing)"; "JavaScript injection is detectable"; "a clean profile. It looks like a normal user's browser."; "(auto-detected on macOS, Linux, Windows)"; "detectable by the page through `navigator.webdriver`, stack trace analysis, and timing fingerprinting. Every major search engine ... block automated access."; "The browser is indistinguishable from a normal Chrome instance."). RESPONSIBLE-USE prior text: "the `recording` namespace redacts cookies and authorization headers before storage."

## create docs/LIFECYCLE-AND-RECORDING.md; revise README.md, docs/reference/README.md
reason: review.md required fixes: removed the unbacked comparative tagline (prior text: "Work with your own logged-in Chrome from Node.js over the Chrome DevTools Protocol, with a lower footprint than the usual automation drivers."); moved examples off port 9222 to 9333; named lifecycle and recording members.
