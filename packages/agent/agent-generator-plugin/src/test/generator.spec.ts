import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readProjectConfiguration, readJson } from '@nx/devkit';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Dirent,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { registryPackageGenerator } from '../generators/registry-package/generator';
import { shellQuote } from '../lib/shell-quote';
import {
  DIRECTORY_PATTERN,
  NAME_PATTERN,
  TABLE_PREFIX_PATTERN,
} from '../lib/safe-inputs';

function seed(tree: ReturnType<typeof createTreeWithEmptyWorkspace>) {
  // tsconfig.base.json must exist for the additive updateJson wiring.
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { paths: {} } })
  );
  return tree;
}

/** Workspace root — 5 levels up from `<root>/packages/agent/<pkg>/src/test`. */
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../..');

/** Every live `@adhd/*` package name in this workspace (packages/ + entrypoint/). */
function collectWorkspacePackageNames(root: string): Set<string> {
  const names = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      try {
        const pkg = JSON.parse(
          readFileSync(path.join(dir, 'package.json'), 'utf-8')
        ) as { name?: unknown };
        if (typeof pkg.name === 'string' && pkg.name.startsWith('@adhd/')) {
          names.add(pkg.name);
        }
      } catch {
        // A malformed package.json is not this test's concern.
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(path.join(root, 'packages'), 0);
  visit(path.join(root, 'entrypoint'), 0);
  return names;
}

const SHELL_METACHARACTERS = new Set([';', '&', '|', '<', '>', '$', '`', '"', '\n']);

/**
 * Characters in `command` that a shell would act on AND that sit outside a
 * POSIX single-quoted span. Quoted values never appear here, so an empty result
 * means no live interpolation can break out.
 */
function unquotedShellMetacharacters(command: string): string[] {
  const unquoted = command.replace(/'[^']*'/g, '');
  return [...unquoted].filter((c) => SHELL_METACHARACTERS.has(c));
}

interface CommandTarget {
  options?: { command?: unknown; cwd?: unknown };
}

function targetCommandMap(
  tree: ReturnType<typeof createTreeWithEmptyWorkspace>,
  project: string
): Record<string, CommandTarget> {
  const config = readProjectConfiguration(tree, project);
  return (config.targets ?? {}) as Record<string, CommandTarget>;
}

function readSchemaPatterns(): {
  name: string;
  directory: string;
  tablePrefix: string;
} {
  const raw = JSON.parse(
    readFileSync(
      path.join(__dirname, '../generators/registry-package/schema.json'),
      'utf-8'
    )
  ) as { properties?: Record<string, { pattern?: unknown }> };
  const get = (key: string): string => {
    const value = raw.properties?.[key]?.pattern;
    if (typeof value !== 'string') {
      throw new Error(`schema.json: '${key}' has no pattern`);
    }
    return value;
  };
  return {
    name: get('name'),
    directory: get('directory'),
    tablePrefix: get('tablePrefix'),
  };
}

describe('registry-package generator', () => {
  it('creates project.json with the layer:ai + platform:node tags', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const config = readProjectConfiguration(tree, 'agent-budget');
    expect(config.tags).toEqual(['layer:ai', 'platform:node']);
  });

  it('names the project agent-<name> and roots it under packages/agent', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'tool-registry' });
    const config = readProjectConfiguration(tree, 'agent-tool-registry');
    expect(config.root).toBe('packages/agent/agent-tool-registry');
  });

  it('uses @nx/js:tsc for build with the drizzle asset glob', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const config = readProjectConfiguration(tree, 'agent-budget');
    expect(config.targets?.['build']?.executor).toBe('@nx/js:tsc');
    const assets = config.targets?.['build']?.options?.['assets'];
    expect(assets).toEqual([
      { input: 'packages/agent/agent-budget', glob: 'drizzle/**/*', output: '.' },
    ]);
  });

  it('does NOT redefine cache/dependsOn on build, test, or typecheck (inherits from nx.json)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const config = readProjectConfiguration(tree, 'agent-budget');
    for (const t of ['build', 'test', 'typecheck'] as const) {
      expect(config.targets?.[t]).toBeDefined();
      expect(config.targets?.[t]?.cache).toBeUndefined();
      expect(config.targets?.[t]?.dependsOn).toBeUndefined();
    }
  });

  it('declares db:generate, db:migrate, typecheck, clean, and nx-release-publish targets', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const config = readProjectConfiguration(tree, 'agent-budget');
    expect(config.targets?.['db:generate']).toBeDefined();
    expect(config.targets?.['db:migrate']).toBeDefined();
    expect(config.targets?.['typecheck']).toBeDefined();
    expect(config.targets?.['clean']).toBeDefined();
    expect(config.targets?.['nx-release-publish']?.dependsOn).toEqual([
      'build',
      'test',
    ]);
  });

  it('writes the full golden-path skeleton', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const base = 'packages/agent/agent-budget';
    for (const f of [
      'package.json',
      'project.json',
      'eslint.config.mjs',
      'vite.config.ts',
      'drizzle.config.ts',
      'tsconfig.json',
      'tsconfig.lib.json',
      'tsconfig.spec.json',
      'README.md',
      'CLAUDE.md',
      'src/index.ts',
      'src/db/schema.ts',
      'src/db/migrate-runner.ts',
      'src/__tests__/skeleton.test.ts',
      'drizzle/meta/_journal.json',
    ]) {
      expect(tree.exists(`${base}/${f}`)).toBe(true);
    }
  });

  it('package.json declares @adhd/agent-core-env + drizzle-orm + better-sqlite3 runtime deps (no unused zod)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const pkg = readJson(tree, 'packages/agent/agent-budget/package.json');
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@adhd/agent-core-env',
      'better-sqlite3',
      'drizzle-orm',
    ]);
    expect(pkg.dependencies.zod).toBeUndefined();
    expect(pkg.name).toBe('@adhd/agent-budget');
  });

  it('does NOT scaffold a module-scope db/client.ts or db/migrate.ts singleton (ENV-ADOPT-CLUSTERS(1) — every DB connection is opened via @adhd/agent-core-env, never at import time)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const base = 'packages/agent/agent-budget';
    expect(tree.exists(`${base}/src/db/client.ts`)).toBe(false);
    expect(tree.exists(`${base}/src/db/migrate.ts`)).toBe(false);
    const barrel = tree.read(`${base}/src/index.ts`, 'utf-8');
    expect(barrel).not.toContain("from './db/client.js'");
    expect(barrel).not.toContain("from './db/migrate.js'");
    const drizzleConfig = tree.read(`${base}/drizzle.config.ts`, 'utf-8');
    expect(drizzleConfig).toContain('resolveRegistryDbPath');
  });

  it('flat eslint config imports the workspace base so a lint target is inferred', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const eslint = tree.read(
      'packages/agent/agent-budget/eslint.config.mjs',
      'utf-8'
    );
    expect(eslint).toContain(
      "import baseConfig from '../../../eslint.base.config.mjs'"
    );
  });

  it('derives the table prefix and stamps it into the schema header', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'tool-registry' });
    const schema = tree.read(
      'packages/agent/agent-tool-registry/src/db/schema.ts',
      'utf-8'
    );
    expect(schema).not.toBeNull();
    expect(schema).toContain('table prefix: tool_registry_');
  });

  it('honours a custom tablePrefix', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, {
      name: 'billing',
      tablePrefix: 'billing_',
    });
    const schema = tree.read(
      'packages/agent/agent-billing/src/db/schema.ts',
      'utf-8'
    );
    expect(schema).not.toBeNull();
    expect(schema).toContain('table prefix: billing_');
  });

  it('skeleton test uses real DB + close/reopen (no :memory:, no mock)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const spec = tree.read(
      'packages/agent/agent-budget/src/__tests__/skeleton.test.ts',
      'utf-8'
    );
    expect(spec).not.toBeNull();
    expect(spec).toContain('better-sqlite3');
    expect(spec).toContain('reopen');
    expect(spec).not.toContain(':memory:');
  });

  it('adds the package path to tsconfig.base.json (additive)', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const tsconfig = readJson(tree, 'tsconfig.base.json');
    expect(tsconfig.compilerOptions.paths['@adhd/agent-budget']).toEqual([
      './packages/agent/agent-budget/src/index.ts',
    ]);
  });

  it('CLAUDE.md links the rules doc', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const claude = tree.read('packages/agent/agent-budget/CLAUDE.md', 'utf-8');
    expect(claude).not.toBeNull();
    expect(claude).toContain('REGISTRY-PACKAGE-RULES.md');
  });

  it('honours a custom directory', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, {
      name: 'budget',
      directory: 'packages/custom/agent-budget',
    });
    expect(tree.exists('packages/custom/agent-budget/project.json')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Hardening (BUG-AGENTMCP-GENERATOR-SHELL/SQL-INJECTION, TEMPLATE-NAMES-AGENT-NX)
// ────────────────────────────────────────────────────────────────────────────

describe('registry-package generator — input hardening', () => {
  it('rejects a shell-injecting directory before any tree mutation', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await expect(
      registryPackageGenerator(tree, {
        name: 'budget',
        directory: `packages/x; rm -rf ${tmpdir()}/pwned`,
      })
    ).rejects.toThrow(/directory/i);

    // The guard runs BEFORE addProjectConfiguration/files, so nothing was
    // written — no half-scaffolded package is left behind.
    expect(tree.exists('packages/agent/agent-budget/project.json')).toBe(false);
    expect(() => readProjectConfiguration(tree, 'agent-budget')).toThrow();
    expect(tree.exists('packages/x; rm -rf ' + tmpdir() + '/pwned')).toBe(false);
  });

  it('rejects a tablePrefix containing SQL metacharacters before any tree mutation', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await expect(
      registryPackageGenerator(tree, {
        name: 'budget',
        tablePrefix: 'budget_probe"; DROP TABLE agent; --',
      })
    ).rejects.toThrow(/tablePrefix/i);
    expect(tree.exists('packages/agent/agent-budget/project.json')).toBe(false);
  });

  it('rejects a directory that escapes the workspace with a .. segment', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await expect(
      registryPackageGenerator(tree, {
        name: 'budget',
        directory: '../../etc/agent-budget',
      })
    ).rejects.toThrow(/directory/i);

    await expect(
      registryPackageGenerator(tree, {
        name: 'budget',
        directory: '/etc/agent-budget',
      })
    ).rejects.toThrow(/directory/i);
  });

  it('rejects a non-kebab-case name', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await expect(
      registryPackageGenerator(tree, { name: 'Budget' })
    ).rejects.toThrow(/name/i);
    await expect(
      registryPackageGenerator(tree, { name: 'budget_probe' })
    ).rejects.toThrow(/name/i);
  });

  it('emits no shell metacharacter outside quotes in ANY target command', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const targets = targetCommandMap(tree, 'agent-budget');
    const commands: string[] = [];
    for (const target of Object.values(targets)) {
      if (typeof target.options?.command === 'string') {
        commands.push(target.options.command);
      }
    }
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      expect(unquotedShellMetacharacters(command)).toEqual([]);
    }
  });

  it('typechecks via a fixed command + cwd, and cleans via a POSIX-quoted path with no cwd', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });
    const targets = targetCommandMap(tree, 'agent-budget');

    const typecheck = targets['typecheck']?.options;
    expect(typecheck?.command).toBe('tsc -p tsconfig.json --noEmit');
    expect(typecheck?.cwd).toBe('packages/agent/agent-budget');

    const clean = targets['clean']?.options;
    expect(clean?.cwd).toBeUndefined();
    expect(clean?.command).toBe(
      `rm -rf ${shellQuote('dist/packages/agent/agent-budget')}`
    );
    expect(unquotedShellMetacharacters(clean?.command as string)).toEqual([]);
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes POSIX-style', () => {
    expect(shellQuote('dist/packages/agent/agent-budget')).toBe(
      "'dist/packages/agent/agent-budget'"
    );
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('; rm -rf /')).toBe("'; rm -rf /'");
  });
});

describe('safe-inputs patterns', () => {
  it('NAME_PATTERN admits kebab-case and rejects uppercase, underscores and metacharacters', () => {
    expect(NAME_PATTERN.test('budget')).toBe(true);
    expect(NAME_PATTERN.test('tool-registry')).toBe(true);
    expect(NAME_PATTERN.test('smoke-test-pkg')).toBe(true);
    expect(NAME_PATTERN.test('Budget')).toBe(false);
    expect(NAME_PATTERN.test('budget_probe')).toBe(false);
    expect(NAME_PATTERN.test('budget; rm -rf /')).toBe(false);
  });

  it('DIRECTORY_PATTERN admits safe relative paths and rejects traversal/metacharacters', () => {
    expect(DIRECTORY_PATTERN.test('packages/agent/agent-budget')).toBe(true);
    expect(DIRECTORY_PATTERN.test('packages/custom/agent-budget')).toBe(true);
    expect(DIRECTORY_PATTERN.test('../../etc')).toBe(false);
    expect(DIRECTORY_PATTERN.test('a/../b')).toBe(false);
    expect(DIRECTORY_PATTERN.test('/etc')).toBe(false);
    expect(DIRECTORY_PATTERN.test('packages/x; rm -rf /')).toBe(false);
  });

  it('TABLE_PREFIX_PATTERN admits a SQL identifier and rejects injection payloads', () => {
    expect(TABLE_PREFIX_PATTERN.test('budget_')).toBe(true);
    expect(TABLE_PREFIX_PATTERN.test('tool_registry_')).toBe(true);
    expect(TABLE_PREFIX_PATTERN.test('1bad')).toBe(false);
    expect(TABLE_PREFIX_PATTERN.test('budget_probe"; DROP TABLE x; --')).toBe(
      false
    );
  });
});

describe('schema.json', () => {
  it('constrains name, directory, and tablePrefix to the runtime-safe patterns', () => {
    const patterns = readSchemaPatterns();
    const nameRe = new RegExp(patterns.name);
    const dirRe = new RegExp(patterns.directory);
    const tableRe = new RegExp(patterns.tablePrefix);

    expect(nameRe.test('tool-registry')).toBe(true);
    expect(nameRe.test('Budget')).toBe(false);
    expect(nameRe.test('budget; rm -rf /')).toBe(false);

    expect(dirRe.test('packages/agent/agent-budget')).toBe(true);
    expect(dirRe.test('../../etc')).toBe(false);
    expect(dirRe.test('packages/x; rm -rf /')).toBe(false);

    expect(tableRe.test('budget_')).toBe(true);
    expect(tableRe.test('1bad')).toBe(false);
    expect(tableRe.test('budget_probe"; DROP TABLE x; --')).toBe(false);
  });
});

describe('emitted skeleton test — quoted identifier runs on a real DB', () => {
  it('double-quotes the table identifier and executes its SQL against a real better-sqlite3 file', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'billing' });
    const spec = tree.read(
      'packages/agent/agent-billing/src/__tests__/skeleton.test.ts',
      'utf-8'
    );
    expect(spec).not.toBeNull();
    const text = spec as string;

    // The SQL identifier is quoted, so the prefix cannot escape into DDL.
    expect(text).toContain('"billing_probe"');
    expect(text).not.toContain('CREATE TABLE billing_probe');

    // Pull the actual SQL statements out of the emitted test and run them
    // against a real on-disk DB — proves the emitted harness is valid SQL.
    const statements = [...text.matchAll(/`([^`]*)`/g)]
      .map((m) => m[1])
      .filter((s) => /^(CREATE|INSERT|SELECT)\b/.test(s) && s.includes('probe'));
    const create = statements.find((s) => s.startsWith('CREATE'));
    const insert = statements.find((s) => s.startsWith('INSERT'));
    const select = statements.find((s) => s.startsWith('SELECT'));
    expect(create).toBeDefined();
    expect(insert).toBeDefined();
    expect(select).toBeDefined();

    const dir = mkdtempSync(path.join(tmpdir(), 'agent-generator-spec-'));
    const dbPath = path.join(dir, 'registry.db');
    try {
      const db = new Database(dbPath);
      db.exec(create as string);
      db.prepare(insert as string).run('alpha', 'hello');
      const row = db.prepare(select as string).get('alpha') as
        | { label: string }
        | undefined;
      db.close();
      expect(row?.label).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generated docs reference only real workspace projects', () => {
  it('every @adhd/* package named in the generated README/CLAUDE.md resolves to a real project', async () => {
    const tree = seed(createTreeWithEmptyWorkspace());
    await registryPackageGenerator(tree, { name: 'budget' });

    const README = 'packages/agent/agent-budget/README.md';
    const CLAUDE = 'packages/agent/agent-budget/CLAUDE.md';
    const readme = tree.read(README, 'utf-8');
    const claude = tree.read(CLAUDE, 'utf-8');
    expect(readme).not.toBeNull();
    expect(claude).not.toBeNull();
    expect(readme).toContain('@adhd/agent-generator-plugin');
    expect(claude).toContain('@adhd/agent-generator-plugin');
    expect(readme).not.toContain('@adhd/agent-nx');
    expect(claude).not.toContain('@adhd/agent-nx');

    const real = collectWorkspacePackageNames(WORKSPACE_ROOT);
    expect(real.has('@adhd/agent-generator-plugin')).toBe(true);
    expect(real.has('@adhd/agent-core-env')).toBe(true);

    const ownName = '@adhd/agent-budget';
    const refs = new Set(
      `${readme}\n${claude}`.match(/@adhd\/[a-z0-9-]+/g) ?? []
    );
    refs.delete(ownName);
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(real.has(ref)).toBe(true);
    }
  });
});
