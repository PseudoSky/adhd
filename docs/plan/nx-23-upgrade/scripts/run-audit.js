#!/usr/bin/env node
/**
 * run-audit.js — shared, vendored declarative-criteria audit runner (SPEC §4.2).
 *
 * Replaces the per-plan, planner-authored `scripts/audit_<plan>.py`. Reads a
 * declarative `criteria.json`, runs each criterion per its `kind`, and emits the
 * exact `[id] PASS/FAIL` contract `parseAuditCriteria()` (state-transition.js:77)
 * scrapes. Emission is owned HERE so a plan can never fail to emit the contract
 * (the apigen `pass=0/0` drift class).
 *
 * Usage:
 *   node scripts/run-audit.js [--phase <phase>] [--no-accumulate] [--criteria <file>] [--repo-root <path>]
 *
 *   --phase       ""   run all phases (the Python harness's empty-phase shape)
 *   --phase       X    run phase X + every phase ordered before it (accumulation)
 *   --no-accumulate    run ONLY phase X (no prior-phase accumulation). Item 2a —
 *                      used by state-transition --complete for a non-audit,
 *                      non-terminal work node so it does not re-run prior phases.
 *   --criteria         path to the criteria file (default: scripts/criteria.json,
 *                      then <planDir>/criteria.json relative to cwd)
 *   --repo-root        explicit repo root (BL-96(1) opt-in, see below). Falls
 *                      back to `git rev-parse --show-toplevel` from cwd, then
 *                      to cwd itself, when omitted.
 *
 * BL-96(1) — cwd resolution is OPT-IN, never implicit (migration note):
 * The runner's own cwd is whatever the caller sets (state-transition.js runs it
 * with `cwd: planDir` so plan-relative paths — the common case — resolve
 * unqualified). A criterion authored with a REPO-ROOT-relative path (e.g.
 * `libs/foo/bar.ts` from a plan several directories deep) silently fails to
 * resolve against planDir cwd — that was BL-96's reported defect (4/128 checks
 * failed in one run). The declined `604d` inbox note explored unifying guard +
 * audit onto one shared cwd outright but was correctly declined: that requires
 * a path-relativity convention decision plus a live-plan migration sweep, and
 * flipping the DEFAULT cwd for every criterion in every in-flight plan risks
 * silently breaking correctly-authored plan-relative paths.
 *
 * Instead, resolution is explicit per-criterion and additive-only — a criterion
 * unsets `cwd` (the default) keeps running exactly as before (planDir/whatever
 * the caller's cwd is); an author who needs a repo-root-relative check opts in
 * with `"cwd": "repo-root"` (kinds `exists`/`present`/`absent`/`command`/
 * `custom`/`negative-control`), which resolves against `--repo-root` (or the
 * git toplevel autodetected from cwd when the flag is absent). Every
 * `command`/`custom`/`negative-control` child process ALSO always receives a
 * `REPO_ROOT` env var (regardless of the per-criterion `cwd` field) so a shell
 * command can `cd "$REPO_ROOT"` itself without a schema opt-in at all. Zero
 * live plan (grep across the repo, 2026-07-09) currently authors a
 * `criteria.json`, so this is a pure addition with no migration required for
 * any existing plan.
 *
 * Contract (SPEC §4.3):
 *   - one `[id] PASS/FAIL` per line, on its OWN line, flushed (pt 3);
 *   - exit == failure count, so exit 0 ⇔ all pass (pt 4);
 *   - FAIL-CLOSED: zero criteria selected/found → sentinel + NON-ZERO exit, never
 *     a silent exit 0 (the apigen regression class).
 *
 * SCOPE §4 #7 — marker channel isolation: `[id]` markers are emitted ONLY by this
 * runner to stdout. `command`/`custom` child output is captured but NEVER parsed
 * for markers, so noisy script output cannot inject a false PASS/FAIL.
 *
 * `negative-control` DETERMINISM: every leg runs with `NX_DAEMON=false` and a
 * per-control scratch `NX_CACHE_DIRECTORY` / `NX_WORKSPACE_DATA_DIRECTORY`, so a
 * mutated source is always observed rather than replayed from a daemon-served
 * stale hash (the intermittent daemon FALSE-PASS this closes). See
 * `negativeControlIsolationEnv`. Inert for non-nx commands.
 *
 * VENDORED & SELF-CONTAINED: the criteria model is inlined (no lib import) so the
 * copy that lands in `plan/scripts/` runs without the skill present (SPEC §4.2
 * portability). Node stdlib only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ── vendor stamp ───────────────────────────────────────────────────────────────
// The runner self-reports the skill identity it was vendored from by reading the
// `skill-version.json` copied alongside it at author time (the same stamp
// gen-skill-version.js writes; reused per Phase 3). gap-check compares this stamp
// against the installed skill to catch silent vendoring drift (SPEC §5/§7). A
// vendored runner with no adjacent stamp reports `unstamped` — gap-check fails it.
export function vendorStamp(scriptsDir) {
  const stampPath = path.join(scriptsDir, "skill-version.json");
  let skill = null;
  try {
    const m = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    if (m && m.plugin && m.version && m.hash) {
      skill = { plugin: m.plugin, version: m.version, hash: m.hash, id: m.id ?? `${m.plugin}@${m.version}+${m.hash}` };
    }
  } catch {}
  return { tool: "run-audit.js", schema_version: 1, skill };
}

/** The stamp for THIS runner instance (resolved from its own directory). */
export const VENDOR_STAMP = vendorStamp(path.dirname(new URL(import.meta.url).pathname));

// ── inlined criteria model (mirror of scripts/lib/criteria.js) ─────────────────

const KINDS = ["absent", "present", "exists", "command", "negative-control", "custom"];
const ID_RE = /^[a-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;
const REQUIRED_FIELDS = {
  absent: ["pattern", "paths"],
  present: ["pattern", "paths"],
  exists: ["path"],
  command: ["cmd"],
  "negative-control": ["positive", "mutate", "restore"],
  custom: ["script"],
};

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function normalizeCriterion(raw, index) {
  const where = raw && raw.id ? `criterion "${raw.id}"` : `criterion #${index}`;
  if (!raw || typeof raw !== "object") throw new Error(`criteria: ${where} is not an object`);
  if (!isNonEmptyString(raw.id) || !ID_RE.test(raw.id)) {
    throw new Error(`criteria: ${where} has an invalid id (must match slug.N)`);
  }
  if (!isNonEmptyString(raw.kind) || !KINDS.includes(raw.kind)) {
    throw new Error(`criteria: ${where} has invalid kind "${raw.kind}"`);
  }
  for (const f of REQUIRED_FIELDS[raw.kind]) {
    if (raw[f] === undefined || raw[f] === null) {
      throw new Error(`criteria: ${where} (kind ${raw.kind}) is missing required field "${f}"`);
    }
  }
  if (raw.kind === "command") {
    const expect = raw.expect ?? "exit0";
    if (expect !== "exit0" && expect !== "marker") {
      throw new Error(`criteria: ${where} command.expect must be "exit0" or "marker"`);
    }
    if (expect === "marker" && !isNonEmptyString(raw.marker)) {
      throw new Error(`criteria: ${where} command.expect "marker" requires a "marker"`);
    }
  }
  if ((raw.kind === "absent" || raw.kind === "present") && !Array.isArray(raw.paths)) {
    throw new Error(`criteria: ${where} (kind ${raw.kind}) "paths" must be an array`);
  }
  if (raw.kind === "custom" && raw.args !== undefined && !Array.isArray(raw.args)) {
    throw new Error(`criteria: ${where} (kind custom) "args" must be an array`);
  }
  // BL-96(1) — optional, additive-only cwd-resolution opt-in. Unset (default)
  // keeps the criterion resolving against the runner's own cwd (unchanged
  // behavior for every existing plan). "repo-root" opts a single criterion
  // into resolving against --repo-root instead — see module header.
  if (raw.cwd !== undefined && raw.cwd !== "plan" && raw.cwd !== "repo-root") {
    throw new Error(`criteria: ${where} "cwd" must be "plan" or "repo-root" when present`);
  }
  return { id: raw.id, phase: raw.phase ?? null, tier: typeof raw.tier === "number" ? raw.tier : null, kind: raw.kind, ...raw };
}

function validateCriteriaDoc(doc) {
  if (!doc || typeof doc !== "object") throw new Error("criteria: document is not an object");
  const list = Array.isArray(doc.criteria) ? doc.criteria : null;
  if (!list) throw new Error('criteria: document is missing a "criteria" array');
  const criteria = list.map((c, i) => normalizeCriterion(c, i));
  const seen = new Set();
  for (const c of criteria) {
    if (seen.has(c.id)) throw new Error(`criteria: duplicate id "${c.id}"`);
    seen.add(c.id);
  }
  return { schema_version: doc.schema_version ?? 1, criteria };
}

function phaseOrder(criteria) {
  const order = [];
  const seen = new Set();
  for (const c of criteria) {
    if (c.phase == null) continue;
    if (!seen.has(c.phase)) {
      seen.add(c.phase);
      order.push(c.phase);
    }
  }
  return order;
}

function accumulatedPhases(criteria, phase) {
  const order = phaseOrder(criteria);
  if (phase === undefined || phase === null || phase === "") return new Set(order);
  const idx = order.indexOf(phase);
  if (idx === -1) {
    throw new Error(`criteria: --phase "${phase}" is not a declared phase (have: ${order.join(", ") || "<none>"})`);
  }
  return new Set(order.slice(0, idx + 1));
}

/**
 * Select the criteria to run for a `--phase` value.
 *
 * `accumulate` (default true) preserves the historical behavior: the selected
 * phase plus every phase ordered before it (SPEC §4.2). Item 2a adds
 * `--no-accumulate`, which selects ONLY the named phase — used by
 * `state-transition.js --complete` for a non-audit, non-terminal work node so
 * completing it does not re-run every prior phase's criteria. An empty/absent
 * phase still means "all phases" in either mode (the Python harness's
 * `--phase ""` shape). A criterion with a null phase always runs.
 */
function selectCriteria(criteria, phase, accumulate = true) {
  const phases = accumulate
    ? accumulatedPhases(criteria, phase)
    : new Set(phase ? [phase] : phaseOrder(criteria));
  return criteria.filter((c) => c.phase == null || phases.has(c.phase));
}

// ── per-kind execution ─────────────────────────────────────────────────────────

/** Read a file, returning "" if it cannot be read (missing file = no match). */
function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** True iff `pattern` (a JS regex source) matches any line of any of `paths`. */
function grepMatches(pattern, paths, cwd) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid pattern /${pattern}/: ${e.message}`);
  }
  for (const p of paths) {
    const full = path.isAbsolute(p) ? p : path.join(cwd, p);
    const text = readFileSafe(full);
    if (re.test(text)) return true;
  }
  return false;
}

/** Run a shell command; return { code, out } with combined stdout+stderr.
 *  `env` (optional) is merged over process.env for the child — used to expose
 *  REPO_ROOT (BL-96(1)) without changing the child's cwd. */
function runShell(cmd, cwd, env) {
  const r = spawnSync(cmd, { shell: true, cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return { code: typeof r.status === "number" ? r.status : 1, out };
}

/**
 * Scratch isolation env for a `negative-control` evaluation.
 *
 * A negative control is mutate → assert the positive now FAILS → restore. When
 * the positive is a build (the common nx case), a live daemon can serve a STALE
 * file hash for the just-mutated source, so nx computes "inputs unchanged" and
 * replays the pre-mutation cached success — the positive exits 0 under the
 * mutation and the control's must-fail leg never fires. That is an intermittent
 * FALSE PASS: the same control passed at 18:16 and 20:15 and failed at 21:36 on
 * one machine, so a fresh re-run is not proof of determinism.
 *
 * `NX_DAEMON=false` forces a fresh, daemonless file hash; a scratch
 * `NX_CACHE_DIRECTORY` + `NX_WORKSPACE_DATA_DIRECTORY` (under the caller's
 * mktemp root) guarantees there is no cached task result or project-graph hash
 * to replay. Together the mutation is always observed. The vars are inert for
 * non-nx commands, so the same isolation is applied to every leg of the control
 * (mutate, positive, restore) — keeping the whole control hermetic rather than
 * only the post-mutate leg is the deliberate, deterministic choice.
 *
 * Pure (no fs side effects) so a test can assert the exact constructed env.
 * `scratchDir` is created by the caller via `fs.mkdtempSync` (the Node-stdlib
 * mktemp); the subdirs are created by nx on demand.
 */
export function negativeControlIsolationEnv(scratchDir) {
  return {
    NX_DAEMON: "false",
    NX_CACHE_DIRECTORY: path.join(scratchDir, "cache"),
    NX_WORKSPACE_DATA_DIRECTORY: path.join(scratchDir, "workspace-data"),
  };
}

/**
 * BL-96(1) — resolve the base directory a criterion's paths/spawn-cwd resolve
 * against. Default ("plan", i.e. `c.cwd` unset) is the runner's own cwd —
 * byte-identical to pre-BL-96 behavior. A criterion that opts in with
 * `"cwd": "repo-root"` resolves against `repoRoot` instead, falling back to
 * `cwd` itself when no repo root could be determined (never throws — a
 * criterion missing a resolvable repo root degrades to the old behavior
 * rather than crashing the whole audit run).
 */
function resolveBase(c, cwd, repoRoot) {
  return c.cwd === "repo-root" && repoRoot ? repoRoot : cwd;
}

/**
 * Evaluate one criterion. Returns { pass: boolean }.
 * `captured` accumulates child stdout/stderr ONLY for the run log — it is never
 * scanned for `[id]` markers (SCOPE §4 #7).
 *
 * `cmdCache` (Item 2c) memoizes `command`-kind executions within a single
 * `runCriteria` run, keyed `${cmd}\u0000${base}`. Several criteria frequently
 * share one expensive command (e.g. a build/test invocation asserted on in
 * multiple ways); running it once per run is enough and the result is identical
 * because the key pins both the command and its resolved cwd. `negative-control`
 * (deliberately stateful: mutate → assert → restore) and `custom` are NEVER
 * memoized — only the pure `command` kind is.
 */
function evaluate(c, cwd, captured, repoRoot, cmdCache) {
  const base = resolveBase(c, cwd, repoRoot);
  // Always exposed to command/custom/negative-control children, independent of
  // the per-criterion cwd opt-in — lets a shell command `cd "$REPO_ROOT"` on
  // its own without touching the schema (BL-96(1)).
  const childEnv = { REPO_ROOT: repoRoot || cwd };
  switch (c.kind) {
    case "absent":
      // pass iff NO path matches the pattern (the expect_empty case).
      return { pass: !grepMatches(c.pattern, c.paths, base) };
    case "present":
      return { pass: grepMatches(c.pattern, c.paths, base) };
    case "exists": {
      const full = path.isAbsolute(c.path) ? c.path : path.join(base, c.path);
      return { pass: fs.existsSync(full) };
    }
    case "command": {
      const key = `${c.cmd}\u0000${base}`;
      let result = cmdCache ? cmdCache.get(key) : undefined;
      if (result) {
        captured.push(`# [${c.id}] command exit=${result.code} (memoized — same cmd+cwd)\n${result.out}`);
      } else {
        result = runShell(c.cmd, base, childEnv);
        if (cmdCache) cmdCache.set(key, result);
        captured.push(`# [${c.id}] command exit=${result.code}\n${result.out}`);
      }
      const expect = c.expect ?? "exit0";
      if (expect === "marker") return { pass: result.out.includes(c.marker) };
      return { pass: result.code === 0 };
    }
    case "custom": {
      const args = Array.isArray(c.args) ? c.args : [];
      const r = spawnSync("node", [c.script, ...args], { cwd: base, encoding: "utf8", env: { ...process.env, ...childEnv } });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      captured.push(`# [${c.id}] custom ${c.script} exit=${r.status}\n${out}`);
      // custom stdout is NEVER parsed for markers; pass iff exit 0.
      return { pass: (typeof r.status === "number" ? r.status : 1) === 0 };
    }
    case "negative-control": {
      // positive→mutate→assert positive now FAILS→restore (always restore).
      //
      // Determinism (the daemon stale-hash FALSE-PASS fix): every leg runs with
      // the nx daemon disabled and a scratch cache/workspace-data dir, so a
      // mutated source is ALWAYS observed instead of being replayed from a
      // daemon-served stale hash (see negativeControlIsolationEnv). A
      // mktemp-style scratch root (`fs.mkdtempSync` — Node's mktemp, no shell
      // dependency) is created per control and removed in `finally`, so a
      // failing run still cleans up.
      let pass = false;
      let scratch = null;
      try {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), "run-audit-nc-"));
        const ncEnv = { ...childEnv, ...negativeControlIsolationEnv(scratch) };
        runShell(c.mutate, base, ncEnv);
        const { code, out } = runShell(c.positive, base, ncEnv);
        captured.push(`# [${c.id}] neg-control positive-under-mutation exit=${code}\n${out}`);
        const expect = c.expect ?? "exit0";
        // The positive check must now FAIL: for exit0 that means non-zero;
        // for marker that means the marker is absent.
        const positiveNowPasses = expect === "marker" ? out.includes(c.marker) : code === 0;
        pass = !positiveNowPasses;
      } catch (e) {
        captured.push(`# [${c.id}] neg-control error: ${e.message}`);
        pass = false;
      } finally {
        // Restore under the SAME isolation so the whole control is hermetic
        // (and, if scratch creation failed, still restore in the ambient env).
        runShell(
          c.restore,
          base,
          scratch ? { ...childEnv, ...negativeControlIsolationEnv(scratch) } : childEnv,
        );
        if (scratch) {
          try {
            fs.rmSync(scratch, { recursive: true, force: true });
          } catch {}
        }
      }
      return { pass };
    }
    default:
      return { pass: false };
  }
}

// ── runner core ────────────────────────────────────────────────────────────────

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function resolveCriteriaFile(args, cwd) {
  const explicit = argValue(args, "--criteria");
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(cwd, explicit);
  for (const cand of [path.join(cwd, "scripts", "criteria.json"), path.join(cwd, "criteria.json")]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Run the audit. Returns { failures, total, lines } where `lines` are the emitted
 * `[id] PASS/FAIL` strings (one per criterion). Pure-ish: it does spawn child
 * processes per kind, but does not write stdout — the caller flushes lines so
 * tests can both capture and assert the failure count directly.
 *
 * `repoRoot` (BL-96(1), optional) is threaded to each criterion's evaluation —
 * only criteria that opt in with `"cwd": "repo-root"` are affected; every
 * command/custom/negative-control child also gets it as `$REPO_ROOT` regardless.
 *
 * `accumulate` (Item 2a, default true) is forwarded to `selectCriteria` — false
 * selects only the named phase. `cmdCache` (Item 2c) memoizes repeated
 * `command`-kind executions across this single run.
 */
export function runCriteria(doc, { phase, cwd, repoRoot, accumulate = true }) {
  const { criteria } = validateCriteriaDoc(doc);
  const selected = selectCriteria(criteria, phase, accumulate);
  const lines = [];
  const captured = [];
  const cmdCache = new Map();
  let failures = 0;
  for (const c of selected) {
    let pass;
    try {
      pass = evaluate(c, cwd, captured, repoRoot, cmdCache).pass;
    } catch (e) {
      captured.push(`# [${c.id}] evaluation error: ${e.message}`);
      pass = false;
    }
    if (!pass) failures += 1;
    lines.push(`[${c.id}] ${pass ? "PASS" : "FAIL"}`);
  }
  return { failures, total: selected.length, lines, captured };
}

/**
 * BL-96(1) — resolve the repo root for the "cwd": "repo-root" opt-in. Explicit
 * `--repo-root` wins; otherwise autodetect via `git rev-parse --show-toplevel`
 * from `cwd` (best-effort — a non-repo cwd or missing git yields null, which
 * `resolveBase` treats as "no opt-in available", degrading to unchanged
 * behavior rather than throwing).
 */
function resolveRepoRoot(args, cwd) {
  const explicit = argValue(args, "--repo-root");
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(cwd, explicit);
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const out = (r.stdout || "").trim();
  return typeof r.status === "number" && r.status === 0 && out ? out : null;
}

function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // Self-report the vendor stamp (used by gap-check / tooling, never gates).
  if (args.includes("--print-stamp")) {
    process.stdout.write(`${JSON.stringify(VENDOR_STAMP)}\n`);
    process.exit(0);
  }
  // --phase passthrough: an empty value means "all phases" (SPEC §4.3 pt 2).
  // argValue returns null when the flag is absent → treat as all phases too.
  const phaseRaw = args.includes("--phase") ? (argValue(args, "--phase") ?? "") : "";
  // Item 2a — --no-accumulate selects ONLY the named phase (no prior-phase
  // accumulation). Default (absent) keeps the historical accumulated selection.
  const accumulate = !args.includes("--no-accumulate");
  const repoRoot = resolveRepoRoot(args, cwd);

  const criteriaFile = resolveCriteriaFile(args, cwd);
  if (!criteriaFile) {
    // FAIL-CLOSED: no criteria file at all is the apigen pass=0/0 class.
    process.stdout.write("[audit.no-criteria] FAIL\n");
    process.stderr.write("run-audit: no criteria file found (looked for scripts/criteria.json, criteria.json)\n");
    process.exit(1);
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(criteriaFile, "utf8"));
  } catch (e) {
    process.stdout.write("[audit.bad-criteria] FAIL\n");
    process.stderr.write(`run-audit: could not parse ${criteriaFile}: ${e.message}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = runCriteria(doc, { phase: phaseRaw, cwd, repoRoot, accumulate });
  } catch (e) {
    process.stdout.write("[audit.bad-criteria] FAIL\n");
    process.stderr.write(`run-audit: ${e.message}\n`);
    process.exit(1);
  }

  // FAIL-CLOSED on zero selected criteria (SPEC §4.3 pt 4): a phase that selects
  // nothing must not exit 0 and read as "all pass".
  if (result.total === 0) {
    process.stdout.write("[audit.no-criteria] FAIL\n");
    process.stderr.write(`run-audit: zero criteria selected for --phase "${phaseRaw}"\n`);
    process.exit(1);
  }

  // Emit one marker per line, flushed (own-line; SPEC §4.3 pt 3).
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  // Captured child output goes to stderr in a fenced block — never parsed for
  // markers, but available for debugging (SCOPE §4 #7).
  if (result.captured.length) {
    process.stderr.write(`\n--- run-audit captured output (not parsed) ---\n${result.captured.join("\n")}\n`);
  }

  process.exit(result.failures);
}

// Direct-run guard. Resolve symlinks on BOTH sides: Node resolves symlinks for
// import.meta.url, but `process.argv[1]` keeps the literal (often unresolved) path.
// On macOS a temp dir under /var/folders is a symlink to /private/var/folders, so a
// raw path.resolve compare FAILS for an absolute-path invocation and main() never
// runs (silent no-op). realpathSync both sides makes the guard invocation-robust.
function isDirectRun() {
  if (!process.argv[1]) return false;
  const self = new URL(import.meta.url).pathname;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
}

if (isDirectRun()) {
  main();
}
