/**
 * citation-path.ts — the citation-path containment contract (BUG c6d35272).
 *
 * A citation's `sha` hashes EXTERNAL file content (§6.3.2/§8.5). By default a
 * citation target must resolve INSIDE the owning project's own root
 * (`project.metadata.path`): that keeps the read surface confined to the tree
 * the project already owns, so a citation can never be used as a
 * file-exists/readable oracle for an arbitrary absolute path elsewhere on the
 * host. But some genuine evidence lives OUTSIDE that root — a machine-level
 * tool (`~/.local/bin/gx`), a globally-installed package's `dist/**`, a
 * `/tmp` scratch artifact, or any root the project explicitly allowlists via
 * `citationAllowedExternalRoots`. Before this module the ONLY way to cite such
 * evidence on a path-PRESENT project was to omit the citation entirely —
 * which `create`
 * still reported as SUCCESS, silently downgrading a labelled-unverified
 * citation to an unlabelled absence (exactly what "No citation, no claim"
 * forbids).
 *
 * The carve-out is a TYPED, per-project ALLOWLIST — `project_policy.
 * citationAllowedExternalRoots` (see `catalog.ts`'s `IProjectPolicy`) — never
 * an env toggle and never a blanket "any absolute path" escape. A citation is
 * accepted iff its CANONICAL (symlink-resolved) target lies within the project
 * root OR within one of the project's allowed external roots. Every allowed
 * root is itself canonicalized before comparison, so:
 *
 * - a relative `../…` traversal cannot widen the surface (it resolves to an
 *   absolute candidate that is then containment-checked);
 * - a symlink INSIDE the root that points OUTSIDE it is rejected (the
 *   canonical target is outside every root) — this is the same defect the
 *   sibling item c6d90ddf names, closed here for free by canonicalizing;
 * - a root that is itself reached through a symlink still matches, because
 *   both the candidate and the root are canonicalized through the SAME
 *   `realpath` pass.
 *
 * Nothing here reads file CONTENT — only paths are resolved and compared.
 * Only the resulting sha is ever persisted (§8.5); the citation node stores
 * `target`/`sha`, never the bytes.
 */

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';

/**
 * The default external roots a project may cite from, used when the project's
 * own policy supplies no `citationAllowedExternalRoots`. This is the EMPTY
 * array: the runtime grants NO machine-global default root.
 *
 * Why: the runtime's own data home, `~/.adhd/backlog`, is the STORE's home,
 * not an evidence tree. It holds only the machine-global backlog database
 * (`production/data/backlog-v2.db`) and its snapshots (`production/backup-*`,
 * top-level `backup-*`/`backups/`), plus the `test/` store. Granting it as a
 * default root let a citation's `sha` read/hash surface resolve straight INTO
 * the shared backlog graph — the very graph the citation containment exists to
 * keep out of citation reads. The earlier narrowing from `~/.adhd` down to
 * `~/.adhd/backlog` (BUG 62059b57) stopped one directory too high (BUG
 * 62059b57 follow-up).
 *
 * This does NOT gut the carve-out MECHANISM: a project that genuinely needs a
 * specific external root (a machine tool, a globally-installed package's
 * `dist/**`) names it explicitly in `project_policy.citationAllowedExternalRoots`,
 * and that typed, per-project allowlist is unchanged. Only the unearned
 * machine-global default is gone.
 *
 * Deliberately a FUNCTION, called LAZILY by {@link resolveProjectPolicy} on
 * every policy resolve, never a module-level constant: the call surface stays
 * stable if a legitimate machine-global root is ever re-introduced, and every
 * caller keeps the lazy, per-resolve contract.
 */
export function defaultCitationAllowedExternalRoots(): string[] {
  return [];
}

/**
 * Render `root` for a human-facing error message: `~`-anchored when it lies
 * under the current home directory, the bare absolute path otherwise. Keeps
 * the `CitationUnverifiableError` message stable across machines (a literal
 * `/Users/<name>/.adhd` would leak the operator's identity and differ per
 * host, making the message hard to assert on).
 */
export function displayExternalRoot(root: string): string {
  const home = homedir();
  if (root === home) return '~';
  const homeWithSep = home.endsWith(sep) ? home : home + sep;
  if (root.startsWith(homeWithSep)) return '~' + root.slice(home.length);
  return root;
}

/**
 * Lexical containment: does `candidate` sit at or under `root`?
 *
 * Uses `path.relative` — NEVER a bare `startsWith(root)`, which a sibling
 * directory sharing a name prefix would defeat (`/repo` vs `/repo-evil`:
 * `'/repo-evil/x'.startsWith('/repo')` is `true`). Both arguments are expected
 * to be ABSOLUTE and (ideally) canonical already; this function is purely
 * lexical and performs no I/O.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  const rel = relative(root, candidate);
  // A candidate outside `root` yields a `relative()` result of `..` or a
  // path beginning with `../` (single `sep`-aware prefix check, not a raw
  // string match), or — when `root`/`candidate` sit on different absolute
  // bases (different drive roots on Windows) — an absolute result.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The §4c "the file genuinely is not there" error taxonomy, in ONE place.
 *
 * `ENOENT` (a path segment does not exist) and `ENOTDIR` (a path segment that
 * should be a directory is in fact a file, so the target cannot exist) both
 * mean exactly "not there" — the ONLY case any caller may degrade to the
 * `'unverified'` sentinel. Every other errno (`EACCES`, `EPERM`, `EMFILE`,
 * `EISDIR`, `ELOOP`, …) is a REAL I/O failure and must never be masked as an
 * absent file. Shared by {@link canonicalizePath} and both write verbs'
 * `computeCitationSha` (BUG c6d35272 follow-up) so that taxonomy is
 * single-source and cannot drift between its three call sites.
 *
 * NOT used by `tools/etl/citation.ts`: that frozen tool deliberately ALSO
 * exempts `EISDIR` (its own documented, corpus-driven divergence), so folding
 * it into this narrower ENOENT/ENOTDIR predicate would regress it.
 */
export function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolve `p` to its real, symlink-free absolute path.
 *
 * `p` need not exist. On `ENOENT`/`ENOTDIR` the nearest EXISTING ancestor is
 * canonicalized and the non-existent tail is re-joined onto it, so a citation
 * naming a file that does not exist still yields a stable absolute candidate
 * for the containment check — the "does it actually exist / is it readable?"
 * verdict is deliberately left to the caller's `readFile` (which the write
 * layer's error taxonomy degrades to the `'unverified'` sentinel on
 * ENOENT/ENOTDIR, `WriteIOError` otherwise). Any OTHER error (EACCES, ELOOP,
 * …) propagates untouched — a real I/O fault must never be masked as a
 * missing file.
 */
export async function canonicalizePath(p: string): Promise<string> {
  const abs = resolvePath(p);
  try {
    return await realpath(abs);
  } catch (err) {
    if (!isMissingPathError(err)) throw err;
    const parent = dirname(abs);
    // Reached the filesystem root (or a relative form that cannot be
    // resolved further) — nothing left to walk up to; surface the original
    // error rather than looping forever.
    if (parent === abs) throw err;
    return join(await canonicalizePath(parent), basename(abs));
  }
}

/** The outcome of {@link resolveCitationTarget}. */
export interface IResolvedCitationTarget {
  /** `true` iff the canonical candidate lies within the project root or one of `allowedRoots`. */
  accepted: boolean;
  /** The CANONICAL (symlink-resolved) absolute path — the exact path the caller should read. Returned even when `accepted` is `false`, for a caller that wants to report it. */
  candidate: string;
}

/**
 * Decide whether `file` (absolute, or relative to `projectRoot`) is a
 * citable target: canonical containment against `projectRoot` ∪
 * `allowedRoots`. See this module's header for the security model.
 *
 * `projectRoot` and every entry of `allowedRoots` are canonicalized through
 * the SAME pass as the candidate, so a root reached via a symlink still
 * matches its own contents (and a root that does not exist is canonicalized
 * to its nearest existing ancestor + the literal tail, exactly like the
 * candidate).
 */
export async function resolveCitationTarget(
  projectRoot: string,
  file: string,
  allowedRoots: readonly string[]
): Promise<IResolvedCitationTarget> {
  const candidate = isAbsolute(file)
    ? resolvePath(file)
    : resolvePath(projectRoot, file);
  const canonicalCandidate = await canonicalizePath(candidate);

  const roots = await Promise.all(
    [projectRoot, ...allowedRoots].map((root) => canonicalizePath(root))
  );
  const accepted = roots.some((root) =>
    isPathWithin(root, canonicalCandidate)
  );
  return { accepted, candidate: canonicalCandidate };
}
