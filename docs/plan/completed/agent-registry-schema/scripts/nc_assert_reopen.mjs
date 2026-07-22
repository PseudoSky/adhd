#!/usr/bin/env node
/**
 * nc_assert_reopen.mjs — Assert that 'default-skeptic' content matches seed.
 *
 * Exits 0 if the content matches (test would PASS).
 * Exits 1 if the content differs (test would FAIL — nc_mutate is in effect).
 *
 * Usage:
 *   node nc_assert_reopen.mjs <db-path>
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DB_PATH = process.argv[2];
if (!DB_PATH) {
    console.error("Usage: node nc_assert_reopen.mjs <db-path>");
    process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, "../../../../");
const DIST_COMPONENTS = path.join(
    REPO_ROOT,
    "dist/packages/ai/agent-registry/src/seed/components.js"
);
const Database = require("better-sqlite3");

const { SEED_COMPONENTS } = require(DIST_COMPONENTS);

const expected = SEED_COMPONENTS.find((c) => c.slug === "default-skeptic");
if (!expected) {
    console.error("nc_assert_reopen: default-skeptic not found in SEED_COMPONENTS");
    process.exit(2);
}

const conn = new Database(DB_PATH);
const row = conn
    .prepare(
        // Decision 5: component content lives in registry_component_versions.
        "SELECT content FROM registry_component_versions WHERE slug = 'default-skeptic' AND version = 2"
    )
    .get();
conn.close();

if (!row) {
    console.error("nc_assert_reopen: no row found for default-skeptic v2");
    process.exit(1);
}

if (row.content === expected.content) {
    console.log("nc_assert_reopen: PASS — content matches seed (test would PASS)");
    process.exit(0);
} else {
    console.log("nc_assert_reopen: FAIL — content mismatch (test would FAIL)");
    console.log(`  Expected prefix: "${expected.content.slice(0, 40)}..."`);
    console.log(`  Actual   prefix: "${row.content.slice(0, 40)}..."`);
    process.exit(1);
}
