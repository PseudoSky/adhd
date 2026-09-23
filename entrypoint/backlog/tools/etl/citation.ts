/**
 * citation.ts — SPEC.md §8.5's citation-repair rule: "for every citation,
 * resolve the issue's owning project's `path`... if `target` resolves to a
 * real, readable file under that `path`, hash its CURRENT content; else
 * `sha = 'unverified'`." This is the SAME two-branch procedure
 * `create-issue.ts`'s `computeCitationSha` runs on the live write path — the
 * ETL is "the first, bulk caller" of it (§8.5) — reimplemented here (not
 * imported) only because `create-issue.ts` is not a frozen export surface
 * this slice may depend on, and its function is not exported from the
 * package; the two-branch RULE and the path-escape confinement guard are
 * copied faithfully.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { UNVERIFIED_SHA } from './constants.js';

/**
 * `target_type` (SPEC.md §8.2): `'url'` if `file` parses as an absolute URL,
 * else `'path'`.
 */
export function citationTargetType(file: string): 'url' | 'path' {
  try {
    // eslint-disable-next-line no-new -- constructed purely to probe parseability
    new URL(file);
    return 'url';
  } catch {
    return 'path';
  }
}

/**
 * Best-effort parse of the START line out of a `lines` range (SPEC.md §8.2):
 * `"42-58"` → `42`; bare `"42"` → `42`; absent/unparseable → `undefined`.
 */
export function parseStartLine(lines: string | undefined): number | undefined {
  if (lines === undefined) return undefined;
  const match = /^\s*(\d+)/.exec(lines);
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Confinement check identical to `create-issue.ts`'s: a resolved citation
 * path landing OUTSIDE `root` (an absolute path elsewhere on the host, or a
 * relative path that walks out via `../`) degrades to "not found" — never
 * read, never a third branch.
 */
function resolvesInsideRoot(root: string, file: string): string | undefined {
  const absRoot = resolvePath(root);
  const candidate = isAbsolute(file) ? resolvePath(file) : resolvePath(absRoot, file);
  const rel = relative(absRoot, candidate);
  const escapes = rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\') || isAbsolute(rel);
  return escapes ? undefined : candidate;
}

export interface ICitationShaResult {
  sha: string;
  /** `true` iff a real file was read and hashed (the opposite of `sha === UNVERIFIED_SHA`, spelled out for callers that want it without a string comparison). */
  verified: boolean;
}

/**
 * SPEC.md §8.5's two-branch rule. `projectPath` is the resolved owning
 * project's known filesystem path (`undefined` for every project but
 * `"adhd"`, per §8.4) — step 1's "no known project path ⇒ go to step 3
 * directly" collapses to the `projectPath === undefined` branch here.
 */
export async function computeCitationSha(projectPath: string | undefined, file: string | undefined): Promise<ICitationShaResult> {
  // A genuine source-data anomaly (SPEC.md §8.2 never anticipates a
  // `Citation` with no `file` at all — see `MISSING_CITATION_FILE`'s own
  // doc comment for the real, empirically-observed row this guards
  // against): degrades to unverified, exactly like an unresolvable path,
  // rather than throwing `ERR_INVALID_ARG_TYPE` out of `node:path` (a real
  // bug this ETL found and fixed).
  if (typeof file !== 'string' || file.length === 0) return { sha: UNVERIFIED_SHA, verified: false };
  if (projectPath === undefined) return { sha: UNVERIFIED_SHA, verified: false };

  const candidate = resolvesInsideRoot(projectPath, file);
  if (candidate === undefined) return { sha: UNVERIFIED_SHA, verified: false };

  try {
    const content = await readFile(candidate);
    return { sha: createHash('sha256').update(content).digest('hex'), verified: true };
  } catch (err) {
    // "The cited file genuinely is not there, or is not a hashable file at
    // all" is the only case that legitimately degrades to 'unverified' —
    // any other failure (EACCES, EPERM, ELOOP, ...) is a real I/O failure
    // the ETL run report must surface loudly, never mask as an absent
    // citation. ENOENT/ENOTDIR are `create-issue.ts`'s own two exempted
    // codes (its own doc comment); EISDIR is added here, NOT present on
    // that already-shipped verb — a real, empirically-discovered bug in it
    // (this frozen corpus cites real directories, e.g.
    // `packages/apigen/codegen/openapi`; `create-issue.ts`'s live write path
    // would throw an uncaught `WriteIOError` for a citation like that today
    // instead of degrading to `'unverified'` the same as a missing file —
    // disclosed as a found bug, not fixed there: that file belongs to a
    // different in-flight slice, out of this task's edit scope).
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return { sha: UNVERIFIED_SHA, verified: false };
    throw err;
  }
}
