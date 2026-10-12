/**
 * R9-hist AC10 / AC11 -- migration 0017 (`message_provider_echo`), in-process proofs (ADR-0009 unit lane: no subprocess).
 * The multi-process counterparts (concurrent runners, a previous-version process holding the database) are in
 * migrate-runner-concurrency.e2e.test.ts.
 *
 * Every proof has a negative control: a deliberately-wrong 0017 (built by `migrationsFolderUpTo` with a rewritten SQL
 * file) that the same assertion must reject, so the assertion cannot pass vacuously.
 *
 * NOT covered here (S4a owns the store code and `schema.ts`): the `schema_v` > supported rows being ignored on read,
 * the sweeper, and "DDL equals schema.ts". What this file pins is the table S4a's test DDL and schema.ts must equal.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER, classifyMigrationRace, runMigrationsOn } from "../db/migrate-runner.js";
import { SESSION, echoIds, insertEchoRow, insertOldShapeMessage, messageIds, seedAgentAndSession } from "./fixtures/legacy-conversation.js";
import { expectedLedgerRows, idxBeforeProviderEcho, journalEntries, migrationsFolderUpTo, providerEchoEntry } from "./fixtures/migration-journal.js";

const PRE = idxBeforeProviderEcho();
const ECHO_TAG = providerEchoEntry().tag;
const shippedSql = (): string => readFileSync(join(MIGRATIONS_FOLDER, `${ECHO_TAG}.sql`), "utf8");

const dirs: string[] = [];
const conns: Database.Database[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) if (c.open) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "adhd-echo-mig-"));
  dirs.push(d);
  return d;
};
const open = (file: string, opts: Database.Options = {}): Database.Database => {
  const c = new Database(file, opts);
  conns.push(c);
  return c;
};

/** A database file migrated to the schema the PREVIOUS version shipped (everything before 0017), holding a short conversation. */
function previousVersionDb(dir: string): string {
  const file = join(dir, "agent.db");
  const c = open(file);
  c.pragma("journal_mode = WAL");
  migrate(drizzle(c), { migrationsFolder: migrationsFolderUpTo(PRE, dir) });
  seedAgentAndSession(c);
  insertOldShapeMessage(c, "m1", 1);
  insertOldShapeMessage(c, "m2", 2);
  c.close();
  return file;
}

/** A fully migrated in-memory database (shipped folder) with FK enforcement as the host runs it. */
function migratedMemory(folder: string = MIGRATIONS_FOLDER, fk: "ON" | "OFF" = "ON"): Database.Database {
  const c = open(":memory:");
  runMigrationsOn(c, drizzle(c), folder);
  c.pragma(`foreign_keys = ${fk}`);
  seedAgentAndSession(c);
  insertOldShapeMessage(c, "m1", 1);
  insertOldShapeMessage(c, "m2", 2);
  return c;
}

interface IColumn { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
const columns = (c: Database.Database, table: string): IColumn[] => c.prepare(`PRAGMA table_info(${table})`).all() as IColumn[];

describe("R9-hist AC11: migration 0017 is registered like every shipped migration", () => {
  it("R9-hist AC11: 0017 is the newest journal entry, its `when` is strictly above every earlier one, and the file exists", () => {
    const entries = journalEntries();
    const echo = providerEchoEntry();
    expect(echo.tag).toBe("0017_message_provider_echo");
    expect(echo.idx).toBe(17);
    expect(entries[entries.length - 1]).toEqual(echo);
    // drizzle skips a migration whose `when` is not above the ledger's newest created_at (AGENTS.md "Journal `when` caveat").
    for (const e of entries.filter((x) => x.idx < echo.idx)) expect(echo.when, e.tag).toBeGreaterThan(e.when);
    expect(shippedSql().length).toBeGreaterThan(0);
  });
});

describe("R9-hist AC11: the table the spec defines", () => {
  it("R9-hist AC11: columns, defaults, primary key, cascading FK to messages(id) and the session index are exactly spec-v2 section 1", () => {
    const c = migratedMemory();
    expect(columns(c, "message_provider_echo").map((x) => ({ name: x.name, type: x.type.toLowerCase(), notnull: x.notnull, dflt: x.dflt_value, pk: x.pk }))).toEqual([
      { name: "message_id", type: "text", notnull: 1, dflt: null, pk: 1 },
      { name: "session_id", type: "text", notnull: 1, dflt: null, pk: 0 },
      { name: "provider", type: "text", notnull: 1, dflt: null, pk: 0 },
      { name: "model", type: "text", notnull: 1, dflt: null, pk: 0 },
      { name: "schema_v", type: "integer", notnull: 1, dflt: "1", pk: 0 },
      { name: "blocks", type: "text", notnull: 1, dflt: null, pk: 0 },
      { name: "bytes", type: "integer", notnull: 1, dflt: null, pk: 0 },
      { name: "server_bytes", type: "integer", notnull: 1, dflt: "0", pk: 0 },
      { name: "created_at", type: "text", notnull: 1, dflt: null, pk: 0 },
    ]);
    const fks = c.prepare("PRAGMA foreign_key_list(message_provider_echo)").all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(fks.map((f) => ({ table: f.table, from: f.from, to: f.to, on_delete: f.on_delete }))).toEqual([{ table: "messages", from: "message_id", to: "id", on_delete: "CASCADE" }]);
    const idx = (c.prepare("PRAGMA index_list(message_provider_echo)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(idx).toContain("idx_message_provider_echo_session");
    expect((c.prepare("PRAGMA index_info(idx_message_provider_echo_session)").all() as Array<{ name: string }>).map((i) => i.name)).toEqual(["session_id"]);
  });

  it("R9-hist AC11: a per-session lookup is served by the session index, not a scan", () => {
    const c = migratedMemory();
    const plan = (c.prepare("EXPLAIN QUERY PLAN SELECT message_id FROM message_provider_echo WHERE session_id = 's1'").all() as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    expect(plan).toMatch(/idx_message_provider_echo_session/);
    expect(plan).not.toMatch(/SCAN message_provider_echo/);
  });

  it("R9-hist AC11: defaults apply (schema_v 1, server_bytes 0) and a future schema_v is storable (no CHECK that would break a newer writer)", () => {
    const c = migratedMemory();
    c.prepare("INSERT INTO message_provider_echo (message_id, session_id, provider, model, blocks, bytes, created_at) VALUES ('m1','s1','anthropic','m','[]',2,'t')").run();
    expect(c.prepare("SELECT schema_v, server_bytes FROM message_provider_echo WHERE message_id='m1'").get()).toEqual({ schema_v: 1, server_bytes: 0 });
    insertEchoRow(c, "m2", { schemaV: 2 });
    expect(c.prepare("SELECT schema_v FROM message_provider_echo WHERE message_id='m2'").get()).toEqual({ schema_v: 2 });
  });

  it("R9-hist AC11: the keyed INSERT is conflict-safe (ON CONFLICT DO NOTHING keeps the first row, ADR-0001/0012)", () => {
    const c = migratedMemory();
    const ins = c.prepare("INSERT INTO message_provider_echo (message_id, session_id, provider, model, blocks, bytes, created_at) VALUES ('m1','s1','anthropic',?,'[]',2,'t') ON CONFLICT(message_id) DO NOTHING");
    expect(ins.run("first").changes).toBe(1);
    expect(ins.run("second").changes).toBe(0);
    expect(c.prepare("SELECT model FROM message_provider_echo WHERE message_id='m1'").get()).toEqual({ model: "first" });
  });
});

describe("R9-hist AC11: additive -- a database written by the previous version loads", () => {
  it("R9-hist AC11: previous-version rows survive, the new table starts empty, the ledger is complete, a second run is a no-op", () => {
    const file = previousVersionDb(scratch());
    const c = open(file);
    expect(c.prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_provider_echo'").get()).toBeUndefined();
    runMigrationsOn(c, drizzle(c));
    runMigrationsOn(c, drizzle(c));
    expect(messageIds(c)).toEqual(["m1", "m2"]);
    expect(c.prepare("SELECT content FROM messages WHERE id='m1'").get()).toEqual({ content: "content of m1" });
    expect(echoIds(c)).toEqual([]);
    expect((c.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(expectedLedgerRows());
    expect(c.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('message_provider_echo','idx_message_provider_echo_session')").get()).toEqual({ n: 2 });
    expect(c.pragma("foreign_key_check")).toEqual([]);
  });

  it("R9-hist AC11: `messages` is byte-identical before and after (nothing is ALTERed); negative control: an ALTERing 0017 changes it", () => {
    const messagesDdl = (c: Database.Database): string => (c.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get() as { sql: string }).sql;
    const before = (() => {
      const c = open(previousVersionDb(scratch()));
      const snapshot = { ddl: messagesDdl(c), cols: columns(c, "messages") };
      runMigrationsOn(c, drizzle(c));
      expect({ ddl: messagesDdl(c), cols: columns(c, "messages") }).toEqual(snapshot);
      return snapshot;
    })();
    expect(before.cols.length).toBeGreaterThan(0);

    // Negative control: a non-additive 0017 is caught by the very same comparison.
    const dir = scratch();
    const bad = migrationsFolderUpTo(providerEchoEntry().idx, dir, { name: "bad", rewrite: { [ECHO_TAG]: `${shippedSql()}\n--> statement-breakpoint\nALTER TABLE \`messages\` ADD \`echo_flag\` text;` } });
    const c = open(previousVersionDb(scratch()));
    runMigrationsOn(c, drizzle(c), bad);
    expect(columns(c, "messages")).not.toEqual(before.cols);
  });
});

describe("R9-hist AC11: idempotent over objects a rival opener already created", () => {
  /** A database at the previous schema whose 0017 objects exist (a rival won the race) but whose ledger has no 0017 row. */
  function rivalWonDb(dir: string): Database.Database {
    const c = open(join(dir, "agent.db"));
    migrate(drizzle(c), { migrationsFolder: migrationsFolderUpTo(PRE, dir) });
    seedAgentAndSession(c);
    insertOldShapeMessage(c, "m1", 1);
    c.exec(shippedSql().replace(/-->\s*statement-breakpoint/g, ""));
    insertEchoRow(c, "m1");
    return c;
  }

  it("R9-hist AC11: the runner applies 0017 over an existing table and index without error and keeps the rival's row", () => {
    const c = rivalWonDb(scratch());
    expect(() => runMigrationsOn(c, drizzle(c))).not.toThrow();
    expect(echoIds(c)).toEqual(["m1"]);
    expect((c.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(expectedLedgerRows());
    expect(c.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('message_provider_echo','idx_message_provider_echo_session')").get()).toEqual({ n: 2 });
  });

  it("R9-hist AC11: negative control -- without IF NOT EXISTS the same state fails as `already exists` (the assertion above has teeth)", () => {
    const dir = scratch();
    const c = rivalWonDb(dir);
    const strict = migrationsFolderUpTo(providerEchoEntry().idx, dir, { name: "strict", rewrite: { [ECHO_TAG]: shippedSql().replace(/IF NOT EXISTS /g, "") } });
    expect(() => runMigrationsOn(c, drizzle(c), strict, { sleepMs: () => undefined })).toThrow(/already exists/);
  });
});

describe("R9-hist AC11: 0017 applied while another connection holds the write lock", () => {
  it("R9-hist AC11: the runner backs off (contention), the holder commits, the migration then lands and the holder's rows are kept", () => {
    const dir = scratch();
    const file = previousVersionDb(dir);
    const holder = open(file);
    holder.pragma("busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    insertOldShapeMessage(holder, "m-held", 3);

    const runner = open(file, { timeout: 0 }); // fail fast on a held lock so the retry path, not the busy handler, is what is exercised
    let backoffs = 0;
    runMigrationsOn(runner, drizzle(runner), MIGRATIONS_FOLDER, {
      sleepMs: () => {
        backoffs++;
        if (holder.inTransaction) holder.exec("COMMIT"); // the previous-version process finishes its transaction
      },
    });
    expect(backoffs).toBeGreaterThanOrEqual(1); // the migration really was refused first
    expect(messageIds(runner)).toEqual(["m1", "m2", "m-held"]);
    expect(columns(runner, "message_provider_echo").length).toBeGreaterThan(0);
  });

  it("R9-hist AC11: negative control -- a holder that never releases makes the runner fail with SQLITE_BUSY after its bounded attempts", () => {
    const file = previousVersionDb(scratch());
    const holder = open(file);
    holder.exec("BEGIN IMMEDIATE");
    insertOldShapeMessage(holder, "m-held", 3);
    const runner = open(file, { timeout: 0 });
    let backoffs = 0;
    let failure: unknown;
    try {
      runMigrationsOn(runner, drizzle(runner), MIGRATIONS_FOLDER, { sleepMs: () => { backoffs++; } });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(classifyMigrationRace(failure)).toBe("contention"); // SQLITE_BUSY from the cause chain, not an unrelated failure
    expect(backoffs).toBeGreaterThanOrEqual(1);
    expect(runner.prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_provider_echo'").get()).toBeUndefined(); // rolled back whole
  });
});

describe("R9-hist AC10: cascade, orphan and foreign_keys behaviour of the echo table", () => {
  it("R9-hist AC10: foreign_keys=ON -- deleting a message cascades its echo row; deleting the session cascades through messages to echoes", () => {
    const c = migratedMemory();
    insertEchoRow(c, "m1");
    insertEchoRow(c, "m2");
    c.prepare("DELETE FROM messages WHERE id='m1'").run();
    expect(echoIds(c)).toEqual(["m2"]);
    c.prepare("DELETE FROM sessions WHERE id=?").run(SESSION);
    expect(echoIds(c)).toEqual([]);
    expect(messageIds(c)).toEqual([]);
  });

  it("R9-hist AC10: foreign_keys=ON -- an echo row for a message that does not exist is rejected", () => {
    const c = migratedMemory();
    expect(() => insertEchoRow(c, "ghost")).toThrow(/FOREIGN KEY constraint failed/);
    expect(echoIds(c)).toEqual([]);
  });

  it("R9-hist AC10: foreign_keys=OFF -- the echo row survives its message as an orphan that foreign_key_check and the sweep predicate both find, and the sweep DELETE removes", () => {
    const c = migratedMemory(MIGRATIONS_FOLDER, "OFF");
    expect(c.pragma("foreign_keys", { simple: true })).toBe(0);
    insertEchoRow(c, "m1");
    insertEchoRow(c, "m2");
    c.prepare("DELETE FROM messages WHERE id='m1'").run();
    expect(echoIds(c)).toEqual(["m1", "m2"]); // no cascade without enforcement: this is why clearMessages deletes echoes explicitly
    expect((c.pragma("foreign_key_check") as Array<{ table: string; parent: string }>).map((r) => `${r.table}->${r.parent}`)).toEqual(["message_provider_echo->messages"]);
    const orphans = c.prepare("SELECT message_id FROM message_provider_echo WHERE message_id NOT IN (SELECT id FROM messages)").all();
    expect(orphans).toEqual([{ message_id: "m1" }]);
    const swept = c.prepare("DELETE FROM message_provider_echo WHERE message_id NOT IN (SELECT id FROM messages)").run();
    expect(swept.changes).toBe(1);
    expect(echoIds(c)).toEqual(["m2"]);
    expect(c.pragma("foreign_key_check")).toEqual([]);
    // Idempotent: a second sweep finds nothing.
    expect(c.prepare("DELETE FROM message_provider_echo WHERE message_id NOT IN (SELECT id FROM messages)").run().changes).toBe(0);
  });

  it("R9-hist AC10: negative control -- a 0017 without ON DELETE CASCADE does not cascade with foreign_keys=ON (the cascade assertion has teeth)", () => {
    const noCascade = migrationsFolderUpTo(providerEchoEntry().idx, scratch(), { name: "nocascade", rewrite: { [ECHO_TAG]: shippedSql().replace(" ON DELETE CASCADE", "") } });
    const c = migratedMemory(noCascade);
    insertEchoRow(c, "m1");
    expect(() => c.prepare("DELETE FROM messages WHERE id='m1'").run()).toThrow(/FOREIGN KEY constraint failed/);
    expect(echoIds(c)).toEqual(["m1"]);
  });

  it("R9-hist AC10: the runner turns foreign_keys OFF while migrating and puts it back; a connection that had it OFF is left OFF", () => {
    for (const [initial, expected] of [["ON", 1], ["OFF", 0]] as const) {
      const c = open(":memory:");
      c.pragma(`foreign_keys = ${initial}`);
      runMigrationsOn(c, drizzle(c));
      expect(c.pragma("foreign_keys", { simple: true }), initial).toBe(expected);
    }
  });
});
