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

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { resolveRegistryDbPath } from '@adhd/agent-core-env';
import { AgentStore } from '@adhd/agent-store-prompts';
import type { CompositionContext } from '@adhd/agent-store-prompts';

import { compileAgent } from '../compile.js';

// ── Migration folders ─────────────────────────────────────────────────────
//
// Each sibling registry-family package ships its drizzle-kit-generated
// migrations at the ROOT of its published package (`<pkgRoot>/drizzle`) — see
// e.g. agent-core-provider's `project.json` `assets` copying `drizzle/**/*`
// to its dist root, and its `migrate-runner.ts` resolving
// `new URL('../../drizzle', import.meta.url)` relative to
// `dist/src/db/migrate-runner.js`.
//
// We MUST resolve these via real Node module resolution rather than `..`
// arithmetic off this file's own __dirname: this monorepo builds each
// package to its OWN per-project `dist/` (via @nx/js:tsc), not into a single
// monolithic dist tree, so there is no fixed number of `..` hops from this
// compiled file to a sibling package's install location — that number
// differs between monorepo-dev, a flat-hoisted npm install, and pnpm's
// isolated store layout. `require.resolve('<pkg>/package.json')` is not an
// option either: these packages restrict the `package.json` subpath via
// `exports`, so that throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Instead we
// resolve the package's MAIN entry file (which every consumer of the
// package is already relying on being resolvable) and walk up from that
// file's directory to the nearest ancestor whose own `package.json` `name`
// matches — i.e. the real package root — then join `drizzle` onto it.
//
// Timestamp order (ascending) matters so Drizzle's journal bookkeeping
// doesn't skip a migration set:
//   provider (1750*)  →  registry (1782193*)  →  tool-registry (1782250*)
//     →  policy (1782256*)  →  compiler (18*)
//
// This mirrors the migration order in compile-agent.test.ts.

const require = createRequire(import.meta.url);

/**
 * Upper bound on how many directory levels we'll walk up from a resolved
 * entry file before giving up looking for its package root. Generous enough
 * to cover any real install layout (monorepo source, flat npm hoist, pnpm's
 * nested `.pnpm/<pkg>@<ver>/node_modules/<pkg>/dist/src/`), while still
 * failing fast — and with a clear error — instead of looping indefinitely.
 */
const MAX_PACKAGE_ROOT_WALK_UP_HOPS = 20;

/**
 * Resolve `<pkgRoot>/drizzle` for a sibling `@adhd/*` package via real Node
 * module resolution, so it works identically under monorepo-dev, a flat npm
 * install, and pnpm's isolated store.
 *
 * Resolves the package's main entry file, then walks up from that file's
 * directory to the nearest ancestor directory whose `package.json` `name`
 * field equals `pkgName` (the real package root — `dist/` in every layout
 * we ship, `packages/agent/<pkg>/` in source), and joins `drizzle` onto it.
 *
 * Throws a clear, actionable error (never silently skips) if the package
 * can't be resolved, its root can't be found, or the resolved `drizzle`
 * directory doesn't exist — a missing migration set must be a hard failure
 * at compile time, not a stderr warning that proceeds to a
 * `no such table` crash deep inside a later query.
 */
function resolveSiblingDrizzle(pkgName: string): string {
  let entryFile: string;
  try {
    entryFile = require.resolve(pkgName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `agent-compiler: cannot resolve sibling package '${pkgName}' to locate ` +
        `its drizzle migrations (is it installed / listed as a dependency ` +
        `of @adhd/agent-engine-compiler?): ${msg}`
    );
  }

  let dir = path.dirname(entryFile);
  for (let hop = 0; hop <= MAX_PACKAGE_ROOT_WALK_UP_HOPS; hop++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
          name?: string;
        };
        if (pkgJson.name === pkgName) {
          const drizzleDir = path.join(dir, 'drizzle');
          if (!fs.existsSync(drizzleDir)) {
            throw new Error(
              `agent-compiler: resolved package root for '${pkgName}' at ` +
                `'${dir}' but it has no 'drizzle' migrations directory ` +
                `('${drizzleDir}' does not exist).`
            );
          }
          return drizzleDir;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('agent-compiler:')) {
          throw err;
        }
        // Malformed package.json on the walk up — keep walking; the real
        // package root's package.json will parse fine.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }
  throw new Error(
    `agent-compiler: walked up from '${entryFile}' without finding a ` +
      `package.json named '${pkgName}' within ${MAX_PACKAGE_ROOT_WALK_UP_HOPS} ` +
      `directory hops — cannot locate its drizzle migrations directory.`
  );
}

/**
 * Resolve `<ownPkgRoot>/drizzle` for THIS package (agent-engine-compiler)
 * itself, using the same walk-up-to-package.json approach as
 * {@link resolveSiblingDrizzle} rather than a fixed hop count off
 * `import.meta.url` — this file's own compiled location
 * (`dist/src/cli/compile.js`) is two directories below the package root in
 * every layout we ship, but relying on that being exactly two hops is the
 * same brittle assumption this fix removes for siblings.
 */
function resolveOwnDrizzle(): string {
  const ownDir = fileURLToPath(new URL('.', import.meta.url));
  let dir = ownDir;
  for (let hop = 0; hop <= MAX_PACKAGE_ROOT_WALK_UP_HOPS; hop++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        name?: string;
      };
      if (pkgJson.name === '@adhd/agent-engine-compiler') {
        const drizzleDir = path.join(dir, 'drizzle');
        if (!fs.existsSync(drizzleDir)) {
          throw new Error(
            `agent-compiler: resolved own package root at '${dir}' but it ` +
              `has no 'drizzle' migrations directory ('${drizzleDir}' does ` +
              `not exist).`
          );
        }
        return drizzleDir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }
  throw new Error(
    `agent-compiler: walked up from '${ownDir}' without finding ` +
      `@adhd/agent-engine-compiler's own package.json within ` +
      `${MAX_PACKAGE_ROOT_WALK_UP_HOPS} directory hops — cannot locate its ` +
      `own drizzle migrations directory.`
  );
}

const PROVIDER_MIGRATIONS = resolveSiblingDrizzle('@adhd/agent-core-provider');
const REGISTRY_MIGRATIONS = resolveSiblingDrizzle('@adhd/agent-store-prompts');
const TOOL_REGISTRY_MIGRATIONS = resolveSiblingDrizzle(
  '@adhd/agent-store-tools'
);
const POLICY_MIGRATIONS = resolveSiblingDrizzle('@adhd/agent-core-policy');
const COMPILER_MIGRATIONS = resolveOwnDrizzle();

// ──────────────────────────────────────────────
// Resolved args
// ──────────────────────────────────────────────

interface CliArgs {
  slug: string | null; // null when --all is set
  platform: string;
  context: CompositionContext;
  formatJson: boolean;
  outDir: string | null;
  all: boolean;
  category: string | null;
  dbPath: string;
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

  let slug: string | null = null;
  let platform = 'claude_code';
  let context: CompositionContext = {};
  let formatJson = false;
  let outDir: string | null = null;
  let all = false;
  let category: string | null = null;
  // AGENT_REGISTRY_DB is this CLI's own pre-existing, bin-specific legacy
  // override (kept for back-compat) — it wins over the shared resolver's
  // canonical default but not over an explicit --db flag (applied below).
  // resolveRegistryDbPath() itself still checks the 3 documented
  // registry-family env vars (ADHD_AGENT_REGISTRY_DB_PATH,
  // REGISTRY_DATABASE_PATH, DATABASE_PATH) before falling back to the
  // @adhd/environment-resolved canonical default.
  let dbPath = process.env['AGENT_REGISTRY_DB'] ?? resolveRegistryDbPath();

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
function openDb(dbPath: string): {
  conn: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BetterSQLite3Database<any>;
} {
  if (!fs.existsSync(dbPath)) {
    const parent = path.dirname(dbPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
  }
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = OFF');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(conn, { schema: {} as any });

  // Migrate in ascending timestamp order — same pattern as the test suite.
  // Each folder was already resolved via resolveSiblingDrizzle/
  // resolveOwnDrizzle above, which throws at module-load time if it can't
  // find a package's migrations directory. We still re-verify existence
  // here (defense in depth against the directory disappearing between
  // resolution and use) and treat a missing folder as a hard failure —
  // never a warn-and-continue that silently skips a migration set and
  // proceeds to a `no such table` crash later.
  for (const folder of [
    PROVIDER_MIGRATIONS,
    REGISTRY_MIGRATIONS,
    TOOL_REGISTRY_MIGRATIONS,
    POLICY_MIGRATIONS,
    COMPILER_MIGRATIONS,
  ]) {
    if (!fs.existsSync(folder)) {
      throw new Error(
        `agent-compiler: migration folder not found: ${folder}`
      );
    }
    migrate(db, { migrationsFolder: folder });
  }

  conn.pragma('foreign_keys = ON');
  return { conn, db };
}

// ──────────────────────────────────────────────
// Compile a single agent → string artifact
// ──────────────────────────────────────────────

function compileSingle(
  slug: string,
  args: CliArgs,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BetterSQLite3Database<any>
): string {
  let result;
  try {
    result = compileAgent({
      agentSlug: slug,
      platform: args.platform,
      context: args.context,
      db,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish AGENT_NOT_FOUND / PLATFORM_NOT_FOUND from other errors.
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) {
      die(`Error: ${msg}`);
    }
    die(
      `Compilation failed for '${slug}' on platform '${args.platform}': ${msg}`
    );
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
          systemPrompt: result.content,
          tools: result.tools,
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
  const ext = args.formatJson ? 'json' : 'md';
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
  const args = parseArgs(process.argv);
  const { conn, db } = openDb(args.dbPath);

  try {
    if (args.all) {
      // Compile every agent in the registry, optionally filtered by category.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentStore = new AgentStore(db as any);
      const agents = agentStore.list(
        args.category ? { category: args.category } : {}
      );

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
