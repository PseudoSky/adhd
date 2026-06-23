#!/usr/bin/env node
/**
 * nc_restore.mjs — Negative-control: restore the 'default-skeptic' seed row.
 *
 * Undoes the corruption applied by nc_mutate.mjs by writing back the exact
 * content from SEED_DATA.md §8.3.  After running this script the roundtrip
 * test "component round-trips after reopen" MUST pass again.
 *
 * Usage:
 *   node nc_restore.mjs <db-path>
 *
 * The <db-path> must be the same file passed to nc_mutate.mjs.
 */

import Database from "better-sqlite3";

const DB_PATH = process.argv[2];

if (!DB_PATH) {
    console.error("Usage: node nc_restore.mjs <db-path>");
    process.exit(1);
}

// Original content from SEED_DATA.md §8.3 for default-skeptic version 2.
// Must be byte-for-byte identical to the value in seed/components.ts.
const ORIGINAL_CONTENT =
    "Default verdict: NEEDS-WORK.\n\n" +
    "Before issuing an APPROVED verdict, enumerate each success criterion explicitly and\n" +
    "confirm it is met with specific evidence. If any criterion cannot be verified from the\n" +
    "provided artifacts, the verdict is NEEDS-WORK regardless of other criteria.\n\n" +
    "\"Looks correct\" is not evidence. \"No issues found\" is not evidence. Evidence is a\n" +
    "specific artifact, output, test result, or log entry that demonstrates the criterion\n" +
    "is satisfied.";

const conn = new Database(DB_PATH);
conn.pragma("journal_mode = WAL");

const result = conn
    .prepare(
        `UPDATE registry_prompt_components
         SET content = ?
         WHERE slug = 'default-skeptic' AND version = 2`
    )
    .run(ORIGINAL_CONTENT);

conn.close();

if (result.changes === 0) {
    console.error(
        "nc_restore: no rows updated — is the DB seeded? " +
        "Expected a row at (slug='default-skeptic', version=2)."
    );
    process.exit(2);
}

console.log(
    `nc_restore: restored 'default-skeptic' v2 in ${DB_PATH} ` +
    `(${result.changes} row updated). ` +
    "The roundtrip reopen assertion will now PASS."
);
