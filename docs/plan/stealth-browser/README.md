# Migrate the agent-search chrome runner to @adhd/stealth-browser (entrypoint)

Extract the Chrome/CDP runner from scratch/agent-browser/adhd into a new generator-built entrypoint package @adhd/stealth-browser, with apigen tracing under the adhd namespace

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **Exactly one new package exists, entrypoint/stealth-browser named @adhd/stealth-browser, produced by the workspace generator and structurally identical to the sibling entrypoints (structural)** — Exactly one new package exists, entrypoint/stealth-browser named @adhd/stealth-browser, produced by the workspace generator and structurally identical to the sibling entrypoints.

- `[dod.2]` **The six chrome-runner verbs work from all three surfaces (library, CLI, MCP stdio) against a real Chrome (behavioral)** — The six chrome-runner verbs work from all three surfaces (library, CLI, MCP stdio) against a real Chrome.
  - given: a built package and a real Chrome launched on a dedicated port with a temp profile
  - when: one e2e run calls chromeStatus/launchChrome/listPageTargets/checkChromeActivity/getPageContext/shutdownChrome through the library, the stealth-browser CLI and the stealth-browser-mcp JSON-RPC server
  - then: each surface returns the same structured results and shutdown stops only the launched Chrome
  - entrypoint: `nx run stealth-browser:e2e`
  - observable: `vitest exit 0 with [surface:library], [surface:cli] and [surface:mcp] suites green and run duration >= 5 s`
  - negative-control: `the e2e fails if the MCP bin is absent or chromeStatus is pointed at an unused port and expected running=true`
  - delivered-by: `surface-api, surface-hosts, tests-e2e`
