# Required tooling

Capabilities verified without Chrome via CLI --help, direct no-Chrome runs, MCP tools/list and the in-process fake-CDP unit specs. The following would upgrade evidence from "fake core" to "executed against real Chrome". Nothing here was run against a real Chrome or port 9222 (by instruction).

| Tool / resource | Use case | Capabilities left at fake-evidence only |
| --- | --- | --- |
| A throwaway Chrome (Chrome for Testing) on a non-default port, in a sandboxed profile | execute chromeStatus / launchChrome / shutdownChrome / listPageTargets / checkChromeActivity / getPageContext end to end | chromeStatus, launchChrome, shutdownChrome, listPageTargets, checkChromeActivity, getPageContext |
| Network access plus Chrome | live `search` success path for duckduckgo, github, npm, ... and the `fetch` provider | search (live success path not executed; failure path UNKNOWN_PROVIDER executed) |
| Live Google SERP capture | convert the PROVISIONAL status of the google parsers (synthetic-fixture verified only) into verified | search (provider google) |
| Release workflow file (CI) access | confirm the publish pipeline (`nx-release-publish`) and npm freshness | distribution.md pipeline row |
| Telemetry sink reader | assert the on-disk JSONL records from a real CLI run (currently asserted through specs with fakes) | observability-spans |

Installed and used: pnpm, nx (stealth-search:build-bin, :test), vitest (via pnpm exec in the package dir), node.
