#!/usr/bin/env node
// backlog.mjs — parse, categorize, and query the repo BACKLOG.md.
//
// The backlog is a flat markdown file of `##`/`###` entries whose header begins
// with a stable ID (e.g. BUG-APIGEN-014, DEBT-DISPATCH-005, ENV-SEC-001). This
// tool parses those entries and reports stats / fetches items by ID without you
// having to page through a 1300-line file.
//
// Usage:
//   node tools/util/backlog.mjs [stats]                 full breakdown (default)
//   node tools/util/backlog.mjs get <ID> [<ID>...]      print full entries by ID (case-insensitive, prefix-ok)
//   node tools/util/backlog.mjs list [filters]          one-line-per-item table
//   node tools/util/backlog.mjs json                    dump parsed items as JSON
//
// list/stats filters (all AND-combined, repeatable-friendly):
//   --status open|closed|OPEN|FIXED|RESOLVED|MITIGATED|DEFERRED|UNKNOWN
//   --family BUG-APIGEN        (id with trailing -NNN stripped; case-insensitive substring)
//   --kind   BUG|DEBT|FEAT|... (first id segment)
//   --priority CRITICAL|HIGH|MEDIUM|LOW
//   --grep   <text>            (matches id + title, case-insensitive)
//   --file   <path>            (default: repo-root BACKLOG.md)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = resolve(__dirname, '../../BACKLOG.md');

// ── An item header is a `##`/`###` line whose first token is an ID:
//    starts uppercase, has ≥1 hyphenated segment, and contains a digit.
//    This excludes section headers ("## Bugs", "## Features", "## Full-repo …",
//    lowercase group headers) and "## FOLLOW-UP:" (no digit).
const HEADER_RE = /^(#{2,3})\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)/;

// ── Standardized status vocabulary ──────────────────────────────────────────
// Every entry's free-form Status line is mapped to exactly one canonical label.
// TERMINAL labels = work is finished (in one of three senses); everything else
// is still open. This is the fixed set the tool categorizes against.
const STATUS_VOCAB = {
  open: ['OPEN', 'IN-PROGRESS', 'PARTIAL', 'OUTSTANDING', 'DEFERRED', 'MIXED', 'UNKNOWN'],
  terminalDone: ['FIXED', 'RESOLVED', 'DONE', 'SHIPPED', 'VERIFIED', 'REMOVED', 'CLOSED'],
  terminalWorkaround: ['MITIGATED'],
  terminalDismissed: ['INVALID', 'SUPERSEDED', 'DUPLICATE', 'WONTFIX'],
};
const TERMINAL = new Set([
  ...STATUS_VOCAB.terminalDone,
  ...STATUS_VOCAB.terminalWorkaround,
  ...STATUS_VOCAB.terminalDismissed,
]);

// Classify a free-form status string into a canonical {label, open}. Backlog
// Status lines are prose ("PARTIALLY RESOLVED — …", "working tree FIXED.
// ROTATION OUTSTANDING", "agent-mcp FIXED; deps OPEN") — so an open signal
// (outstanding work) must win over a closed word when both are present.
function classifyStatus(raw) {
  const t = (raw || '').toLowerCase();
  if (!t.trim()) return null;
  const has = (w) => t.includes(w);

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
  if (has('downgraded')) return { label: 'OPEN', open: true }; // "downgraded to a prose fix" = still to do
  return { label: t.trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, '') || 'UNKNOWN', open: true };
}

function detectStatus(headerLine, body) {
  // 1) explicit **Status:** field wins (with or without a leading "- ").
  // Matches both `**Status:** X` and `**Status: X**` (colon inside the bold).
  const m = body.match(/^\s*-?\s*\*\*Status:\*?\*?\s*([^\n]+)/im);
  const fromField = m && classifyStatus(m[1]);
  if (fromField) return fromField;
  // 2) fall back to a status word in the header.
  const h = headerLine.toUpperCase();
  for (const w of ['RESOLVED', 'FIXED', 'MITIGATED', 'DONE', 'CLOSED']) {
    if (h.includes(w)) return { label: w, open: false };
  }
  return { label: 'UNKNOWN', open: true };
}

function detectPriority(headerLine, body) {
  const src = `${headerLine}\n${body}`;
  const explicit = src.match(/\*{0,2}priority:?\*{0,2}\s*[:\-]?\s*(CRITICAL|HIGH|MEDIUM|LOW)/i);
  if (explicit) return explicit[1].toUpperCase();
  if (/—\s*CRITICAL\b/i.test(headerLine) || /\bCRITICAL\b/.test(headerLine)) return 'CRITICAL';
  return '';
}

function parse(text) {
  const lines = text.split('\n');
  const items = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.bodyLines.join('\n');
    const st = detectStatus(cur.headerLine, body);
    cur.status = st.label;
    // openness is a pure function of the canonical status vocabulary
    cur.open = !TERMINAL.has(cur.status);
    cur.terminal = !cur.open;
    cur.priority = detectPriority(cur.headerLine, body);
    cur.body = body.trim();
    delete cur.bodyLines;
    items.push(cur);
  };

  lines.forEach((line, i) => {
    const m = line.match(HEADER_RE);
    const isAnyHeader = /^#{2,3}\s/.test(line);
    if (m && /\d/.test(m[2])) {
      // an item header: close the previous item and open a new one
      flush();
      const id = m[2];
      const title = line.replace(HEADER_RE, '').replace(/^\s*[—–-]\s*/, '').trim();
      const segs = id.split('-');
      cur = {
        id,
        kind: segs[0],
        family: id.replace(/-\d+[a-z]?$/i, ''),
        title,
        level: m[1].length,
        line: i + 1,
        headerLine: line,
        bodyLines: [],
      };
    } else if (isAnyHeader) {
      // a section header (no ID): ends the current item; its own lines belong to
      // no item, so nothing until the next item header is attributed.
      flush();
      cur = null;
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  });
  flush();
  return items;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      // repeated flags accumulate into an array (e.g. --exclude X --exclude Y)
      if (key in opts) opts[key] = [].concat(opts[key], val);
      else opts[key] = val;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function applyFilters(items, opts) {
  let out = items;
  if (opts.status) {
    const s = opts.status.toLowerCase();
    if (s === 'open') out = out.filter((it) => it.open);
    else if (s === 'closed') out = out.filter((it) => !it.open);
    else out = out.filter((it) => it.status === opts.status.toUpperCase());
  }
  if (opts.family) out = out.filter((it) => it.family.toLowerCase().includes(opts.family.toLowerCase()));
  if (opts.kind) out = out.filter((it) => it.kind.toLowerCase() === opts.kind.toLowerCase());
  if (opts.priority) out = out.filter((it) => it.priority === opts.priority.toUpperCase());
  if (opts.grep) {
    const g = opts.grep.toLowerCase();
    out = out.filter((it) => `${it.id} ${it.title}`.toLowerCase().includes(g));
  }
  return out;
}

// ── formatting helpers ──────────────────────────────────────────────────────
function countBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it) || '(none)';
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function bar(n, max, width = 24) {
  const filled = max ? Math.round((n / max) * width) : 0;
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function table(title, rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const keyW = Math.max(...rows.map((r) => String(r[0]).length), 4);
  let s = `\n${title}\n`;
  for (const [k, n] of rows) {
    s += `  ${String(k).padEnd(keyW)}  ${String(n).padStart(4)}  ${bar(n, max)}\n`;
  }
  return s;
}

function cmdStats(items, opts) {
  const scoped = applyFilters(items, opts);
  const uniq = new Set(scoped.map((it) => it.id));
  const open = scoped.filter((it) => it.open);
  const closed = scoped.filter((it) => !it.open);

  let out = '';
  out += `BACKLOG stats — ${scoped.length} entries (${uniq.size} unique IDs)\n`;
  out += `  open: ${open.length}   closed: ${closed.length}\n`;

  out += `\nStatus vocabulary (canonical):\n`;
  out += `  terminal → done: ${STATUS_VOCAB.terminalDone.join(' ')} | workaround: ${STATUS_VOCAB.terminalWorkaround.join(' ')} | dismissed: ${STATUS_VOCAB.terminalDismissed.join(' ')}\n`;
  out += `  open     → ${STATUS_VOCAB.open.join(' ')}\n`;
  out += table('By status', countBy(scoped, (it) => it.status));
  out += table('By kind', countBy(scoped, (it) => it.kind));
  out += table('By family (top 25)', countBy(scoped, (it) => it.family).slice(0, 25));
  const prio = countBy(scoped.filter((it) => it.priority), (it) => it.priority);
  if (prio.length) out += table('By priority (tagged only)', prio);

  // Actionable spotlight: open + prioritized, most-severe first.
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, '': 4 };
  const spotlight = open
    .filter((it) => it.priority)
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id));
  if (spotlight.length) {
    out += `\nOpen + prioritized (${spotlight.length}):\n`;
    for (const it of spotlight) out += `  [${it.priority.padEnd(8)}] ${it.id} — ${truncate(it.title, 70)}\n`;
  }

  // Duplicate IDs (same ID appears in multiple sections — real in this file).
  const dupes = countBy(scoped, (it) => it.id).filter(([, n]) => n > 1);
  if (dupes.length) {
    out += `\nDuplicate IDs (${dupes.length}):\n`;
    for (const [id, n] of dupes) out += `  ${id} ×${n}\n`;
  }
  return out;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function cmdList(items, opts) {
  const scoped = applyFilters(items, opts).sort((a, b) => a.line - b.line);
  if (!scoped.length) return '(no matching items)\n';
  const idW = Math.max(...scoped.map((it) => it.id.length));
  const stW = Math.max(...scoped.map((it) => it.status.length));
  let out = '';
  for (const it of scoped) {
    const p = it.priority ? ` !${it.priority}` : '';
    out += `${it.id.padEnd(idW)}  ${it.status.padEnd(stW)}  L${String(it.line).padEnd(5)} ${truncate(it.title, 74)}${p}\n`;
  }
  out += `\n${scoped.length} item(s).\n`;
  return out;
}

function cmdGet(items, ids) {
  let out = '';
  for (const query of ids) {
    const q = query.toLowerCase();
    const exact = items.filter((it) => it.id.toLowerCase() === q);
    const matches = exact.length ? exact : items.filter((it) => it.id.toLowerCase().includes(q));
    if (!matches.length) {
      out += `\n## ${query} — NOT FOUND\n`;
      continue;
    }
    for (const it of matches) {
      out += `\n${'═'.repeat(80)}\n${it.headerLine}\n`;
      out += `(status: ${it.status}${it.priority ? ` · priority: ${it.priority}` : ''} · line ${it.line} · family ${it.family})\n`;
      if (it.body) out += `\n${it.body}\n`;
    }
  }
  return out;
}

// ── archive: relocate terminal items out of BACKLOG.md into CHANGELOG.md ──────
// Block boundary is header-aware: an item's block runs from its own header line
// to the next `##`/`###` header of ANY kind — so section headers ("## Features")
// that follow a moved item stay put. --exclude drops an auto-selected id;
// --also START-END force-includes a raw inclusive line range (for clusters whose
// children lack their own Status line, e.g. the DEBT-LT summary + 8 findings).
function planArchive(text, items, opts) {
  const lines = text.split('\n');
  const headerLineNos = [];
  lines.forEach((l, i) => {
    if (/^#{2,3}\s/.test(l)) headerLineNos.push(i + 1);
  });
  const nextHeaderAfter = (ln) => {
    for (const h of headerLineNos) if (h > ln) return h;
    return lines.length + 1;
  };

  const exclude = new Set(asArray(opts.exclude).map((s) => s.toUpperCase()));
  const alsoRanges = asArray(opts.also).map((s) => {
    const m = String(s).match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error(`bad --also range "${s}" (want START-END)`);
    return { start: +m[1], end: +m[2] + 1, label: `lines ${s}` };
  });

  const terminal = items.filter((it) => it.terminal && !exclude.has(it.id.toUpperCase()));
  const autoRanges = terminal.map((it) => ({ start: it.line, end: nextHeaderAfter(it.line), label: it.id }));

  const ranges = [...autoRanges, ...alsoRanges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.label += `, ${r.label}`;
    } else merged.push({ ...r });
  }

  const removeIdx = new Set();
  const blocks = [];
  for (const r of merged) {
    const block = lines.slice(r.start - 1, r.end - 1);
    blocks.push({ label: r.label, start: r.start, endInclusive: r.end - 1, text: block.join('\n').replace(/\s+$/, '') });
    for (let i = r.start - 1; i < r.end - 1; i++) removeIdx.add(i);
  }
  const newBacklog = lines.filter((_, i) => !removeIdx.has(i)).join('\n');
  return { lines, merged, blocks, removeIdx, newBacklog };
}

// Demote heading levels by two so moved `##`/`###` entries nest under the
// `### Archived …` subsection instead of becoming top-level CHANGELOG sections.
function demoteHeadings(md) {
  return md
    .split('\n')
    .map((l) => (/^###\s/.test(l) ? `##${l}` : /^##\s/.test(l) ? `##${l}` : l))
    .join('\n');
}

function buildChangelogSection(blocks, date) {
  let s = `### Archived — resolved/terminal BACKLOG items relocated in batch (${date})\n\n`;
  s += `> Moved verbatim from \`BACKLOG.md\` via \`node tools/util/backlog.mjs archive\` (canonical terminal statuses:\n`;
  s += `> FIXED/RESOLVED/DONE/SHIPPED/VERIFIED/REMOVED/MITIGATED/SUPERSEDED/INVALID). \`BACKLOG.md\` holds only open\n`;
  s += `> work; per AGENTS.md/CLAUDE.md completed items live here. Entry text is unchanged except heading levels,\n`;
  s += `> which are demoted two levels to nest under this section. Some items also have curated narrative above;\n`;
  s += `> this is the lossless record.\n\n`;
  s += blocks.map((b) => demoteHeadings(b.text)).join('\n\n');
  s += '\n';
  return s;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = opts.file && opts.file !== 'true' ? opts.file : DEFAULT_FILE;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`backlog: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }
  const items = parse(text);
  const cmd = opts._[0] || 'stats';

  switch (cmd) {
    case 'stats':
      process.stdout.write(cmdStats(items, opts));
      break;
    case 'list':
      process.stdout.write(cmdList(items, opts));
      break;
    case 'get': {
      const ids = opts._.slice(1);
      if (!ids.length) {
        process.stderr.write('backlog get: need at least one ID\n');
        process.exit(1);
      }
      process.stdout.write(cmdGet(items, ids));
      break;
    }
    case 'json':
      process.stdout.write(`${JSON.stringify(applyFilters(items, opts), null, 2)}\n`);
      break;
    case 'archive': {
      const plan = planArchive(text, items, opts);
      const date = (opts.date && opts.date !== 'true' && opts.date) || new Date().toISOString().slice(0, 10);
      const movedLines = plan.removeIdx.size;
      let summary = `archive plan — ${plan.blocks.length} block(s), ${movedLines} lines to move → CHANGELOG.md\n\n`;
      for (const b of plan.blocks) {
        summary += `  L${b.start}-${b.endInclusive}  ${b.label}\n`;
      }
      if (!opts.apply) {
        summary += `\nDRY-RUN. Re-run with --apply to write. Targets: BACKLOG.md (remove) + ${opts.changelog || 'CHANGELOG.md'} (append to Unreleased).\n`;
        process.stdout.write(summary);
        break;
      }
      // apply
      const clogPath = opts.changelog && opts.changelog !== 'true' ? opts.changelog : resolve(__dirname, '../../CHANGELOG.md');
      const clog = readFileSync(clogPath, 'utf8');
      const clogLines = clog.split('\n');
      // insert as the last subsection of "## Unreleased": before the first released version header.
      let insertAt = clogLines.findIndex((l) => /^#{1,2}\s+\d+\.\d+\.\d+\b/.test(l));
      if (insertAt < 0) insertAt = clogLines.length;
      const section = buildChangelogSection(plan.blocks, date);
      const newClog = [...clogLines.slice(0, insertAt), section, ...clogLines.slice(insertAt)].join('\n');

      writeFileSync(file, plan.newBacklog);
      writeFileSync(clogPath, newClog);
      summary += `\nAPPLIED. BACKLOG.md -${movedLines} lines; ${clogPath} +section before line ${insertAt + 1}.\n`;
      process.stdout.write(summary);
      break;
    }
    default:
      process.stderr.write(`backlog: unknown command "${cmd}" (stats|get|list|json)\n`);
      process.exit(1);
  }
}

main();
