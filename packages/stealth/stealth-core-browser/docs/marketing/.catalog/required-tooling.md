# Required tooling

Provisioned and used this run: pnpm, vitest 4.1.9 (via `pnpm exec vitest run`), tsx (runtime export enumeration), python3.

Not available / not used (capabilities left unproven in the stated respect, none marked unverified at the unit level):
- A real Chrome/Chromium: needs: Chrome on a non-9222 port (use 9333) -> real-browser proof of launchChrome, chromeStatus, listPageTargets, cdp.CdpSession, capture.* end to end. All receipts here are in-process fake-CDP specs.
- Linux host: needs: Linux runner with google-chrome/chromium -> verifies browser.ts Linux binary lookup, XDG profile dirs, lsof/fuser probe.
- Windows host: needs: Windows runner -> verifies win32 binary path, LOCALAPPDATA profile dir; note no Windows process probe or taskkill path exists (POSIX lsof/fuser/ps and process.kill(-pid)).
- Live Google results page / sanctioned fixture capture: needs: a real recorded SERP fixture -> promotes parsers.extractWithXpath/extractStructural/extractResultsFromHtml from PROVISIONAL (synthetic fixtures) to verified.
- npm registry access: needs: `npm view @adhd/stealth-core-browser version` -> confirm publication state (distribution.md claims none).
- Stable doc-baseline snapshot: the steward rewrote README/AGENTS/CHANGELOG while this run was in progress; baseline was recovered with `git archive 2b8320c8e`.
