# Demo: `@adhd/policy-core-client` and `adhd-policy`, v1

Status: acceptance demo for what is being built now. Companion to `architect-spec.md` (SC, PD, PM, FX, AT, LY, MG, NR, EX, FC, CL, SV, IN), `architect-spec-sources.md` (SRC, GW, AK, WM), `architect-spec-layer.md` (LP) and the interface files. Supersedes the `policy-gw` names in `architect-demo-v2/v3/v4.md`; the current commands are `adhd-policy run bin:<cmd>` and `adhd-policy serve <source>`.

Scope: the library `@adhd/policy-core-client` (compile, evaluate, resolve, narrow, explain, verify, draft) and the CLI `adhd-policy` (`check`, `evaluate`, `verify`, `explain`, `resolve`, `narrow`, `draft`, `run`, `serve`, `mcp-json`), whose `run` and `serve` verbs load the apigen policy Layer. Out of scope and not shown: the sandbox, agent-mcp integration, any auth layer, any live third-party service.

Notation. `[U#]` points to the UNKNOWN list at the end: a place where the specs do not fix the behavior. Where a step depends on an unknown, the assertion is written to the weakest form the specs guarantee, and the unknown is named so the implementer can confirm it first. Spec IDs after "Proves" are the acceptance contract for that beat.

## The story

Priya runs a platform team. Her developers let coding agents run commands, read files and, in one case, issue small refunds. She wants one small policy file that says who may do what, wants a refused call to be a plain non-zero exit a script can trust, and wants to hand a sub-agent a narrower version of her own authority without writing code. She never starts a server to get any of this.

## Prerequisites and setup (cold start)

Needs: Node 20+, the built `adhd-policy` bin on `PATH`, `jq`, and the library resolvable from a scratch directory (`pnpm add @adhd/policy-core-client`). No server, no sandbox, no network, no other process (SC-05, VR-07, WM-08).

Use a throwaway shell: the demo sets `HOME` so the real user-level policy and layer files are never read or written.

```bash
export DEMO="$(cd "$(mktemp -d)" && pwd -P)"      # real path: on macOS /var is a link to /private/var
mkdir -p "$DEMO/home/.ssh" "$DEMO/work/out" "$DEMO/shared" "$DEMO/bad" "$DEMO/lib"
echo "# readme"  > "$DEMO/work/readme.md"
echo "SECRET=1"  > "$DEMO/work/.env"
echo "n"         > "$DEMO/work/out/notes.txt"
echo "guide"     > "$DEMO/shared/guide.md"
echo "SECRET=2"  > "$DEMO/shared/.env"
export HOME="$DEMO/home"
cd "$DEMO"

cat > attrs-dev.json <<EOF
{"role":"dev","read_roots":["$DEMO/work"],"write_roots":["$DEMO/work/out"]}
EOF
cat > attrs-intern.json <<EOF
{"role":"intern","write_roots":["$DEMO/work/out"]}
EOF
cat > attrs-support.json <<EOF
{"role":"support","customers":["cust_1"],"max_refund":50}
EOF
A() { cat "$DEMO/attrs-$1.json"; }                 # attributes for a named caller
P() { printf '{"path":"%s"}' "$DEMO/$1"; }         # a {path} argument object
```

Verify (setup): `ls -d "$DEMO/work/out" "$DEMO/shared" >/dev/null && jq -e .role attrs-dev.json` exits 0 and prints `"dev"`.

Command-surface convention used throughout [U1]: an operation's input fields become flags (`--tool`, `--args '<json>'`, `--attributes '<json>'`), object values are JSON strings. Results go to stdout as JSON; errors go to stderr; exit codes are apigen's (`invalid_argument` 2, `permission_denied` 3, `not_found` 4, `internal` 1). The exact rendering of stdout and stderr is [U2].

Policy discovery for the operation commands (`check`, `evaluate`, `explain`, `verify`, `resolve`, `narrow`, `draft`): the working directory is searched upward for `workspace-policy.yaml` (PD-01, PD-04); with no file the built-in deny-by-default policy applies. File locations for the global and local layers are [U5].

---

## Scenario 1. Library first: compile once, decide in process, no server

Priya starts where a program starts: import, compile, ask.

Source: PD-09, PM-01 to PM-11, AT-09, AT-10, CL-01 to CL-08, CL-11, CL-12, SC-06, QE-08.

### B1.1 Import starts nothing (happy)

Do:
```bash
cd "$DEMO/lib" && pnpm init >/dev/null 2>&1; pnpm add @adhd/policy-core-client >/dev/null 2>&1
cat > import-only.mjs <<'EOF'
import * as client from '@adhd/policy-core-client';
const handles = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap');
console.log(JSON.stringify({ exports: Object.keys(client).sort(), activeResources: handles }));
EOF
node import-only.mjs
```
Expect: one JSON line. `exports` includes `compile`, `evaluate`, `explain`, `narrow`, `resolve`, `verify`, `draft`, `createDecider` [U3]. `activeResources` is `[]`. The process exits by itself with status 0.

Verify:
- [ ] `node import-only.mjs | jq -e '.activeResources == []'` exits 0.
- [ ] `node import-only.mjs | jq -e '.exports | index("evaluate") != null and index("narrow") != null and index("createDecider") != null'` exits 0.

Proves: SC-06, CL-12, SV-13. Source: architect-spec.md SC-06, CL-12; interfaces 1.1 root exports [U3].

### B1.2 Compile, then allow, deny, forced value, no match (happy and edge)

Do:
```bash
cat > decide.mjs <<'EOF'
import assert from 'node:assert/strict';
import { compile, evaluate } from '@adhd/policy-core-client';

const doc = {
  version: 1,
  attributes: { role: 'name', read_roots: 'paths' },
  defaults: [{ set: { role: 'guest', read_roots: [] } }],
  permissions: [
    { tool: 'files.read', args: { path: { _within: '$attributes.read_roots' } } },
    { tool: 'files.*', effect: 'deny', args: { path: { _regex: '(^|/)\\.env$' } } },
    { tool: 'files.write', context: { role: { _eq: 'dev' } }, set: { overwrite: false } },
  ],
};
const layers = [{ name: 'project', source: 'inline', document: doc }];
const compiled = compile(layers);
assert.equal(compiled.ok, true);
const policy = compiled.policy;

const demo = process.env.DEMO;
const dev = { role: 'dev', read_roots: [`${demo}/work`] };

const read = evaluate(policy, { tool: 'files.read', args: { path: `${demo}/work/readme.md` } }, dev);
assert.equal(read.effect, 'allow');

const env = evaluate(policy, { tool: 'files.read', args: { path: `${demo}/work/.env` } }, dev);
assert.equal(env.effect, 'deny');
assert.equal(env.denial.code, 'explicit-deny');

const write = evaluate(policy, { tool: 'files.write', args: { path: `${demo}/work/out/notes.txt` } }, dev);
assert.equal(write.effect, 'allow');
assert.deepEqual(write.set, { overwrite: false });

const anon = evaluate(policy, { tool: 'files.write', args: { path: `${demo}/work/out/notes.txt` } });
assert.equal(anon.effect, 'deny');
assert.equal(anon.denial.code, 'no-match');

console.log('ok', JSON.stringify({ read: read.effect, env: env.denial.code, write: write.set, anon: anon.denial.code }));
EOF
node decide.mjs
```
Expect: a single line `ok {"read":"allow","env":"explicit-deny","write":{"overwrite":false},"anon":"no-match"}` and exit 0. Why each line: the first allow matches because the path is inside `read_roots`; `.env` also matches the allow, and the deny wins (PM-06); the write allow carries its forced `overwrite: false` (PM-08); the caller with no attributes gets the empty set plus the `guest` default, so the `dev`-only write permission does not apply and nothing matches, which is deny (PM-07, AT-09, AT-10).

Verify:
- [ ] `node decide.mjs; echo "exit=$?"` prints the `ok` line and `exit=0`.
- [ ] Negative control: delete the second permission (the `files.*` deny) from `doc` in a copy of the script; the `.env` assertion must now fail (exit non-zero), proving the deny is what stopped the read.

Proves: CL-01, CL-02, CL-07, CL-08, PM-05 to PM-08, PM-11, AT-09, AT-10, FX-01, FX-04, FX-07 (real-path comparison: `$DEMO` is a real path). Source: architect-spec.md CL-*, PM-*, AT-*; interfaces 4.1 core signatures [U3], 4.2 `IDecision`.

### B1.3 Deterministic and serializable (happy)

Do:
```bash
cat > determinism.mjs <<'EOF'
import assert from 'node:assert/strict';
import { compile } from '@adhd/policy-core-client';
const doc = { version: 1, permissions: [{ tool: 'files.read' }] };
const layers = [{ name: 'project', source: 'inline', document: doc }];
const a = compile(layers), b = compile(layers);
assert.equal(a.ok && b.ok, true);
assert.equal(JSON.stringify(a.policy), JSON.stringify(b.policy));
assert.equal(typeof a.policy.contentHash, 'string');
assert.equal(typeof a.policy.schemaVersion, 'number');
console.log('deterministic', a.policy.schemaVersion);
EOF
node determinism.mjs
```
Expect: `deterministic 1`, exit 0. A policy with no `attributes` block and no runtime provider compiles (AT-09, SC-05).

Verify:
- [ ] `node determinism.mjs` exits 0 and prints `deterministic 1`.

Proves: CL-05, CL-06, SC-05. Source: architect-spec.md CL-05, CL-06; interfaces 3 (`schemaVersion: 1`).

### B1.4 Explain a decision (happy)

Do: append to a new script and run.
```bash
cat > explain.mjs <<'EOF'
import assert from 'node:assert/strict';
import { compile, explain } from '@adhd/policy-core-client';
const doc = {
  version: 1,
  attributes: { read_roots: 'paths' },
  permissions: [
    { tool: 'files.read', args: { path: { _within: '$attributes.read_roots' } } },
    { tool: 'files.*', effect: 'deny', args: { path: { _regex: '(^|/)\\.env$' } } },
  ],
};
const { policy } = compile([{ name: 'project', source: 'inline', document: doc }]);
const demo = process.env.DEMO;
const e = explain(policy, { tool: 'files.read', args: { path: `${demo}/work/.env` } }, { read_roots: [`${demo}/work`] });
assert.equal(e.decision.effect, 'deny');
assert.equal(e.considered.filter((c) => c.argsMatched === true).length, 2);
const readEntry = e.considered.find((c) => c.substituted && c.substituted.path && c.substituted.path._within);
assert.deepEqual(readEntry.substituted.path._within, [`${demo}/work`]);
console.log('explained');
EOF
node explain.mjs
```
Expect: `explained`, exit 0. Both permissions matched on arguments; the allow's placeholder was replaced by the caller's `read_roots` value (FX-04, EX-02) [U10].

Verify:
- [ ] `node explain.mjs` exits 0.

Proves: CL-11, EX-02, FX-04. Source: architect-spec.md CL-11, EX-02; interfaces 4.2 `IExplanation`.

---

## Scenario 2. Gate a script on an exit code: `check`, `evaluate`, and `ask`

Priya's CI job should stop when a tool call is not allowed. She uses the one policy file below and two commands: `evaluate` answers the question, `check` turns the answer into an exit code.

Source: PD-01, PD-04, PM-*, AT-04, AT-05, AT-09, AT-10, CL-08, SV-06, SV-08, IN-09, IN-10, FC-04, AK-01, AK-03, OD-16.

### B2.0 The policy file

Do:
```bash
cd "$DEMO"
cat > workspace-policy.yaml <<'EOF'
version: 1
attributes:
  role: name
  read_roots: paths
  write_roots: paths
  customers: names
  max_refund: number
defaults:
  - set: { role: guest, read_roots: [], write_roots: [], customers: [], max_refund: 0 }
permissions:
  - tool: files.read
    args: { path: { _within: $attributes.read_roots } }
  - tool: files.write
    context: { role: { _eq: dev } }
    args: { path: { _within: $attributes.write_roots } }
    set: { overwrite: false }
  - tool: files.*
    effect: deny
    args: { path: { _regex: '(^|/)\.env$|(^|/)\.ssh/' } }
  - tool: billing.refund
    effect: ask
    context: { role: { _eq: support } }
    args:
      _and:
        - { customer: { _in: $attributes.customers } }
        - { amount: { _lte: $attributes.max_refund } }
  - tool: billing.*
    effect: deny
    context: { role: { _eq: guest } }
EOF
```
Expect: the file exists; nothing runs. Resolution rules in force: deny beats ask beats allow; no matching permission is deny; supplied attributes beat defaults.

Verify:
- [ ] `adhd-policy verify; echo "exit=$?"` ends with `exit=0` and reports no errors [U8] (full check in B6.1).

### B2.1 Allowed call exits 0 (happy)

Do: `adhd-policy check --tool files.read --args "$(P work/readme.md)" --attributes "$(A dev)"; echo "exit=$?"`

Expect: stdout is a decision object with `"effect":"allow"` and `"set":{}` [U2, U4]; last line `exit=0`.

Verify:
- [ ] `adhd-policy check --tool files.read --args "$(P work/readme.md)" --attributes "$(A dev)" | jq -e '.effect=="allow"'` exits 0.

Proves: SV-06, CL-08, PM-03. Source: architect-spec.md SV-06, IN-09.

### B2.2 Secret path denied, exit 3 (edge)

Do: `adhd-policy check --tool files.read --args "$(P work/.env)" --attributes "$(A dev)"; echo "exit=$?"`

Expect: no decision on stdout; stderr carries a `permission_denied` error whose reason names the matched deny [U2]; last line `exit=3`. The path is inside `read_roots`, so the read permission matches too; the deny wins.

Verify:
- [ ] `adhd-policy check --tool files.read --args "$(P work/.env)" --attributes "$(A dev)" >/dev/null 2>&1; [ $? -eq 3 ]` exits 0.

Proves: PM-06, SV-08, IN-09, TL-02. Source: architect-spec.md PM-06, IN-09; examples TL-02.

### B2.3 `evaluate` answers, `check` gates (happy)

Do: `adhd-policy evaluate --tool files.read --args "$(P work/.env)" --attributes "$(A dev)"; echo "exit=$?"`

Expect: exit 0 and a decision with `"effect":"deny"` and `"denial":{"code":"explicit-deny", ...}`; `matched` lists at least the deny permission's id [U4].

Verify:
- [ ] `adhd-policy evaluate --tool files.read --args "$(P work/.env)" --attributes "$(A dev)" | jq -e '.effect=="deny" and .denial.code=="explicit-deny"'` exits 0.

Proves: SV-06 (`evaluate` and `check` are distinct operations), CL-07. Source: interfaces 5 (`evaluate` returns `IDecision`; `check` raises `permission_denied`).

### B2.4 Forced value on an allowed write (happy)

Do: `adhd-policy check --tool files.write --args "{\"path\":\"$DEMO/work/out/notes.txt\",\"content\":\"hi\"}" --attributes "$(A dev)"; echo "exit=$?"`

Expect: exit 0; the decision's `set` is `{"overwrite":false}`.

Verify:
- [ ] The same command piped to `jq -e '.effect=="allow" and .set=={"overwrite":false}'` exits 0.

Proves: PM-08, CL-07. Source: architect-spec.md PM-08.

### B2.5 No attributes at all: deny by default (edge)

Do: `adhd-policy check --tool files.write --args "$(P work/out/notes.txt)"; echo "exit=$?"` then `adhd-policy evaluate --tool files.write --args "$(P work/out/notes.txt)" | jq -c '{effect, code: .denial.code}'`

Expect: first command ends `exit=3`. Second prints `{"effect":"deny","code":"no-match"}`. The caller supplied nothing, got the `guest` default role, and no write permission applies to a guest.

Verify:
- [ ] `adhd-policy evaluate --tool files.write --args "$(P work/out/notes.txt)" | jq -e '.denial.code=="no-match"'` exits 0.

Proves: AT-05, AT-09, AT-10, PM-07, PM-11. Source: architect-spec.md AT-05, PM-07.

### B2.6 `ask` collapses to `permission_denied`, exit 3 (edge)

Do:
```bash
adhd-policy evaluate --tool billing.refund --args '{"customer":"cust_1","amount":40}' --attributes "$(A support)" | jq -c '{effect}'
adhd-policy check    --tool billing.refund --args '{"customer":"cust_1","amount":40}' --attributes "$(A support)"; echo "exit=$?"
```
Expect: `{"effect":"ask"}` from `evaluate`. `check` writes a `permission_denied` error to stderr whose reason names `ask`, and ends `exit=3` (interim behavior until apigen has an approval-required result; OD-16) [U17].

Verify:
- [ ] `adhd-policy evaluate ... | jq -e '.effect=="ask"'` exits 0.
- [ ] `adhd-policy check ... 2>&1 >/dev/null | grep -qi ask` exits 0 and the check's own status is 3.

Proves: PM-05, SV-08, IN-09, FC-04, AK-01, AK-03. Source: architect-spec.md SV-08, OD-16.

### B2.7 Over the limit is not an `ask` (edge)

Do: `adhd-policy evaluate --tool billing.refund --args '{"customer":"cust_1","amount":90}' --attributes "$(A support)" | jq -c '{effect, code: .denial.code}'`

Expect: `{"effect":"deny","code":"no-match"}`. Ninety exceeds `max_refund` 50, so the `ask` permission does not apply, and nothing else covers a support caller.

Verify:
- [ ] The piped `jq -e '.effect=="deny" and .denial.code=="no-match"'` exits 0.

Proves: FX-02 (`_lte`, `_in`, `_and`), PM-07. Source: architect-spec.md FX-02, PM-07.

### B2.8 A caller that never identified itself is a guest (edge)

Do: `adhd-policy evaluate --tool billing.refund --args '{"customer":"cust_1","amount":1}' | jq -c '{effect, code: .denial.code}'`

Expect: `{"effect":"deny","code":"explicit-deny"}`: the `defaults` rule gave `role: guest`, the refund `ask` rule needs `support`, and the `billing.*` deny names guests.

Verify:
- [ ] The piped `jq -e '.denial.code=="explicit-deny"'` exits 0.

Proves: AT-05, LY-02, AT-10. Source: architect-spec.md AT-05, LY-02.

### B2.9 Malformed call is rejected before any decision (edge)

Do: `adhd-policy check --args '{}'; echo "exit=$?"`

Expect: stderr names the missing `tool` input; last line `exit=2` (`invalid_argument`).

Verify:
- [ ] `adhd-policy check --args '{}' >/dev/null 2>&1; [ $? -eq 2 ]` exits 0.

Proves: IN-10, SV-03 (validation comes from apigen, not hand-written code). Source: architect-spec.md IN-10.

---

## Scenario 3. Put a policy in front of any command: `run bin:`

Priya wants `touch` to work only for developers, only in their write roots, and to need approval for interns. She does not change `touch`, and no server runs.

Source: VR-02, VR-09, SV-20, SRC-05, SRC-07, SRC-09, LC-01, LC-04, SV-22, GW-01, GW-05, GW-06, GW-09, GW-17, GW-19, AK-03, AT-09, PM-06.

### B3.0 The gate policy and a policy-gated command

Do:
```bash
cd "$DEMO"
cat > gate.yaml <<'EOF'
version: 1
attributes:
  role: name
  write_roots: paths
defaults:
  - set: { role: guest, write_roots: [] }
permissions:
  - tool: touch
    context: { role: { _eq: dev } }
    args: { cwd: { _within: $attributes.write_roots } }
  - tool: touch
    effect: ask
    context: { role: { _eq: intern } }
    args: { cwd: { _within: $attributes.write_roots } }
  - tool: touch
    effect: deny
    args: { cwd: { _regex: '(^|/)\.ssh(/|$)' } }
EOF
cp attrs-dev.json attrs-active.json
ptouch() { adhd-policy run bin:touch --spec "$DEMO/gate.yaml" --adhd-attributes "@$DEMO/attrs-active.json" -- "$@"; }
```
Expect: nothing runs. `ptouch` keeps `touch`'s own interface; the tool name the policy sees is the command name and its arguments are `{ argv, cwd }` [U6].

### B3.1 Developer in the write root: runs (happy)

Do: `cd "$DEMO/work/out" && ptouch made-by-dev.txt; echo "exit=$?"; ls made-by-dev.txt`

Expect: `exit=0`; `ls` prints `made-by-dev.txt`. The command ran with its original arguments and exit status; no server was started.

Verify:
- [ ] `test -f "$DEMO/work/out/made-by-dev.txt"` exits 0.
- [ ] `ptouch made-by-dev2.txt` exits 0 (run from `$DEMO/work/out`).

Proves: VR-02, SV-20 (allow path), SRC-07, GW-05, FX-06, FX-07. Source: architect-spec.md VR-02, SV-20.

### B3.2 Same developer, wrong directory: refused (edge)

Do: `cd "$DEMO/work" && ptouch outside.txt; echo "exit=$?"; ls outside.txt`

Expect: stderr has a refusal reason; the shell shows a non-zero status (apigen would map `permission_denied` to 3 [U7]); `ls` reports no such file. The command never ran.

Verify:
- [ ] `cd "$DEMO/work" && ptouch outside.txt 2>/dev/null; [ $? -ne 0 ]` exits 0.
- [ ] `test ! -e "$DEMO/work/outside.txt"` exits 0.

Proves: GW-05 (denied calls do not reach the upstream), GW-09, PM-07, SV-20 (deny path). Source: architect-spec-sources.md GW-05, GW-09; architect-spec.md SV-20.

### B3.3 Intern: `ask` with nobody to answer is a refusal (edge)

Do: `cp "$DEMO/attrs-intern.json" "$DEMO/attrs-active.json"; cd "$DEMO/work/out" && ptouch intern.txt; echo "exit=$?"; ls intern.txt`

Expect: stderr has a refusal reason; non-zero status [U7]; no file. The same file path as B3.1 would have been allowed for a developer; the only change is the attribute file, which is re-read on this new invocation (LC-04). With no answering channel an `ask` is a deny (AK-03, SV-20).

Verify:
- [ ] `test ! -e "$DEMO/work/out/intern.txt"` exits 0 and the previous command's status was non-zero.

Proves: LC-01, LC-04, AK-03, FC-04, SV-20. Source: architect-spec.md LC-04, AK-03, SV-20.

### B3.4 A deny in a developer's own root still wins (edge)

Do:
```bash
cat > "$DEMO/attrs-active.json" <<EOF
{"role":"dev","write_roots":["$DEMO/home"]}
EOF
cd "$DEMO/home/.ssh" && ptouch key.txt; echo "exit=$?"
```
Expect: non-zero status [U7]; `ls "$DEMO/home/.ssh"` is empty. The developer permission matches (the directory is inside the write root) and so does the deny; deny wins.

Verify:
- [ ] `test -z "$(ls -A "$DEMO/home/.ssh")"` exits 0.

Proves: PM-06, PM-10, TL-02. Source: architect-spec.md PM-06.

### B3.5 No identity means the empty set, and the gate still works (edge)

Do: `ptouch2() { adhd-policy run bin:touch --spec "$DEMO/gate.yaml" -- "$@"; }; cd "$DEMO/work/out" && ptouch2 anon.txt; echo "exit=$?"`

Expect: non-zero status; `anon.txt` absent. No attribute source was given, so the wrapper starts with the empty set (guest) and nothing allows a guest.

Verify:
- [ ] `test ! -e "$DEMO/work/out/anon.txt"` exits 0.

Proves: GW-19, AT-09, LC-07. Source: architect-spec-sources.md GW-19.

### B3.6 Bad attributes refuse to start (edge)

Do: `echo '"not-an-object"' > "$DEMO/bad-attrs.json"; adhd-policy run bin:touch --spec "$DEMO/gate.yaml" --adhd-attributes "@$DEMO/bad-attrs.json" -- never.txt; echo "exit=$?"; ls "$DEMO/work/out/never.txt"`

Expect: stderr says the attributes must be a JSON object; non-zero status; no file.

Verify:
- [ ] `test ! -e "$DEMO/work/out/never.txt"` exits 0.

Proves: GW-19, PS-05. Source: architect-spec-sources.md GW-19.

---

## Scenario 4. Layers: global, then project, then local

The default for shared documents is Priya's own machine setting; the project sets limits per role; a developer's personal layer tightens a number. Nobody can lift a deny from above.

Source: PD-05, PD-06, PD-07, LY-01 to LY-04, AT-04, PM-09, PM-10, CL-10, EX-01, QE-08.

### B4.1 Defaults resolve in layer order, last matching rule wins (happy)

Do:
```bash
cd "$DEMO/lib" && cat > layers.mjs <<'EOF'
import assert from 'node:assert/strict';
import { compile, resolve, evaluate } from '@adhd/policy-core-client';
const S = `${process.env.DEMO}/shared`;

const global = { version: 1,
  attributes: { shared_read_roots: 'paths', repos: 'names', max_refund: 'number' },
  defaults: [{ set: { shared_read_roots: [S], repos: [], max_refund: 0 } }],
  permissions: [
    { tool: 'files.read', args: { path: { _within: '$attributes.shared_read_roots' } } },
    { tool: 'files.*', effect: 'deny', args: { path: { _regex: '(^|/)\\.env$' } } },
  ] };
const project = { version: 1,
  attributes: { role: 'name', read_roots: 'paths', shared_read_roots: 'paths', repos: 'names', max_refund: 'number' },
  defaults: [
    { where: { role: { _eq: 'support' } },  set: { max_refund: 50 } },
    { where: { role: { _eq: 'release' } },  set: { repos: ['acme/shop'] } },
    { where: { role: { _eq: 'reviewer' } }, set: { shared_read_roots: [] } },
  ],
  permissions: [
    { tool: 'files.read', context: { role: { _in: ['dev', 'reviewer'] } }, args: { path: { _within: '$attributes.read_roots' } } },
  ] };
const local = { version: 1,
  attributes: { role: 'name', max_refund: 'number' },
  defaults: [{ where: { role: { _eq: 'support' } }, set: { max_refund: 20 } }],
  permissions: [
    { tool: 'files.read', effect: 'allow', args: { path: { _regex: '\\.env$' } } },
  ] };

const c = compile([
  { name: 'global',  source: 'global.yaml',            document: global },
  { name: 'project', source: 'workspace-policy.yaml',  document: project },
  { name: 'local',   source: 'local.yaml',             document: local },
]);
assert.equal(c.ok, true);
const policy = c.policy;

const support = resolve(policy, { role: 'support' });
assert.deepEqual(support.attributes.shared_read_roots, [S]);
assert.deepEqual(support.attributes.repos, []);
assert.equal(support.attributes.max_refund, 20);                 // local beats project (50) beats global (0)
assert.equal(support.provenance.role, 'supplied');
assert.ok(support.provenance.shared_read_roots.startsWith('global:'));
assert.ok(support.provenance.max_refund.startsWith('local:'));

const release = resolve(policy, { role: 'release' });
assert.deepEqual(release.attributes.repos, ['acme/shop']);
assert.ok(release.provenance.repos.startsWith('project:'));
assert.equal(release.attributes.max_refund, 0);                  // only the global default sets it
assert.ok(release.provenance.max_refund.startsWith('global:'));

const dev = resolve(policy, { role: 'dev' });
assert.deepEqual(dev.attributes.shared_read_roots, [S]);         // inherited

const reviewer = resolve(policy, { role: 'reviewer' });
assert.deepEqual(reviewer.attributes.shared_read_roots, []);     // explicit empty stops inheriting
assert.ok(reviewer.provenance.shared_read_roots.startsWith('project:'));

const supplied = resolve(policy, { role: 'support', max_refund: 5 });
assert.equal(supplied.attributes.max_refund, 5);                 // supplied is final (AT-04)
assert.equal(supplied.provenance.max_refund, 'supplied');
console.log('layers ok');

// --- decisions across layers (B4.2) ---
const call = (p) => ({ tool: 'files.read', args: { path: p } });
const devAttrs = { role: 'dev', read_roots: [`${process.env.DEMO}/work`] };
assert.equal(evaluate(policy, call(`${S}/guide.md`), devAttrs).effect, 'allow');                    // global shared permission
assert.equal(evaluate(policy, call(`${process.env.DEMO}/work/readme.md`), devAttrs).effect, 'allow'); // project permission
const lifted = evaluate(policy, call(`${S}/.env`), devAttrs);
assert.equal(lifted.effect, 'deny');                              // local allow cannot lift the global deny
assert.equal(lifted.denial.code, 'explicit-deny');
console.log('decisions ok');
EOF
node layers.mjs
```
Expect: two lines, `layers ok` then `decisions ok`; exit 0. What each assertion shows: the support caller gets `max_refund: 20` because rules apply in layer order and the last matching rule that sets an attribute wins (LY-01), with the value's source reported (EX-01, CL-10); the release caller inherits the global `max_refund` but gets its own `repos`; reviewers drop the inherited shared folder by an explicit empty list (LY-04); a supplied value is final (AT-04). The local layer's allow for `.env` cannot lift the global deny (PM-09, PM-10).

Verify:
- [ ] `node layers.mjs; echo "exit=$?"` prints `layers ok`, `decisions ok`, `exit=0`.
- [ ] Negative control: in `layers.mjs` swap the order of the `compile([...])` array to put `local` first; the `max_refund` assertion must fail (exit non-zero), proving order is layer order and not file order.

Proves: PD-05, PD-06, PD-07, LY-01 to LY-04, AT-04, PM-09, PM-10, CL-10, EX-01, SI-07. Source: architect-spec.md LY-*, PM-09; interfaces 2.1 layer rules, `IResolved`. Layer file paths when discovered from disk are [U5]; here the layers are passed explicitly.

---

## Scenario 5. Hand a sub-agent less authority: `narrow`

Priya's orchestrator may spawn a reviewer. The reviewer gets the orchestrator's authority minus whatever the reviewer role specifies, plus an explicit grant if the orchestrator adds one, optionally cut down by `only`, and never more than the orchestrator itself holds.

Source: MG-01 to MG-11, NR-01 to NR-04, DL-01, EX-04, FC-05, SI-03.

### B5.0 The policy and the parent

Do:
```bash
mkdir -p "$DEMO/narrow" && cd "$DEMO/narrow"
cat > workspace-policy.yaml <<'EOF'
version: 1
attributes:
  role: name
  read_roots: paths
  write_roots: paths
  repos: names
  max_refund: number
defaults:
  - where: { role: { _eq: reviewer } }
    set: { write_roots: [], repos: [acme/shop] }
permissions:
  - tool: agent.spawn
    effect: deny
    args:
      _not:
        _and:
          - { 'child.read_roots':  { _within: $attributes.read_roots } }
          - { 'child.write_roots': { _within: $attributes.write_roots } }
          - { 'child.repos':       { _contained_in: $attributes.repos } }
          - { 'child.max_refund':  { _lte: $attributes.max_refund } }
  - tool: agent.spawn
    context: { role: { _eq: orchestrator } }
    args: { agent_name: { _in: [reviewer] } }
EOF
cat > parent.json <<EOF
{"role":"orchestrator","read_roots":["$DEMO/work","$DEMO/shared"],"write_roots":["$DEMO/work/out"],"repos":["acme/shop"],"max_refund":100}
EOF
mkdir -p "$DEMO/work/tests" "$DEMO/work/src"
N() { adhd-policy narrow --parent "$(cat parent.json)" --request "$1"; }     # [U1]
```
Expect: nothing runs. The spawn tool is "child-creating" because its deny permission reads `child.*` [U9]. The reviewer role specifies `write_roots` and `repos` itself and does not specify `read_roots` or `max_refund`.

### B5.1 Grant adds, unspecified values inherit (happy)

Do: `N "{\"attributes\":{\"role\":\"reviewer\"},\"grant\":{\"read_roots\":[\"$DEMO/work/tests\"]}}" | jq -S .`

Expect (keys sorted, exit 0):
```json
{
  "child": {
    "max_refund": 100,
    "read_roots": ["<DEMO>/work/tests"],
    "repos": ["acme/shop"],
    "role": "reviewer",
    "write_roots": []
  },
  "ok": true
}
```
`read_roots`: the reviewer does not specify it and the grant sets it, so the child gets the grant (MG-02). `write_roots` and `repos`: the reviewer's own values (MG-03). `max_refund`: not specified, not granted, inherited (MG-01) [U9 for the shape].

Verify:
- [ ] `N ... | jq -e '.ok==true and .child.max_refund==100 and .child.write_roots==[] and .child.repos==["acme/shop"] and (.child.read_roots|length)==1'` exits 0.

Proves: MG-01, MG-02, MG-03, NR-01, DL-01. Source: architect-spec.md MG-01 to MG-03.

### B5.2 `only` restricts the add step (happy)

Do: `N "{\"attributes\":{\"role\":\"reviewer\"},\"grant\":{\"read_roots\":[\"$DEMO/work/tests\",\"$DEMO/work/src\"]},\"only\":{\"read_roots\":[\"$DEMO/work/src\"]}}" | jq -c '.child.read_roots'`

Expect: `["<DEMO>/work/src"]`. The add step gave `tests` and `src`; `only` lies within that and replaces it (MG-05). `grant` and `only` on the same attribute is the current default (MG-06, OD-06) [U18].

Verify:
- [ ] The output `jq -e '. == ["'"$DEMO"'/work/src"]'` exits 0.

Proves: MG-04 (grant first), MG-05, MG-06. Source: architect-spec.md MG-05, MG-06.

### B5.3 Widening is refused and named (edge)

Do: `N '{"attributes":{"role":"reviewer"},"grant":{"max_refund":900}}' | jq -c '{ok, variable}'`

Expect: `{"ok":false,"variable":"max_refund"}`; the full result also carries a `rule` and a `reason` string naming why. Nothing is clamped to 100 (MG-09, OD-01) [U18]. Exit 0: `narrow` reports a refusal as data; the gate is `check` on the spawn call.

Verify:
- [ ] The piped `jq -e '.ok==false and .variable=="max_refund" and (.rule|type)=="string" and (.reason|type)=="string"'` exits 0.

Proves: MG-08, MG-09, NR-01, NR-03, EX-04, SI-03. Source: architect-spec.md MG-08, MG-09, EX-04.

### B5.4 `only` outside what the child would have (edge)

Do: `N "{\"attributes\":{\"role\":\"reviewer\"},\"only\":{\"read_roots\":[\"$DEMO/home\"]}}" | jq -c '{ok, variable}'`

Expect: `{"ok":false,"variable":"read_roots"}`. The add step inherited the parent's `work` and `shared`; `home` is not inside it (MG-07).

Verify:
- [ ] The piped `jq -e '.ok==false and .variable=="read_roots"'` exits 0.

Proves: MG-07, MG-11. Source: architect-spec.md MG-07.

### B5.5 A union that exceeds the parent is refused (edge)

Do: `N '{"attributes":{"role":"reviewer"},"grant":{"repos":["acme/api"]}}' | jq -c '{ok, variable}'`

Expect: `{"ok":false,"variable":"repos"}`. The reviewer keeps `acme/shop`, the grant adds `acme/api`, the union is `[acme/shop, acme/api]`, and the parent holds only `acme/shop` (MG-04, MG-08).

Verify:
- [ ] The piped `jq -e '.ok==false and .variable=="repos"'` exits 0.

Proves: MG-04, MG-08, NR-03. Source: architect-spec.md MG-04, MG-08.

### B5.6 An unchecked key fails closed (edge)

Do: `N '{"attributes":{"role":"reviewer"},"grant":{"unknown_var":["x"]}}' | jq -c '{ok, variable}'`

Expect: `{"ok":false,"variable":"unknown_var"}`.

Verify:
- [ ] The piped `jq -e '.ok==false and .variable=="unknown_var"'` exits 0.

Proves: NR-04, FC-05, PS-11. Source: architect-spec.md NR-04, FC-05.

### B5.7 The parent is untouched (happy)

Do: `cat parent.json | jq -S . | md5` before and after all of B5.1 to B5.6 (take the checksum once before, once after).

Expect: both checksums equal. `narrow` is pure: it stores nothing and issues no reference (DL-01).

Verify:
- [ ] The two checksums are identical.

Proves: DL-01, NR-07. Source: architect-spec.md DL-01.

---

## Scenario 6. Know what a policy says before you ship it: `verify`, `explain`, `resolve`, `draft`

### B6.1 A good file verifies clean (happy)

Do: `cd "$DEMO" && adhd-policy verify | jq -c '.'; echo "exit=${PIPESTATUS[0]}"`

Expect: a report with no errors and no warnings [U8], exit 0.

Verify:
- [ ] `adhd-policy verify >/dev/null; [ $? -eq 0 ]` exits 0.

Proves: CL-04, SV-06. Source: architect-spec.md CL-04.

### B6.2 A broken file reports every defect with its location (edge)

Do:
```bash
cd "$DEMO/bad"
cat > workspace-policy.yaml <<'EOF'
version: 1
attributes:
  role: name
  docs: paths
runtime:
  calls: number
defaults:
  - set: { docs: ["/opt/docs"] }
permissions:
  - tool: files.read
    args: { path: { _wthin: $attributes.docs } }
  - tool: files.write
    args: { team: { _eq: $attributes.team } }
  - tool: slack.post
    context: { 'runtime.calls': { _lt: 3 } }
EOF
adhd-policy verify; echo "exit=$?"
```
Expect: the report lists, each with a JSON path into the document, an error with code `unknown-operator` (the `_wthin` typo; QE-05), an error `undeclared-attribute` (`$attributes.team`; PD-09), an error `layer-violation` (a project layer may not introduce the absolute path `/opt/docs`; LY-05), and a warning `runtime-without-provider` (the `slack.post` permission reads `runtime`; RT-09). The document does not load partially (PD-12) [U8 for shape, exit code and path syntax].

Verify:
- [ ] `adhd-policy verify 2>&1 | grep -c -E 'unknown-operator|undeclared-attribute|layer-violation|runtime-without-provider'` prints a number at least 4 (all four codes appear).
- [ ] The same four codes do not appear in the `adhd-policy verify` output of B6.1.

Proves: CL-04, QE-05, PD-09, PD-12, LY-05, FX-09, RT-09, PS-24. Source: architect-spec.md CL-04, PD-12, LY-05, RT-09; interfaces 4.2 `IPolicyIssue` codes.

### B6.3 A policy that does not load stops the tool (edge)

Do: `cd "$DEMO/bad" && adhd-policy check --tool files.read --args '{"path":"/etc/hosts"}'; echo "exit=$?"`

Expect: no decision on stdout; stderr names the load failure; the exit status is non-zero [U8]. The tool did not fall back to a weaker policy: running the same call from `$DEMO/work` (where the walk-up finds `$DEMO/workspace-policy.yaml`) yields that file's decision instead, never the broken file's partial rules.

Verify:
- [ ] `cd "$DEMO/bad" && adhd-policy check --tool files.read --args '{"path":"/etc/hosts"}' >/dev/null 2>&1; [ $? -ne 0 ]` exits 0.

Proves: FC-06, FC-01, PD-12, CL-13. Source: architect-spec.md FC-06.

### B6.4 Explain a refusal (happy)

Do: `cd "$DEMO" && adhd-policy explain --tool files.read --args "$(P work/.env)" --attributes "$(A dev)" | jq -c '{effect: .decision.effect, code: .decision.denial.code, argsMatched: [.considered[] | .argsMatched]}'`

Expect: `{"effect":"deny","code":"explicit-deny","argsMatched":[...]}` where the list includes at least two `true` values (the read allow and the secret deny both matched on arguments) and the substituted `_within` list of the read allow equals the caller's `read_roots` [U10].

Verify:
- [ ] The piped `jq -e '.effect=="deny" and ([.argsMatched[] | select(.==true)] | length) >= 2'` exits 0.

Proves: EX-02, FX-04, CL-11. Source: architect-spec.md EX-02.

### B6.5 Show where an effective value came from (happy)

Do: `adhd-policy resolve --attributes '{"role":"dev"}' | jq -c '{role: .attributes.role, max_refund: .attributes.max_refund, p_role: .provenance.role, p_max: .provenance.max_refund}'`

Expect: `{"role":"dev","max_refund":0,"p_role":"supplied","p_max":"project:<n>"}` where `project:<n>` is the id of the single `defaults` rule in the discovered file [U4].

Verify:
- [ ] The piped `jq -e '.p_role=="supplied" and (.p_max|startswith("project:"))'` exits 0.

Proves: EX-01, CL-10, RS-02, AT-04. Source: architect-spec.md EX-01, CL-10.

### B6.6 Draft a starter policy from a tool schema (happy)

Priya has a file-tool server she has never governed. She feeds its operation list to `draft` as plain data; the draft is a starting point to edit, never loaded by default.

Do:
```bash
cd "$DEMO" && cat > ops.json <<'EOF'
{"operations":[
  {"name":"read_file","args":[{"name":"path","type":"string","kind":"path","provenance":"inferred"}],"hints":{"readOnly":true}},
  {"name":"list_dir","args":[{"name":"path","type":"string","kind":"path","provenance":"inferred"}],"hints":{"readOnly":true}},
  {"name":"write_file","args":[{"name":"path","type":"string","kind":"path","provenance":"inferred"},{"name":"content","type":"string","kind":"text","provenance":"declared"}],"hints":{"destructive":true}}
 ],
 "options":{"source":"files"}}
EOF
adhd-policy draft --operations "$(jq -c .operations ops.json)" --options "$(jq -c .options ops.json)" > draft.json; echo "exit=$?"
jq -c '{version: .document.version, tools: [.document.permissions[].tool], inferred: (.inferred | length)}' draft.json
```
Expect: `exit=0`. The document has `version` 1 and permissions covering the three operations, split by class from the hints (the two read-only operations are one class, the destructive write another), plus a deny permission for secret-path patterns. Every inferred value is listed in `inferred`, each with a `path` and a `reason`; at least three entries, one per inferred `path` argument (SRC-08, SRC-11) [U11].

Verify:
- [ ] `jq -e '.document.version==1 and (.inferred|length)>=3 and all(.inferred[]; has("path") and has("reason"))' draft.json` exits 0.
- [ ] `jq -e '[.document.permissions[] | select(.effect=="deny")] | length >= 1' draft.json` exits 0.

Proves: SRC-08, SRC-11, CL-14. Source: architect-spec-sources.md SRC-11; interfaces-sources 4.

### B6.7 A draft is a valid starting file (happy)

Do: `mkdir -p "$DEMO/drafted" && cd "$DEMO/drafted" && jq -r '.document | tojson' ../draft.json | python3 -c 'import sys,yaml,json; print(yaml.safe_dump(json.load(sys.stdin)))' > workspace-policy.yaml && adhd-policy verify; echo "exit=$?"`

Expect: verification passes with no errors [U11]; `exit=0`. If the draft reads attributes, they are declared in it (PD-09).

Verify:
- [ ] The final `adhd-policy verify` exits 0.

Proves: SRC-11 ("the author reviews and edits it"), PD-09, CL-04. Source: architect-spec-sources.md SRC-11.

---

## Scenario 7. Wrap an unmodified MCP server in `.mcp.json`: `mcp-json` and `serve`

Priya's team already has an MCP server for notes. She does not edit the server or the host: she wraps its entry, and the unchanged host now talks through the policy. Everything is stdio; no policy server runs.

Source: VR-03, SV-14, WM-01 to WM-11, GW-01 to GW-06, GW-09, GW-17, GW-19, AK-03, PD-11, SRC-09, LP-06 to LP-08 (the Layer is loaded by `serve`).

### B7.0 A stub upstream, its policy and a tiny host-side client

Do:
```bash
mkdir -p "$DEMO/wrap" && cd "$DEMO/wrap"
cat > stub.js <<'EOF'
const fs = require('node:fs');
const log = process.argv[2];
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.0.1' } });
  if (m.method === 'tools/list') return reply({ tools: [
    { name: 'notes_add',     description: 'Append a note',      inputSchema: { type: 'object', properties: { text: { type: 'string' }, tag: { type: 'string' } }, required: ['text'] } },
    { name: 'notes_clear',   description: 'Delete all notes',   inputSchema: { type: 'object', properties: {} } },
    { name: 'notes_archive', description: 'Archive all notes',  inputSchema: { type: 'object', properties: {} } } ] });
  if (m.method === 'tools/call') {
    fs.appendFileSync(log, JSON.stringify({ name: m.params.name, args: m.params.arguments }) + '\n');
    return reply({ content: [{ type: 'text', text: 'ok' }] });
  }
});
EOF
cat > notes.yaml <<'EOF'
version: 1
attributes:
  role: name
permissions:
  - tool: notes_add
    context: { role: { _eq: writer } }
    set: { tag: policy }
  - tool: notes_archive
    effect: ask
    context: { role: { _eq: writer } }
EOF
cat > driver.mjs <<'EOF'
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const rpc = (id, method, params) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no response for id ${id}`)), 15000);
  waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const out = {};
out.init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
out.list    = await rpc(2, 'tools/list', {});
out.add     = await rpc(3, 'tools/call', { name: 'notes_add',     arguments: { text: 'hello', tag: 'mine' } });
out.clear   = await rpc(4, 'tools/call', { name: 'notes_clear',   arguments: {} });
out.archive = await rpc(5, 'tools/call', { name: 'notes_archive', arguments: {} });
child.stdin.end();
console.log(JSON.stringify(out));
child.kill();
EOF
echo '{"role":"writer"}' > attrs-writer.json
```
Expect: nothing runs. The stub is a stdio MCP server that appends every `tools/call` it receives to a log file, so what reached the upstream is observable independent of any response format. It speaks newline-delimited JSON-RPC [U12].

### B7.1 `mcp-json init` wraps the entry, once, reversibly (happy)

Do:
```bash
cat > .mcp.json <<EOF
{ "mcpServers": { "notes": { "command": "node", "args": ["$DEMO/wrap/stub.js", "$DEMO/wrap/stub.log"] } } }
EOF
cp .mcp.json original.mcp.json
adhd-policy mcp-json init --spec "$DEMO/wrap/notes.yaml"; echo "exit=$?"     # [U13]
jq -c '.mcpServers.notes | {command, first: .args[0]}' .mcp.json
cp .mcp.json after-init.json
adhd-policy mcp-json init --spec "$DEMO/wrap/notes.yaml"; cmp .mcp.json after-init.json && echo "not wrapped twice"
adhd-policy mcp-json init --undo; cmp .mcp.json original.mcp.json && echo "restored"
```
Expect: `exit=0`; the entry now reads `{"command":"adhd-policy","first":"serve"}` with the next argument `bin:node <DEMO>/wrap/stub.js <DEMO>/wrap/stub.log` and the spec path among the arguments [U13]; the second `init` leaves the file unchanged (`not wrapped twice`); `--undo` restores the original byte for byte (`restored`). A backup of the original was written by `init`. No process was started and the host and the server were not modified.

Verify:
- [ ] `jq -e '.mcpServers.notes.command=="adhd-policy" and .mcpServers.notes.args[0]=="serve"' after-init.json` exits 0.
- [ ] The run printed both `not wrapped twice` and `restored` (the second `init` left the file byte-identical, and `--undo` restored the original byte for byte).
- [ ] A backup file of the original exists next to `.mcp.json` [U13].

Proves: WM-01, WM-04, WM-05, WM-09, PD-11, PS-21 (round trip). Source: architect-spec-sources.md WM-01, WM-04, WM-05, WM-09.

### B7.2 Serve the wrapped entry as the host would (happy, edge, recovery of intent)

Do:
```bash
rm -f "$DEMO/wrap/stub.log" 2>/dev/null; : > "$DEMO/wrap/stub.log"
node driver.mjs adhd-policy serve "bin:node $DEMO/wrap/stub.js $DEMO/wrap/stub.log" --spec "$DEMO/wrap/notes.yaml" --adhd-attributes "@$DEMO/wrap/attrs-writer.json" > serve-out.json; echo "exit=$?"
jq -c '{tools: (.list.result.tools | map(.name)), add_error: (.add.error != null), clear: ((.clear.error != null) or (.clear.result.isError == true)), archive: ((.archive.error != null) or (.archive.result.isError == true))}' serve-out.json
cat stub.log
```
Expect: `exit=0`; the `tools/list` result includes `notes_add` with the upstream's name unchanged (GW-03) [U12 on whether denied tools are also listed]; `add_error` is `false`; the `clear` call (no permission matches) and the `archive` call (`ask`, nobody to answer) both come back as errors, with `permission_denied` in the serialized response [U12]. `stub.log` contains exactly one line, the allowed call, with the forced value: `{"name":"notes_add","args":{"text":"hello","tag":"policy"}}`. The caller sent `"tag":"mine"`; the policy's forced `tag` replaced it before the call was forwarded. The two refused calls never reached the upstream.

Verify:
- [ ] `[ "$(wc -l < stub.log | tr -d ' ')" = "1" ]` exits 0.
- [ ] `jq -e '.name=="notes_add" and .args.tag=="policy" and .args.text=="hello"' stub.log` exits 0.
- [ ] `grep -c -E 'notes_clear|notes_archive' stub.log` prints `0`.
- [ ] `jq -e '(.clear|tostring|test("permission_denied")) and (.archive|tostring|test("permission_denied"))' serve-out.json` exits 0.
- [ ] Negative control: serve the same stub directly (`node driver.mjs node stub.js stub.log`): `stub.log` then holds all three calls, proving the wrapper is what stopped two of them.

Proves: VR-03, SV-14, WM-02, WM-06, WM-08, GW-01, GW-03, GW-05, GW-06, GW-09, GW-17, AK-03, PM-08, LP-06 to LP-08, LP-10, FC-04. Source: architect-spec-sources.md GW-01 to GW-09, AK-03, WM-*; architect-spec-layer.md LP-06 to LP-10. The Layer is loaded by `serve`; its standalone use is [U15].

### B7.3 No attributes, no policy file: built-in default applies and says so (edge)

Do (run from a directory with no `workspace-policy.yaml` anywhere above it; `$DEMO` itself has one, so leave it):
```bash
OUT="$(cd "$(mktemp -d)" && pwd -P)"; cd "$OUT"
: > "$DEMO/wrap/stub.log"
node "$DEMO/wrap/driver.mjs" adhd-policy serve "bin:node $DEMO/wrap/stub.js $DEMO/wrap/stub.log" > serve-default.json 2> serve-default.err; echo "exit=$?"; cat serve-default.err
```

Expect: with no `--spec` argument and no `workspace-policy.yaml` found upward from `$OUT` (HOME is the throwaway, so no user-level default either) the wrapper runs under the built-in deny-by-default policy and says so once on stderr (WM-11, PD-03). Every call is refused; `stub.log` stays empty.

Verify:
- [ ] `test ! -s "$DEMO/wrap/stub.log"` exits 0.
- [ ] `test -s serve-default.err` exits 0.

Proves: WM-11, PD-02, PD-03, EV-06, GW-09, SC-05. Source: architect-spec-sources.md WM-11; architect-spec.md PD-02, EV-06. Whether the walk-up from a temporary directory outside the home directory behaves as assumed is [U5].

---

## Teardown

Close the throwaway shell (it holds the temporary `HOME`). Then remove the demo directory the shell printed with `echo "$DEMO"` using one deliberate command, `rm -r "$DEMO"`, from a new shell where `DEMO` is set to that path. Check: `test ! -e "$DEMO"` exits 0. Nothing outside `$DEMO` was written; confirm with `git status --porcelain` in the repo, which must be unchanged.

## Coverage map

| Spec group | Beats |
|---|---|
| SC-05, SC-06, CL-12, SV-13 | B1.1, B1.3, B7.3 |
| PM-01 to PM-11, FX-*, QE-05 | B1.2, B2.1 to B2.8, B6.2 |
| AT-04, AT-05, AT-09, AT-10 | B1.2, B2.5, B2.8, B3.5, B4.1 |
| LY-01 to LY-05, PD-05 to PD-07, PM-09 | B4.1, B6.2 |
| MG-01 to MG-11, NR-01 to NR-04, DL-01, FC-05 | B5.1 to B5.7 |
| CL-04 to CL-08, CL-10, CL-11, CL-13, CL-14 | B1.2 to B1.4, B4.1, B6.1 to B6.7 |
| EX-01, EX-02, EX-04 | B1.4, B4.1, B5.3, B6.4, B6.5 |
| SV-06, SV-08, IN-09, IN-10, FC-04 | B2.1 to B2.9, B3.3 |
| VR-02, VR-09, SV-20, SRC-07, LC-01, LC-04, GW-19 | B3.1 to B3.6 |
| VR-03, SV-14, WM-01 to WM-11, GW-01 to GW-09, AK-03, LP-06 to LP-10 | B7.1 to B7.3 |
| SRC-08, SRC-11 | B6.6, B6.7 |
| FC-01, FC-06, PD-12 | B1.2, B6.2, B6.3 |

Not covered (outside this demo's scope): sandbox (SB, SX, SP), agent-mcp integration (DP, PG), runtime providers and counters (RT-03, RT-07, RT-08, `runtime-unavailable` happy path), `remote:` sources, `.mcp.json` entries with a `url`, attribute authentication (SC-08), the HTTP and MCP projections of the policy operation set (VR-06, SV-04 parity), `createDecider` (SV-18) and the Layer's standalone use (LP-04).

---

## UNKNOWN list

Each item is behavior the specs do not fix. None is invented in the demo beyond the weakest assertion; each needs an owner decision or a read of the built code before the demo can be run as written.

| # | Unknown | Spec IDs | Where it bites |
|---|---|---|---|
| U1 | Flag spelling and nested-JSON input convention of the apigen-derived CLI (`--tool`, `--args '<json>'`, `--attributes '<json or @file>'`, `--parent`, `--request`, `--operations`, `--options`). Whether `Record<string, unknown>` and union inputs survive schema extraction at all. | SV-03, IF-12, 5.3 | every CLI beat |
| U2 | Rendering of results and errors: stdout JSON shape (bare decision or an envelope), stderr text of a `permission_denied`, and the format of the "policy source used" line each tool must print. | PD-03, SV-04, SV-08 | B2.*, B3.*, B7.3 |
| U3 | Signatures at the package root. The behavior spec says `compile(policyJson)`, `evaluate(policy, call, attributes?, runtime?)`; the interface file defines those as core functions and exports object-input operations (`evaluate({tool,args,attributes})`) from the root, while SV-16 closes `core` as an import path. The demo uses the positional core form with `compile(layers[])`. Also the exact export list at the root. | CL-01, CL-02, SV-01, SV-16, interfaces 4.1 and 5 | B1.*, B4.1 |
| U4 | Permission id format and base (`<layer>:<n>`; zero- or one-based) and exactly which ids `matched` carries when an allow and a deny both match. | CL-07, ICompiledPermission.id | B2.3, B6.5 |
| U5 | Policy discovery details for the operation commands: the name of the "flag" in PD-01 (only `run` and `serve` have `--spec`); on-disk paths of the global and local layers (D4 used `~/.config/policy/global.yaml`; the environment spec only says `files.global`/`files.local` under a `config` dir whose kind is unverified); how the walk-up treats a start directory outside the home directory (B7.3 depends on it). | PD-01, PD-05, EV-02, IF-03 | B2.*, B7.3 |
| U6 | The `bin:` fallback operation: the tool name the policy sees for `bin:touch` (`touch` assumed; SRC-09 also mentions `<source name>.<operation>`), whether `argv` includes the command, whether `cwd` is the absolute launch directory, and what `set` means for `{argv, cwd}`. | SV-20, SV-21, SRC-05, SRC-09, IF-16 | B3.* |
| U7 | `run` refusal exit code. SV-20 says "non-zero"; apigen's mapping would give 3 for `permission_denied`. The demo asserts only non-zero. Reason text on stderr is unspecified. | SV-20, IN-09 | B3.2 to B3.4 |
| U8 | `verify` report shape; whether it exits non-zero on errors; whether it reports all issues or stops at the first; JSON-path syntax; the issue code for a mistyped operator (`unknown-operator` vs `schema`) and whether the runtime read is reported as a warning with code `runtime-without-provider`; the exit code of an operation command when the discovered policy fails to load (FC-06 says the tool stops, not how). | CL-04, QE-05, RT-09, PD-12, FC-06 | B2.0, B6.1 to B6.3 |
| U9 | How a document declares a tool child-creating and how narrowing coverage (`narrowingCovered`) is computed. The demo assumes the D4 pattern: a deny permission reading `child.*`. Unspecified: whether `narrow` consults permissions or compares by attribute kind alone (NR-03), the value of `rule` in a denial, whether returned paths are normalized to real paths, whether the child includes the supplied `role`, whether unspecified attributes appear. | NR-02 to NR-04, MG-*, `INarrowOutcome` | B5.* |
| U10 | `explain`: whether `considered` lists permissions whose tool does not match, the order of entries, whether `substituted` holds normalized paths. | EX-02, `IExplanation` | B1.4, B6.4 |
| U11 | `draft` output: tool naming (`<source>.<operation>`), the effect given to the write class (allow, ask or deny), the default secret patterns, the `inferred` entry format, which attribute names the draft invents, and whether a draft always passes `verify`. | SRC-08, SRC-11, CL-14 | B6.6, B6.7 |
| U12 | `serve`: how `bin:` recognizes a stdio MCP server (SRC-05 classifies scripts, help text and an argv fallback, while WM-01 wraps `bin:<original command>` of MCP servers); the source name used when matching permissions (bare `notes_add` assumed); the shape of a refusal in the MCP response (JSON-RPC error or `isError`); whether denied tools are hidden from `tools/list`; stdin/stdout framing assumed to be newline-delimited JSON-RPC; whether `--adhd-attributes` placed after the source is recognized. | SRC-05, SRC-09, WM-01, WM-02, GW-03, GW-06, IF-S2 | B7.2, B7.3 |
| U13 | `mcp-json`: flags (how the spec path is passed), whether `--undo` is a flag of `init` or a separate verb, backup file name and location, and the exact `args` array of a wrapped entry (WM-01 shows `--spec <file>` as one list item). | WM-01, WM-04, PD-11 | B7.1 |
| U14 | Path and operator edge cases the demo avoids on purpose: `_within` over an empty root list (assumed false for a path; vacuously true for an empty list of paths), relative paths and their base, real path of a not-yet-existing file, implicit AND across keys (demo uses `_and`), `_is_null` presence tests. | FX-06, FX-07, FX-08, AT-12 | none (avoided) |
| U15 | The apigen policy Layer used alone (`apigen serve x.ts --use <policy layer> ...`): how the decider specifier and the `--spec` file reach the Layer, and whether the apigen CLI and MCP hosts deliver `--use` options and envelope fields. The Layer is exercised only indirectly through `run` and `serve`. | LP-04, LP-09, LP-O2, LI-01, OD-17 | not demonstrated |
| U16 | The packages and bins do not exist yet (BO-02 approval pending); names are placeholders (BO-05). Precedence among `--adhd-attributes`, `ADHD_POLICY_ATTRIBUTES` and the caller's argument is open (LC-01, EV-05); the demo uses only the flag. | BO-02, BO-05, LC-01, EV-05 | all |
| U17 | `check` collapsing `ask` to `permission_denied` is an interim rule (OD-16). B2.6 and B3.3 will change when apigen gains an approval-required result. | OD-16, SV-08, IN-09 | B2.6, B3.3 |
| U18 | Open decisions whose current default the demo exercises: `grant` and `only` on one attribute (OD-06), deny instead of clamp (OD-01), supplied-but-undeclared attributes ignored (OD-28, not exercised). | MG-06, MG-09, AT-11 | B5.2, B5.3 |

## Disclosure

No bugs found. The deferrals above are spec gaps recorded in this file (U1 to U18); none has been filed to the backlog graph yet.
