/**
 * retry-scan — fails any runner configuration that sets a retry without a tracking item (T36.AC3, G5).
 *
 * A retry turns a flake into a pass, so it hides exactly the signal G5 exists to report. It is allowed only when it
 * names an item and an expiry on the same line or in the comment lines directly above:
 *   `// retry-ok: <8 hex> until YYYY-MM-DD <reason>`
 *
 * WHAT IS SCANNED. Git-tracked runner configs (`vitest*.config.*`, `vite.config.*`, `vitest.workspace.*`,
 * `playwright.config.*`, `jest.config.*`) for `retry: N` (N > 0 or true) and `retries: N` (N > 0), and the command
 * strings of tracked `package.json` and `project.json` for `--retry` / `--retries` with a non-zero value. Comment
 * lines are not settings. A retry whose date has passed is a violation, as is one with no annotation.
 *
 * usage: retry-scan.mjs [--workspace-root <dir>]      exit: 0 clean, 1 violation
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = /(^|\/)(vitest[^/]*\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s)$/;
const MANIFEST_FILE = /(^|\/)(package|project)\.json$/;
const SKIP_DIRS = /(^|\/)(node_modules|dist|\.worktrees|\.claude|\.nx|\.git)(\/|$)/;
const SETTING = /\b(?:retry\s*:\s*(?:true|[1-9]\d*)|retries\s*:\s*[1-9]\d*)\b/;
const FLAG = /--retr(?:y|ies)(?:[= ]+(?!0\b)(?:\d+|true))/;
const OK = /retry-ok:\s*([0-9a-f]{8})\s+until\s+(\d{4}-\d{2}-\d{2})/;

const isComment = (line) => /^\s*(\/\/|\*|\/\*|#)/.test(line);

/**
 * Violations in one file's text.
 * @param {string} src
 * @param {{ manifest?: boolean, today?: string }} [opts] `manifest` reads command strings (JSON) instead of config code
 * @returns {{ line: number, rule: 'retry-unannotated'|'retry-expired', text: string }[]}
 */
export function scanRetries(src, { manifest = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = src.split('\n');
  const found = [];
  lines.forEach((text, i) => {
    if (isComment(text)) return;
    if (!(manifest ? FLAG.test(text) : SETTING.test(text))) return;
    // The annotation is on this line or in the unbroken run of comment lines directly above it.
    let note = OK.exec(text);
    for (let j = i - 1; !note && j >= 0 && isComment(lines[j]); j--) note = OK.exec(lines[j]);
    if (!note) found.push({ line: i + 1, rule: 'retry-unannotated', text: text.trim() });
    else if (note[2] < today || Number.isNaN(Date.parse(`${note[2]}T00:00:00Z`))) found.push({ line: i + 1, rule: 'retry-expired', text: text.trim() });
  });
  return found;
}

/** Scan every tracked runner config and manifest under `root`. */
export function scanWorkspace(root, { today } = {}) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const out = [];
  for (const f of files) {
    if (SKIP_DIRS.test(f)) continue;
    const config = CONFIG_FILE.test(f);
    if (!config && !MANIFEST_FILE.test(f)) continue;
    let src;
    try {
      src = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    for (const v of scanRetries(src, { manifest: !config, today })) out.push({ file: f, ...v });
  }
  return out;
}

function main(argv) {
  const i = argv.indexOf('--workspace-root');
  const root = i === -1 ? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..') : resolve(argv[i + 1]);
  const violations = scanWorkspace(root);
  for (const v of violations) process.stderr.write(`retry-scan: ${v.file}:${v.line} ${v.rule}: ${v.text}\n  name an item and a date: // retry-ok: <8 hex> until YYYY-MM-DD <reason>, or remove the retry (G5)\n`);
  process.stdout.write(`retry-scan: ${violations.length === 0 ? 'no untracked retry in any runner config' : `${violations.length} violation(s)`}\n`);
  return violations.length ? 1 : 0;
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) process.exit(main(process.argv.slice(2)));
