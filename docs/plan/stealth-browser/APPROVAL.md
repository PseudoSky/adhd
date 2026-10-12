# APPROVAL - stealth-browser

| Field | Value |
|---|---|
| Approver | Dispatcher (run dispatch-2026-10-12-ca18), acting under the brief: "Dispatcher approval at your TOOLS gate is GRANTED - proceed without waiting" |
| Approved artifacts | `demo/DEMO.md` (validate_demo.py exit 0, 4 stubs reconciled with `demo/UNRESOLVED.md`), `TOOLS.md` (valid-as-of 2026-10-12T00:00:00Z) |
| Timestamp | 2026-10-12 |
| Backlog item | `8468f7b1-8adc-4237-9986-21ea1e27c537` |

## Human approval carried by the request

The human's verbatim request ("must be built with the workspace generator and match the entrypoint structure", package "called @adhd/stealth-browser and live in entrypoints") approves creating exactly ONE new package: `entrypoint/stealth-browser`. No other new package is approved. The nested `@adhd/cdp-connection` package proposed by the existing agent-search plan is not created; it becomes `src/lib/cdp/`.

## Not approved (human gates remain)

- The three new third-party dependencies (`node-html-parser`, `xpath`, `@xmldom/xmldom`): blocker `hb-deps-approval`, evidenced by `APPROVALS.md` at execution time.
- Publishing and the agent-search cutover: blocker `hb-release-decision`, owned by the dispatcher.
