/**
 * markdown.ts — parse()/render() ported from `tools/util/backlog.mjs`
 * (DESIGN.md §8). This is a real, acknowledged duplication (the legacy file
 * is a standalone `tools/` script, not an importable package — there is
 * nothing to `import` from it; see DESIGN.md §8 / DEBT-BACKLOG-MARKDOWN-DUP-001)
 * — pure functions only, no store/env imports, so `archiveResolved`
 * (store/lifecycle.ts + client.ts) can compose this without a layering
 * violation (store/* never depends on markdown.ts).
 */
import type { BacklogFilter, BacklogItem, BacklogStatus, Citation, MalformedHeaderInfo, Priority } from './model.js';

// ── An item header is a `##`/`###` line whose first token is an ID: starts
//    uppercase, has ≥1 hyphenated segment, and contains a digit — ported
//    verbatim from tools/util/backlog.mjs:34.
const HEADER_RE = /^(#{2,3})\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/;

// ── Legacy status vocabulary (tools/util/backlog.mjs:40-50) ────────────────
const LEGACY_TERMINAL_DONE = ['FIXED', 'RESOLVED', 'DONE', 'SHIPPED', 'VERIFIED', 'REMOVED', 'CLOSED'];
const LEGACY_TERMINAL_WORKAROUND = ['MITIGATED'];
const LEGACY_TERMINAL_DISMISSED = ['INVALID', 'SUPERSEDED', 'DUPLICATE', 'WONTFIX'];
const LEGACY_TERMINAL = new Set([...LEGACY_TERMINAL_DONE, ...LEGACY_TERMINAL_WORKAROUND, ...LEGACY_TERMINAL_DISMISSED]);

/**
 * SPEC.md §6 — the canonical-vocabulary superset normalization, applied once
 * at `importFromMarkdown` time so every item in the graph always carries a
 * canonical `BacklogStatus`.
 */
const CANONICAL_STATUSES: ReadonlySet<string> = new Set<BacklogStatus>([
  'OPEN',
  'IN_PROGRESS',
  'PARTIAL',
  'OUTSTANDING',
  'DEFERRED',
  'BLOCKED',
  'MIXED',
  'UNKNOWN',
  'FIXED',
  'RESOLVED',
  'DONE',
  'SHIPPED',
  'VERIFIED',
  'REMOVED',
  'MITIGATED',
  'SUPERSEDED',
  'INVALID',
  'DUPLICATE',
  'WONTFIX',
]);

export function normalizeLegacyStatus(rawLabel: string): BacklogStatus {
  const label = rawLabel.toUpperCase();
  if (label === 'IN-PROGRESS') return 'IN_PROGRESS';
  if (label === 'CLOSED') return 'RESOLVED';
  if (CANONICAL_STATUSES.has(label)) return label as BacklogStatus;
  return 'UNKNOWN';
}

/**
 * Classify a free-form status string into a {label, open} pair — ported
 * verbatim from tools/util/backlog.mjs:56-82 (`classifyStatus`). Backlog
 * Status lines are prose, so an open signal must win over a closed word when
 * both are present.
 */
export function classifyStatus(raw: string | undefined): { label: string; open: boolean } | null {
  const t = (raw ?? '').toLowerCase();
  if (!t.trim()) return null;
  const has = (w: string) => t.includes(w);

  if (has('outstanding')) return { label: 'OUTSTANDING', open: true };
  if (has('partially')) return { label: 'PARTIAL', open: true };
  if (has('in progress')) return { label: 'IN-PROGRESS', open: true };

  const closedWord =
    (has('shipped') && 'SHIPPED') ||
    (has('superseded') && 'SUPERSEDED') ||
    (has('invalid') && 'INVALID') ||
    (has('mitigated') && 'MITIGATED') ||
    (has('removed') && !has('open') && 'REMOVED') ||
    (has('fixed') && 'FIXED') ||
    (has('resolved') && 'RESOLVED') ||
    (has('done') && 'DONE') ||
    null;
  const openWord = (has('open') && 'OPEN') || ((has('deferred') || has('defer')) && 'DEFERRED') || null;

  if (closedWord && openWord) return { label: 'MIXED', open: true };
  if (closedWord) return { label: closedWord, open: false };
  if (openWord) return { label: openWord, open: true };
  if (has('downgraded')) return { label: 'OPEN', open: true };
  return { label: t.trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, '') || 'UNKNOWN', open: true };
}

/** Ported verbatim from tools/util/backlog.mjs:84-96 (`detectStatus`). */
export function detectStatus(headerLine: string, body: string): { label: string; open: boolean } {
  const m = body.match(/^\s*-?\s*\*\*Status:\*?\*?\s*([^\n]+)/im);
  const fromField = m ? classifyStatus(m[1]) : null;
  if (fromField) return fromField;
  const h = headerLine.toUpperCase();
  for (const w of ['RESOLVED', 'FIXED', 'MITIGATED', 'DONE', 'CLOSED']) {
    if (h.includes(w)) return { label: w, open: false };
  }
  return { label: 'UNKNOWN', open: true };
}

/** Ported verbatim from tools/util/backlog.mjs:98-104 (`detectPriority`). */
export function detectPriority(headerLine: string, body: string): string {
  const src = `${headerLine}\n${body}`;
  const explicit = src.match(/\*{0,2}priority:?\*{0,2}\s*[:-]?\s*(CRITICAL|HIGH|MEDIUM|LOW)/i);
  if (explicit) return explicit[1].toUpperCase();
  if (/—\s*CRITICAL\b/i.test(headerLine) || /\bCRITICAL\b/.test(headerLine)) return 'CRITICAL';
  return '';
}

export interface ParsedMarkdownItem {
  id: string;
  kind: string;
  family: string;
  title: string;
  level: number;
  line: number;
  headerLine: string;
  status: string;
  open: boolean;
  terminal: boolean;
  priority: string;
  body: string;
}

/**
 * Narrow, high-precision heuristic for "this header was TRYING to be an id
 * header and failed `HEADER_RE`" vs. "this is a legitimate narrative section
 * heading" (e.g. `## Bugs`, `` ## `@adhd/backlog` design (session ...) ``,
 * `### Leak fixes — RESOLVED 2026-07-02` — all real headers from this repo's
 * own BACKLOG.md files, none of which should ever be flagged). A real id
 * (`HEADER_RE`) is upper-hyphen-segmented; a corrupted one (the negative
 * control this was filed from: `DEBT-ENV-CLI-002` -> `DEBT_ENV_CLI_002`)
 * still reads as a single, unspaced, uppercase-with-separators TOKEN — so
 * checking just the header's FIRST WHITESPACE-DELIMITED TOKEN for
 * "all-caps/digits/hyphens/underscores, with at least one digit or
 * underscore" catches the id-shaped-but-malformed case while a prose heading
 * (lowercase words, or backtick/`@`-prefixed) never matches.
 */
const MALFORMED_ID_TOKEN_RE = /^[A-Z][A-Z0-9_-]*$/;

function looksLikeAttemptedId(headerText: string): boolean {
  const firstToken = headerText.trim().split(/\s+/)[0] ?? '';
  return MALFORMED_ID_TOKEN_RE.test(firstToken) && /[0-9_]/.test(firstToken);
}

export interface ParseWithDiagnosticsResult {
  items: ParsedMarkdownItem[];
  malformedHeaders: MalformedHeaderInfo[];
}

/** Ported (structure preserved) from tools/util/backlog.mjs:106-155 (`parse`). */
function parseBacklogMarkdownInternal(text: string): ParseWithDiagnosticsResult {
  const lines = text.split('\n');
  const items: ParsedMarkdownItem[] = [];
  const malformedHeaders: MalformedHeaderInfo[] = [];
  let cur:
    | (Omit<ParsedMarkdownItem, 'status' | 'open' | 'terminal' | 'priority' | 'body'> & { bodyLines: string[] })
    | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.bodyLines.join('\n');
    const st = detectStatus(cur.headerLine, body);
    const priority = detectPriority(cur.headerLine, body);
    const { bodyLines, ...rest } = cur;
    void bodyLines;
    // Openness is a PURE FUNCTION of the canonical status vocabulary — ported
    // verbatim from tools/util/backlog.mjs:117 (`cur.open = !TERMINAL.has(cur.status)`).
    // Deliberately NOT `st.open` (classifyStatus's own best-effort prose
    // guess) — e.g. "VERIFIED" isn't one of classifyStatus's word-sniffed
    // closedWord branches, but IS a member of the fixed TERMINAL set, so the
    // label-vs-vocabulary recomputation is what correctly classifies it
    // (and "CLOSED") as terminal.
    const open = !LEGACY_TERMINAL.has(st.label);
    items.push({ ...rest, status: st.label, open, terminal: !open, priority, body: body.trim() });
    cur = null;
  };

  lines.forEach((line, i) => {
    const m = line.match(HEADER_RE);
    const isAnyHeader = /^#{2,3}\s/.test(line);
    if (m && /\d/.test(m[2])) {
      flush();
      const id = m[2];
      const title = line.replace(HEADER_RE, '').replace(/^\s*[—–-]\s*/, '').trim();
      const segs = id.split('-');
      cur = {
        id,
        kind: segs[0] ?? id,
        family: id.replace(/-\d+[a-z]?$/i, ''),
        title,
        level: m[1].length,
        line: i + 1,
        headerLine: line,
        bodyLines: [],
      };
    } else if (isAnyHeader) {
      // This header failed `HEADER_RE` — before dropping it (the previous
      // behavior), check whether it LOOKS like a corrupted/typo'd id rather
      // than a legitimate narrative section heading, and surface it instead
      // of silently vanishing (DEBT-BACKLOG-IMPORT-SILENT-DROP-001).
      const headerText = line.replace(/^#{2,3}\s+/, '');
      if (looksLikeAttemptedId(headerText)) {
        malformedHeaders.push({ line: i + 1, headerLine: line });
      }
      flush();
      cur = null;
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  });
  flush();
  return { items, malformedHeaders };
}

/** Ported (structure preserved) from tools/util/backlog.mjs:106-155 (`parse`). */
export function parseBacklogMarkdown(text: string): ParsedMarkdownItem[] {
  return parseBacklogMarkdownInternal(text).items;
}

/**
 * Same parse as {@link parseBacklogMarkdown}, plus `malformedHeaders` — every
 * `##`/`###` line that looks like a corrupted/typo'd id header and was
 * dropped instead of parsed into an item (DEBT-BACKLOG-IMPORT-SILENT-DROP-001).
 * `importFromMarkdown` (client.ts) uses this to populate `ImportResult.malformedHeaders`.
 */
export function parseBacklogMarkdownWithDiagnostics(text: string): ParseWithDiagnosticsResult {
  return parseBacklogMarkdownInternal(text);
}

// ============================================================================
// render — the inverse: BacklogItem[] -> `### {humanId} — {title}` blocks
// (SPEC.md §4.3), byte-compatible with the OLD parser above.
// ============================================================================

function renderCitationsLine(citations: Citation[]): string {
  const parts = citations.map((c) => {
    const loc = c.lines ? `${c.file}:${c.lines}` : c.file;
    return c.context ? `${loc} (${c.context})` : loc;
  });
  return `**Citations:** [${parts.join(', ')}]`;
}

/**
 * The OLD parser's `classifyStatus` recognizes "in progress" ONLY as the
 * literal substring "in progress" (a space) — neither "IN_PROGRESS" nor
 * "IN-PROGRESS" trigger that branch (they fall to the generic
 * strip-non-letters fallback instead, losing the round trip). Rendering the
 * literal words is what makes `IN_PROGRESS` round-trip through the OLD tool
 * (SPEC.md §7 DoD clause 2) — every other canonical status is already a
 * single all-letters word the OLD parser's fallback captures verbatim.
 */
function toRenderedStatusText(status: BacklogStatus): string {
  if (status === 'IN_PROGRESS') return 'IN PROGRESS';
  return status;
}

function renderItemBlock(item: BacklogItem): string {
  const lines: string[] = [];
  lines.push(`### ${item.humanId} — ${item.title}`);
  lines.push('');
  lines.push(`**Status:** ${toRenderedStatusText(item.status)}`);
  if (item.priority) lines.push(`**Priority:** ${item.priority}`);
  if (item.assignee) lines.push(`**Assignee:** ${item.assignee}`);
  if (item.plan) lines.push(`**Plan:** ${item.plan}`);
  lines.push('');
  if (item.body) lines.push(item.body, '');
  if (item.citations.length > 0) lines.push(renderCitationsLine(item.citations));
  for (const note of item.notes) lines.push(`- Note (${note.by}, ${note.at}): ${note.text}`);
  return lines.join('\n').trimEnd();
}

/**
 * SPEC.md §5.6 `renderToMarkdown` — one `###` block per item. Archived-item
 * exclusion (SPEC.md §5.4 `archiveResolved`'s "renderToMarkdown's default
 * view excludes them") happens one layer up, in `client.ts`'s
 * `renderToMarkdown`, which has access to the raw node `metadata.archivedAt`
 * flag — `BacklogItem` (SPEC.md §4.1) deliberately carries no `archivedAt`
 * field of its own, so this function (pure, no store access) cannot filter
 * on it and takes an already-filtered `items` array.
 */
export function renderItemsToMarkdown(items: BacklogItem[]): string {
  if (items.length === 0) return '';
  return `${items.map(renderItemBlock).join('\n\n')}\n`;
}

/** Demote heading levels by two — ported from tools/util/backlog.mjs:342-349 (`demoteHeadings`). */
function demoteHeadings(md: string): string {
  return md.split('\n').map(demoteHeadingLine).join('\n');
}

function demoteHeadingLine(line: string): string {
  if (/^###\s/.test(line)) return `##${line}`;
  if (/^##\s/.test(line)) return `##${line}`;
  return line;
}

/** Ported from tools/util/backlog.mjs:351-361 (`buildChangelogSection`). */
export function buildChangelogSection(items: BacklogItem[], date: string): string {
  let s = `### Archived — resolved/terminal backlog items relocated in batch (${date})\n\n`;
  s += `> Moved via \`@adhd/backlog\`'s \`archiveResolved\` (canonical terminal statuses: FIXED/RESOLVED/DONE/\n`;
  s += `> SHIPPED/VERIFIED/REMOVED/MITIGATED/SUPERSEDED/INVALID/DUPLICATE/WONTFIX). The graph node itself is\n`;
  s += `> NEVER deleted — this is a rendered snapshot; full history remains queryable via auditTrail.\n\n`;
  s += items.map((it) => demoteHeadings(renderItemBlock(it))).join('\n\n');
  s += '\n';
  return s;
}

/** Applies the SAME filters `applyFilters`/`BacklogFilter` describes, used only for markdown-side symmetry checks in tests. */
export function matchesFilter(item: ParsedMarkdownItem, filter: BacklogFilter): boolean {
  if (filter.grep) {
    const g = filter.grep.toLowerCase();
    if (!`${item.id} ${item.title}`.toLowerCase().includes(g)) return false;
  }
  return true;
}

export interface ParsedImportItem {
  humanId: string;
  title: string;
  body: string;
  status: BacklogStatus;
  priority?: Priority;
}

/** Bridges the legacy parser's raw shape into the canonical vocabulary (SPEC.md §5.6 `importFromMarkdown`). */
export function toImportItems(parsed: ParsedMarkdownItem[]): ParsedImportItem[] {
  return parsed.map((p) => {
    const out: ParsedImportItem = {
      humanId: p.id,
      title: p.title,
      body: p.body,
      status: normalizeLegacyStatus(p.status),
    };
    if (p.priority && (p.priority === 'CRITICAL' || p.priority === 'HIGH' || p.priority === 'MEDIUM' || p.priority === 'LOW')) {
      out.priority = p.priority;
    }
    return out;
  });
}

export { LEGACY_TERMINAL, LEGACY_TERMINAL_DONE, LEGACY_TERMINAL_DISMISSED, LEGACY_TERMINAL_WORKAROUND };
