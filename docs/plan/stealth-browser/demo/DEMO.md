# 🎬 @adhd/stealth-browser - Live Demo & Acceptance Script

> A real, quiet Chrome you can drive from code, a CLI or an MCP server - with every call traced under the `adhd` namespace.

**What this is.** A presentation-grade walkthrough of `@adhd/stealth-browser` that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the package the way a brand-new maintainer would and (b) prove every capability works, with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means for plan `docs/plan/stealth-browser/` (backlog item `8468f7b1-8adc-4237-9986-21ea1e27c537`): if it is demonstrated here, it must work; if it must work, it is demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat - what is happening and why the persona cares. |
| ▶️ **Do** | The exact action to take with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the context did not specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**

- Commands run from the worktree root `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` unless noted; the prompt is `$`.
- `$PORT` is a free TCP port chosen in §2.3; the developer's own Chrome on 9222 is never touched.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` beside this file - confirm them before treating the step as authoritative.

---

## 1 · Cold Open - The Hook

🎬 **Scene.** Dana maintains a search tool whose Chrome plumbing - launching a quiet Chrome, talking CDP, reaping it when idle - lives inside a scratch repo, welded to a search server. Every new tool that needs a real browser copies it or imports a private path. The promise: the runner becomes one workspace package, built by the generator, with a library API, a CLI, an MCP server and tracing, and the search tool keeps working.

> **The promise we'll prove in the next 20 minutes:** one generator-built package exposes six Chrome-runner verbs on three surfaces, traced under `adhd`, without disturbing the developer's own Chrome.

🔗 **Proves (framing):** REQ-001 · CAP-001
📎 **Source:** `/Users/nix/dev/ai/scratch/agent-browser/docs/restructure-proposal.md:1-8`; backlog `8468f7b1` body.

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet Dana

Dana is a platform maintainer. Her goal is to ship `@adhd/stealth-browser` and cut `agent-search` over to it without breaking the MCP server agents use every day. Stake: the live MCP source must never go dark.

### 2.2 Canonical fixtures

- Worktree: `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`, branch `stealth-browser`.
- Fixture page: `data:text/html,<title>Fixture</title><h1>hello</h1>`.
- Telemetry sink: `$TMPDIR/stealth-demo/sink.ndjson`.

### 2.3 Cold start

▶️ **Do**
```bash
mkdir -p "$TMPDIR/stealth-demo/profile"
PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
echo "$PORT" > "$TMPDIR/stealth-demo/port"
git rev-parse --abbrev-ref HEAD
test ! -e entrypoint/stealth-browser/dist && echo clean-start
```
👀 **Expect**
```
stealth-browser
clean-start
```
✅ **Verify**
- [ ] Branch is `stealth-browser`.
- [ ] `$TMPDIR/stealth-demo/port` holds a number between 1024 and 65535 that is not 9222.

📎 **Source:** plan README "Execution model"; SCOPE.md invariants `[inv:live-chrome]`.

---

## 3 · The Story

### Act 1 - The package exists, the generator's way

#### 3.1.1 · Dry run, then the real thing (happy)

🎬 **Scene.** Dana refuses to hand-build a package; the workspace generator is the only door.

▶️ **Do**
```bash
npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-browser --nxLayer entrypoints --platform node --dry-run
```
👀 **Expect**
```
CREATE entrypoint/stealth-browser/src/index.ts
CREATE entrypoint/stealth-browser/project.json
CREATE entrypoint/stealth-browser/package.json
CREATE entrypoint/stealth-browser/tsconfig.json
CREATE entrypoint/stealth-browser/README.md
UPDATE tsconfig.base.json
NOTE: The "dryRun" flag means no changes were made.
```
✅ **Verify**
- [ ] Every CREATE path starts with `entrypoint/stealth-browser/`.
- [ ] Exactly one `UPDATE`, to `tsconfig.base.json`.
- [ ] `jq -r .name entrypoint/stealth-browser/package.json` after the real run prints `@adhd/stealth-browser`.

🔗 **Proves:** REQ-001
📎 **Source:** `packages/workspace/workspace-codegen-nx/src/generators/entrypoint/schema.json`; dry-run captured in `docs/plan/stealth-browser/evidence/scaffold-dry-run.txt`.

#### 3.1.2 · Same structure as its siblings (happy)

🎬 **Scene.** A new package that looks different from `dispatch-cli` is a new maintenance burden.

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py entrypoint-parity --only entrypoint-parity.1
```
👀 **Expect**
```
PASS [entrypoint-parity.1] Top-level tracked file set contains every file common to dispatch-cli, backlog and apigen-cli ...
```
✅ **Verify**
- [ ] Exit status is 0.
- [ ] `./node_modules/.bin/nx show project stealth-browser --json | jq '.targets|keys'` includes `build-bin`, `verify-dist-load`, `e2e`, `test`, `typecheck-spec`.

🔗 **Proves:** REQ-002
📎 **Source:** `entrypoint/dispatch-cli/project.json` targets; `docs/plan/stealth-browser/scripts/guard.py` check `entrypoint-parity.1`.

### Act 2 - Six verbs, three surfaces

#### 3.2.1 · Nothing is running yet (happy)

🎬 **Scene.** Before launching anything Dana asks the library whether a Chrome is up.

▶️ **Do**
```bash
node --input-type=module -e "import { chromeStatus } from '@adhd/stealth-browser'; console.log(JSON.stringify(await chromeStatus({ port: Number(process.env.PORT) })))"
```
👀 **Expect**
```
{"running":false,"managed":false,"port":⟨PORT⟩}
```
✅ **Verify**
- [ ] `running` is `false`.
- [ ] `managed` is present and is a boolean (never undefined).

🔗 **Proves:** REQ-003 · CAP-001
📎 **Source:** `/Users/nix/dev/ai/scratch/agent-browser/search-mcp-source.ts:454-495` (`chromeStatus`, `ChromeStatus.managed` comment); ⟦U3⟧ inferred - see UNRESOLVED.md.

#### 3.2.2 · Launch on a dedicated port (happy)

🎬 **Scene.** Dana launches a quiet Chrome - no automation banner - in a throwaway profile.

▶️ **Do**
```bash
node --input-type=module -e "import { launchChrome } from '@adhd/stealth-browser'; console.log(JSON.stringify(await launchChrome({ port: Number(process.env.PORT), userDataDir: process.env.TMPDIR + '/stealth-demo/profile' })))"
```
👀 **Expect**
```
{"launched":true,"port":⟨PORT⟩,"pid":⟨PID⟩}
```
✅ **Verify**
- [ ] `curl -s http://127.0.0.1:$PORT/json/version` returns JSON containing `Browser`.
- [ ] `ps -p ⟨PID⟩ -o args=` contains `--remote-debugging-port=⟨PORT⟩` and does NOT contain `--enable-automation`.

🔗 **Proves:** REQ-003 · REQ-007 · CAP-002
📎 **Source:** `adhd/cdp-connection/src/browser.ts:99` (remote-debugging flag) and the "No --enable-automation flag" comment at `:8`; ⟦U3⟧ inferred - see UNRESOLVED.md.

#### 3.2.3 · Targets, activity, context (happy)

🎬 **Scene.** Dana opens the fixture page and asks what Chrome is doing.

▶️ **Do**
```bash
curl -s -X PUT "http://127.0.0.1:$PORT/json/new?data:text/html,%3Ctitle%3EFixture%3C/title%3E%3Ch1%3Ehello%3C/h1%3E" >/dev/null
node --input-type=module -e "import { listPageTargets, checkChromeActivity, getPageContext } from '@adhd/stealth-browser'; const o={port:Number(process.env.PORT)}; console.log(JSON.stringify({t:(await listPageTargets(o)).length, a:await checkChromeActivity(o), c:await getPageContext(o)}))"
```
👀 **Expect**
```
{"t":⟨N>=1⟩,"a":{"inUse":true,...},"c":{"title":"Fixture",...}}
```
✅ **Verify**
- [ ] `t` is at least 1.
- [ ] `c.title` equals `Fixture`.
- [ ] `a.inUse` is `true` while the fixture page is open.

🔗 **Proves:** REQ-003 · CAP-004 · CAP-005 · CAP-006
📎 **Source:** `adhd/cdp-connection/src/targets.ts`, `adhd/types.ts:151` (`ChromeActivity`), `search/queries/{activity,context}.ts`; ⟦U3⟧ inferred - see UNRESOLVED.md.

#### 3.2.4 · The same status from the CLI (happy)

🎬 **Scene.** Scripts and humans use the CLI.

▶️ **Do**
```bash
node entrypoint/stealth-browser/dist/bin/cli.js chromeStatus --port "$PORT"
```
👀 **Expect**
```
{"running":true,"managed":⟨true|false⟩,"port":⟨PORT⟩}
```
✅ **Verify**
- [ ] Exit status 0.
- [ ] Output contains `"running":true`.

🔗 **Proves:** REQ-004 · CAP-001
📎 **Source:** `entrypoint/dispatch-cli/bin/cli.ts` (bin shape); ⟦U1⟧ ⟦U4⟧ inferred - see UNRESOLVED.md.

#### 3.2.5 · The CLI help lists every verb (happy)

🎬 **Scene.** Dana checks the CLI is generated from the same six verbs.

▶️ **Do**
```bash
node entrypoint/stealth-browser/dist/bin/cli.js --help
```
👀 **Expect**
```
chromeStatus  launchChrome  shutdownChrome  listPageTargets  checkChromeActivity  getPageContext
```
✅ **Verify**
- [ ] All six verb names appear (case/dash-insensitive).
- [ ] Exit status 0 (the apigen extraction did not crash on the types).

🔗 **Proves:** REQ-004 · CAP-001 · CAP-002 · CAP-003 · CAP-004 · CAP-005 · CAP-006
📎 **Source:** guard `surface-hosts.4`; ⟦U1⟧ inferred - see UNRESOLVED.md.

#### 3.2.6 · The same tools over MCP (happy)

🎬 **Scene.** Agents reach Chrome over MCP stdio.

▶️ **Do**
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node entrypoint/stealth-browser/dist/bin/mcp.js
```
👀 **Expect**
```
{"jsonrpc":"2.0","id":1,"result":{...}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"⟨...chrome_status⟩",...}, ...]}}
```
✅ **Verify**
- [ ] The `tools/list` result has six tools.
- [ ] Every stdout line is valid JSON-RPC (logs go to stderr).

🔗 **Proves:** REQ-005 · CAP-001
📎 **Source:** `entrypoint/backlog/src/server.mcp.e2e.ts` (stdio client pattern); ⟦U2⟧ inferred - see UNRESOLVED.md.

#### 3.2.7 · Shutdown stops only what we launched (happy)

🎬 **Scene.** Dana is done; the developer's own Chrome must survive.

▶️ **Do**
```bash
node --input-type=module -e "import { shutdownChrome } from '@adhd/stealth-browser'; console.log(JSON.stringify(await shutdownChrome({ port: Number(process.env.PORT) })))"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:$PORT/json/version || true
```
👀 **Expect**
```
{"stopped":true}
000
```
✅ **Verify**
- [ ] The HTTP probe cannot connect (`000`).
- [ ] If a Chrome was listening on 9222 before §2.3, the same PID still listens afterwards: `lsof -ti tcp:9222` unchanged.

🔗 **Proves:** REQ-003 · REQ-008 · CAP-003
📎 **Source:** `adhd/cdp-connection/src/browser.ts:248` (`lsof -ti tcp:${port}` kill, scoped to the launched PID first); ⟦U3⟧ inferred - see UNRESOLVED.md.

### Act 3 - Every call leaves an `adhd` trace

#### 3.3.1 · The sink only ever sees `adhd.*` (happy)

🎬 **Scene.** The platform team's dashboards filter on the `adhd` namespace; `apigen.*` records would vanish from them.

▶️ **Do**
```bash
./node_modules/.bin/nx run stealth-browser:test -- src/test/unit/tracing/tracing-namespace.spec.ts
```
👀 **Expect**
```
✓ src/test/unit/tracing/tracing-namespace.spec.ts (⟨N⟩ tests)
```
✅ **Verify**
- [ ] Exit status 0.
- [ ] The spec reads a real telemetry file sink and asserts every record `event` starts with `adhd.` and none starts with `apigen.`.

🔗 **Proves:** REQ-006 · CAP-007
📎 **Source:** `entrypoint/backlog/src/tracing.ts`, `entrypoint/backlog/src/server.tracing-six-tags.spec.ts`; `packages/apigen/apigen-plugin-tracing/README.md`.

---

## 4 · The Climax - All Three Surfaces, One Run

🎬 **Scene.** Dana runs the whole thing at once: one setup, one teardown, a real Chrome, the library, the CLI and the MCP server all asked the same questions - and a Chrome on 9222 that nobody touched.

▶️ **Do**
```bash
./node_modules/.bin/nx run stealth-browser:e2e
```
👀 **Expect**
```
 ✓ [surface:library] ...
 ✓ [surface:cli] ...
 ✓ [surface:mcp] ...
 Test Files  ⟨N⟩ passed
 Duration  ⟨>= 5s⟩
```
✅ **Verify**
- [ ] Exit status 0 and wall-clock duration at least 5 seconds.
- [ ] Exactly one `beforeAll` and one `afterAll` exist under `entrypoint/stealth-browser/src/test/e2e/`.
- [ ] `lsof -ti tcp:9222` prints the same PIDs before and after.

🔗 **Proves:** REQ-003 · REQ-004 · REQ-005 · REQ-008 · REQ-010 · CAP-001 · CAP-002 · CAP-003 · CAP-004 · CAP-005 · CAP-006
📎 **Source:** `entrypoint/dispatch-cli/src/test/cli-smoke.e2e.test.ts` (e2e lane shape); guard `tests-e2e.1-5`.

---

## 5 · Resilience Sweep - Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ Unused port reports not-running, not an error

▶️ **Do**
```bash
node entrypoint/stealth-browser/dist/bin/cli.js chromeStatus --port 1
```
👀 **Expect** - exit 0 and output containing `"running":false`.
✅ **Verify**
- [ ] No stack trace on stderr.

🔗 **Proves:** REQ-003 · CAP-001
📎 **Source:** `search-mcp-source.ts:454-467` (error path returns a status object); ⟦U1⟧ inferred - see UNRESOLVED.md.

#### 5.2 · ⚠️ Stealth invariants cannot regress

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.ref-runner-port
```
👀 **Expect** - `PASS [audit-final.ref-runner-port]`.
✅ **Verify**
- [ ] The guard fails if any migrated file gains `Runtime.evaluate` or `--enable-automation` in code (hygiene rule) or loses an export.

🔗 **Proves:** REQ-007
📎 **Source:** `port-manifest.json`; `adhd/capture/dom.ts:7` ("No Runtime.evaluate").

#### 5.3 · ⚠️ Mutation proves the namespace test has teeth

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py tracing-namespace-proof --only tracing-namespace-proof.4
```
👀 **Expect** - `PASS [tracing-namespace-proof.4]` (the guard flips `serviceName` to `apigen`, requires the spec to fail, restores the file).
✅ **Verify**
- [ ] `git status --porcelain -- entrypoint/stealth-browser/src/tracing.ts` is empty afterwards.

🔗 **Proves:** REQ-006 · CAP-007
📎 **Source:** `docs/plan/stealth-browser/scripts/guard.py` (`_tn4`).

#### 5.4 · ⚠️ An executor strays outside its bucket

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/check-disjoint.py
```
👀 **Expect** - `OK: 30 states, 54 concurrent pairs, 0 overlaps`.
✅ **Verify**
- [ ] Exit 0; any overlap would print `CONCURRENT OVERLAP` and exit 1.

🔗 **Proves:** REQ-010
📎 **Source:** `scripts/ownership.json`; SCOPE.md "Prior decisions".

#### 5.5 · ⚠️ The live agent-search source is byte-identical until cutover

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.5
```
👀 **Expect** - `PASS [audit-final.5]`.
✅ **Verify**
- [ ] `git -C /Users/nix/dev/ai/scratch status --porcelain -- agent-browser/adhd` is empty.

🔗 **Proves:** REQ-009
📎 **Source:** `evidence/source-baseline.txt`; guard `source_untouched`.

#### 5.6 · 🛟 After cutover the live MCP server still serves

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py agent-search-cutover --only agent-search-cutover.4
```
👀 **Expect** - `PASS [agent-search-cutover.4]` (a real MCP stdio client lists tools, calls `chrome_status` and `list_providers`).
✅ **Verify**
- [ ] `tools/list` contains a tool ending in `search`.
- [ ] Both calls return a `result`.

🔗 **Proves:** REQ-009 · CAP-008
📎 **Source:** `/Users/nix/dev/ai/scratch/agent-browser/server.mjs`, `search-mcp-source.ts:454-495`.

#### 5.7 · 🛟 The blind review chain is closed

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.6
```
👀 **Expect** - `PASS [audit-final.6]`.
✅ **Verify**
- [ ] `review/BRIEF.txt` is the single word `Review`; every finding in `FINDINGS.json` has a `RESOLUTION.json` entry; one implementer authored the fixes.

🔗 **Proves:** REQ-011
📎 **Source:** `docs/plan/stealth-browser/review/`.

#### 5.8 · 🛟 Docs and README are receipts-backed

▶️ **Do**
```bash
python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.7
```
👀 **Expect** - `PASS [audit-final.7]`.
✅ **Verify**
- [ ] README has >= 5 `<!-- receipt:ID -->` markers, each resolving to a `shipped` capability in `docs/marketing/.catalog/capabilities.json`.

🔗 **Proves:** REQ-012
📎 **Source:** `entrypoint/stealth-browser/docs/marketing/.catalog/`.

---

## 6 · Teardown - Back to Zero

▶️ **Do**
```bash
PORT=$(cat "$TMPDIR/stealth-demo/port")
node --input-type=module -e "import { shutdownChrome } from '@adhd/stealth-browser'; await shutdownChrome({ port: Number(process.env.PORT) }).catch(()=>{})" 
rm -rf "$TMPDIR/stealth-demo"
lsof -ti "tcp:$PORT" || echo no-listener
```
👀 **Expect**
```
no-listener
```
✅ **Verify**
- [ ] No process listens on `$PORT`.
- [ ] `$TMPDIR/stealth-demo` no longer exists.
- [ ] `git status --porcelain -- entrypoint/stealth-browser/src/tracing.ts` is empty.

🔗 **Proves:** REQ-008 · CAP-003
📎 **Source:** `adhd/cdp-connection/src/browser.ts:248`; SCOPE.md `[inv:live-chrome]`.

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Generator-built `entrypoint/stealth-browser` named `@adhd/stealth-browser` | 1, 3.1.1 | H | ☐ |
| REQ-002 | Structure matches sibling entrypoints | 3.1.2 | H | ☐ |
| REQ-003 | Six verbs work from the library | 3.2.1, 3.2.2, 3.2.3, 3.2.7, 4, 5.1 | H/E | ☐ |
| REQ-004 | CLI surface | 3.2.4, 3.2.5, 4 | H | ☐ |
| REQ-005 | MCP stdio surface | 3.2.6, 4 | H | ☐ |
| REQ-006 | Tracing namespace is `adhd`, never `apigen` | 3.3.1, 5.3 | H/E | ☐ |
| REQ-007 | Stealth invariants preserved | 3.2.2, 5.2 | H/E | ☐ |
| REQ-008 | Developer's Chrome on 9222 untouched | 3.2.7, 4, 6 | H/E | ☐ |
| REQ-009 | Live agent-search source untouched, then cut over | 5.5, 5.6 | E/R | ☐ |
| REQ-010 | One e2e run, one setup/teardown, disjoint buckets | 4, 5.4 | H/E | ☐ |
| REQ-011 | One blind review, one implementer | 5.7 | R | ☐ |
| REQ-012 | Docs and README receipts-backed | 5.8 | R | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | chromeStatus | 1, 3.2.1, 3.2.4, 3.2.5, 3.2.6, 4, 5.1 | ☐ |
| CAP-002 | launchChrome | 3.2.2, 3.2.5, 4 | ☐ |
| CAP-003 | shutdownChrome | 3.2.5, 3.2.7, 4, 6 | ☐ |
| CAP-004 | listPageTargets | 3.2.3, 3.2.5, 4 | ☐ |
| CAP-005 | checkChromeActivity | 3.2.3, 3.2.5, 4 | ☐ |
| CAP-006 | getPageContext | 3.2.3, 3.2.5, 4 | ☐ |
| CAP-007 | apigen tracing under `adhd` | 3.3.1, 5.3 | ☐ |
| CAP-008 | agent-search consumes the package | 5.6 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

- 4 unresolved interface stubs (⟦U1⟧-⟦U4⟧) and 4 scope gaps; full list in `UNRESOLVED.md`. Highest impact: ⟦U1⟧ the generated CLI invocation shape and ⟦U2⟧ the MCP tool names, both fixed once `surface-hosts` lands.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved.
