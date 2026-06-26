#!/usr/bin/env node
// ──────────────────────────────────────────────
// cli/compile.ts — argv parser + dispatcher for the agent-compiler bin.
//
// Usage:
//   node cli/compile.js compile <slug> [options]
//
// Options:
//   --platform <p>      Target platform (default: claude_code).
//                       Must match a row in tool_platforms.
//   --context '<json>'  Runtime context key/value object (JSON string).
//   --format json       Emit JSON instead of platform default.
//   --out-dir <d>       Write <slug>.md (or <slug>.json) under <d>
//                       instead of printing to stdout.
//   --all               Compile every agent in the registry (use with
//                       --category to limit scope).
//   --category <c>      Filter to agents in this taxonomy category slug.
//   --db <path>         Path to the SQLite registry file. Defaults to
//                       AGENT_REGISTRY_DB env var, then ~/.agent-registry/registry.db.
//
// Exit codes:
//   0  — success
//   1  — unknown slug / unknown platform / bad argument / I/O error
//
// [ref:cli-bin] — mirrors agent-mcp's bin entry in package.json;
//   parses compile <slug> ... and writes content to stdout or --out-dir.
// [inv:platform-node] — no browser imports; pure Node + SQLite.
// [inv:one-db-handle] — opens ONE better-sqlite3 handle for the shared DB.
// ──────────────────────────────────────────────

import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { AgentStore }  from '@adhd/agent-registry';
import type { CompositionContext } from '@adhd/agent-registry';

import { compileAgent } from '../compile.js';

// ── Migration folders ─────────────────────────────────────────────────────
//
// Resolved relative to this compiled file's __dirname at runtime so the bin
// works from the dist layout without referencing source paths.
//
// dist/packages/ai/agent-compiler/src/cli/compile.js
//   → ../../               = dist/packages/ai/agent-compiler/
//   → ../../../            = dist/packages/ai/
//   → ../../../<pkg>/drizzle = dist/packages/ai/<pkg>/drizzle
//
// Timestamp order (ascending) matters so Drizzle's journal bookkeeping
// doesn't skip a migration set:
//   provider (1750*)  →  registry (1782193*)  →  tool-registry (1782250*)
//     →  policy (1782256*)  →  compiler (18*)
//
// This mirrors the migration order in compile-agent.test.ts.

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const AI_DIST   = path.resolve(__dirname, '../../../');

const PROVIDER_MIGRATIONS     = path.join(AI_DIST, 'agent-provider/drizzle');
const REGISTRY_MIGRATIONS     = path.join(AI_DIST, 'agent-registry/drizzle');
const TOOL_REGISTRY_MIGRATIONS = path.join(AI_DIST, 'agent-tool-registry/drizzle');
const POLICY_MIGRATIONS       = path.join(AI_DIST, 'agent-policy/drizzle');
const COMPILER_MIGRATIONS     = path.join(AI_DIST, 'agent-compiler/drizzle');

// ──────────────────────────────────────────────
// Resolved args
// ──────────────────────────────────────────────

interface CliArgs {
  slug:       string | null;  // null when --all is set
  platform:   string;
  context:    CompositionContext;
  formatJson: boolean;
  outDir:     string | null;
  all:        boolean;
  category:   string | null;
  dbPath:     string;
}

// ──────────────────────────────────────────────
// argv parser
// ──────────────────────────────────────────────

/**
 * Parse process.argv into a CliArgs object.
 * Exits 1 with a usage message on any parse error.
 */
function parseArgs(argv: string[]): CliArgs {
  // argv: [ node, compile.js, 'compile', <slug?>, ...flags ]
  const args = argv.slice(2); // strip node + script path

  if (args[0] !== 'compile') {
    die(`Expected sub-command 'compile', got: ${args[0] ?? '(nothing)'}`);
  }

  let slug:       string | null = null;
  let platform    = 'claude_code';
  let context:    CompositionContext = {};
  let formatJson  = false;
  let outDir:     string | null = null;
  let all         = false;
  let category:   string | null = null;
  let dbPath      =
    process.env['AGENT_REGISTRY_DB'] ??
    path.join(os.homedir(), '.agent-registry', 'registry.db');

  const flags = args.slice(1); // everything after 'compile'
  let i = 0;
  while (i < flags.length) {
    const tok = flags[i];

    if (tok === '--platform') {
      platform = requireNext(flags, i, '--platform');
      i += 2;
    } else if (tok === '--context') {
      const raw = requireNext(flags, i, '--context');
      try {
        // Parse as unknown first, then cast to CompositionContext (Record<string, string>).
        // The runtime contract is that --context values are string-keyed, string-valued.
        context = JSON.parse(raw) as CompositionContext;
      } catch {
        die(`--context must be valid JSON; got: ${raw}`);
      }
      i += 2;
    } else if (tok === '--format') {
      const fmt = requireNext(flags, i, '--format');
      if (fmt !== 'json') {
        die(`--format only supports 'json'; got: '${fmt}'`);
      }
      formatJson = true;
      i += 2;
    } else if (tok === '--out-dir') {
      outDir = requireNext(flags, i, '--out-dir');
      i += 2;
    } else if (tok === '--all') {
      all = true;
      i++;
    } else if (tok === '--category') {
      category = requireNext(flags, i, '--category');
      i += 2;
    } else if (tok === '--db') {
      dbPath = requireNext(flags, i, '--db');
      i += 2;
    } else if (tok != null && !tok.startsWith('-')) {
      // Positional slug — only accepted once.
      if (slug !== null) {
        die(`Unexpected extra positional argument: '${tok}'`);
      }
      slug = tok;
      i++;
    } else {
      die(`Unknown flag: '${tok}'`);
    }
  }

  if (!all && slug === null) {
    die('Provide a slug (compile <slug>) or use --all [--category <c>]');
  }
  if (all && slug !== null) {
    die('--all and a positional slug are mutually exclusive');
  }

  return { slug, platform, context, formatJson, outDir, all, category, dbPath };
}

function requireNext(flags: string[], i: number, flag: string): string {
  const val = flags[i + 1];
  if (val == null || val.startsWith('-')) {
    die(`${flag} requires a value`);
  }
  return val;
}

// ──────────────────────────────────────────────
// DB open helper
// ──────────────────────────────────────────────

/**
 * Open the shared SQLite registry file and apply migrations so the schema is
 * always current ([inv:one-db-handle]).
 *
 * Runs all five migration sets in ascending timestamp order so Drizzle's
 * journal does not skip any set.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openDb(dbPath: string): { conn: Database.Database; db: BetterSQLite3Database<any> } {
  if (!fs.existsSync(dbPath)) {
    die(`Registry DB not found at: ${dbPath}\nUse --db <path> or set AGENT_REGISTRY_DB.`);
  }
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });

  // Migrate in ascending timestamp order — same pattern as the test suite.
  for (const folder of [
    PROVIDER_MIGRATIONS,
    REGISTRY_MIGRATIONS,
    TOOL_REGISTRY_MIGRATIONS,
    POLICY_MIGRATIONS,
    COMPILER_MIGRATIONS,
  ]) {
    if (fs.existsSync(folder)) {
      migrate(db, { migrationsFolder: folder });
    }
  }

  conn.pragma('foreign_keys = ON');
  return { conn, db };
}

// ──────────────────────────────────────────────
// Compile a single agent → string artifact
// ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compileSingle(slug: string, args: CliArgs, db: BetterSQLite3Database<any>): string {
  let result;
  try {
    result = compileAgent({
      agentSlug: slug,
      platform:  args.platform,
      context:   args.context,
      db,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish AGENT_NOT_FOUND / PLATFORM_NOT_FOUND from other errors.
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) {
      die(`Error: ${msg}`);
    }
    die(`Compilation failed for '${slug}' on platform '${args.platform}': ${msg}`);
  }

  // --format json overrides the platform's default header format.
  if (args.formatJson) {
    // If content is already JSON (json_object platforms), return as-is.
    try {
      JSON.parse(result.content);
      return result.content; // already valid JSON
    } catch {
      // Wrap markdown in a JSON envelope.
      return JSON.stringify(
        {
          systemPrompt:      result.content,
          tools:             result.tools,
          componentVersions: result.componentVersions,
        },
        null,
        2
      );
    }
  }

  return result.content;
}

// ──────────────────────────────────────────────
// Output helper
// ──────────────────────────────────────────────

/**
 * Write content either to stdout or to <outDir>/<slug>.<ext>.
 */
function writeOutput(slug: string, content: string, args: CliArgs): void {
  if (args.outDir === null) {
    process.stdout.write(content);
    return;
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const ext  = args.formatJson ? 'json' : 'md';
  const dest = path.join(args.outDir, `${slug}.${ext}`);
  fs.writeFileSync(dest, content, 'utf8');
}

// ──────────────────────────────────────────────
// Fatal error helper
// ──────────────────────────────────────────────

function die(msg: string): never {
  process.stderr.write(`agent-compiler: ${msg}\n`);
  process.exit(1);
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

function main(): void {
  const args            = parseArgs(process.argv);
  const { conn, db }    = openDb(args.dbPath);

  try {
    if (args.all) {
      // Compile every agent in the registry, optionally filtered by category.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentStore = new AgentStore(db as any);
      const agents     = agentStore.list(args.category ? { category: args.category } : {});

      if (agents.length === 0) {
        const scope = args.category ? ` in category '${args.category}'` : '';
        process.stderr.write(`agent-compiler: no agents found${scope}\n`);
        // Exit 0 — empty category is not an error.
      }

      for (const agent of agents) {
        const content = compileSingle(agent.slug, args, db);
        writeOutput(agent.slug, content, args);
      }
    } else {
      // Single-slug path.
      // slug is guaranteed non-null here by parseArgs.
      const content = compileSingle(args.slug as string, args, db);
      writeOutput(args.slug as string, content, args);
    }
  } finally {
    conn.close();
  }
}

main();
