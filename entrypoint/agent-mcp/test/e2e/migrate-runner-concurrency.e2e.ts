/**
 * 8333f755 AC3 (migration 0015) -- REAL concurrent openers (ADR-0009 e2e lane; not env-gated).
 *
 * Several real node processes open ONE database file at the schema before migration 0015 and call the real `runMigrationsOn` at the same
 * instant (a start barrier). The store is parallel-process enabled (ADR-0012): every opener must come up migrated,
 * none may fail, and the new column must exist exactly once. Deterministic counterpart: migrate-runner-race.test.ts.
 *
 * R9-hist AC11 (migration 0017, `message_provider_echo`) extends this file with the same real-process treatment: N
 * concurrent runners over a database written by the previous version, and a LIVE previous-version process that holds the
 * write lock during the migration and keeps writing and deleting through it. In-process counterpart:
 * message-provider-echo-migration.test.ts.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER, runMigrationsOn } from "../../src/db/migrate-runner.js";
import { SESSION, echoIds, insertEchoRow, insertOldShapeMessage, messageIds, seedAgentAndSession } from "../fixtures/legacy-conversation.js";
import { expectedLedgerRows, idxBeforeCacheCreation1h, idxBeforeProviderEcho, journalEntries, migrationsFolderUpTo } from "../fixtures/migration-journal.js";

const CHILD = fileURLToPath(new URL("../fixtures/migrate-child.mjs", import.meta.url));
const ANNOUNCE_CHILD = fileURLToPath(new URL("../fixtures/migrate-announce-child.mjs", import.meta.url));
const OLD_BINARY_CHILD = fileURLToPath(new URL("../fixtures/old-binary-writer-child.mjs", import.meta.url));
/**
 * The child imports `db/migrate-runner.ts` straight from plain Node (no loader). Native TypeScript type-stripping
 * is on by default from Node 22.18 / 23.6 and behind this flag on 22.6-22.17 (the CI floor is Node 22); passing it
 * explicitly keeps the child working across that whole range and is harmless where it is already the default.
 * (b3999dfa AC6)
 */
const CHILD_NODE_FLAGS = ["--experimental-strip-types", "--no-warnings"];
const OPENERS = 8;
const ROUNDS = 6;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Seed `file` at the schema just BEFORE the cache_creation_1h migration (derived from the journal, not a literal). */
function seedBeforeCacheCreation1h(dir: string, file: string): void {
  const maxIdx = idxBeforeCacheCreation1h();
  const old = join(dir, `upto-${maxIdx}`);
  mkdirSync(join(old, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  journal.entries = journal.entries.filter((e) => e.idx <= maxIdx);
  writeFileSync(join(old, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(old, `${e.tag}.sql`));
  const c = new Database(file);
  c.pragma("journal_mode = WAL");
  migrate(drizzle(c), { migrationsFolder: old });
  c.close();
}

function runChild(dbFile: string, goFile: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [...CHILD_NODE_FLAGS, CHILD, dbFile, goFile], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => resolve({ code, out }));
  });
}

describe("8333f755 AC3: parallel-process openers of one old-schema database", () => {
  it("b3999dfa AC6: the module the child loads under bare Node is strip-types-clean (no relative imports, no non-erasable syntax)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/db/migrate-runner.ts", import.meta.url)), "utf8");
    // Bare Node does not rewrite `./x.js` -> `./x.ts`; a relative import here would make every child fail to load.
    expect(src.match(/^\s*(?:import|export)\b[^;]*\bfrom\s+["']\.{1,2}\//gm) ?? []).toEqual([]);
    // enums / namespaces / constructor parameter properties are not erasable.
    expect(src).not.toMatch(/^\s*(?:export\s+)?(?:const\s+)?enum\s/m);
    expect(src).not.toMatch(/^\s*(?:export\s+)?namespace\s/m);
    expect(src).not.toMatch(/constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s/);
  });

  it(`8333f755 AC3: ${OPENERS} processes migrating one old-schema database at once all succeed, ${ROUNDS} rounds, column added exactly once`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "adhd-mig-conc-")));
      dirs.push(dir);
      const file = join(dir, "agent.db");
      const go = join(dir, "go");
      seedBeforeCacheCreation1h(dir, file);
      const running = Array.from({ length: OPENERS }, () => runChild(file, go));
      writeFileSync(go, "go");
      const results = await Promise.all(running);
      expect(results.filter((r) => r.code !== 0).map((r) => r.out), `round ${round}`).toEqual([]);
      const c = new Database(file);
      const cols = (c.prepare("PRAGMA table_info(task_usage)").all() as Array<{ name: string }>).filter((x) => x.name === "cache_creation_1h_tokens");
      expect(cols).toHaveLength(1);
      expect((c.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(expectedLedgerRows());
      c.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// R9-hist AC11: migration 0017 (`message_provider_echo`) against REAL processes.
// ---------------------------------------------------------------------------------------------------------------------

/** Every reply/announcement line a child prints, with awaitable, deadline-bounded reads (no sleeps). */
class LineReader {
  private readonly lines: string[] = [];
  private waiter: (() => void) | undefined;
  constructor(stream: NodeJS.ReadableStream) {
    let buf = "";
    stream.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        this.lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      this.waiter?.();
    });
  }
  /** Resolve with the next line, or reject once `deadlineMs` has passed (a hang is a failure, not a wait). */
  next(what: string, deadlineMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(new Error(`timed out waiting for ${what}`)); }, deadlineMs);
      const check = (): void => {
        const line = this.lines.shift();
        if (line === undefined) { this.waiter = check; return; }
        clearTimeout(timer);
        this.waiter = undefined;
        resolve(line);
      };
      check();
    });
  }
  /** Skip lines until one equals `want`. */
  async until(want: string): Promise<void> {
    for (;;) if ((await this.next(`line "${want}"`)) === want) return;
  }
}

/** A live PREVIOUS-VERSION process: it never learns about the echo table. */
class OldBinary {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly reader: LineReader;
  private readonly exited: Promise<number | null>;
  constructor(dbFile: string) {
    this.proc = spawn(process.execPath, [...CHILD_NODE_FLAGS, OLD_BINARY_CHILD, dbFile, SESSION], { stdio: ["pipe", "pipe", "pipe"] });
    this.reader = new LineReader(this.proc.stdout);
    this.proc.stderr.on("data", () => undefined);
    this.exited = new Promise((resolve) => this.proc.on("close", resolve));
  }
  async send(cmd: Record<string, unknown>): Promise<{ ok: boolean; error?: string; n?: number; changes?: number }> {
    this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    return JSON.parse(await this.reader.next(`reply to ${JSON.stringify(cmd)}`)) as { ok: boolean; error?: string; n?: number; changes?: number };
  }
  async quit(): Promise<number | null> {
    await this.send({ op: "quit" });
    return this.exited;
  }
  kill(): void {
    this.proc.kill("SIGKILL");
  }
}

/** The NEW binary's migration run, announcing its progress. */
function startAnnouncedRunner(dbFile: string, goFile: string, folder?: string) {
  const p = spawn(process.execPath, [...CHILD_NODE_FLAGS, ANNOUNCE_CHILD, dbFile, goFile, ...(folder ? [folder] : [])], { stdio: ["ignore", "pipe", "pipe"] });
  const reader = new LineReader(p.stdout);
  let err = "";
  p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  const closed = new Promise<number | null>((resolve) => p.on("close", resolve));
  return { reader, closed, stderr: () => err, kill: () => p.kill("SIGKILL") };
}

/** A database at the schema the PREVIOUS version shipped, holding agent a1 / session s1 / messages m1, m2. */
function seedPreviousVersion(dir: string, name = "agent.db"): string {
  const file = join(dir, name);
  const c = new Database(file);
  c.pragma("journal_mode = WAL");
  migrate(drizzle(c), { migrationsFolder: migrationsFolderUpTo(idxBeforeProviderEcho(), dir) });
  seedAgentAndSession(c);
  insertOldShapeMessage(c, "m1", 1);
  insertOldShapeMessage(c, "m2", 2);
  c.close();
  return file;
}

const scratchDir = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "adhd-echo-conc-")));
  dirs.push(dir);
  return dir;
};

const objectsNamed = (c: Database.Database): Array<{ type: string; name: string }> =>
  c.prepare("SELECT type, name FROM sqlite_master WHERE name IN ('message_provider_echo','idx_message_provider_echo_session') ORDER BY name").all() as Array<{ type: string; name: string }>;

describe("R9-hist AC11: migration 0017 under real parallel processes", () => {
  it(`R9-hist AC11: ${OPENERS} processes migrating one previous-version database at once all succeed, ${ROUNDS} rounds; table and index exist once, the conversation is intact`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const dir = scratchDir();
      const file = seedPreviousVersion(dir);
      const go = join(dir, "go");
      const running = Array.from({ length: OPENERS }, () => runChild(file, go));
      writeFileSync(go, "go");
      const results = await Promise.all(running);
      expect(results.filter((r) => r.code !== 0).map((r) => r.out), `round ${round}`).toEqual([]);
      const c = new Database(file);
      expect(objectsNamed(c), `round ${round}`).toEqual([
        { type: "index", name: "idx_message_provider_echo_session" },
        { type: "table", name: "message_provider_echo" },
      ]);
      // 0017 is idempotent (IF NOT EXISTS), so a loser that read the ledger before a rival committed re-runs it as a no-op and
      // INSERTs a second ledger row for the same migration (a non-idempotent first-pending migration, like 0015's ALTER, throws
      // and retries instead). drizzle only reads the NEWEST `created_at`, so a duplicate row is benign; what must hold is that
      // every migration is recorded, none is missing, and the newest stamp is the last journal entry's `when`.
      const ledger = c.prepare("SELECT hash, created_at FROM __drizzle_migrations").all() as Array<{ hash: string; created_at: number }>;
      expect(new Set(ledger.map((r) => r.hash)).size, `round ${round}: distinct migrations recorded`).toBe(expectedLedgerRows());
      expect(ledger.length, `round ${round}: at most one extra row per losing opener`).toBeLessThanOrEqual(expectedLedgerRows() + OPENERS - 1);
      expect(Math.max(...ledger.map((r) => Number(r.created_at))), `round ${round}`).toBe(journalEntries()[expectedLedgerRows() - 1].when);
      expect(messageIds(c)).toEqual(["m1", "m2"]);
      expect(echoIds(c)).toEqual([]);
      expect(c.pragma("foreign_key_check")).toEqual([]);
      c.close();
    }
  }, 120_000);

  it("R9-hist AC11: a previous-version process holds the write lock while the new binary migrates; the migration waits, lands once the holder commits, and the holder's rows are kept", async () => {
    const dir = scratchDir();
    const file = seedPreviousVersion(dir);
    const go = join(dir, "go");
    const old = new OldBinary(file);
    const runner = startAnnouncedRunner(file, go);
    try {
      expect(await old.send({ op: "begin" })).toEqual({ ok: true });
      expect(await old.send({ op: "insert", id: "m-held", n: 3 })).toEqual({ ok: true });
      writeFileSync(go, "go");
      await runner.reader.until("started");
      await runner.reader.until("begin"); // the migration transaction is open; its first write queues behind the holder's lock
      // While the holder keeps its lock the migration cannot finish: a bounded absence check (it can only pass if the runner is blocked).
      await expect(runner.reader.next("runner finishing", 250)).rejects.toThrow(/timed out/);
      expect(await old.send({ op: "commit" })).toEqual({ ok: true });
      await runner.reader.until("ok");
      expect(await runner.closed, runner.stderr()).toBe(0);
      expect(await old.send({ op: "count" })).toEqual({ ok: true, n: 3 });
    } finally {
      runner.kill();
      old.kill();
    }
    const c = new Database(file);
    expect(messageIds(c)).toEqual(["m1", "m2", "m-held"]);
    expect(objectsNamed(c)).toHaveLength(2);
    expect((c.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(expectedLedgerRows());
    c.close();
  }, 60_000);

  it("R9-hist AC11: the previous-version process keeps working across the migration and alternating old/new writers leave a valid mixed history (cascade through the old binary's DELETE)", async () => {
    const dir = scratchDir();
    const file = seedPreviousVersion(dir);
    const go = join(dir, "go");
    const old = new OldBinary(file);
    // The old process warms its prepared statements BEFORE the schema changes under it.
    expect(await old.send({ op: "insert", id: "old-1", n: 3 })).toEqual({ ok: true });

    const runner = startAnnouncedRunner(file, go);
    writeFileSync(go, "go");
    try {
      await runner.reader.until("ok");
      expect(await runner.closed, runner.stderr()).toBe(0);

      const newBinary = new Database(file);
      newBinary.pragma("busy_timeout = 30000");
      newBinary.pragma("foreign_keys = ON");
      // Alternate: old writes, new writes (message + echo in ONE transaction), old writes, ...
      for (let i = 0; i < 4; i++) {
        expect(await old.send({ op: "insert", id: `old-${i + 2}`, n: 10 + i * 2 })).toEqual({ ok: true });
        newBinary.transaction(() => {
          insertOldShapeMessage(newBinary, `new-${i}`, 11 + i * 2);
          insertEchoRow(newBinary, `new-${i}`);
        })();
      }
      expect(echoIds(newBinary)).toEqual(["new-0", "new-1", "new-2", "new-3"]); // only new-binary messages carry an echo
      expect(newBinary.pragma("foreign_key_check")).toEqual([]);

      // The previous version's clearMessages-style DELETE relies on the FK cascade, which holds for it because it runs foreign_keys=ON.
      expect(await old.send({ op: "delete", id: "new-1" })).toEqual({ ok: true, changes: 1 });
      expect(echoIds(newBinary)).toEqual(["new-0", "new-2", "new-3"]);
      expect(newBinary.pragma("foreign_key_check")).toEqual([]);
      expect(messageIds(newBinary)).toEqual(["m1", "m2", "old-1", "old-2", "new-0", "old-3", "old-4", "new-2", "old-5", "new-3"]);
      expect(await old.send({ op: "count" })).toEqual({ ok: true, n: 10 });
      newBinary.close();
      expect(await old.quit()).toBe(0);
    } finally {
      runner.kill();
      old.kill();
    }
  }, 60_000);

  it("R9-hist AC11: negative control -- a NON-additive migration breaks the live previous-version writer, so the check above can fail", async () => {
    const dir = scratchDir();
    const file = seedPreviousVersion(dir);
    const old = new OldBinary(file);
    try {
      expect(await old.send({ op: "insert", id: "before", n: 3 })).toEqual({ ok: true });
      const breaking = migrationsFolderUpTo(idxBeforeProviderEcho(), dir, {
        name: "breaking",
        extra: [{ tag: "0017_rename_messages_content", sql: "ALTER TABLE `messages` RENAME COLUMN `content` TO `body`;" }],
      });
      const c = new Database(file);
      c.pragma("busy_timeout = 30000");
      runMigrationsOn(c, drizzle(c), breaking);
      c.close();
      const after = await old.send({ op: "insert", id: "after", n: 4 });
      expect(after.ok).toBe(false);
      expect(after.error).toMatch(/content/);
    } finally {
      old.kill();
    }
  }, 60_000);
});
