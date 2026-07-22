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
 *   node scripts/run-audit.js [--phase <phase>] [--criteria <file>]
 *
 *   --phase  ""   run all phases (the Python harness's empty-phase shape)
 *   --phase  X    run phase X + every phase ordered before it (accumulation)
 *   --criteria    path to the criteria file (default: scripts/criteria.json,
 *                 then <planDir>/criteria.json relative to cwd)
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
 * VENDORED & SELF-CONTAINED: the criteria model is inlined (no lib import) so the
 * copy that lands in `plan/scripts/` runs without the skill present (SPEC §4.2
 * portability). Node stdlib only.
 */

import fs from "node:fs";
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

function selectCriteria(criteria, phase) {
  const phases = accumulatedPhases(criteria, phase);
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

/** Run a shell command; return { code, out } with combined stdout+stderr. */
function runShell(cmd, cwd) {
  const r = spawnSync(cmd, { shell: true, cwd, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return { code: typeof r.status === "number" ? r.status : 1, out };
}

/**
 * Evaluate one criterion. Returns { pass: boolean }.
 * `captured` accumulates child stdout/stderr ONLY for the run log — it is never
 * scanned for `[id]` markers (SCOPE §4 #7).
 */
function evaluate(c, cwd, captured) {
  switch (c.kind) {
    case "absent":
      // pass iff NO path matches the pattern (the expect_empty case).
      return { pass: !grepMatches(c.pattern, c.paths, cwd) };
    case "present":
      return { pass: grepMatches(c.pattern, c.paths, cwd) };
    case "exists": {
      const full = path.isAbsolute(c.path) ? c.path : path.join(cwd, c.path);
      return { pass: fs.existsSync(full) };
    }
    case "command": {
      const { code, out } = runShell(c.cmd, cwd);
      captured.push(`# [${c.id}] command exit=${code}\n${out}`);
      const expect = c.expect ?? "exit0";
      if (expect === "marker") return { pass: out.includes(c.marker) };
      return { pass: code === 0 };
    }
    case "custom": {
      const args = Array.isArray(c.args) ? c.args : [];
      const r = spawnSync("node", [c.script, ...args], { cwd, encoding: "utf8" });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      captured.push(`# [${c.id}] custom ${c.script} exit=${r.status}\n${out}`);
      // custom stdout is NEVER parsed for markers; pass iff exit 0.
      return { pass: (typeof r.status === "number" ? r.status : 1) === 0 };
    }
    case "negative-control": {
      // positive→mutate→assert positive now FAILS→restore (always restore).
      let pass = false;
      try {
        runShell(c.mutate, cwd);
        const { code, out } = runShell(c.positive, cwd);
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
        runShell(c.restore, cwd);
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
 */
export function runCriteria(doc, { phase, cwd }) {
  const { criteria } = validateCriteriaDoc(doc);
  const selected = selectCriteria(criteria, phase);
  const lines = [];
  const captured = [];
  let failures = 0;
  for (const c of selected) {
    let pass;
    try {
      pass = evaluate(c, cwd, captured).pass;
    } catch (e) {
      captured.push(`# [${c.id}] evaluation error: ${e.message}`);
      pass = false;
    }
    if (!pass) failures += 1;
    lines.push(`[${c.id}] ${pass ? "PASS" : "FAIL"}`);
  }
  return { failures, total: selected.length, lines, captured };
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
    result = runCriteria(doc, { phase: phaseRaw, cwd });
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
