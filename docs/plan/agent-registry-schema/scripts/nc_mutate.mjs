#!/usr/bin/env node
/**
 * nc_mutate.mjs — Negative-control: corrupt the 'default-skeptic' seed row.
 *
 * Proves [seed-and-roundtrip.3] has teeth: after running this script the
 * roundtrip.test.ts "component round-trips after reopen" case MUST fail,
 * because the persisted content no longer matches the seed source of truth.
 *
 * Usage:
 *   node nc_mutate.mjs <db-path>
 *
 * The <db-path> argument must point to a real on-disk SQLite file that has
 * already been seeded (the same file the roundtrip test uses).
 *
 * After running nc_mutate:
 *   - default-skeptic content is replaced with a CORRUPTION sentinel string.
 *   - The roundtrip deep-equals check will fail.
 * Run nc_restore.mjs <db-path> to undo.
 */

import Database from "better-sqlite3";

const DB_PATH = process.argv[2];

if (!DB_PATH) {
    console.error("Usage: node nc_mutate.mjs <db-path>");
    process.exit(1);
}

const conn = new Database(DB_PATH);
conn.pragma("journal_mode = WAL");

// Corrupt the content of the 'default-skeptic' row at version 2.
// The original content begins with "Default verdict: NEEDS-WORK."
// We overwrite it with a sentinel value the deep-equals check will reject.
const result = conn
    .prepare(
        `UPDATE registry_prompt_components
         SET content = '__NC_MUTATED__: This content was corrupted by nc_mutate.mjs'
         WHERE slug = 'default-skeptic' AND version = 2`
    )
    .run();

conn.close();

if (result.changes === 0) {
    console.error(
        "nc_mutate: no rows updated — is the DB seeded? " +
        "Expected a row at (slug='default-skeptic', version=2)."
    );
    process.exit(2);
}

console.log(
    `nc_mutate: corrupted 'default-skeptic' v2 in ${DB_PATH} ` +
    `(${result.changes} row updated). ` +
    "The roundtrip reopen assertion will now FAIL."
);
