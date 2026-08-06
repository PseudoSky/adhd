/**
 * provenance.ts — commit-trailer + CHANGELOG-note provenance parsing and
 * rendering (FEAT-PROVENANCE-001).
 *
 * Format worked example (matches `docs/workspace-base/SCOPE.md` §7):
 *
 * ```
 * Work-Item: backlog:FEAT-PROVENANCE-001
 * Dispatcher: plan-orchestrator
 * Author: typescript-pro:v1
 * Model: claude/opus
 * ```
 *
 * renders to the CHANGELOG note:
 *
 * ```
 * ‹work:backlog:FEAT-PROVENANCE-001 · dispatcher:plan-orchestrator · author:typescript-pro:v1 · model:claude/opus›
 * ```
 */

/**
 * A parsed provenance trailer block, whether sourced from a commit message
 * or (once rendered + re-parsed) a CHANGELOG note.
 */
export interface ProvenanceTrailer {
  /** Matches `^(plan:|backlog:|oneoff)`. */
  workItem: string;
  dispatcher?: string;
  author: string;
  model?: string;
}

const WORK_ITEM_PATTERN = /^(plan:|backlog:|oneoff)/;
const TRAILER_LINE_PATTERN = /^(Work-Item|Dispatcher|Author|Model):\s*(.+)$/gm;

/**
 * Parses standard trailer-style lines out of the LAST blank-line-delimited
 * block of a commit message (the conventional "trailer" position — same
 * convention `git interpret-trailers` uses). Returns `null` if the two
 * mandatory fields (`Work-Item`, `Author`) are both absent, or if
 * `workItem` doesn't match {@link WORK_ITEM_PATTERN}.
 */
export function parseCommitTrailers(commitMessage: string): ProvenanceTrailer | null {
  const blocks = commitMessage.split(/\n\s*\n/);
  const lastBlock = blocks[blocks.length - 1] ?? '';

  const fields: Partial<Record<'Work-Item' | 'Dispatcher' | 'Author' | 'Model', string>> = {};
  let match: RegExpExecArray | null;
  // Reset lastIndex since TRAILER_LINE_PATTERN is a module-level global regex.
  TRAILER_LINE_PATTERN.lastIndex = 0;
  while ((match = TRAILER_LINE_PATTERN.exec(lastBlock)) !== null) {
    const [, key, value] = match;
    fields[key as 'Work-Item' | 'Dispatcher' | 'Author' | 'Model'] = value.trim();
  }

  const workItem = fields['Work-Item'];
  const author = fields['Author'];
  if (!workItem || !author) return null;
  if (!WORK_ITEM_PATTERN.test(workItem)) return null;

  const trailer: ProvenanceTrailer = { workItem, author };
  if (fields['Dispatcher']) trailer.dispatcher = fields['Dispatcher'];
  if (fields['Model']) trailer.model = fields['Model'];
  return trailer;
}

/**
 * Renders a {@link ProvenanceTrailer} as the literal CHANGELOG provenance
 * note format: guillemets + middle-dot separators.
 */
export function renderChangelogProvenanceNote(t: ProvenanceTrailer): string {
  return `‹work:${t.workItem} · dispatcher:${t.dispatcher ?? 'unknown'} · author:${t.author} · model:${t.model ?? 'n/a'}›`;
}

const NOTE_PATTERN =
  /‹work:(.+?) · dispatcher:(.+?) · author:(.+?) · model:(.+?)›/;

/**
 * Inverse of {@link renderChangelogProvenanceNote}: parses a `‹...›`
 * provenance span out of a CHANGELOG line. Returns `null` if the line
 * doesn't contain a well-formed note.
 *
 * A `dispatcher`/`model` value of the literal sentinel (`unknown`/`n/a`
 * respectively — what `renderChangelogProvenanceNote` emits for an absent
 * field) is treated as absent, so a round-trip through render -> parse
 * reproduces the original optional-field `undefined`s exactly.
 */
export function parseChangelogProvenanceNote(line: string): ProvenanceTrailer | null {
  const match = NOTE_PATTERN.exec(line);
  if (!match) return null;
  const [, workItem, dispatcher, author, model] = match;
  if (!WORK_ITEM_PATTERN.test(workItem)) return null;

  const trailer: ProvenanceTrailer = { workItem, author };
  if (dispatcher !== 'unknown') trailer.dispatcher = dispatcher;
  if (model !== 'n/a') trailer.model = model;
  return trailer;
}

/**
 * A resolved author identity — either an agent (with an optional spec
 * version) or a human (git author name).
 */
export interface AuthorIdentity {
  kind: 'agent' | 'human';
  name: string;
  version?: string;
}

export interface ResolveAuthorIdentityInput {
  envAgentName?: string;
  specFrontmatter?: { name: string; version: string };
  gitAuthorName: string;
}

/**
 * Resolves an {@link AuthorIdentity} from already-gathered inputs. PURE:
 * this function never reads `process.env`, the filesystem, or shells out —
 * gathering `envAgentName` (e.g. from `SOX_AGENT_NAME`), `specFrontmatter`
 * (parsed from an agent spec file), and `gitAuthorName` (via `git config
 * user.name`) is the CALLER's responsibility (e.g. a future git hook
 * script), so this function stays unit-testable without process mocking.
 *
 * Resolution order:
 *  1. `envAgentName` set -> agent, name = envAgentName, version =
 *     `specFrontmatter?.version ?? 'unknown'`.
 *  2. else `specFrontmatter` set -> agent, name/version from frontmatter.
 *  3. else -> human, name = `gitAuthorName`.
 */
export function resolveAuthorIdentity(input: ResolveAuthorIdentityInput): AuthorIdentity {
  if (input.envAgentName) {
    return {
      kind: 'agent',
      name: input.envAgentName,
      version: input.specFrontmatter?.version ?? 'unknown',
    };
  }
  if (input.specFrontmatter) {
    return {
      kind: 'agent',
      name: input.specFrontmatter.name,
      version: input.specFrontmatter.version,
    };
  }
  return { kind: 'human', name: input.gitAuthorName };
}
