#!/usr/bin/env node
/**
 * check-no-credentials.js — pre-commit credential gate.
 *
 * Scans the STAGED content of a commit (not the working tree) for:
 *   1. forbidden PATHS   — artifacts known to embed resolved secret values
 *   2. forbidden CONTENT — high-signal credential patterns
 *
 * Exit 0 = clean. Exit 1 = blocked. Exit 2 = the check itself could not run
 * (missing git, unreadable index) — a hard failure, never a silent skip.
 *
 * Design notes (see BACKLOG ENV-CORE-009..011):
 *  - `@adhd/environment` writes `adhd-environment.json` snapshots containing
 *    `config` + `raw`, i.e. FULLY RESOLVED values including fields marked
 *    `secret: true`. There is no redaction anywhere in that package family.
 *    `atomicWrite` also leaves a `<file>.tmp` behind on a mid-write crash.
 *    Both are blocked by path here regardless of content.
 *  - We NEVER print a matched secret's value — only file, line, and the name
 *    of the rule that fired. Printing it would leak it into terminal
 *    scrollback, CI logs, and this hook's own error output.
 *  - Escape hatch, per line: append `pragma: allowlist secret`. Deliberate,
 *    reviewable, and greppable. There is no blanket directory allowlist —
 *    exempting `__tests__/` wholesale is exactly how real keys hide in fixtures.
 *
 * Zero dependencies: no gitleaks/trufflehog/secretlint install required
 * (CLAUDE.md forbids installing external tools without human approval).
 * If `gitleaks` is on PATH we additionally defer to it, but its ABSENCE is
 * never a reason to pass.
 */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWLIST_PRAGMA = /pragma:\s*allowlist secret/i;

/**
 * Modes. The SAME rule table runs locally and in CI (and now the
 * `source:secret-scan` nx target both wrap), so a commit that passes the
 * hook cannot fail differently on a PR.
 *
 *   (none) | --staged      scan the git index              (pre-commit)
 *   --range <base> <head>  scan the diff base..head        (CI on a PR)
 *   --all                  scan every tracked file         (audit / backfill)
 *
 * @param {string[]} argv arguments after the script name, e.g. `process.argv.slice(2)`
 */
function parseMode(argv) {
  const a = argv;
  if (a.length === 0 || a[0] === '--staged') return { kind: 'staged' };
  if (a[0] === '--all') return { kind: 'all' };
  if (a[0] === '--range') {
    if (!a[1] || !a[2]) {
      return { kind: 'error', message: 'usage: check-no-credentials.js --range <base> <head>' };
    }
    return { kind: 'range', base: a[1], head: a[2] };
  }
  return {
    kind: 'error',
    message: `unknown argument: ${a[0]}\nusage: check-no-credentials.js [--staged | --range <base> <head> | --all]`,
  };
}

/** Files that must never be committed, matched against the repo-relative path. */
const FORBIDDEN_PATHS = [
  {
    name: 'environment-snapshot',
    // <adhdRoot>/<org>/<project>/<namespace>/adhd-environment.json  + its .tmp
    re: /(^|\/)adhd-environment\.json(\.tmp)?$/,
    why: 'resolved @adhd/environment snapshot — contains plaintext values for fields marked `secret: true`',
  },
  {
    name: 'dotenv',
    re: /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/,
    why: 'dotenv file',
    // .env.example / .env.sample / .env.template are the documented, value-less templates
    except: /(^|\/)\.env\.(example|sample|template)$/,
  },
  {
    name: 'private-key-file',
    re: /\.(pem|p12|pfx|key|keystore|jks)$/i,
    why: 'private key / keystore material',
  },
  {
    name: 'credential-store',
    re: /(^|\/)(credentials|\.netrc|\.npmrc|\.pypirc)$/,
    // The workspace-root `.npmrc` holds ONLY pnpm resolution settings
    // (node-linker, link-workspace-packages, …) — no auth. Exempt it from this
    // coarse PATH rule; the precise `npmrc-auth-token` CONTENT rule below still
    // scans it (and every file) for a real `//registry/:_authToken=` leak, so
    // an actual token committed here is still blocked. Only the vetted root
    // `.npmrc` is exempt — nested `.npmrc`/`.netrc`/`.pypirc` still trip.
    except: /^\.npmrc$/,
    why: 'credential store',
  },
];

/**
 * High-signal content rules. Deliberately biased toward provider-issued key
 * shapes over generic entropy: entropy heuristics on a monorepo full of hashes,
 * lockfiles, and test vectors produce noise, and a noisy gate gets bypassed.
 */
const CONTENT_RULES = [
  { name: 'aws-access-key-id', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'anthropic-api-key', re: /\bsk-ant-(?:api|admin)[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'crates-io-token', re: /\bcio[A-Za-z0-9]{32,}\b/ },
  { name: 'pypi-token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  {
    // `//<registry>/:_authToken=<literal>` in ANY file, not just one named `.npmrc`.
    // A FontAwesome Pro token lived at `.github/scripts/setup-npmrc.sh:6` and reached
    // origin/main on a PUBLIC repo. The `credential-store` PATH rule never fired
    // because the file is a shell script, and `generic-secret-assignment` requires
    // quotes around the value. Only gitleaks caught it. See BACKLOG ENV-SEC-001.
    name: 'npmrc-auth-token',
    re: /_authToken\s*=\s*(?!\$\{)(?!\$[A-Za-z_])[A-Za-z0-9._-]{16,}/,
  },
  {
    // Nx Cloud token — grants remote-cache WRITE access, i.e. arbitrary build-output
    // poisoning. Leaked via `nx.json` on origin/main. See BACKLOG ENV-SEC-002.
    name: 'nx-cloud-access-token',
    re: /["']?nxCloudAccessToken["']?\s*[:=]\s*["'](?!\$)[A-Za-z0-9_-]{16,}["']/,
  },
  {
    // ADHD_AGENT_* deployment secrets (see BACKLOG ENV-PLAN-007). Name-only is
    // fine (docs reference them constantly); an ASSIGNED non-empty literal is not.
    name: 'adhd-agent-secret-assignment',
    re: /\bADHD_AGENT_[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)\s*[=:]\s*["']?(?!\s*$)(?!\$\{)(?!process\.env)(?!os\.environ)[^\s"'#,}]{8,}/,
  },
  {
    // Generic assignment with a long, non-placeholder literal.
    name: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[=:]\s*["'][^"'\s]{16,}["']/i,
  },
];

/** Obvious non-secrets that would otherwise trip `generic-secret-assignment`. */
/**
 * Also excludes *indirection*: a value that is a shell/env variable reference
 * (`"$LMSTUDIO_KEY"`, `"${FOO}"`, `process.env.X`) is a pointer to a secret,
 * not a secret. Real history contained `API_KEY="$LMSTUDIO_..."`, which the
 * generic rule flagged until this was added.
 */
// NOTE the deliberate absence of a TRAILING `\b` on the word alternatives.
// With one, `changeme123`, `example_key_…`, and `placeholder_x` all FAIL to
// match — a word boundary needs a non-word char after the token — so the most
// common placeholder shapes in real code were flagged as live secrets. A noisy
// gate gets bypassed, and a bypassed gate catches nothing. The LEADING `\b` is
// kept so `myexample` still doesn't match. (Verified by the false-positive
// suite: `password = "changeme123"` must pass.)
const PLACEHOLDER =
  /(\bsk-test|\bsk-fake|\btest[_-]?key|\bdummy|\bexample|\bplaceholder|\bredacted|\bchangeme|\bx{3,}|\byour[_-]|<[^>]+>|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|process\.env|os\.environ|std::env|import\.meta\.env)/i;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Candidate (non-deleted) paths for the active mode. */
function candidatePaths(mode) {
  if (mode.kind === 'staged') {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  }
  if (mode.kind === 'range') {
    return git(['diff', '--name-only', '--diff-filter=ACMR', '-z', mode.base, mode.head])
      .split('\0')
      .filter(Boolean);
  }
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function sanitize(buf) {
  if (!buf) return null;
  // Skip binary: a NUL in the first 8KB is git's own heuristic.
  if (buf.subarray(0, 8192).includes(0)) return null;
  if (buf.length > 4 * 1024 * 1024) return null; // oversized: not a credential file
  return buf.toString('utf8');
}

/**
 * Content of `p` AS IT WILL EXIST at the scanned revision — never the worktree
 * for staged/range mode. Reading the worktree would let a staged secret hide
 * behind an unstaged edit.
 */
function contentAt(mode, p) {
  if (mode.kind === 'all') {
    try {
      return sanitize(fs.readFileSync(p));
    } catch {
      return null;
    }
  }
  const rev = mode.kind === 'staged' ? `:0:${p}` : `${mode.head}:${p}`;
  const r = spawnSync('git', ['show', rev], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return sanitize(r.stdout);
}

/**
 * Run gitleaks over the same surface. gitleaks exits 1 BOTH for "leaks found"
 * and for its own errors (bad config, bad revision), so the exit code alone is
 * ambiguous — we key on its log line instead and escalate a tool error to exit 2
 * rather than mistaking it for a finding (or, worse, for a pass).
 */
function runGitleaks(mode, repoRoot) {
  const args = ['git', '--redact', '--no-banner'];
  const cfg = path.join(repoRoot, '.gitleaks.toml');
  if (fs.existsSync(cfg)) args.push('--config', cfg);
  if (mode.kind === 'staged') args.push('--staged');
  else if (mode.kind === 'range') args.push('--log-opts', `${mode.base}..${mode.head}`);

  const gl = spawnSync('gitleaks', args, { encoding: 'utf8' });

  if (gl.error && gl.error.code === 'ENOENT') return { ran: false };

  const out = `${gl.stdout || ''}${gl.stderr || ''}`;
  if (/no leaks found/i.test(out)) return { ran: true, leaks: false };
  if (/leaks found:\s*\d+/i.test(out)) return { ran: true, leaks: true };
  if (gl.status !== 0) return { ran: true, toolError: out.trim().split('\n').slice(-3).join('\n') };
  return { ran: true, leaks: false };
}

/**
 * Run the scan and return the intended process exit code — never calls
 * `process.exit` itself, so it is safe to `require()` and call in-process
 * (e.g. from the `@adhd/nx-secret-scan:scan` executor) without tearing down
 * the host process. Only the `require.main === module` guard at the bottom
 * of this file converts the return value into a real `process.exit`.
 *
 * @param {string[]} [argv] arguments after the script name, e.g. `['--staged']`
 * @returns {number} 0 = clean, 1 = blocked, 2 = the check itself could not run
 */
function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  if (mode.kind === 'error') {
    console.error(mode.message);
    return 2;
  }

  // CI (and any caller) sets this. A missing `gitleaks` binary then becomes a
  // HARD FAILURE instead of a quiet downgrade to pattern-only scanning: a
  // scanner that isn't there must never be indistinguishable from a scanner
  // that found nothing.
  const requireGitleaks = process.env.SECRET_SCAN_REQUIRE_GITLEAKS === '1';

  let repoRoot;
  let paths;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel']).trim();
    paths = candidatePaths(mode);
  } catch (e) {
    console.error(`✖ secret-scan: cannot read git state — refusing to pass.\n  ${e.message}`);
    return 2;
  }
  if (paths.length === 0) {
    console.log('✓ secret-scan: nothing to scan.');
    return 0;
  }

  const findings = [];

  // ── 1. forbidden paths ────────────────────────────────────────────────────
  for (const p of paths) {
    const posix = p.split(path.sep).join('/');
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.except && rule.except.test(posix)) continue;
      if (rule.re.test(posix)) {
        findings.push({ file: p, line: 0, rule: `path:${rule.name}`, why: rule.why });
      }
    }
  }

  // ── 2. forbidden content ──────────────────────────────────────────────────
  for (const p of paths) {
    // These files DEFINE the patterns being hunted. Without the exemption the
    // scanner flags itself and can never be committed.
    if (posixEq(p, '.githooks/check-no-credentials.js')) continue;
    if (posixEq(p, '.gitleaks.toml')) continue;
    const content = contentAt(mode, p);
    if (content === null) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4096) continue; // minified/bundled
      if (ALLOWLIST_PRAGMA.test(line)) continue;

      for (const rule of CONTENT_RULES) {
        if (!rule.re.test(line)) continue;
        if (rule.name === 'generic-secret-assignment' && PLACEHOLDER.test(line)) continue;
        if (rule.name === 'adhd-agent-secret-assignment' && PLACEHOLDER.test(line)) continue;
        findings.push({ file: p, line: i + 1, rule: rule.name, why: 'matched a credential pattern' });
      }
    }
  }

  // ── 3. gitleaks — authoritative when present ──────────────────────────────
  const gl = runGitleaks(mode, repoRoot);

  if (gl.toolError) {
    console.error('\n✖ secret-scan: gitleaks failed to run — refusing to pass.\n');
    console.error(gl.toolError.replace(/^/gm, '  '));
    console.error('\n  A scanner that errored is NOT a scanner that found nothing.\n');
    return 2;
  }
  if (!gl.ran && requireGitleaks) {
    console.error('\n✖ secret-scan: gitleaks is REQUIRED here but is not installed.');
    console.error('  Hard failure by design — a missing scanner must never look like a pass.\n');
    return 2;
  }
  if (gl.leaks) {
    findings.push({ file: '(gitleaks)', line: 0, rule: 'gitleaks', why: 'gitleaks flagged the scanned revision' });
  }

  if (findings.length > 0) {
    console.error('\n✖ secret-scan: possible credential leak — BLOCKED.\n');
    for (const f of findings) {
      const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      console.error(`  [${f.rule}] ${loc}`);
      console.error(`      ${f.why}`);
    }
    console.error('\n  Values are never printed here. Open the file to inspect.');
    console.error('  If a match is genuinely not a secret, append this to the line:');
    console.error('      pragma: allowlist secret');
    console.error('  Emergency bypass (leaves the secret in history): git commit --no-verify\n');
    return 1;
  }

  if (!gl.ran) {
    console.warn('! secret-scan: gitleaks not installed — built-in pattern rules only (reduced coverage).');
    console.warn('  Install for full coverage:  brew install gitleaks');
  }
  console.log(
    `✓ secret-scan: no credentials in ${paths.length} file(s) [${mode.kind}]` +
      (gl.ran ? ' (gitleaks + built-in rules)' : ' (built-in rules only)'),
  );
  return 0;
}

function posixEq(p, target) {
  return p.split(path.sep).join('/') === target;
}

module.exports = { main };

// Only run as a CLI when invoked directly (`node check-no-credentials.js ...`)
// — not when `require()`d in-process (e.g. by the `@adhd/nx-secret-scan:scan`
// executor, or a test).
if (require.main === module) {
  process.exit(main());
}
