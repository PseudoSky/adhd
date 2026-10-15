# search-port-fetch — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-fetch`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The `fetch` provider is ported with its security failsafe intact: SSRF policy, Turndown cap, PDF extraction, cookieless render, sparse-challenge heuristic and two-phase Cloudflare wait, each with a unit scenario.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/lib/fetch/{policy,markdown,pdf,fetch}.ts`, `entrypoint/stealth-search/src/test/unit/fetch/*.spec.ts`, `docs/plan/stealth-browser/evidence/split/u-pdf.json`. READ `search-fetch.ts`, `fetch-policy.ts`, `fetch-markdown.ts`, `fetch-pdf.ts` of the source repo.

- **Reference Pattern:** inventory rows I-09, I-27..I-30; `SPEC-stealth-search.md` risk O4 (pdfjs-dist ESM-only vs the CJS build).

- **Delta Spec:** (1) FIRST STEP (probe U-PDF, risk O4): build a throwaway fixture PDF, run the dynamic `await import('pdfjs-dist/legacy/build/pdf.mjs')` through the BUILT module (`nx run stealth-search:build`, then load `dist`), record `evidence/split/u-pdf.json` {route, built_load, fixture_pdf, extracted_text}. If the CJS compile rewrote it to `require()`, use an `.mjs` helper copied to dist by a build asset entry (`mjs-helper`); if that needs a project.json edit it is a plan-repair request to the dispatcher, not an edit here. (2) Then port. SSRF matrix: IP literals including IPv4-mapped IPv6 hex, RFC1918, 169.254/16, loopback, single-label hosts, trailing dot, non-http(s), embedded credentials, 2000-character cap; a refused URL is a RESPONSE outcome `error` whose message carries `FETCH_URL_REFUSED`. (3) Browser access only through core `cdp.*`/`capture.*`/`chromeManager`. No `process.env`; the user agent is the `FETCH_UA` constant. (4) Specs: the policy matrix (one file), markdown cap and truncation, PDF extraction and corrupt PDF, sparse-challenge two-phase wait; unit lane spawns no process (ADR-0009), PDF specs read the fixture bytes in-process.

- **Invariants:** [inv:typed-errors] [inv:tests-cite] [inv:search-over-core]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-port-fetch]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-fetch` — runs every acceptance criterion below (red until the work is done); `--only search-port-fetch.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-port-fetch --only search-port-fetch.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-port-fetch.1] FIRST STEP, probe U-PDF (risk O4): evidence/split/u-pdf.json records `fixture_pdf` (a PDF in the unit fixtures), `extracted_text` containing the fixture's known sentence, `built_load: true` (the BUILT bin or dist module extracted it, not tsx), and `route` of `dynamic-import` or `mjs-helper`; if the CJS build rewrote `await import('pdfjs-dist/legacy/build/pdf.mjs')` into `require()` the route is `mjs-helper` and the helper is copied to dist by a build asset entry.
- [search-port-fetch.2] src/lib/fetch/ holds policy.ts, markdown.ts, pdf.ts and fetch.ts: the SSRF policy, the 1 MiB Turndown input cap with a truncation marker, the pdfjs text extraction (failure -> StealthSearchError PDF_EXTRACT_FAILED), and the cookieless render with `FETCH_UA`, the 3000-character sparse-challenge heuristic and the two-phase Cloudflare wait; fetch.ts reaches Chrome only through core `cdp.*`/`capture.*`/`chromeManager` calls.
- [search-port-fetch.3] The SSRF matrix is a security failsafe with its own spec: the policy spec asserts a refusal for `::ffff:169.254.169.254`, `localhost.` (trailing dot), `file:`, embedded credentials (`user:pass@`), `169.254.169.254`, `10.0.0.1`, `192.168.1.1`, `127.0.0.1`, a single-label host, an IPv4-mapped hex form, a URL over 2000 characters and a non-http(s) scheme, plus an accepted public https URL; a refusal stays a RESPONSE outcome `error` whose message carries `FETCH_URL_REFUSED`.
- [search-port-fetch.4] The markdown and PDF branches are proven by specs: a 1.5 MiB HTML input is truncated at the 1 MiB cap with the marker, a fixture PDF is extracted page by page under the per-page cap, a corrupt PDF raises PDF_EXTRACT_FAILED, and a sparse (under 3000 characters) challenge page triggers the two-phase wait before the result is returned.
- [search-port-fetch.5] Every inventory row owned by search-port-fetch is cited by id in the source or specs, and the specs (at least two files, one for the policy matrix) cite ticket 8468f7b1 and a search-port-fetch.N id.
- [search-port-fetch.6] Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket.
- [search-port-fetch.7] The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0.
- [search-port-fetch.8] Only owned paths changed by [psm:search-port-fetch] commits.

- [search-port-fetch.9] (backlog cd05ad09) The fetch result is token-efficient by default: with the default `content: 'none'` it holds only the metadata fields provider, url, finalUrl, outcome, status, contentType, contentSize, title, truncated, attempts and tookMs (no `content`, no HTML, no `raw.preview`); `content: 'full'` adds `content` as HTML-stripped markdown or text bounded by `maxContentSize` (the exported constant `DEFAULT_MAX_CONTENT_SIZE = 20000` bytes in src/lib/fetch/fetch.ts) starting at `offset`, and returns `nextOffset` while truncated so a caller can page. A spec under src/test/unit/fetch/ simulates the real case, a 408112-byte repository README page: the default result serializes under 2048 bytes, `content: 'full'` returns at most 20000 bytes plus `nextOffset`, and following `nextOffset` reaches the end with `nextOffset` absent; spec titles carry the literals `contentSize`, `nextOffset`, `maxContentSize`, `offset`, `finalUrl`, `408112`, `2048`, `20000` and the uid cd05ad09, and the spec cites [search-port-fetch.9].
- [search-port-fetch.10] (backlog 86ed154e) A fetch of a missing page is never `success`: HTTP 404 and 410 return outcome `error` carrying the HTTP `status` and a message that begins `SEARCH_FAILED:` (no new error code: the registry stays at the 13 of search-errors); a soft not-found (status 200 whose title or first heading matches a not-found phrase on a sparse page under 3000 characters, or a deep path that redirects to the site root so `finalUrl` differs from `url`) returns outcome `error` the same way; a long real page (over 3000 characters) that merely contains the phrase 'page not found' in its body stays `success`. Specs under src/test/unit/fetch/ simulate the reported cases (self-hosting docs URL that 404s, a marketing page reached by redirect, a guide page that is real) with HTML fixtures; titles carry `404`, `410`, `soft-404`, `redirect`, `SEARCH_FAILED`, `false positive` and the uid 86ed154e, and the spec cites [search-port-fetch.10].
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/fetch/", "entrypoint/stealth-search/src/test/unit/fetch/", "docs/plan/stealth-browser/evidence/split/u-pdf.json"]
```

---

## Contract Promise

Added: fetch modules, specs, `evidence/split/u-pdf.json`. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-port-fetch]`:

- [ ] After the probe: `docs(plan): U-PDF probe [psm:search-port-fetch]`
- [ ] After the guard passes: `feat(stealth-search): port the fetch provider with the SSRF policy [psm:search-port-fetch]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.
