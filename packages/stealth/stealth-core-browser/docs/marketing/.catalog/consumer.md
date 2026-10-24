# Consumer test (docs only, no source)

Fresh doc-consumer agent, tasks: (1) launch/status/list/shutdown on 9333, (2) meaning of stealth, defaults, Linux support, (3) responsible use and cookie handling.

## Result before fixes
- Task 1 partial: call sequence clear; no per-verb return shapes or errors (reader would open `src/api.ts`).
- Task 2 sufficient; reference/README contradicted the two-choice definition and macOS-first statement.
- Task 3 sufficient; recorder redaction wording overstated (redaction is opt-in); cookie writes by Chrome itself not stated.

## Fixes applied
- Added `docs/VERBS.md` (input, return shape, errors per verb; chromeStatus returns `running: false` rather than throwing).
- Reconciled `docs/reference/README.md` stealth and platform wording.
- RESPONSIBLE-USE: redaction is opt-in via `redactHeaders()`; Chrome writes cookies; the cookie reader can return values.

## Reader-search points remaining
- Reference quickstart in `docs/reference/README.md` still uses `ensureChromeRunning` and port 9222 (ported reference, unchanged).
