#!/usr/bin/env node
/**
 * scripts/validate-dag.js
 *
 * CLI validation script for dag.json files. Wraps @adhd/dispatch-spec's
 * validateDagJson so agents and CI can validate plans without importing
 * TypeScript directly.
 *
 * Usage:
 *   node scripts/validate-dag.js <path-to-dag.json>              # validate
 *   node scripts/validate-dag.js --strict <path-to-dag.json>     # strict: exit 1 on any error
 *   node scripts/validate-dag.js --check <field> <path>          # check specific field exists
 */

const fs = require("fs");
const path = require("path");

// Lazy-load dispatch-spec — graceful degradation if not yet built
let validateDagJson;
try {
  const spec = require("../packages/shared/dispatch-spec/src/lib/validate");
  validateDagJson = spec.validateDagJson;
} catch {
  // spec not built yet — use embedded minimal validation
  validateDagJson = function (dag) {
    const errors = [];
    if (!dag || typeof dag !== "object") return { valid: false, errors: [{ path: "", message: "root must be an object" }] };
    if (!dag.milestones || Object.keys(dag.milestones).length === 0) errors.push({ path: "milestones", message: "must have at least one entry" });
    if (!dag.phases || dag.phases.length === 0) errors.push({ path: "phases", message: "must have at least one entry" });
    if (!dag.description) errors.push({ path: "description", message: "required" });
    return { valid: errors.length === 0, errors };
  };
}

const args = process.argv.slice(2);
const isStrict = args.includes("--strict");
const checkIdx = args.indexOf("--check");
const isCheck = checkIdx >= 0;

if (isCheck) {
  const field = args[checkIdx + 1];
  const filePath = path.resolve(args[checkIdx + 2] || args[args.length - 1]);
  if (!field || !filePath) {
    console.error("Usage: validate-dag.js --check <field> <path>");
    process.exit(1);
  }
  try {
    const dag = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const fields = field.split(".");
    let current = dag;
    for (const f of fields) {
      if (current == null || typeof current !== "object") { console.log(`FAIL: ${field} not found`); process.exit(1); }
      current = current[f];
    }
    if (current === undefined || current === null) { console.log(`FAIL: ${field} is null/undefined`); process.exit(1); }
    console.log(`OK: ${field} present`);
    if (Array.isArray(current)) console.log(`  count: ${current.length}`);
    else if (typeof current === "object" && current !== null) console.log(`  count: ${Object.keys(current).length}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const filePath = args.filter(a => !a.startsWith("--")).pop();
if (!filePath) {
  console.error("Usage: validate-dag.js [--strict] <path-to-dag.json>");
  console.error("       validate-dag.js --check <field> <path-to-dag.json>");
  process.exit(1);
}

const resolved = path.resolve(filePath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

let dag;
try {
  dag = JSON.parse(fs.readFileSync(resolved, "utf-8"));
} catch (err) {
  console.error(`Invalid JSON: ${err.message}`);
  process.exit(1);
}

const result = validateDagJson(dag);
if (!result.valid) {
  console.error(`FAILED: ${result.errors.length} validation error(s)`);
  for (const e of result.errors) {
    console.error(`  ${e.path}: ${e.message}`);
  }
  if (isStrict) process.exit(1);
} else {
  console.log(`OK: ${resolved}`);
  const ms = dag.milestones || {};
  const ops = Array.isArray(dag.operations) ? dag.operations : Object.values(dag.operations || {});
  console.log(`  schema_version: ${dag.schema_version || "?"}`);
  console.log(`  milestones: ${Object.keys(ms).length}`);
  console.log(`  operations: ${ops.length}`);
  console.log(`  dispatch_log entries: ${(dag.dispatch_log || []).length}`);
}
