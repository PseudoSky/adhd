#!/usr/bin/env node
/**
 * gap-check.js — deterministic gap review for a state-machine plan directory.
 *
 * Validates the mechanical checks of Step 6 (deep gap review) so an author
 * never ships a plan with a machine-detectable hole. Node standard library
 * only — no npm dependencies.
 *
 * Usage:
 *   node scripts/gap-check.js <plan-dir> [--discover]
 *
 * <plan-dir> is a directory laid out per the plan-state-machine skill:
 *   <plan-dir>/README.md              (Definition of Done lives here)
 *   <plan-dir>/dag.json
 *   <plan-dir>/state.json
 *   <plan-dir>/references.json        (optional)
 *   <plan-dir>/final-review.md        (filled Step-7 checklist)
 *   <plan-dir>/contexts/<slug>.md
 *   <plan-dir>/scripts/audit_*.py     (audit scripts)
 *
 * Checks (each independent; all run, all reported):
 *   1. slug-set identity   — keys(dag.nodes) === keys(state.states)
 *   2. artifacts ↔ mutates — each node's artifacts === the mutates set parsed
 *                            from that node's context file (warning, not failure,
 *                            when the context Reservations block is unparseable)
 *   3. criterion/audit IDs — every [<slug>.<n>] criterion in a context file has a
 *                            matching check ID in some audit script
 *   4. dependency integrity— every depends_on resolves to a real slug; graph acyclic
 *   5. null gaps           — any required field null/empty in dag.json, state.json,
 *                            or references.json is a blocking gap
 *   6. references shape    — references.json must be a FLAT slug-keyed object;
 *                            a wrapper key (schema_version/refs/version) is rejected
 *   7. reference ↔ audit   — every reference declares an audit_check whose ID exists
 *                            in some audit script (no idiom ships unverified)
 *   8. Definition of Done  — README has a `## Definition of Done` with [dod.N] clauses,
 *                            every [dod.N] is proven by a final-audit check, and
 *                            every BEHAVIORAL clause (a runtime interaction) declares
 *                            an `entrypoint:`/`observable:` and is proven by a check
 *                            that DRIVES that entrypoint — not a grep/test -e proxy.
 *                            Fidelity: the programmatic step must mirror the exact
 *                            interaction the requester asked to see work.
 *   9. final-review gate   — final-review.md exists with no unticked boxes
 *  10. discovery (opt-in,  — with --discover, every symbol in a node's `changes` block
 *      --discover)           is resolved through a tiered caller oracle
 *                            (gitnexus when index==working-tree HEAD → LSP via
 *                            $PSM_LSP_CMD → scoped grep) and each caller location
 *                            must be accounted for in mutates/read_only. The grep
 *                            tier is scoped to real source roots and excludes
 *                            docs/prose (no false positives from documentation).
 *
 * Exit code 0 when clean (warnings allowed). Non-zero = number of failures.
 * Each failure line names the offending file and what is wrong.
 *
 * NOTE: this script verifies MECHANICAL gaps only. The judgment review
 * (references/gap-review.md) and — unless --discover ran clean — the Step-0
 * caller mapping are NOT discharged by a green exit here.
 */

import fs from "node:fs";
import path from "node:path";
import {
  gitnexusStatus,
  selectOracle,
  resolveCallers,
} from "./lib/caller-oracle.js";

const failures = [];
const warnings = [];

function fail(file, msg) {
  failures.push(`FAIL ${file}: ${msg}`);
}
function warn(file, msg) {
  warnings.push(`WARN ${file}: ${msg}`);
}

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function readJsonOrNull(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    fail(file, `not valid JSON: ${e.message}`);
    return undefined; // distinguishes "present but broken" from "absent"
  }
}

/**
 * Parse the `mutates:` array out of a context markdown's Reservations block.
 * Returns { ok: true, mutates: [...] } or { ok: false } when the block is not
 * machine-parseable. The block shape (per work-state.template.md):
 *
 *   ```text
 *   read_only:  ["a", "b"]
 *   mutates:    ["c",
 *                "d"]
 *   ```
 */
function parseMutates(mdText) {
  // Grab the fenced block immediately after a `## Reservations` heading.
  const resHeading = mdText.search(/^##\s+Reservations\s*$/m);
  if (resHeading === -1) return { ok: false };
  const after = mdText.slice(resHeading);
  const fence = after.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!fence) return { ok: false };
  const block = fence[1];

  // Find `mutates:` and capture everything up to the next top-level key
  // (read_only:, **Merge, or end of block).
  const mIdx = block.search(/(^|\n)\s*mutates\s*:/);
  if (mIdx === -1) return { ok: false };
  let tail = block.slice(mIdx).replace(/(^|\n)\s*mutates\s*:/, "");
  // Cut at the next recognised key so a following read_only: doesn't bleed in.
  const stop = tail.search(/\n\s*(read_only\s*:|\*\*)/);
  if (stop !== -1) tail = tail.slice(0, stop);

  // Extract quoted string literals — the file paths.
  const files = [];
  const re = /["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(tail)) !== null) files.push(m[1]);
  if (files.length === 0) {
    // mutates present but no quoted entries — could be an empty `[]`.
    if (/\[\s*\]/.test(tail)) return { ok: true, mutates: [] };
    return { ok: false };
  }
  return { ok: true, mutates: files };
}

/** Collect criterion IDs [<slug>.<token>] from arbitrary text. */
function collectCriterionIds(text) {
  const ids = new Set();
  const re = /\[([a-z0-9-]+\.[A-Za-z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  return ids;
}

/** Collect check IDs referenced anywhere in audit script text. */
function collectAuditIds(text) {
  const ids = new Set();
  // check("slug.n", ...) or check('slug.n', ...)
  const reCall = /check\(\s*["']([A-Za-z0-9_.-]+)["']/g;
  let m;
  while ((m = reCall.exec(text)) !== null) ids.add(m[1]);
  // Bare [slug.n] tokens in comments/docstrings.
  for (const id of collectCriterionIds(text)) ids.add(id);
  return ids;
}

// ── Check 8 (DoD fidelity) helpers ──────────────────────────────────────────
//
// A DoD clause is *confirmed by executing the interaction the human described*,
// never by a proxy. These helpers let Check 8 bind each behavioral [dod.N] to a
// proving check that actually DRIVES the clause's declared `entrypoint` — so a
// grep/`test -e` that merely correlates with the behavior is rejected.

/**
 * Read every `check("id", "desc", "cmd", ...)` call across audit text and return
 * a Map<checkId, cmd[]>. The cmd is the third positional argument; Python triple-
 * quoted, escaped, and adjacent-concatenated string literals are all handled, so
 * a multi-line audit command is captured intact.
 */
function collectCheckCmds(text) {
  const map = new Map();
  const re = /check\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1; // index of '('
    const parsed = readCallArgs(text, open);
    if (!parsed) continue;
    re.lastIndex = parsed.end; // resume after this call
    const id = stringLiteralValue(parsed.args[0] || "");
    if (!id) continue;
    const cmd = parsed.args.length >= 3 ? stringLiteralValue(parsed.args[2]) : "";
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(cmd);
  }
  return map;
}

/** Walk from a `(` to its matching `)`, splitting top-level commas. String-aware
 *  (handles ' " ''' """ and backslash escapes) so commas/parens inside a command
 *  string are not treated as argument boundaries. */
function readCallArgs(text, openIdx) {
  let i = openIdx + 1, depth = 1, cur = "", str = null;
  const args = [];
  while (i < text.length) {
    const ch = text[i];
    if (str) {
      if (str.length === 3) {
        if (text.startsWith(str, i)) { cur += str; i += 3; str = null; continue; }
        cur += ch; i++; continue;
      }
      if (ch === "\\") { cur += ch + (text[i + 1] ?? ""); i += 2; continue; }
      if (ch === str) { cur += ch; i++; str = null; continue; }
      cur += ch; i++; continue;
    }
    if (text.startsWith("'''", i) || text.startsWith('"""', i)) {
      str = text.slice(i, i + 3); cur += str; i += 3; continue;
    }
    if (ch === "'" || ch === '"') { str = ch; cur += ch; i++; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; cur += ch; i++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) { args.push(cur); return { args: args.map((s) => s.trim()), end: i + 1 }; }
      cur += ch; i++; continue;
    }
    if (ch === "," && depth === 1) { args.push(cur); cur = ""; i++; continue; }
    cur += ch; i++;
  }
  return null; // unbalanced — ignore this call
}

/** Concatenate the content of all Python string literals in an argument source
 *  (drops f/r/b prefixes, joins adjacency), returning the runtime command text. */
function stringLiteralValue(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const tm = src.slice(i).match(/^[a-zA-Z]{0,2}('''|"""|'|")/);
    if (!tm) { i++; continue; }
    const delim = tm[1];
    let j = i + tm[0].length;
    if (delim.length === 3) {
      const close = src.indexOf(delim, j);
      if (close === -1) { out += src.slice(j); break; }
      out += src.slice(j, close); i = close + 3;
    } else {
      let buf = "";
      while (j < src.length) {
        if (src[j] === "\\") { buf += src[j + 1] ?? ""; j += 2; continue; }
        if (src[j] === delim) { j++; break; }
        buf += src[j]; j++;
      }
      out += buf; i = j;
    }
  }
  return out;
}

/**
 * Parse the README `## Definition of Done` section into structured clauses:
 *   { id, text, entrypoint, observable }
 * A clause line carries `[dod.N]`; the optional `entrypoint:` / `observable:`
 * fields live on indented sub-bullets beneath it (verbatim human interaction +
 * the result the human looks for).
 */
function parseDodClauses(readme) {
  const secIdx = readme.search(/^##\s+Definition of Done\s*$/m);
  if (secIdx === -1) return [];
  let body = readme.slice(secIdx);
  const nextHeading = body.slice(1).search(/\n##\s+/);
  if (nextHeading !== -1) body = body.slice(0, nextHeading + 1);
  const clauses = [];
  let cur = null;
  for (const ln of body.split("\n")) {
    const idm = ln.match(/\[(dod\.[A-Za-z0-9_-]+)\]/);
    const isTopBullet = /^\s{0,3}[-*]\s/.test(ln);
    if (idm && isTopBullet) {
      if (cur) clauses.push(cur);
      cur = { id: idm[1], text: ln, entrypoint: null, observable: null };
      continue;
    }
    if (!cur) continue;
    const epm = ln.match(/entrypoint\s*:\s*(.+)$/i);
    const obm = ln.match(/observable\s*:\s*(.+)$/i);
    if (epm) cur.entrypoint = stripInlineMarkup(epm[1]);
    if (obm) cur.observable = stripInlineMarkup(obm[1]);
  }
  if (cur) clauses.push(cur);
  return clauses;
}

function stripInlineMarkup(s) {
  return String(s).replace(/[`*]/g, "").trim();
}

// A clause is BEHAVIORAL when it asserts a runtime interaction (a door a user or
// agent walks through). Structural clauses ("X is gone", "Y exists", "conforms
// to Z") are legitimately proven by grep/AST and are left to the ID-match rule.
const BEHAVIORAL_VERBS =
  /\b(install(s|ed|ing)?|runs?|ran|works?|working|can|enables?|starts?|serves?|serving|renders?|responds?|executes?|exec|dispatch(es)?|produces?|generates?|loads?|displays?|accepts?|returns?|boots?|invokes?|connects?|emits?|opens?|sends?|receives?|navigates?|clicks?|uploads?|downloads?)\b/i;
function isBehavioral(text) {
  return BEHAVIORAL_VERBS.test(text);
}

// A command that is nothing but a structural probe (string/file presence) or a
// no-op proves nothing about an interaction.
const STRUCTURAL_PROBE =
  /^(grep|rg|egrep|fgrep|ls|find|cat|head|tail|wc|stat|test\s+-[edfsLhr]|\[\s+-[edfsLhr])\b/;
function isStructuralOnly(cmd) {
  const segs = String(cmd).split(/\|\||&&|;|\|/).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return true;
  return segs.every((s) => STRUCTURAL_PROBE.test(s) || /^(true|:)\b/.test(s));
}

/** The most specific token of an entrypoint — a path/route/script the proving
 *  command must contain to prove it drove the same door, not a proxy. */
function distinctiveToken(ep) {
  const toks = String(ep).replace(/[`'"]/g, "").trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
  if (toks.length === 0) return String(ep).replace(/[`'"]/g, "").trim();
  let best = toks[0], bestScore = -1;
  for (const t of toks) {
    let score = t.length;
    if (t.includes("/")) score += 100;
    if (t.includes(".")) score += 40;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

function normCmd(s) {
  return String(s).replace(/[`'"]/g, "").replace(/\s+/g, " ").trim();
}

// Only flag a token that is clearly a TEST file/dir — the door rule nudges
// "a behavioral proof should be a declared test artifact". A production CLI
// entrypoint (bin/install.js) is NOT a test path and must not be flagged.
function looksLikeTestPath(tok) {
  return /(^|\/)(tests?|spec|e2e|__tests__)\//.test(tok) || /\.(spec|test)\.[a-z]+$/.test(tok) || /(^|\/)test_[^/]+\.py$/.test(tok);
}

// ── Check 4 helper: cycle detection over a slug → depends_on adjacency. ──
function findCycle(adj) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const k of adj.keys()) color.set(k, WHITE);
  const stack = [];

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of adj.get(node) || []) {
      if (!adj.has(dep)) continue; // dangling edges handled separately
      if (color.get(dep) === GRAY) {
        const start = stack.indexOf(dep);
        return stack.slice(start).concat(dep);
      }
      if (color.get(dep) === WHITE) {
        const c = dfs(dep);
        if (c) return c;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      const c = dfs(node);
      if (c) return c;
    }
  }
  return null;
}

/** Strip a leading "./" so grep/GitNexus paths compare equal to declared ones. */
function normPath(p) {
  return String(p).replace(/^\.\//, "").trim();
}

/**
 * Extract the quoted file list for a named key inside the `## Reservations`
 * fenced block (e.g. "read_only"). Returns an array, or null if not parseable.
 */
function parseReservationKey(mdText, key) {
  const resHeading = mdText.search(/^##\s+Reservations\s*$/m);
  if (resHeading === -1) return null;
  const after = mdText.slice(resHeading);
  const fence = after.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!fence) return null;
  const block = fence[1];
  const kRe = new RegExp(`(^|\\n)\\s*${key}\\s*:`);
  const kIdx = block.search(kRe);
  if (kIdx === -1) return null;
  let tail = block.slice(kIdx).replace(kRe, "");
  const stop = tail.search(/\n\s*(read_only\s*:|mutates\s*:|\*\*)/);
  if (stop !== -1) tail = tail.slice(0, stop);
  const files = [];
  const re = /["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(tail)) !== null) files.push(m[1]);
  return files;
}

// Caller-discovery oracle (gitnexus → LSP → grep tiering) lives in
// ./lib/caller-oracle.js. gap-check.js consumes gitnexusStatus / selectOracle /
// resolveCallers from there; the grep tier is scoped to real source roots and
// excludes docs/prose so a symbol mentioned in documentation is never mistaken
// for a caller.

function main() {
  const args = process.argv.slice(2);
  const discover = args.includes("--discover");
  // --dag-only: shift-left pre-flight. Run only the structural checks (slug-set
  // identity, dependency integrity, null-gaps on dag.json/state.json) and skip
  // every check that needs context/audit/references files, so the DAG topology
  // can be validated before those files are authored. Additive; default off.
  const dagOnly = args.includes("--dag-only");
  const planDir = args.find((a) => !a.startsWith("--"));
  if (!planDir) {
    process.stderr.write("usage: node scripts/gap-check.js <plan-dir> [--discover] [--dag-only]\n");
    process.exit(2);
  }
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${planDir}\n`);
    process.exit(2);
  }

  const dagPath = path.join(planDir, "dag.json");
  const statePath = path.join(planDir, "state.json");
  const refsPath = path.join(planDir, "references.json");
  const contextsDir = path.join(planDir, "contexts");
  const scriptsDir = path.join(planDir, "scripts");

  const dag = readJsonOrNull(dagPath);
  const state = readJsonOrNull(statePath);
  const refs = readJsonOrNull(refsPath); // null if absent (optional)

  if (dag === null) fail(dagPath, "missing — every plan must have a dag.json");
  if (state === null) fail(statePath, "missing — every plan must have a state.json");

  const dagOk = dag && typeof dag === "object";
  const stateOk = state && typeof state === "object";

  const nodes = dagOk && dag.nodes && typeof dag.nodes === "object" ? dag.nodes : {};
  const states = stateOk && state.states && typeof state.states === "object" ? state.states : {};
  const dagSlugs = Object.keys(nodes);
  const stateSlugs = Object.keys(states);

  // ── Check 1: slug-set identity ──
  if (dagOk && stateOk) {
    const inDagNotState = dagSlugs.filter((s) => !(s in states));
    const inStateNotDag = stateSlugs.filter((s) => !(s in nodes));
    for (const s of inDagNotState) {
      fail(statePath, `slug "${s}" is in dag.json.nodes but missing from state.json.states`);
    }
    for (const s of inStateNotDag) {
      fail(dagPath, `slug "${s}" is in state.json.states but missing from dag.json.nodes`);
    }
  }

  // ── Check 4: dependency integrity (dangling edges + acyclicity) ──
  if (dagOk) {
    const adj = new Map();
    for (const [slug, node] of Object.entries(nodes)) {
      const deps = Array.isArray(node && node.depends_on) ? node.depends_on : [];
      adj.set(slug, deps);
      for (const dep of deps) {
        if (!(dep in nodes)) {
          fail(dagPath, `node "${slug}" depends_on "${dep}" which is not a node in dag.json`);
        }
      }
    }
    const cycle = findCycle(adj);
    if (cycle) {
      fail(dagPath, `dependency cycle detected: ${cycle.join(" -> ")}`);
    }
  }

  // ── Pre-read context files + audit scripts ──
  const contextText = {}; // slug -> md text
  if (fs.existsSync(contextsDir)) {
    for (const f of fs.readdirSync(contextsDir)) {
      if (!f.endsWith(".md")) continue;
      const slug = f.replace(/\.md$/, "");
      contextText[slug] = fs.readFileSync(path.join(contextsDir, f), "utf-8");
    }
  }

  let auditIds = new Set();
  const auditCheckCmds = new Map(); // checkId -> [cmd, ...] (Check 8 fidelity)
  if (fs.existsSync(scriptsDir)) {
    for (const f of fs.readdirSync(scriptsDir)) {
      if (!/^audit.*\.(py|js)$/.test(f)) continue;
      const txt = fs.readFileSync(path.join(scriptsDir, f), "utf-8");
      for (const id of collectAuditIds(txt)) auditIds.add(id);
      for (const [id, cmds] of collectCheckCmds(txt)) {
        if (!auditCheckCmds.has(id)) auditCheckCmds.set(id, []);
        auditCheckCmds.get(id).push(...cmds);
      }
    }
  }

  // All files any node declares as an artifact — used by Check 8's door rule to
  // confirm a behavioral clause's entrypoint test is something the plan builds.
  const declaredArtifacts = new Set();
  if (dagOk) {
    for (const node of Object.values(nodes)) {
      for (const a of Array.isArray(node && node.artifacts) ? node.artifacts : []) {
        declaredArtifacts.add(normPath(a));
      }
    }
  }

  // ── Check 2: artifacts ↔ mutates ──
  if (dagOk && !dagOnly) {
    for (const [slug, node] of Object.entries(nodes)) {
      const artifacts = Array.isArray(node && node.artifacts) ? node.artifacts : [];
      const ctxRel = node && node.context ? String(node.context) : `contexts/${slug}.md`;
      const ctxPath = path.join(planDir, ctxRel);
      if (!fs.existsSync(ctxPath)) {
        fail(dagPath, `node "${slug}" context "${ctxRel}" does not exist`);
        continue;
      }
      const md = fs.readFileSync(ctxPath, "utf-8");
      const parsed = parseMutates(md);
      if (!parsed.ok) {
        // Not machine-parseable: emit a warning and check the dag node internally.
        warn(ctxPath, `Reservations/mutates block not machine-parseable; verified dag node "${slug}" artifacts internally only`);
        if (artifacts.length === 0) {
          fail(dagPath, `node "${slug}" has empty artifacts and its context mutates set is unparseable — declare artifacts`);
        }
        continue;
      }
      const a = new Set(artifacts);
      const mset = new Set(parsed.mutates);
      const onlyArtifacts = [...a].filter((x) => !mset.has(x));
      const onlyMutates = [...mset].filter((x) => !a.has(x));
      for (const x of onlyArtifacts) {
        fail(dagPath, `node "${slug}" artifacts has "${x}" not in ${ctxRel} mutates`);
      }
      for (const x of onlyMutates) {
        fail(ctxPath, `mutates has "${x}" not in dag.json node "${slug}" artifacts`);
      }
    }
  }

  // ── Check 3: criterion/audit ID match ──
  if (!dagOnly)
    for (const [slug, md] of Object.entries(contextText)) {
    // Only criterion IDs whose prefix matches this state's slug are "owned" here.
    const ids = collectCriterionIds(md);
    for (const id of ids) {
      if (!id.startsWith(slug + ".")) continue; // foreign citations ignored
      if (!auditIds.has(id)) {
        fail(
          path.join(contextsDir, `${slug}.md`),
          `acceptance criterion [${id}] has no matching check ID in any audit script`
        );
      }
    }
  }

  // ── Check 5: null gaps in dag.json ──
  if (dagOk) {
    const REQ_NODE = ["kind", "phase", "depends_on", "guard", "artifacts", "context"];
    for (const [slug, node] of Object.entries(nodes)) {
      if (!node || typeof node !== "object") {
        fail(dagPath, `node "${slug}" is null/empty`);
        continue;
      }
      for (const field of REQ_NODE) {
        // depends_on / artifacts may be empty arrays legitimately ONLY for depends_on.
        if (field === "depends_on") {
          if (!Array.isArray(node[field])) fail(dagPath, `node "${slug}" field "depends_on" is null/missing (use [])`);
          continue;
        }
        if (isEmpty(node[field])) {
          fail(dagPath, `node "${slug}" required field "${field}" is null/empty`);
        }
      }
    }
  }

  // ── Check 5: null gaps in state.json ──
  if (stateOk) {
    if (isEmpty(state.current_state)) {
      fail(statePath, `required field "current_state" is null/empty`);
    } else if (stateOk && dagOk && !(state.current_state in nodes)) {
      fail(statePath, `current_state "${state.current_state}" is not a slug in dag.json.nodes`);
    }
    for (const [slug, st] of Object.entries(states)) {
      if (!st || typeof st !== "object") {
        fail(statePath, `state "${slug}" is null/empty`);
        continue;
      }
      if (isEmpty(st.status)) {
        fail(statePath, `state "${slug}" required field "status" is null/empty`);
      }
    }
  }

  // ── Check 5/6/7: references.json (optional file) ──
  if (!dagOnly && refs && typeof refs === "object") {
    // Check 6: must be a FLAT slug-keyed object — reject the wrapper shape.
    // A wrapper shows up two ways, neither of which a real reference entry can
    // look like (entries are objects with anchor/rule): a scalar-valued
    // top-level key (e.g. `schema_version: 2`), or a known object-valued
    // envelope key (`refs`/`nodes`/`states`). We do NOT hard-list slug-shaped
    // names like `version`/`title` — those are legitimate ref-slugs.
    const scalarKeys = Object.entries(refs)
      .filter(([, v]) => v === null || typeof v !== "object")
      .map(([k]) => k);
    const envelopeKeys = ["refs", "nodes", "states"].filter(
      (k) => k in refs && refs[k] && typeof refs[k] === "object"
    );
    const wrappers = [...scalarKeys, ...envelopeKeys];
    if (wrappers.length > 0) {
      fail(
        refsPath,
        `must be a FLAT slug-keyed object — found wrapper key(s) ${wrappers
          .map((w) => `"${w}"`)
          .join(", ")}. Unlike dag.json/state.json, references.json has NO ` +
          `schema_version and NO wrapper: each top-level key is a ref-slug ` +
          `whose value is the reference object.`
      );
    } else {
      for (const [refSlug, ref] of Object.entries(refs)) {
        if (!/^[a-z0-9-]+$/.test(refSlug)) {
          fail(refsPath, `reference slug "${refSlug}" does not match ^[a-z0-9-]+$`);
        }
        if (!ref || typeof ref !== "object") {
          fail(refsPath, `reference "${refSlug}" is null/empty`);
          continue;
        }
        // Check 5: required fields populated.
        for (const field of ["anchor", "rule", "discovered_via"]) {
          if (isEmpty(ref[field])) {
            fail(refsPath, `reference "${refSlug}" required field "${field}" is null/empty`);
          }
        }
        if (ref.discovered_via && !["gitnexus", "manual"].includes(ref.discovered_via)) {
          fail(refsPath, `reference "${refSlug}" discovered_via "${ref.discovered_via}" must be "gitnexus" or "manual"`);
        }
        // Check 7: every idiom is verified by a final-audit check.
        if (isEmpty(ref.audit_check)) {
          fail(refsPath, `reference "${refSlug}" has no audit_check — every idiom must be proven by a final-audit check (a null audit_check is a blocking gap)`);
        } else {
          const acId = String(ref.audit_check).replace(/^\[|\]$/g, "");
          if (!auditIds.has(acId)) {
            fail(refsPath, `reference "${refSlug}" audit_check "${ref.audit_check}" has no matching check ID in any audit script`);
          }
        }
      }
    }
  }

  // ── Check 8: Definition of Done present + every [dod.N] proven; behavioral
  //    clauses proven through their declared entrypoint (fidelity, not a proxy) ──
  const readmePath = path.join(planDir, "README.md");
  if (!dagOnly && !fs.existsSync(readmePath)) {
    fail(readmePath, "README.md missing — the plan needs a README with a `## Definition of Done` section (Step 1a)");
  } else if (!dagOnly) {
    const readme = fs.readFileSync(readmePath, "utf-8");
    if (!/^##\s+Definition of Done\s*$/m.test(readme)) {
      fail(readmePath, "no `## Definition of Done` section — Step 1a requires an agreed, IDed DoD before any work state");
    } else {
      const clauses = parseDodClauses(readme);
      if (clauses.length === 0) {
        fail(readmePath, "`## Definition of Done` has no [dod.N] clauses — the DoD must enumerate IDed clauses");
      }
      for (const clause of clauses) {
        const id = clause.id;
        // (a) Every clause must map to at least one final-audit check.
        if (!auditIds.has(id)) {
          fail(readmePath, `Definition-of-Done clause [${id}] is not proven by any final-audit check — every [dod.N] must map to a check`);
          continue;
        }
        // Structural clauses (absence/conformance) are correctly proven by
        // grep/AST — the ID-match above is sufficient. Fidelity rules apply only
        // to BEHAVIORAL clauses (a runtime interaction a user/agent performs).
        if (!isBehavioral(clause.text)) continue;

        // (b) A behavioral clause must declare the interaction it proves.
        if (!clause.entrypoint) {
          fail(readmePath, `behavioral DoD clause [${id}] declares no \`entrypoint:\` — name the exact command/invocation a user or agent performs, so the proving check drives the real interaction (tier 3), not a proxy`);
          continue;
        }
        if (!clause.observable) {
          fail(readmePath, `behavioral DoD clause [${id}] declares no \`observable:\` — name the exact result the requester looks for, so the check asserts the real outcome`);
        }

        // (c) Entrypoint fidelity: a proving check must DRIVE the declared
        //     entrypoint — contain its most specific token — not prove a proxy.
        const cmds = auditCheckCmds.get(id) || [];
        const tok = distinctiveToken(clause.entrypoint);
        const normTok = normCmd(tok);
        const drives = cmds.some((c) => normCmd(c).includes(normTok) && normTok.length > 0);
        const allStructural = cmds.length > 0 && cmds.every((c) => isStructuralOnly(c));
        if (!drives) {
          if (cmds.length === 0) {
            // ID matched only a bare token/comment, no executable check() command.
            fail(readmePath, `behavioral DoD clause [${id}] maps to no executable audit check() command — it cannot drive the declared entrypoint \`${clause.entrypoint}\`; the orchestrator would confirm DONE without ever performing the interaction`);
          } else if (allStructural) {
            fail(readmePath, `behavioral DoD clause [${id}] is proven only by structural probe(s) (grep/test -e) — these never execute the declared entrypoint \`${clause.entrypoint}\`. Prove it through the documented entrypoint (tier 3): run the real command/test and assert \`${clause.observable || "the observable"}\``);
          } else {
            fail(readmePath, `behavioral DoD clause [${id}]: no proving check drives the declared entrypoint \`${clause.entrypoint}\` (looked for token "${tok}") — the check proves a proxy, not the interaction the requester asked for`);
          }
        } else {
          // (d) Door rule (warn): an entrypoint that is a test file should be a
          //     declared plan artifact, so the proof exercises a door the plan
          //     actually builds rather than a throwaway.
          if (looksLikeTestPath(tok) && !declaredArtifacts.has(normPath(tok))) {
            warn(readmePath, `behavioral DoD clause [${id}] entrypoint test "${tok}" is not declared in any node's artifacts — the executor must author it and the owning state must list it (forcing function), or the proof is unbuilt`);
          }
          // (e) Observable assertion (warn): the driving check should assert the
          //     declared observable, not just invoke the entrypoint.
          if (clause.observable) {
            const obsTok = distinctiveToken(clause.observable);
            const asserts = cmds.some((c) => /assert|expect|==|!=|grep|PASS|PARITY|--check|\bin\b/.test(c) || normCmd(c).includes(normCmd(obsTok)));
            if (!asserts) {
              warn(readmePath, `behavioral DoD clause [${id}] check drives \`${clause.entrypoint}\` but does not visibly assert the observable \`${clause.observable}\` — confirm the check fails when the observable is absent`);
            }
          }
        }
      }
    }
  }

  // ── Check 9: final-review gate (Step 7 checklist filled, no unticked boxes) ──
  const reviewPath = path.join(planDir, "final-review.md");
  if (!dagOnly && !fs.existsSync(reviewPath)) {
    fail(reviewPath, "final-review.md missing — copy references/final-review-checklist.md into the plan dir and tick every box (Step 7)");
  } else if (!dagOnly) {
    const review = fs.readFileSync(reviewPath, "utf-8");
    let unticked = 0;
    for (const ln of review.split("\n")) {
      if (/\[\s\]/.test(ln) && !/N\/A/i.test(ln)) unticked++;
    }
    if (unticked > 0) {
      fail(reviewPath, `${unticked} unchecked box(es) in final-review.md — every Step-7 item must be [x] or marked N/A before publish`);
    }
  }

  // ── Check 10: discovery completeness (opt-in via --discover) ──
  if (discover && dagOk && !dagOnly) {
    const accounted = new Set();
    for (const node of Object.values(nodes)) {
      for (const a of Array.isArray(node && node.artifacts) ? node.artifacts : []) {
        accounted.add(normPath(a));
      }
    }
    for (const md of Object.values(contextText)) {
      for (const f of parseReservationKey(md, "read_only") || []) accounted.add(normPath(f));
    }

    // Tiered caller oracle (gitnexus → LSP → grep). gitnexus is used ONLY when
    // its index provably equals the working-tree HEAD (clean tree + commit
    // match); otherwise it is disqualified because it cannot see un-indexed
    // edits. LSP runs when $PSM_LSP_CMD is configured (worktree-accurate). grep
    // is the scoped last resort (source roots only, docs/prose excluded,
    // word-boundary construct match).
    const lspCmd = process.env.PSM_LSP_CMD || null;
    // Never count the plan's OWN files as callers: dag.json/contexts mention the
    // changed symbols by design (they live in the `changes` block). Exclude the
    // plan dir from the grep tier.
    const planExclude = [path.basename(path.resolve(planDir))];
    const gx = gitnexusStatus();
    const sel = selectOracle({ gitnexus: gx, lspCmd });
    if (sel.tier !== "gitnexus" && gx.available && !gx.fresh) {
      warn(
        dagPath,
        `--discover: GitNexus index is STALE vs the working tree (indexed=${gx.indexedCommit ?? "?"} head=${gx.currentCommit ?? "?"}${gx.dirty ? ", uncommitted changes" : ""}) — not used; run \`npx gitnexus analyze\` to make it graph-authoritative`,
      );
    }
    if (sel.tier === "grep") {
      warn(
        dagPath,
        "--discover: caller discovery fell back to scoped grep (no fresh GitNexus index, no $PSM_LSP_CMD). For construct-aware coverage, set $PSM_LSP_CMD or run the LSP tool on the symbols below from the calling agent.",
      );
    }

    let anyChanges = false;
    let resolvedTier = sel.tier;
    for (const [slug, node] of Object.entries(nodes)) {
      const ch = node && node.changes;
      if (!ch || typeof ch !== "object") continue;
      anyChanges = true;
      const syms = [];
      for (const s of Array.isArray(ch.deletes) ? ch.deletes : []) syms.push(s);
      for (const s of Array.isArray(ch.resigns) ? ch.resigns : []) syms.push(s);
      for (const r of Array.isArray(ch.renames) ? ch.renames : []) if (r && r.from) syms.push(r.from);
      for (const sym of syms) {
        const { files: found, tier } = resolveCallers(sym, {
          oracle: sel,
          lspCmd,
          excludeDirs: planExclude,
        });
        resolvedTier = tier;
        for (const f of [...found].filter((x) => !accounted.has(x))) {
          fail(dagPath, `--discover: symbol "${sym}" (changed in node "${slug}") is referenced in "${f}", which no state mutates or reserves read_only — Step-0 caller mapping is incomplete`);
        }
      }
    }
    if (!anyChanges) {
      warn(dagPath, "--discover requested but no node declares a `changes` block — declare changed symbols (deletes/resigns/renames) to enable discovery-completeness checking");
    }
    process.stdout.write(`gap-check: discovery oracle = ${resolvedTier} (${sel.reason})\n`);
  }

  // ── Report ──
  for (const w of warnings) process.stdout.write(w + "\n");
  if (dagOnly) {
    process.stdout.write(
      "NOTE: --dag-only — ran structural checks only (slug-set identity, dependency integrity, null-gaps); content checks (artifacts/criteria/audit/references/DoD/final-review/discovery) were skipped. Re-run without --dag-only before publish.\n",
    );
  }
  const boundary = discover
    ? "NOTE: --discover ran (caller mapping checked against the declared `changes` set). The non-mechanical gap-review (references/gap-review.md) is the planner's own mandatory work; a green exit does not discharge it. FAIL lines above are hard blocks, not advisory warnings."
    : "NOTE: mechanical checks only — Step-0 caller mapping (re-run with --discover) and the non-mechanical gap-review (references/gap-review.md) are the planner's job, NOT verified here. FAIL lines above are hard blocks, not advisory warnings.";
  process.stdout.write(boundary + "\n");
  if (failures.length === 0) {
    process.stdout.write(`gap-check PASSED: ${planDir} (${warnings.length} warning(s))\n`);
    process.exit(0);
  }
  process.stdout.write(`\ngap-check FAILED: ${failures.length} gap(s) in ${planDir}\n`);
  for (const f of failures) process.stdout.write(f + "\n");
  process.exit(failures.length);
}

main();
