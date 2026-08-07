#!/usr/bin/env node
/**
 * detect-mass-deletion.js — pre-commit "did I just write stale content back
 * over already-fixed files" gate (BUG-ADHD-EE8D24C8-REVERT-001).
 *
 * PROVEN INCIDENT (root cause this guards against): `git update-ref
 * refs/heads/main <merge-sha>` moved main's ref WITHOUT touching its working
 * tree or index. Every file the merge had fixed then showed as modified-or-
 * deleted in the working tree. ~9 minutes later a separate session ran a
 * broad "commit pre-existing in-progress work found uncommitted in main's
 * working tree" and committed that STALE content back over the merge
 * (`ee8d24c8`: 39 files, 630 insertions, 1399 DELETIONS, `--no-verify`) —
 * destroying 4 files (including 2 regression tests) and silently reverting
 * 12 already-reviewed backlog fixes. The signature is simple and would have
 * caught it: "this commit deletes far more than it adds, across many files
 * that already existed at HEAD/base — confirm intent."
 *
 * WHAT THIS DOES: computes `git diff --numstat <base> <target>` and flags a
 * commit/range whose aggregate shape is dominated by deletions of files that
 * already existed at `<base>` — many files, large deletion count, deletions
 * far exceeding insertions. It is deliberately a coarse, cheap, structural
 * signal (line-count shape), not a content-aware diff — the exact incident
 * above didn't need content awareness, only "did we just delete way more
 * than we added, broadly."
 *
 * MODES (mirrors check-no-credentials.js's mode contract):
 *   --staged                 diff HEAD..index (pre-commit; BLOCKING)
 *   --range <base> <target>  diff base..target (post-commit/CI; REPORT-ONLY
 *                            by the caller's choice — this script itself
 *                            only classifies, exit code semantics are the
 *                            same for both, callers decide whether to warn
 *                            or refuse)
 *
 * EXIT CODES: 0 = clean. 1 = mass-deletion shape detected, not acknowledged
 * — BLOCKED. 2 = the check itself could not run (git failure) — a hard
 * failure, never a silent pass.
 *
 * ACKNOWLEDGEMENT ESCAPE HATCH: set `ADHD_CONFIRM_MASS_DELETE=1` in the
 * environment of the `git commit` invocation. Deliberately NOT a commit-
 * message trailer — pre-commit runs BEFORE the commit message is finalized,
 * so no trailer exists yet to read. This is explicit, visible in shell
 * history, and impossible to trigger by accident.
 *
 * DOES THIS SURVIVE `--no-verify`? NO. `--no-verify` skips pre-commit (and
 * commit-msg) entirely — no local hook can prevent that; it is git's own,
 * by-design bypass. `ee8d24c8` itself used `--no-verify`, so this exact gate
 * would NOT have blocked it in the moment. What it changes: `post-commit`
 * (wired below in `.githooks/post-commit`) ALWAYS runs, even after
 * `--no-verify` — it cannot block (the commit already exists) but it prints
 * a loud, impossible-to-miss warning immediately after the commit lands,
 * closing the ~9-minute silent window the real incident had. A local hook
 * can never fully close the `--no-verify` gap; the only guard that can is a
 * server-side check (pre-receive / branch-protection CI) — see this
 * script's companion backlog item for that follow-up.
 */
'use strict';

const { execFileSync } = require('node:child_process');

const DEFAULT_MIN_FILES = 5;
const DEFAULT_MIN_DELETIONS = 100;
const DEFAULT_RATIO = 1.5;

/**
 * @param {string[]} argv
 */
function parseMode(argv) {
  const a = argv;
  if (a.length === 0 || a[0] === '--staged') return { kind: 'staged' };
  if (a[0] === '--range') {
    if (!a[1] || !a[2]) return { kind: 'error', message: 'usage: detect-mass-deletion.js --range <base> <target>' };
    return { kind: 'range', base: a[1], target: a[2] };
  }
  return { kind: 'error', message: `unknown argument: ${a[0]}\nusage: detect-mass-deletion.js [--staged | --range <base> <target>]` };
}

/**
 * Run `git diff --numstat` for the given mode and return per-file stats.
 * @param {ReturnType<typeof parseMode>} mode
 * @param {{ cwd?: string }} [opts]
 * @returns {{ file: string, insertions: number, deletions: number, binary: boolean }[]}
 */
function numstat(mode, opts = {}) {
  const args = ['diff', '--numstat'];
  if (mode.kind === 'staged') args.push('--cached');
  else args.push(`${mode.base}..${mode.target}`);
  const out = execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ins, del, ...fileParts] = line.split('\t');
      const file = fileParts.join('\t');
      const binary = ins === '-' || del === '-';
      return { file, insertions: binary ? 0 : Number(ins), deletions: binary ? 0 : Number(del), binary };
    });
}

/**
 * Pure classifier — takes numstat rows, returns a verdict. Exhaustively
 * unit-testable without git.
 * @param {{file:string,insertions:number,deletions:number,binary:boolean}[]} rows
 * @param {{ minFiles?: number, minDeletions?: number, ratio?: number }} [thresholds]
 */
function classify(rows, thresholds = {}) {
  const minFiles = thresholds.minFiles ?? DEFAULT_MIN_FILES;
  const minDeletions = thresholds.minDeletions ?? DEFAULT_MIN_DELETIONS;
  const ratio = thresholds.ratio ?? DEFAULT_RATIO;

  const totalInsertions = rows.reduce((s, r) => s + r.insertions, 0);
  const totalDeletions = rows.reduce((s, r) => s + r.deletions, 0);
  const filesWithDeletions = rows.filter((r) => r.deletions > 0);

  const massDeletion =
    filesWithDeletions.length >= minFiles && totalDeletions >= minDeletions && totalDeletions > totalInsertions * ratio;

  return {
    filesChanged: rows.length,
    filesWithDeletions: filesWithDeletions.length,
    totalInsertions,
    totalDeletions,
    massDeletion,
    thresholds: { minFiles, minDeletions, ratio },
  };
}

/**
 * @param {string[]} [argv]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, thresholds?: object }} [opts]
 * @returns {number} exit code
 */
function main(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env || process.env;
  const mode = parseMode(argv);
  if (mode.kind === 'error') {
    console.error(mode.message);
    return 2;
  }

  let rows;
  try {
    rows = numstat(mode, opts);
  } catch (err) {
    console.error(`✖ detect-mass-deletion: could not compute diff (${err.message}).`);
    console.error('  A check that cannot run is a hard failure, never a silent pass.');
    return 2;
  }

  const verdict = classify(rows, opts.thresholds);

  if (!verdict.massDeletion) {
    console.log(
      `✓ detect-mass-deletion: no mass-deletion shape (${verdict.filesChanged} file(s), ` +
        `+${verdict.totalInsertions}/-${verdict.totalDeletions}) [${mode.kind}]`
    );
    return 0;
  }

  const confirmed = env.ADHD_CONFIRM_MASS_DELETE === '1';
  const header =
    `${confirmed ? '!' : '✖'} detect-mass-deletion: this ${mode.kind === 'staged' ? 'commit' : 'range'} deletes ` +
    `${verdict.totalDeletions} lines across ${verdict.filesWithDeletions} file(s) that already existed — ` +
    `only +${verdict.totalInsertions} inserted.`;
  console.error(`\n${header}`);
  console.error('  This is the exact shape of BUG-ADHD-EE8D24C8-REVERT-001: a stale working tree');
  console.error('  (e.g. after `git update-ref` moved a branch without updating the tree) committed');
  console.error('  back OVER already-fixed files, silently destroying them.');
  console.error('\n  Files with the largest deletions:');
  for (const r of [...rows].sort((a, b) => b.deletions - a.deletions).slice(0, 10)) {
    if (r.deletions > 0) console.error(`    -${r.deletions} +${r.insertions}  ${r.file}`);
  }

  if (confirmed) {
    console.error('\n  ADHD_CONFIRM_MASS_DELETE=1 is set — proceeding (acknowledged).\n');
    return 0;
  }

  console.error('\n  If this is genuinely intentional (a real revert/cleanup you mean to make),');
  console.error('  re-run with the explicit acknowledgement:');
  console.error('      ADHD_CONFIRM_MASS_DELETE=1 git commit ...');
  console.error('  Otherwise: `git status`, verify HEAD actually matches your working tree');
  console.error('  (`git diff HEAD --stat`), and if it does not, do NOT commit — restore first.');
  console.error('  Emergency bypass (skips this AND every other pre-commit gate): git commit --no-verify\n');
  return 1;
}

module.exports = { main, classify, numstat, parseMode };

if (require.main === module) {
  process.exit(main());
}
