# Lifecycle definitions for backlog items B-036..B-039

Plan 8468f7b1 · state `chrome-lifecycle` · criterion `[chrome-lifecycle.25]` (gap G3 of `EVAL-service-proxy.md`).

## What the source tree says

Backlog items B-036, B-037, B-038 and B-039 have no definition anywhere in the source tree.

- Commit `cffee3c` (scratch repository, 2026-07-28) is titled "B-034 through B-039: Browser lifecycle + challenge detection + Wikipedia URLs + fetch standardization". Of those six ids it carries only the title. Its `agent-browser/BACKLOG.md` diff adds rows for B-034 and B-035 only. Its `agent-browser/CHANGELOG.md` diff describes the `urlTemplate` / B-019 fix, the Cloudflare challenge detection and the MCP isolated-target change, and names none of B-036..B-039. `git show cffee3c | rg "B-03[5-9]"` matches only the commit title line.
- `rg "B-03[6-9]" agent-browser/BACKLOG.md` at HEAD is empty, and `git log --all -S"B-036" -- agent-browser` finds no commit that ever added the string.

The commit title names four themes (browser lifecycle, challenge detection, Wikipedia URLs, fetch standardization). The Wikipedia-URL theme is B-019. The challenge-detection theme was implemented by that commit (`checkBans` rules, HITL) and is preserved by the capture-upgrade state. The browser-lifecycle theme has no written requirement. The four definitions below therefore treat B-036..B-039 as lifecycle requirements. Each is derived from the features F1-F26 and the requirements N1-N7 inventoried in `EVAL-service-proxy.md` (section 2, "Features" and gap G5), and each names the chrome-lifecycle criterion that pins it.

## Definitions

### B-036: one shared Chrome, launched race-free and self-healing

Every consumer on a machine shares one Chrome per CDP port, by default 127.0.0.1:9222.

- Launch is serialised across processes by an exclusive per-port O_EXCL lock. A loser waits, bounded, for the winner's Chrome, and a lock older than 15 s is reclaimed.
- A launch whose CDP does not answer within 10 s fails with a typed error.
- After another process killed the shared Chrome, the next `ready()` relaunches it.
- N concurrent callers produce exactly one Chrome process tree.

Derived from F1, F2, F3, F4, F17 and N6. Pinned by `chrome-lifecycle.1` (race-free launch) and `chrome-lifecycle.2` (self-heal and reset). The fast path that keeps a revealed window visible is pinned by `chrome-lifecycle.3`.

### B-037: idle reap that never closes a Chrome someone is using

An idle Chrome is closed automatically, but never while it is in use. The safety tiers run in a fixed order:

1. Another live client was active within the idle window.
2. An open http(s) page exists. Browser-internal targets never count, and an unreachable CDP during the check proceeds.
3. History shows a visit within 2 minutes. `checkHistory` defaults to true, and the tier is on when any connected client enables it.

Deferring writes no activity, so N idle processes cannot keep each other alive. The idle timer is bumped by real work and is unref'd.

Derived from F6, F7, F8, F9, F10, F11, F12, F13, F14 and F15. Pinned by:

- `chrome-lifecycle.4`: activity-bumped idle timer.
- `chrome-lifecycle.5`: sibling coordination.
- `chrome-lifecycle.6`: livelock protection.
- `chrome-lifecycle.7`: page tier.
- `chrome-lifecycle.8`: history tier.
- `chrome-lifecycle.9`: force and soft shutdown modes.

### B-038: no orphaned Chrome after a client dies

An out-of-process reaper, one per port, outlives every client and closes an idle Chrome. This holds even after `kill -9` of the client that launched it.

- Presence is one held connection per client. A killed client's connection is dropped at once, so a dead process can never pin Chrome.
- After the last client leaves, Chrome is closed within the shutdown grace.
- A reaper nobody uses retires after the orphan window once Chrome is gone.
- A launch circuit breaker stops a crash loop.
- Clients never respawn a retired reaper on disconnect.
- Kills reach the whole process group. A recorded pid is signalled only while its start token still matches, so it is never a recycled pid.

Derived from F18, F19, F24, F25, N1, N2, N3, N4 and N5. Pinned by:

- `chrome-lifecycle.11`: group kill.
- `chrome-lifecycle.12`: reaper scope and the pid-reuse-safe owner.
- `chrome-lifecycle.15`: the out-of-process reaper over the service proxy.
- `chrome-lifecycle.16`: the connection registry.
- `chrome-lifecycle.17`: launch circuit breaker.
- `chrome-lifecycle.18`: sibling diagnostic.
- `chrome-lifecycle.19`: shared Chrome and grace.
- `chrome-lifecycle.29`: no respawn loop.

### B-039: clean exits and no leaked isolated contexts

Every exit path of a hosting process releases its presence and runs the soft shutdown once, bounded by a 5 s force-exit with exit codes 130, 143 and 1. The exit paths are exit, SIGINT, SIGTERM, uncaughtException, unhandledRejection and (opt-in) stdin end.

An isolated page never leaks its browser context or its creator session on any failure path. The failure paths are context creation, target creation, window bounds, page connect and a target that never registers.

Every lifecycle failure a user can hit is typed. When the reaper cannot start, the runner degrades safely: it never closes a sibling's Chrome, a forced shutdown still works, and it logs exactly one warning.

Derived from F16, F20, F21, F22, F23 and F26, gaps G1 and G2, and N7 (one lifecycle implementation, no parallel mechanism). Pinned by:

- `chrome-lifecycle.10`: ordered shutdown.
- `chrome-lifecycle.13`: isolated pages and the G1 fix.
- `chrome-lifecycle.14`: exit hooks.
- `chrome-lifecycle.20`: typed lifecycle errors.
- `chrome-lifecycle.21`: best-effort I/O.
- `chrome-lifecycle.28`: degraded mode.

## Coverage check

Every feature F1-F26 and requirement N1-N7 is assigned to exactly one of B-036..B-039 above. F5 (hide windows after a fresh launch only) belongs to B-036 through `chrome-lifecycle.3`. N7 (no parallel lifecycle implementation) belongs to B-039 and is enforced structurally by `chrome-lifecycle.22` (one seam) and `chrome-lifecycle.24` (the old heartbeat mechanism is gone).
