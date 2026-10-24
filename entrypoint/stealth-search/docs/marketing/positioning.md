# Positioning

## Audience

Developers and agent builders who want an AI agent or a script to search the web, read documentation URLs as markdown and look at pages in the Chrome they already use, from a terminal or any MCP client.

## Pain to gain

- Pain: giving an agent web access usually means a separate throwaway browser, per-site scrapers, and errors that surface as unparsed text.
- Gain: one install (`pnpm add @adhd/stealth-search`) exposes 11 operations over 12 providers as a CLI (`stealth-search`) and an MCP server (`stealth-search-mcp`), with typed errors and exit statuses.

## The honest wedge

Not "invisible". The wedge is a small, auditable footprint plus operational manners:

1. Two concrete choices: Chrome launched without `--enable-automation`; pages read without `Runtime.evaluate`.
2. Guard rails around a human's browser: activity check before launch or shutdown, idle-only soft shutdown, per-provider tripwire lock, cookie values never returned.
3. Typed errors: 13 error codes with stable exit statuses and an MCP `isError` channel.

Every item above is marked shipped in `docs/marketing/.catalog/capabilities.json` with a receipt.

## What we do not claim

- No guarantee that a site will not notice, throttle or block you.
- Google result parsing is provisional (synthetic fixtures only).
- Live end-to-end search was not run in the catalog verification (needs Chrome); Chrome-dependent operations are evidenced by fake-core unit tests and `--help` output.
- Version is 0.1.0.

## Message hierarchy

1. Headline: lower-footprint search and fetch through your own Chrome, as a CLI and MCP server.
2. Proof: 11 operations, 12 providers, 13 typed error codes, stdout kept clean for JSON-RPC.
3. Caveat, stated plainly: responsible use only; see `docs/RESPONSIBLE-USE.md`.
