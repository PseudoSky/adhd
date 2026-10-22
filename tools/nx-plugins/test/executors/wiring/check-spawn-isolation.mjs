#!/usr/bin/env node
/**
 * check-spawn-isolation — the repo-wide static guard for the HOME-redirect
 * isolation posture (backlog 0945d1b9, decisions D1 + D2).
 *
 * THE CLASS. A spec or e2e test that spawns a Node bin (`process.execPath`, the
 * literal `node`, or `fork(modulePath)`) hands the child the parent's environment.
 * The child builds its own `@adhd/environment` cascade from argv, env and `HOME`, so
 * a child that inherits the real `HOME` reads the machine's real `~/.adhd` config and
 * stores. The isolation mechanism is therefore the HOME redirect: every spawn site
 * must either route through an isolation helper (which sets `HOME` to a throwaway
 * root) or set `HOME` explicitly in its own env. A resolver-side gate cannot protect
 * a child process, so this guard is the control (see docs/decisions/0002 and the
 * spec's D1 rationale).
 *
 * SCOPE. A file is checked when its owning package (nearest `package.json` at or
 * above it) declares a dependency on any `@adhd/environment*` package: those are
 * the packages whose children resolve the cascade. Only `*.spec.*`, `*.test.*` and
 * `*.e2e.*` files under `packages/` and `entrypoint/` are scanned.
 *
 * WHAT IT CHECKS (any violation => exit 1). Each file is tokenized (comments and
 * string/template/regex literals are recognised, so a spawn inside an embedded script
 * string is not a site and a commented `HOME:` routes nothing). Then:
 *   A. (spawn-isolation-unrouted) a spawn SITE is unrouted unless that call routes
 *      itself. A site is a call of `spawn|spawnSync|execFile|execFileSync` whose
 *      executable is `process.execPath`, `'node'` or a const alias of either, or
 *      `fork(modulePath, …)`. It is routed when, within the call's own argument span,
 *      there is a `HOME` override (`HOME:` / `'HOME':` / shorthand `HOME`, not the real
 *      home) or a use of something imported from an isolation helper
 *      (a call, a `...helper(…)` spread, or a `...opts` spread of an identifier built by one;
 *      `spawn-isolated-bin`, `spawn-backlog-bin`, or any name in `helpers`;
 *      `DIST_INDEX` and other non-isolating exports do not count), or the span names
 *      an identifier whose visible declaration carries one of those, or a
 *      `process.env.HOME =` / `env.HOME =` assignment precedes the call in an
 *      enclosing scope (or a `beforeAll`/`beforeEach` hook of one). A `HOME` key
 *      elsewhere in the file routes nothing.
 *   B. (spawn-isolation-unrouted, over the baseline) `spawn-isolation.baseline.json`
 *      records, per file, the COUNT of unrouted sites tolerated today. A baselined
 *      file whose unrouted count exceeds its baseline fails, naming file:line of every
 *      site; a file not in the baseline tolerates none. Code changes can only lower
 *      the tolerated counts; adding a file or raising a count is a reviewed edit of
 *      the JSON (the same property as rule 6's ratchet), not something this check
 *      rejects.
 *   C. (spawn-isolation-baseline-stale) a baselined file under a scanned root whose
 *      unrouted count dropped below its baseline (routed, moved, renamed, deleted)
 *      fails until the entry is lowered or removed. (spawn-isolation-baseline-invalid:
 *      an entry without a positive integer `count`.)
 *   D. (spawn-isolation-scan-found-nothing) the scope holds `@adhd/environment*`
 *      packages but zero spec/e2e files were scanned: the walker is broken.
 *
 * Known limits (static, regex-grade):
 *   - a re-export of a helper under another module name is not followed;
 *   - an identifier is matched by name against visible const/function declarations to
 *     depth 2; sites inside template-literal `${}` expressions are judged like any other code;
 *   - a bare-identifier HOME value (`HOME: home`, `env.HOME = home`) is resolved through its
 *     visible `const|let|var` / plain-assignment initializer: an initializer matching the real-home
 *     forms (`os.homedir()`, `process.env.HOME`, a saved `prev*`/`orig*`/… copy) is UNROUTED; any other
 *     initializer routes it; an identifier with no resolvable initializer (a parameter, an import,
 *     a function result bound elsewhere) is treated as ROUTED;
 *   - the per-file-count ratchet allows swapping a routed call for an unrouted one (routing one
 *     site and adding another unrouted site leaves the count unchanged, so it passes);
 *   - a shorthand `HOME` is a redirect only inside an object-literal `{ … }` (a destructuring
 *     `const { HOME } = …` or a function call argument does not count); a parameter-list
 *     destructuring `({ HOME }) =>` is indistinguishable from an object literal and counts;
 *   - child_process is recognised through static and `require`/dynamic import bindings, aliases
 *     (`spawn as launch`), and namespace members (`cp.spawn`, `cp.exec`); a spawn reached only
 *     through a re-exported or wrapped `child_process` binding is not detected;
 *   - `exec`/`execSync` are node-bin sites only when their first argument is a string or template
 *     beginning with `node`/`nodejs`, or contains `process.execPath` or a const alias of it.
 *
 * Exit code is the only signal (0 = clean, 1 = violation), per the repo's
 * verification standard. Invoked by check-lane-reachability.mjs (rule 9), which
 * the pre-push hook and both CI workflows run, and by the backlog package's
 * `vocabulary-gate` through a thin caller.
 *
 * `--workspace-root <dir>` points the scan (and the default baseline lookup) at a
 * fixture workspace; `--baseline <file>` overrides the baseline (fixture runs).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globScan } from './glob-exclusions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');

/** Workspace-relative location of the ratchet baseline (resolved against the scanned workspace root). */
export const BASELINE_REL = 'tools/nx-plugins/test/executors/wiring/spawn-isolation.baseline.json';

const SPEC_FILE = /\.(spec|test|e2e)\.[cm]?[jt]sx?$/;

/** Default workspace roots scanned, relative to the workspace root. */
export const DEFAULT_ROOTS = ['packages', 'entrypoint'];

/** Isolation helpers whose import marks a spawn site as routed (when the site uses what it imported). */
export const ISOLATION_HELPERS = ['spawn-isolated-bin', 'spawn-backlog-bin'];

/**
 * Helper exports that do NOT isolate anything (the bin path, key lists, parsers).
 * Importing or mentioning them never routes a spawn site.
 */
export const NON_ISOLATING_EXPORTS = [
  'DIST_INDEX',
  'AMBIENT_REDIRECT_ENV_KEYS',
  'extractMintedSandboxRoot',
  'looksLikeOwnSandboxDir',
];

/**
 * Coarse regex for a direct spawn of a Node bin with a literal executable. Retained
 * as an export for callers; the guard itself decides per call site (see
 * {@link findUnroutedSpawnSites}), which also covers `fork(module)` and const aliases.
 */
export const NODE_SPAWN =
  /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(\s*(?:process\.execPath|process\.argv0|'node'|"node"|`node`)/;

// Start-of-identifier boundary: not preceded by a word char, and not by a member-access `.`
// (`a.helper`, `a?.helper`) — but a spread `...helper(…)` / `...opts` IS a use of the name.
const NAME_START = String.raw`(?<![\w$])(?<!(?<!\.\.)\.)`;

/** Spawn-family names recognised by bare name (a `.name(` member call matches too). */
const BARE_SPAWN_NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
/** Every child_process export a file may bind under another local name (alias / destructure). */
const CHILD_PROCESS_FUNCS = [...BARE_SPAWN_NAMES, 'exec', 'execSync'];
/** The exec family takes a command STRING, so it is a node site only through a node-string first argument. */
const EXEC_FAMILY = new Set(['exec', 'execSync']);
const EXEC_NODE_STRING = /^\s*(?:`|'|")?\s*(?:node|nodejs)(?=[\s'"`]|$)/;
const NODE_LITERAL = /^(?:process\.execPath|process\.argv0|process\.argv\[\s*0\s*\]|(['"`])(?:node|nodejs)\1)$/;
const ALIAS_DECL =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:process\.execPath|process\.argv0|process\.argv\[\s*0\s*\]|(['"`])(?:node|nodejs)\2)\s*(?:as\s+[\w.]+\s*)?(?=[;,\n)]|$)/g;
const ALIAS_DESTRUCTURE = /(?:const|let|var)\s*\{[^}]*\bexecPath\b[^}]*\}\s*=\s*process\b/;
const ALIAS_IMPORT = /import\s*\{[^}]*\bexecPath\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/;
// A value that is the real home (or a variable holding a saved copy of it): not a redirect.
const REAL_HOME_VALUE =
  /^(?:process\.env\.HOME\b|process\.env\[\s*['"]HOME['"]\s*\]|(?:os\.)?homedir\s*\(|(?:prev|orig|saved|old|real)[\w$]*\s*(?:$|[;,}]))/;
const KEYWORDS = new Set([
  'process', 'true', 'false', 'null', 'undefined', 'new', 'await', 'async', 'typeof', 'void', 'return',
  'const', 'let', 'var', 'function', 'this', 'as', 'of', 'in', 'string', 'number', 'boolean', 'any', 'unknown',
]);

/**
 * One pass over the source: `code` is the source with comments blanked (same length,
 * newlines kept, so indices and line numbers stay exact), `mask[i] === 1` marks
 * characters inside a string, template or regex literal, and `blocks` lists every
 * `{ … }` block of real code.
 * @param {string} src Raw file contents.
 * @returns {{ code: string, mask: Uint8Array, blocks: Array<{ start: number, end: number }> }}
 */
export function scanSource(src) {
  const n = src.length;
  const out = src.split('');
  const mask = new Uint8Array(n);
  const blocks = [];
  const open = [];
  const tpl = [];
  let depth = 0;
  let lastSig = '';
  let lastWord = '';

  const scanTemplate = (from) => {
    let j = from;
    while (j < n) {
      mask[j] = 1;
      const c = src[j];
      if (c === '\\') {
        if (j + 1 < n) mask[j + 1] = 1;
        j += 2;
        continue;
      }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') {
        mask[j + 1] = 1;
        tpl.push(depth);
        depth += 1;
        return j + 2;
      }
      j += 1;
    }
    return j;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i += 1) if (src[i] !== '\n') out[i] = ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      mask[i] = 1;
      i += 1;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        mask[i] = 1;
        if (src[i] === '\\') {
          i += 1;
          if (i < n) mask[i] = 1;
        }
        i += 1;
      }
      if (i < n && src[i] === c) mask[i] = 1;
      i += 1;
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      mask[i] = 1;
      i = scanTemplate(i + 1);
      lastSig = '`';
      lastWord = '';
      continue;
    }
    if (c === '/' && (lastSig === '' || '(,=:[!&|?{};'.includes(lastSig) || lastWord === 'return' || lastWord === 'typeof')) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      if (j < n && src[j] === '/') {
        for (let k = i; k <= j; k += 1) mask[k] = 1;
        i = j + 1;
        lastSig = '/';
        lastWord = '';
        continue;
      }
    }
    if (c === '{') {
      open.push({ start: i, depth });
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (tpl.length > 0 && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        mask[i] = 1;
        i = scanTemplate(i + 1);
        lastSig = '`';
        continue;
      }
      const o = open.pop();
      if (o) blocks.push({ start: o.start, end: i });
    }
    if (!/\s/.test(c)) {
      if (/[\w$]/.test(c)) lastWord = /[\w$]/.test(src[i - 1] ?? '') ? lastWord + c : c;
      else lastWord = '';
      lastSig = c;
    }
    i += 1;
  }
  for (const o of open) blocks.push({ start: o.start, end: n });
  return { code: out.join(''), mask, blocks };
}

/** Index of the matching `)` for the `(` at `openIdx` (literals skipped), or `code.length`. */
function matchParen(code, mask, openIdx) {
  let d = 0;
  for (let j = openIdx; j < code.length; j += 1) {
    if (mask[j]) continue;
    if (code[j] === '(') d += 1;
    else if (code[j] === ')') {
      d -= 1;
      if (d === 0) return j;
    }
  }
  return code.length;
}

/** The first top-level argument text of a call whose argument span is `[from, to)`. */
function firstArgument(code, mask, from, to) {
  let d = 0;
  for (let j = from; j < to; j += 1) {
    if (mask[j]) continue;
    const c = code[j];
    if (c === '(' || c === '[' || c === '{') d += 1;
    else if (c === ')' || c === ']' || c === '}') d -= 1;
    else if (c === ',' && d === 0) return code.slice(from, j).trim();
  }
  return code.slice(from, to).trim();
}

/** Escape a string for use inside a RegExp source. */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Local names a file binds from an isolation helper module (ESM import, `require`,
 * or awaited `import()`), minus type-only and non-isolating bindings.
 * @param {string} code Comment-blanked source.
 * @param {readonly string[]} helpers Helper module basenames.
 * @returns {{ names: Set<string>, namespaces: Set<string> }}
 */
function helperBindings(code, helpers) {
  const names = new Set();
  const namespaces = new Set();
  if (helpers.length === 0) return { names, namespaces };
  const modulePath = new RegExp(`(?:^|[\\\\/])(?:${helpers.map(esc).join('|')})(?:\\.[cm]?[jt]s)?$`);
  const bindList = (list) => {
    for (const part of list.split(',')) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+)|\s*:\s*([\w$]+))?$/.exec(p);
      if (!m) continue;
      if (NON_ISOLATING_EXPORTS.includes(m[1])) continue;
      names.add(m[2] ?? m[3] ?? m[1]);
    }
  };
  const importRe = /import\s+(?!\()(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(importRe)) {
    if (m[1] || !modulePath.test(m[3])) continue;
    const clause = m[2].trim();
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) namespaces.add(ns[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) bindList(braces[1]);
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, '').trim());
    if (def) names.add(def[1]);
  }
  const requireRe = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(requireRe)) {
    if (!modulePath.test(m[2])) continue;
    if (m[1].startsWith('{')) bindList(m[1].slice(1, -1));
    else namespaces.add(m[1]);
  }
  return { names, namespaces };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * What a file binds from `child_process` (ESM import, `require`, or `import()` assigned to a
 * binding): `direct` maps each local name to the child_process export it names (so
 * `import { spawn as launch }` gives `launch → spawn`), and `namespaces` holds the local names
 * of a whole-module binding (`import * as cp`, `import cp from`, `const cp = require(…)`).
 * Type-only imports are skipped.
 * @param {string} code Comment-blanked source.
 * @returns {{ direct: Map<string, string>, namespaces: Set<string> }}
 */
function childProcessBindings(code) {
  const direct = new Map();
  const namespaces = new Set();
  const isChildProcess = (spec) => /^(?:node:)?child_process$/.test(spec);
  const bindList = (list) => {
    for (const part of list.split(',')) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+)|\s*:\s*([\w$]+))?$/.exec(p);
      if (!m || !CHILD_PROCESS_FUNCS.includes(m[1])) continue;
      direct.set(m[2] ?? m[3] ?? m[1], m[1]);
    }
  };
  for (const m of code.matchAll(/import\s+(?!\()(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1] || !isChildProcess(m[3])) continue;
    const clause = m[2].trim();
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) namespaces.add(ns[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) bindList(braces[1]);
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, '').trim());
    if (def) namespaces.add(def[1]);
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!isChildProcess(m[2])) continue;
    if (m[1].startsWith('{')) bindList(m[1].slice(1, -1));
    else namespaces.add(m[1]);
  }
  return { direct, namespaces };
}

/**
 * Index of the unclosed `(`, `[` or `{` that encloses `idx` in `text`, or `-1`.
 * @param {string} text Source slice (comments blanked).
 * @param {number} idx Position inside the slice.
 * @returns {number}
 */
function innermostOpen(text, idx) {
  let d = 0;
  for (let j = idx - 1; j >= 0; j -= 1) {
    const c = text[j];
    if (c === ')' || c === ']' || c === '}') d += 1;
    else if (c === '(' || c === '[' || c === '{') {
      if (d === 0) return j;
      d -= 1;
    }
  }
  return -1;
}

/**
 * Is a `{` at `open` an object-literal brace (an expression position) rather than a block,
 * a class/function body, or a destructuring pattern? Judged by the token before it.
 * @param {string} text Source slice (comments blanked).
 * @param {number} open Index of the `{`.
 * @returns {boolean}
 */
function isObjectLiteralBrace(text, open) {
  const before = text.slice(0, open).trimEnd();
  return /(?:[(,=:[?]|\breturn)$/.test(before);
}

/**
 * Does `text` carry a shorthand `HOME` property (`{ HOME }`, `{ a, HOME, b }`) inside an
 * object literal? A bare `HOME` argument (`f(x, HOME)`) or a destructuring pattern
 * (`const { HOME } = …`) is not an object-literal shorthand and routes nothing. The shorthand
 * is `HOME: HOME`, so its value is judged by `isRealHome` like any other HOME value.
 * @param {string} text Source slice (comments blanked).
 * @param {(value: string) => boolean} isRealHome True when a HOME value is the real home at the call site.
 * @returns {boolean}
 */
function hasShorthandHome(text, isRealHome) {
  for (const m of text.matchAll(/(?<![\w$.'"`])HOME(?=\s*[,}])/g)) {
    if (!/[{,]$/.test(text.slice(0, m.index).trimEnd())) continue;
    const open = innermostOpen(text, m.index);
    if (open >= 0 && text[open] === '{' && isObjectLiteralBrace(text, open) && !isRealHome('HOME')) return true;
  }
  return false;
}

/**
 * Does `text` contain a HOME-redirect signal: a `HOME` key (bare, quoted or
 * shorthand) whose value is not the real home, a `.HOME =` assignment, a
 * `stubEnv('HOME', …)`, or a use of something imported from an isolation helper?
 * @param {string} text Source slice (comments blanked).
 * @param {{ names: Set<string>, namespaces: Set<string> }} binds Helper bindings.
 * @param {(value: string) => boolean} isRealHome True when a HOME value is the real home at the call site.
 * @returns {boolean}
 */
function hasHomeSignal(text, binds, isRealHome) {
  for (const m of text.matchAll(/(?<![\w$.])(?:HOME|'HOME'|"HOME"|`HOME`)\s*:\s*([^,}\n]*)/g)) {
    if (!isRealHome(m[1].trim())) return true;
  }
  if (hasShorthandHome(text, isRealHome)) return true;
  if (/stubEnv\s*\(\s*['"]HOME['"]/.test(text)) return true;
  for (const m of text.matchAll(/[\w$\]]\s*(?:\.HOME|\[\s*['"]HOME['"]\s*\])\s*=(?!=)\s*([^;\n]*)/g)) {
    if (!isRealHome(m[1].trim())) return true;
  }
  for (const name of binds.names) if (new RegExp(`${NAME_START}${esc(name)}(?![\\w$])`).test(text)) return true;
  for (const ns of binds.namespaces) {
    const re = new RegExp(`${NAME_START}${esc(ns)}\\s*\\.\\s*([\\w$]+)`, 'g');
    for (const m of text.matchAll(re)) if (!NON_ISOLATING_EXPORTS.includes(m[1])) return true;
  }
  return false;
}

/**
 * Positions of every `.HOME =` / `stubEnv('HOME', …)` statement (HOME set for the whole process
 * or an env object), with the assigned value text (`undefined` for `stubEnv`).
 * @param {string} code Comment-blanked source.
 * @param {Uint8Array} mask String/regex literal mask.
 * @returns {Array<{ index: number, value: string | undefined }>}
 */
function homeAssignments(code, mask) {
  const out = [];
  const re = /[\w$\]]\s*(?:\.HOME|\[\s*['"]HOME['"]\s*\])\s*=(?!=)\s*([^;\n]*)|stubEnv\s*\(\s*['"]HOME['"]/g;
  for (const m of code.matchAll(re)) {
    if (mask[m.index] && !/^stubEnv/.test(m[0])) continue;
    out.push({ index: m.index, value: m[1]?.trim() });
  }
  return out;
}

/** The initializer / body texts (with their start index) that declare `id` in `code`. */
function declarationsOf(code, mask, blocks, id) {
  const texts = [];
  // `const|let|var ID … = init` declarations, and later plain `ID = init` assignments
  // (`let sandbox; … sandbox = mintBacklogSandbox();`).
  const declRe = new RegExp(
    `(?:(?:const|let|var)\\s+${esc(id)}(?![\\w$])[^=;\\n]*=(?!=)|(?<![\\w$.])${esc(id)}\\s*=(?![=>]))\\s*`,
    'g',
  );
  for (const m of code.matchAll(declRe)) {
    if (mask[m.index]) continue;
    const from = m.index + m[0].length;
    let d = 0;
    let j = from;
    for (; j < code.length && j - from < 4000; j += 1) {
      if (mask[j]) continue;
      const c = code[j];
      if (c === '(' || c === '[' || c === '{') d += 1;
      else if (c === ')' || c === ']' || c === '}') {
        d -= 1;
        if (d < 0) break;
      } else if (d === 0 && c === ';') break;
      else if (d === 0 && c === '\n') {
        const prev = code.slice(from, j).trimEnd().slice(-1);
        const nxt = /\S/.exec(code.slice(j))?.[0] ?? '';
        if (!'=,(+-*/&|?:>'.includes(prev) && !'.?:+-*/&|,)'.includes(nxt)) break;
      }
    }
    texts.push({ idx: m.index, text: code.slice(from, j) });
  }
  const fnRe = new RegExp(`function\\s+${esc(id)}\\s*\\(`, 'g');
  for (const m of code.matchAll(fnRe)) {
    if (mask[m.index]) continue;
    const close = matchParen(code, mask, m.index + m[0].length - 1);
    const body = blocks.filter((b) => b.start > close).sort((a, b) => a.start - b.start)[0];
    if (body) texts.push({ idx: m.index, text: code.slice(m.index, body.end + 1) });
  }
  return texts;
}

const HOOK_HEAD = /(?:beforeAll|beforeEach)\s*\(\s*(?:async\s*)?(?:function\s*\w*\s*\([^)]*\)|\([^)]*\)\s*(?::\s*[^=]+)?=>|[\w$]+\s*=>)\s*$/;

/**
 * Every spawn call of a Node bin in a spec or e2e source whose child can inherit the
 * real `HOME`. Judged PER CALL SITE: a site is routed only when its own argument span
 * carries a HOME redirect or helper use (directly, or through an identifier declared
 * with one), or a `.HOME =` assignment whose value is not the real home precedes it in an
 * enclosing scope. A `HOME:` key elsewhere in the file routes nothing.
 *
 * Candidate calls: the spawn family (`spawn|spawnSync|execFile|execFileSync|fork`) by bare
 * name; any local alias bound from `child_process` (`import { spawn as launch }`,
 * `const { spawnSync: run } = require('child_process')`); and the exec family
 * (`exec|execSync`) only when child_process binds it (directly, or as a namespace member
 * `cp.exec(…)`). A spawn-family candidate is a node-bin site when its executable is
 * `process.execPath`, `'node'`, or a const alias of either; an exec-family candidate when its
 * command string starts with `node`/`nodejs` or contains `process.execPath` or such an alias;
 * `fork(modulePath, …)` always is.
 * @param {string} rawSrc Raw file contents.
 * @param {readonly string[]} [helpers] Helper module basenames that mark a routed site.
 * @returns {Array<{ line: number, callee: string }>} `callee` is the child_process export the call names.
 */
export function findUnroutedSpawnSites(rawSrc, helpers = ISOLATION_HELPERS) {
  if (!/child_process|\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/.test(rawSrc)) return [];
  const { code, mask, blocks } = scanSource(rawSrc);
  const binds = helperBindings(code, helpers);
  const cp = childProcessBindings(code);
  const aliases = new Set();
  for (const m of code.matchAll(ALIAS_DECL)) if (!mask[m.index]) aliases.add(m[1]);
  if (ALIAS_DESTRUCTURE.test(code) || ALIAS_IMPORT.test(code)) aliases.add('execPath');
  const assignments = homeAssignments(code, mask);
  const lineAt = (idx) => code.slice(0, idx).split('\n').length;
  const innermost = (p, within = blocks) => {
    let best;
    for (const b of within) if (b.start < p && p < b.end && (!best || b.end - b.start < best.end - best.start)) best = b;
    return best;
  };
  const contains = (b, p) => !b || (b.start < p && p < b.end);
  // Is a statement at `p` in a scope the site at `siteIdx` can see: module level, a block
  // enclosing the site, or a `beforeAll`/`beforeEach` hook of such a block?
  const scopeReaches = (p, siteIdx) => {
    const home = innermost(p);
    if (contains(home, siteIdx)) return true;
    if (HOOK_HEAD.test(code.slice(Math.max(0, home.start - 160), home.start))) return contains(innermost(home.start), siteIdx);
    return false;
  };

  /**
   * Is a HOME value the real home at the site `siteIdx`? The real-home forms match directly; a
   * bare identifier resolves to its visible initializer(s) and is real only when every one is.
   * No resolvable initializer (a parameter, an import, an unknown binding) is NOT real: routed.
   * `undefined` (a `stubEnv('HOME', …)` call carries no value) is not real.
   */
  const realHomeAt = (siteIdx) => (value) => {
    if (value === undefined) return false;
    const v = value.trim();
    if (REAL_HOME_VALUE.test(v)) return true;
    if (!IDENT.test(v) || KEYWORDS.has(v)) return false;
    const inits = declarationsOf(code, mask, blocks, v)
      .filter((d) => !code.startsWith('function', d.idx) && scopeReaches(d.idx, siteIdx))
      .map((d) => d.text.trim());
    return inits.length > 0 && inits.every((t) => REAL_HOME_VALUE.test(t));
  };
  const hasSignal = (text, siteIdx) => hasHomeSignal(text, binds, realHomeAt(siteIdx));

  // A spawn-family call names a Node bin; an exec-family call names one through its command string.
  const execRunsNode = (first) =>
    EXEC_NODE_STRING.test(first) ||
    /\bprocess\s*\.\s*(?:execPath|argv0)\b|\bprocess\.argv\[\s*0\s*\]/.test(first) ||
    (first.match(/[A-Za-z_$][\w$]*/g) ?? []).some((id) => aliases.has(id));

  const visited = new Set();
  const identifierRouted = (text, absStart, level, siteIdx) => {
    if (level > 2) return false;
    for (const m of text.matchAll(new RegExp(`${NAME_START}([A-Za-z_$][\\w$]*)(?![\\w$])(?!\\s*:)`, 'g'))) {
      const id = m[1];
      if (KEYWORDS.has(id) || (absStart !== undefined && mask[absStart + m.index])) continue;
      if (visited.has(`${level}:${id}`)) continue;
      visited.add(`${level}:${id}`);
      for (const decl of declarationsOf(code, mask, blocks, id)) {
        // Only a declaration visible from the site counts: module level, or in a block enclosing it.
        if (!scopeReaches(decl.idx, siteIdx)) continue;
        if (hasSignal(decl.text, siteIdx) || identifierRouted(decl.text, undefined, level + 1, siteIdx)) return true;
      }
    }
    return false;
  };

  // Candidate calls, in source order: the spawn family by bare name (or a child_process alias),
  // and the exec family only when child_process binds it or it is a namespace member.
  const callNames = [...new Set([...BARE_SPAWN_NAMES, ...cp.direct.keys()])];
  const callRe = new RegExp(`(?<![\\w$])(${callNames.map(esc).join('|')})\\s*\\(`, 'g');
  const candidates = [];
  for (const m of code.matchAll(callRe)) {
    candidates.push({ index: m.index, callee: cp.direct.get(m[1]) ?? m[1], open: m.index + m[0].length - 1 });
  }
  if (cp.namespaces.size > 0) {
    const nsRe = new RegExp(`(?<![\\w$])(?:${[...cp.namespaces].map(esc).join('|')})\\s*\\.\\s*(exec|execSync)\\s*\\(`, 'g');
    for (const m of code.matchAll(nsRe)) candidates.push({ index: m.index, callee: m[1], open: m.index + m[0].length - 1 });
  }
  candidates.sort((a, b) => a.index - b.index);

  const sites = [];
  for (const { index, callee, open } of candidates) {
    if (mask[index]) continue;
    if (callee === 'fork' && /(?:cluster|worker)\s*\.\s*$/.test(code.slice(Math.max(0, index - 12), index))) continue;
    const close = matchParen(code, mask, open);
    // A declaration (`function fork(a) {`, `fork(a) {` class member), not a call.
    if (/function\s*\*?\s*$/.test(code.slice(Math.max(0, index - 20), index)) || /^\s*\{/.test(code.slice(close + 1, close + 40))) continue;
    const first = firstArgument(code, mask, open + 1, close);
    const isNodeBin =
      callee === 'fork'
        ? first.length > 0
        : EXEC_FAMILY.has(callee)
          ? execRunsNode(first)
          : NODE_LITERAL.test(first) || aliases.has(first);
    if (!isNodeBin) continue;

    const span = code.slice(open + 1, close);
    if (hasSignal(span, index)) continue;
    visited.clear();
    if (identifierRouted(span, open + 1, 0, index)) continue;
    const routedByAssignment = assignments.some(
      (a) => a.index < index && scopeReaches(a.index, index) && !realHomeAt(index)(a.value),
    );
    if (routedByAssignment) continue;
    sites.push({ line: lineAt(index), callee });
  }
  return sites;
}

/**
 * Why a spec or e2e source (raw text) spawns a Node bin without isolation, or
 * `undefined` when every Node-bin spawn site is routed (see {@link findUnroutedSpawnSites}).
 * @param {string} rawSrc Raw file contents.
 * @param {readonly string[]} [helpers] Helper module basenames that mark a routed site.
 * @returns {string | undefined}
 */
export function spawnIsolationReason(rawSrc, helpers = ISOLATION_HELPERS) {
  const sites = findUnroutedSpawnSites(rawSrc, helpers);
  if (sites.length === 0) return undefined;
  return `${sites.length} spawn site(s) of a node bin (process.execPath / node / fork) without an isolation helper or an explicit HOME override in the call (line ${sites.map((s) => s.line).join(', ')})`;
}

/**
 * Parse a JSON file, naming it on failure. A bare `SyntaxError` from `JSON.parse` says nothing about which
 * of the workspace's files is broken; this rethrows with the workspace-relative path (plan discovery-sweep-1014
 * blind-review D AC2) and keeps the parser's message and original error as `cause`.
 * @param {string} abs Absolute path of the JSON file.
 * @param {string} workspaceRoot Absolute workspace root, used to name the file relative to it.
 * @returns {any} The parsed document.
 */
export function readJsonFile(abs, workspaceRoot) {
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`${relative(workspaceRoot, abs)}: not valid JSON — ${err.message}`, { cause: err });
  }
}

/**
 * The owning package of a workspace-relative file: the nearest `package.json` at
 * or above its directory, read as `{ dir, pkg }`, or `undefined` if none exists.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {string} relFile Workspace-relative file path.
 * @returns {{ dir: string, pkg: object } | undefined}
 */
export function owningPackage(workspaceRoot, relFile) {
  let dir = dirname(relFile);
  for (;;) {
    const abs = join(workspaceRoot, dir, 'package.json');
    if (existsSync(abs)) return { dir, pkg: readJsonFile(abs, workspaceRoot) };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * True when the package declares any `@adhd/environment*` dependency (runtime,
 * dev or peer). Such a package's children resolve the environment cascade.
 * @param {object} pkg Parsed `package.json`.
 * @returns {boolean}
 */
export function usesEnvironmentFamily(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  return Object.keys(deps).some((name) => name.startsWith('@adhd/environment'));
}

/**
 * Normalize a baseline document to `Map<file, { count, reason? }>`. The current shape
 * is `{ unrouted: { "<file>": { count, reason } } }`. A legacy array of file names is
 * still parsed (each file tolerated without a count ceiling, for fixture compatibility
 * only; the checked-in baseline uses counts).
 * @param {{ unrouted?: Record<string, { count: number, reason?: string }> | string[] }} [baseline]
 * @returns {Map<string, { count: number, reason?: string }>}
 */
export function normalizeBaseline(baseline) {
  const out = new Map();
  const u = baseline?.unrouted;
  if (Array.isArray(u)) for (const f of u) out.set(f, { count: Number.POSITIVE_INFINITY });
  else if (u && typeof u === 'object') for (const [f, v] of Object.entries(u)) out.set(f, v);
  return out;
}

/**
 * Run the repo-wide spawn-isolation scan.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {{ baseline?: object, roots?: string[], helpers?: string[] }} [opts]
 *   `baseline` overrides the baseline read from `BASELINE_REL` under the workspace root (a
 *   workspace without that file has an empty baseline); `roots` limits the scan (and
 *   the stale-entry check) to those workspace-relative directories.
 * @returns {{ violations: Array<{ rule: string, detail: string }>, scanned: number }}
 */
export function collectSpawnIsolationViolations(workspaceRoot, opts = {}) {
  const roots = opts.roots ?? DEFAULT_ROOTS;
  const helpers = opts.helpers ?? ISOLATION_HELPERS;
  const baselinePath = join(workspaceRoot, BASELINE_REL);
  const baseline = opts.baseline ?? (existsSync(baselinePath) ? readJsonFile(baselinePath, workspaceRoot) : {});
  const known = normalizeBaseline(baseline);
  const violations = [];
  const unroutedCount = new Map();
  let scanned = 0;
  let envPackages = 0;
  let rootsPresent = 0;

  // Tolerated unrouted count per baselined file. A valid entry carries a positive integer
  // `count`; anything else (a null or non-object entry, a missing/zero/fractional count) is
  // reported and tolerates nothing. `Infinity` is only the legacy array form's sentinel.
  const tolerance = new Map();
  for (const [file, entry] of known) {
    const count = entry !== null && typeof entry === 'object' ? entry.count : undefined;
    if (count === Number.POSITIVE_INFINITY) {
      tolerance.set(file, count);
    } else if (Number.isInteger(count) && count > 0) {
      tolerance.set(file, count);
    } else {
      tolerance.set(file, 0);
      violations.push({
        rule: 'spawn-isolation-baseline-invalid',
        detail: `${file} — spawn-isolation.baseline.json entry needs a positive integer "count"; got ${JSON.stringify(entry) ?? String(entry)}.`,
      });
    }
  }

  for (const root of roots) {
    if (!existsSync(join(workspaceRoot, root))) continue;
    rootsPresent += 1;
    for (const f of globScan(join(workspaceRoot, root), '**/package.json')) {
      const pkg = readJsonFile(join(workspaceRoot, root, f), workspaceRoot);
      if (usesEnvironmentFamily(pkg)) envPackages += 1;
    }
    for (const f of globScan(join(workspaceRoot, root), '**/*.*')) {
      if (!SPEC_FILE.test(f)) continue;
      const rel = `${root}/${f}`;
      const owner = owningPackage(workspaceRoot, rel);
      if (!owner || !usesEnvironmentFamily(owner.pkg)) continue;
      scanned += 1;
      const sites = findUnroutedSpawnSites(readFileSync(join(workspaceRoot, rel), 'utf8'), helpers);
      if (sites.length === 0) continue;
      unroutedCount.set(rel, sites.length);
      const allowed = tolerance.get(rel) ?? 0;
      if (sites.length <= allowed) continue;
      const where = sites.map((s) => `${rel}:${s.line} (${s.callee})`).join(', ');
      violations.push({
        rule: 'spawn-isolation-unrouted',
        detail:
          allowed > 0
            ? `${rel} — ${sites.length} unrouted node-bin spawn site(s), baseline allows ${allowed}; a new unrouted site was added. Sites: ${where}. Route each through an isolation helper (spawn-isolated-bin or spawn-backlog-bin) or set an explicit HOME in the child env (backlog 0945d1b9 AC1).`
            : `${rel} — spawns a node bin without an isolation helper or an explicit HOME override in the call: ${where}. Route the spawn through an isolation helper (spawn-isolated-bin or spawn-backlog-bin) or set an explicit HOME in the child env (backlog 0945d1b9 AC1).`,
      });
    }
  }

  if (rootsPresent > 0 && envPackages > 0 && scanned === 0) {
    violations.push({
      rule: 'spawn-isolation-scan-found-nothing',
      detail: `${workspaceRoot} — found ${envPackages} @adhd/environment-family package(s) but ZERO spec/test/e2e files scanned; the walker is broken.`,
    });
  }

  for (const [rel, count] of tolerance) {
    const underScannedRoot = roots.some((root) => rel.startsWith(`${root}/`));
    if (!underScannedRoot || !(count > 0)) continue;
    const now = unroutedCount.get(rel) ?? 0;
    if (count === Number.POSITIVE_INFINITY ? now === 0 : now < count) {
      violations.push({
        rule: 'spawn-isolation-baseline-stale',
        detail: `${rel} — spawn-isolation.baseline.json allows ${count} unrouted site(s) but only ${now} remain (routed, moved, renamed or deleted); ${now === 0 ? 'remove the entry' : `lower the count to ${now}`}.`,
      });
    }
  }

  return { violations, scanned };
}

function isEntry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

function main() {
  const i = process.argv.indexOf('--workspace-root');
  const workspaceRoot = i >= 0 ? resolve(process.argv[i + 1]) : REPO_ROOT;
  const b = process.argv.indexOf('--baseline');
  const baseline = b >= 0 ? JSON.parse(readFileSync(resolve(process.argv[b + 1]), 'utf8')) : undefined;
  let result;
  try {
    result = collectSpawnIsolationViolations(workspaceRoot, { baseline });
  } catch (err) {
    console.error(`✖ spawn-isolation check FAILED: ${err.message}`);
    process.exit(1);
  }
  const { violations, scanned } = result;
  if (violations.length > 0) {
    console.error('✖ spawn-isolation check FAILED:');
    for (const v of violations) console.error(`   [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log(
    `✓ spawn-isolation OK — ${scanned} spec/e2e file(s) in @adhd/environment-family packages checked; every node spawn site is routed or within its baseline count.`,
  );
}

if (isEntry()) main();
