# Reaper smoke (sp-reaper-smoke, CL30)

Real-process gate: the BUILT core package entry spawns the detached reaper host through `ensureBackend` (the reaper-link spawn form), the host answers `ping`, `hello`, `activity` and `status`, retires on its own after `orphanWindowMs` = 1000 ms with Chrome never started, and removes its socket.

BUILD: nx run stealth-core-browser:build exit=0
RUN: exit=0
DIST: packages/stealth/stealth-core-browser/dist/index.js sha256 6989498f9c2475ea47bb66a37a40bdea7534009ee4ce99be58f6ecf758c8e064
SERVICE-PROXY: @adhd/sox-service-proxy 0.6.0

Safety: scratch stateDir from `mkdtemp` under os.tmpdir(), a CDP port picked closed at run time, no Chrome started or killed, no user profile touched. The script output is in `reaper-smoke.json`.

VERDICT: reaper-lifecycle-ok
