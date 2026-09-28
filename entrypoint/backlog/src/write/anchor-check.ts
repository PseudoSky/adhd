/**
 * anchor-check.ts — the cheap-first mechanical anchor ladder (C3, DESIGN §2
 * Primitive 2).
 *
 * An attestation's `anchor` is a `locator + digest`. This module parses the
 * closed locator grammar and resolves a `path:` anchor against the subject
 * project's git work tree, in the cheapest useful order:
 *
 *   1. `existsAtHead`      — `git cat-file -e HEAD:<relpath>` (exit 0 =
 *      present). No file read, no network, no agent.
 *   2. `changedSinceFiling`— `git log --since=<t> -- <relpath>` non-empty.
 *   3. full re-resolve     — ONLY when `opts.full` is set (`recheck`, and the
 *      verdict's own rung 5): hash the HEAD blob and compare to the anchor's
 *      `digest`.
 *
 * Every outcome carries the rung that produced it (`method`), so `verified` /
 * `stale` / `unknown` / `unverified` are EXPLICIT states with a `reason` —
 * never an absent field, never a silent success.
 *
 * The whole module is pure with respect to the store (no writes); it shells to
 * the local `git` CLI the repo already uses. A missing `git`, a non-repo root,
 * or an unresolvable path degrades to `unknown`, never a thrown exception —
 * `unknown` is a first-class value here (Wikidata deprecate-with-reason, C2PA
 * claim-vs-assertion). `refuted` is deliberately absent: a mechanical anchor
 * proves present/matching/stale/absent only, never "the claim is contradicted".
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { AnchorLocatorInvalidError } from './errors.js';

/** The closed set of mechanical-check states. `refuted` is deliberately absent (see module header). */
export type AttestationCheckState =
  | 'unverified'
  | 'verified'
  | 'stale'
  | 'unknown';

/**
 * One rung-result of the anchor ladder. `method` names which rung actually ran
 * (`'exists_at_head'` | `'changed_since'` | `'full_resolve'` | `'none'`), so a
 * cheap pre-filter can be proven cheap (AC7) and a full re-resolve is visible.
 */
export interface IAttestCheck {
  state: AttestationCheckState;
  method: string;
  checked_at: string;
  checked_by: string;
  reason?: string;
}

/**
 * An anchor is `locator + digest`. The locator grammar is closed:
 * `path:<file>[:<line>]` | `url:<url>` | `query:<cql>` | `registry:<ref>` |
 * `commit:<sha>` (C5: ancestry of the default branch).
 * A bare hand-maintained `path:line` is INSUFFICIENT without a `digest` — the
 * digest is the whole point of content-addressing the claim.
 */
export interface IAttestationAnchor {
  locator: string;
  digest: string;
}

/** The parsed form of a locator (one arm per grammar production). */
export type IParsedAnchor =
  | { scheme: 'path'; target: string; line?: number }
  | { scheme: 'url'; target: string }
  | { scheme: 'query'; target: string }
  | { scheme: 'registry'; target: string }
  | { scheme: 'commit'; target: string }
  // C10: `revision:<revision uid>` — the anchor of a spec-revision ANNOTATION
  // (`spec-annotation.ts`). Immutable by construction (a revision never
  // changes), so its "digest" is the revision's own `sha256:<hex>` token.
  | { scheme: 'revision'; target: string };

/**
 * The closed set of locator SCHEMES the grammar names (C3 added
 * `path|url|query|registry`; C5 adds `commit:<sha>`; C10 adds `revision:<uid>`).
 * Kept as an exported alias so a consumer (the C5 gate) can branch on the
 * scheme without re-listing it.
 */
export type AnchorLocatorKind =
  | 'path'
  | 'url'
  | 'query'
  | 'registry'
  | 'commit'
  | 'revision';

/** Options for {@link checkAnchor}. */
export interface ICheckAnchorOptions {
  /** The subject project's root (git work tree) — absent means `unknown`. */
  root?: string;
  /** ISO filing time for the changed-since rung. Absent skips rung 2. */
  sinceISO?: string;
  /** Run the full re-resolve (rung 3: hash HEAD content and compare to `digest`). */
  full?: boolean;
  now: string;
  by: string;
}

const ANCHOR_SCHEMES = [
  'path',
  'url',
  'query',
  'registry',
  'commit',
  'revision',
] as const;

/**
 * Parse `locator` against the closed grammar, throwing
 * {@link AnchorLocatorInvalidError} for anything outside it (a blank locator,
 * an unknown scheme, an empty body). `path:` accepts an optional trailing
 * `:<digits>` line number; every other scheme carries its body verbatim.
 */
export function parseAnchor(locator: string): IParsedAnchor {
  if (typeof locator !== 'string' || locator.trim().length === 0) {
    throw new AnchorLocatorInvalidError(locator, 'locator is required');
  }
  const colon = locator.indexOf(':');
  if (colon < 1) {
    throw new AnchorLocatorInvalidError(
      locator,
      `expected one of ${ANCHOR_SCHEMES.map((s) => `"${s}:"`).join(', ')}`
    );
  }
  const scheme = locator.slice(0, colon);
  const body = locator.slice(colon + 1);
  if (!(ANCHOR_SCHEMES as readonly string[]).includes(scheme)) {
    throw new AnchorLocatorInvalidError(
      locator,
      `unknown scheme "${scheme}" — expected one of ${ANCHOR_SCHEMES.map(
        (s) => `"${s}:"`
      ).join(', ')}`
    );
  }
  if (body.trim().length === 0) {
    throw new AnchorLocatorInvalidError(
      locator,
      `"${scheme}:" anchor has an empty body`
    );
  }
  if (scheme === 'path') {
    const match = /^(.*?)(?::(\d+))?$/.exec(body);
    const file = match?.[1] ?? body;
    if (file.trim().length === 0) {
      throw new AnchorLocatorInvalidError(locator, 'path anchor names no file');
    }
    const line = match?.[2] === undefined ? undefined : Number(match[2]);
    return line === undefined
      ? { scheme: 'path', target: file }
      : { scheme: 'path', target: file, line };
  }
  return { scheme, target: body } as IParsedAnchor;
}

interface IGitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git` in `cwd`, NEVER throwing: a non-zero exit (including a missing
 * `git` binary) is returned as `{ status, stdout, stderr }` with no throw, so
 * every caller can decide between `stale` and `unknown` rather than inheriting
 * a raw driver error. `status: -1` marks "could not even spawn git".
 */
function runGit(cwd: string, args: string[]): IGitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

/** Whether `root` is (inside) a git work tree — the precondition for rungs 1–3. */
export function isGitWorkTree(root: string): boolean {
  const r = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

/**
 * Rung 1 — is `relpath` present at `HEAD`? Exit 0 = present; any other exit
 * (missing object, not a repo) = not present. Cheap: no content is read.
 */
export function existsAtHead(root: string, relpath: string): boolean {
  return runGit(root, ['cat-file', '-e', `HEAD:${relpath}`]).status === 0;
}

/**
 * Rung 2 — did any commit touch `relpath` at/after `sinceISO`? `git log
 * --since` compares against committer date, so this is a genuine "has the
 * tracked file moved since we filed" probe with no content read.
 */
export function changedSinceFiling(
  root: string,
  relpath: string,
  sinceISO: string
): boolean {
  const r = runGit(root, [
    'log',
    '--oneline',
    `--since=${sinceISO}`,
    '--',
    relpath,
  ]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** The sha256 of the blob at `HEAD:<relpath>`, or `undefined` when unreadable. */
function digestAtHead(root: string, relpath: string): string | undefined {
  const r = runGit(root, ['cat-file', '-p', `HEAD:${relpath}`]);
  if (r.status !== 0) return undefined;
  return createHash('sha256').update(r.stdout).digest('hex');
}

/** The mechanical check a `commit:` anchor names — the one string every refusal carries as `performed_check`. */
export const DEFAULT_BRANCH_ANCESTOR_CHECK = 'default_branch_ancestor' as const;

/** The result of the default-branch check: whether `sha` is an ancestor of the resolved default branch, and the named check that produced it. */
export interface IDefaultBranchCheck {
  onDefaultBranch: boolean;
  performed: string;
}

/**
 * Resolve the repo's default branch NAME, or `undefined` when it cannot be
 * determined. An explicit `defaultBranch` wins; otherwise `origin/HEAD`
 * (`git symbolic-ref refs/remotes/origin/HEAD`, the cloned-repo convention)
 * is tried, then the currently checked-out branch. A detached HEAD reports
 * literally `"HEAD"`, which is not a branch — unresolved, so the caller
 * fails closed rather than guessing.
 */
function resolveDefaultBranch(
  root: string,
  defaultBranch?: string
): string | undefined {
  if (typeof defaultBranch === 'string' && defaultBranch.trim().length > 0) {
    return defaultBranch.trim();
  }
  const originHead = runGit(root, [
    'symbolic-ref',
    '-q',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead.status === 0) {
    const ref = originHead.stdout.trim();
    if (ref.length > 0) return ref.replace(/^origin\//, '');
  }
  const head = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = head.status === 0 ? head.stdout.trim() : '';
  if (name.length > 0 && name !== 'HEAD') return name;
  return undefined;
}

/**
 * The SYNC core of the default-branch check — `git merge-base --is-ancestor
 * <sha> <default>`. Sync because `checkAnchor` is sync and runs on `attest`'s
 * pre-transaction path; {@link isShaOnDefaultBranch} is the async face the
 * spec's `IGateRefusal.performed_check` consumer (the C5 gate) calls.
 *
 * **Fail-closed.** A missing `git`, a non-repo root, an unresolvable default
 * branch, or an unknown `sha` all return `onDefaultBranch: false` — never a
 * silent pass. `performed` is always {@link DEFAULT_BRANCH_ANCESTOR_CHECK}, so
 * a refusal can name the check whether it passed, failed, or could not run.
 */
function defaultBranchAncestorCheck(
  repoRoot: string,
  sha: string,
  defaultBranch?: string
): IDefaultBranchCheck {
  const performed = DEFAULT_BRANCH_ANCESTOR_CHECK;
  if (
    typeof sha !== 'string' ||
    sha.trim().length === 0 ||
    typeof repoRoot !== 'string' ||
    repoRoot.trim().length === 0
  ) {
    return { onDefaultBranch: false, performed };
  }
  if (!isGitWorkTree(repoRoot)) {
    return { onDefaultBranch: false, performed };
  }
  const branch = resolveDefaultBranch(repoRoot, defaultBranch);
  if (branch === undefined) {
    return { onDefaultBranch: false, performed };
  }
  // `--is-ancestor` exits 0 when <sha> is an ancestor of <branch>, 1 when it is
  // not, and >1 (documented as 128) on an unknown object/branch. Only exit 0 is
  // a pass; every other exit is fail-closed false.
  const result = runGit(repoRoot, ['merge-base', '--is-ancestor', sha.trim(), branch]);
  return { onDefaultBranch: result.status === 0, performed };
}

/**
 * Is `<sha>` an ancestor of the repo's default branch? Shells
 * `git merge-base --is-ancestor <sha> <default>`, exactly as C3's anchor ladder
 * shells `git cat-file`/`git log`. Returns `{onDefaultBranch:false,
 * performed:'default_branch_ancestor'}` when the repo or the branch cannot be
 * resolved (fail-closed, never a silent pass) — the `performed` field is
 * present in every outcome so the caller can name the mechanical check.
 */
export async function isShaOnDefaultBranch(
  repoRoot: string,
  sha: string,
  defaultBranch?: string
): Promise<IDefaultBranchCheck> {
  return defaultBranchAncestorCheck(repoRoot, sha, defaultBranch);
}

/**
 * Resolve an anchor's `path:` target to a repo-relative path, or `undefined`
 * when it escapes the root (a `..` traversal is not a repo path).
 */
function toRepoRelative(root: string, target: string): string | undefined {
  const absRoot = resolvePath(root);
  const abs = isAbsolute(target) ? resolvePath(target) : resolvePath(absRoot, target);
  const rel = relative(absRoot, abs);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return undefined;
  }
  return rel;
}

/**
 * Run the cheap-first ladder against `anchor` and return the rung-result.
 *
 * A non-`path` locator (`url:`/`query:`/`registry:`) has no mechanical checker
 * wired, so it is explicitly `unverified` — never an absent field. A `path:`
 * anchor with no resolvable root, or a root that is not a git work tree, is
 * `unknown` (a genuine "could not determine", distinct from "gone").
 *
 * Throws {@link AnchorLocatorInvalidError} (a caller-input mistake) when the
 * locator is outside the closed grammar; every other failure is a reported
 * state, not a throw.
 */
export function checkAnchor(
  anchor: IAttestationAnchor,
  opts: ICheckAnchorOptions
): IAttestCheck {
  const base = { checked_at: opts.now, checked_by: opts.by };
  const parsed = parseAnchor(anchor.locator);

  if (parsed.scheme === 'commit') {
    const root = opts.root;
    if (!root) {
      return {
        state: 'unknown',
        method: 'none',
        ...base,
        reason: 'no project root could be resolved for the subject',
      };
    }
    if (!isGitWorkTree(root)) {
      return {
        state: 'unknown',
        method: 'none',
        ...base,
        reason: `no git work tree at "${root}"`,
      };
    }
    // C5: a `commit:<sha>` anchor is mechanically checkable — is the sha an
    // ancestor of the default branch? `verified` when yes; `stale` when no
    // (the commit is not merged); the check names itself via `method` so a
    // refusal can carry `performed_check`. Fail-closed: an unresolvable
    // repo/branch is `unknown`, never a silent pass.
    const check = defaultBranchAncestorCheck(root, parsed.target);
    if (check.onDefaultBranch) {
      return { state: 'verified', method: check.performed, ...base };
    }
    return {
      state: 'stale',
      method: check.performed,
      ...base,
      reason: `commit "${parsed.target}" is not an ancestor of the default branch`,
    };
  }

  if (parsed.scheme !== 'path') {
    return {
      state: 'unverified',
      method: 'none',
      ...base,
      reason: `no mechanical checker is wired for "${parsed.scheme}:" anchors yet`,
    };
  }

  const root = opts.root;
  if (!root) {
    return {
      state: 'unknown',
      method: 'none',
      ...base,
      reason: 'no project root could be resolved for the subject',
    };
  }
  if (!isGitWorkTree(root)) {
    return {
      state: 'unknown',
      method: 'none',
      ...base,
      reason: `no git work tree at "${root}"`,
    };
  }

  const rel = toRepoRelative(root, parsed.target);
  if (rel === undefined) {
    return {
      state: 'unknown',
      method: 'none',
      ...base,
      reason: `anchor path "${parsed.target}" lies outside the project root`,
    };
  }

  if (!existsAtHead(root, rel)) {
    return {
      state: 'stale',
      method: 'exists_at_head',
      ...base,
      reason: `"${rel}" is not present at HEAD`,
    };
  }

  if (opts.sinceISO !== undefined && changedSinceFiling(root, rel, opts.sinceISO)) {
    if (opts.full !== true) {
      return {
        state: 'stale',
        method: 'changed_since',
        ...base,
        reason: `"${rel}" changed since ${opts.sinceISO}`,
      };
    }
    const headDigest = digestAtHead(root, rel);
    if (headDigest !== undefined && headDigest === anchor.digest.toLowerCase()) {
      return { state: 'verified', method: 'full_resolve', ...base };
    }
    return {
      state: 'stale',
      method: 'full_resolve',
      ...base,
      reason: `"${rel}" content no longer matches the anchor digest`,
    };
  }

  // Present and untouched since filing — the anchor still describes HEAD.
  return { state: 'verified', method: 'changed_since', ...base };
}
