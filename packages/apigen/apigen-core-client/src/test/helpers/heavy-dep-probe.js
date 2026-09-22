'use strict';

/**
 * heavy-dep-probe.js — child-process probe that proves a module's IMPORT is
 * lazy with respect to a set of "heavy" specifiers (here: `ts-morph` and
 * `ts-json-schema-generator`).
 *
 * WHY A CHILD PROCESS: require/import side effects are only observable at the
 * module-loader boundary of the process doing the loading. Requiring the
 * module under test inside vitest would inherit vitest's already-populated
 * `require.cache` (every heavy dep is loaded somewhere in the suite), so the
 * probe could never distinguish "this module imported it" from "some earlier
 * test did". A fresh `node` process with a monkey-patched `Module._load` is
 * the only honest observer.
 *
 * HOW: `Module._load` is patched so that, while the guard is ARMED, any
 * request for a guarded specifier is recorded and then THROWN. The probe:
 *
 *   1. requires the target module            -> must succeed while armed
 *   2. runs `driver.nonLazy(exports, fixture)` -> must succeed while armed
 *   3. disarms the guard
 *   4. runs `driver.lazy(exports, fixture)`  -> the heavy dep must resolve now
 *
 * and prints exactly one `__PROBE_RESULT__<json>` line describing what it saw.
 * The process ALWAYS exits 0 once it can report — the parent test asserts on
 * the payload, so a guard trip is evidence, not a crash. A missing result
 * marker (probe could not even run) makes the parent throw.
 *
 * Environment contract (all set by the parent test):
 *   PROBE_TARGET     absolute path to the (CJS) module under test
 *   PROBE_DRIVER     absolute path to a CJS driver exporting
 *                    `{ nonLazy(mod, fixture), lazy(mod, fixture) }`
 *   PROBE_GUARDED    JSON array of specifiers to guard
 *   PROBE_FIXTURE    absolute path to a real source file the driver may use
 *   PROBE_STOP_AFTER optional; 'nonLazy' stops before disarming (isolation)
 */

const fs = require('node:fs');
const Module = require('node:module');

const MARKER = '__PROBE_RESULT__';

const target = process.env.PROBE_TARGET;
const driverPath = process.env.PROBE_DRIVER;
const fixture = process.env.PROBE_FIXTURE;
const stopAfter = process.env.PROBE_STOP_AFTER || '';
const guarded = new Set(JSON.parse(process.env.PROBE_GUARDED || '[]'));

if (!target || !driverPath || !fixture) {
  process.stderr.write(
    'heavy-dep-probe: PROBE_TARGET, PROBE_DRIVER and PROBE_FIXTURE are required\n'
  );
  process.exit(2);
}

/** Thrown when a guarded specifier is requested while the guard is armed. */
class GuardedDepRequestedError extends Error {
  constructor(specifier) {
    super(
      `guarded heavy dependency requested before the lazy boundary: ${specifier}`
    );
    this.name = 'GuardedDepRequestedError';
    this.guardedSpecifier = specifier;
  }
}

/** Every guarded request observed this process, in order. */
const attempts = [];
let armed = true;
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (guarded.has(request)) {
    attempts.push(request);
    if (armed) throw new GuardedDepRequestedError(request);
  }
  return originalLoad.call(this, request, parent, isMain);
};

function errorInfo(err) {
  return {
    name: err && err.name ? err.name : String(err),
    message: err && err.message ? err.message : String(err),
    guardedSpecifier:
      err && err.guardedSpecifier ? err.guardedSpecifier : undefined,
  };
}

/** Synchronously write the single result line, then stop. */
function emit(payload) {
  fs.writeSync(1, `\n${MARKER}${JSON.stringify(payload)}\n`);
  process.exit(0);
}

// 1. Import the module under test — must be clean while the guard is armed.
let targetExports;
try {
  targetExports = require(target);
} catch (err) {
  emit({
    ok: false,
    phase: 'import',
    attempts: attempts.slice(),
    error: errorInfo(err),
  });
}

const attemptsAfterImport = attempts.slice();

// The driver encodes the non-lazy / lazy exercise. It is loaded while armed,
// so it must itself never touch a guarded specifier.
let driver;
try {
  driver = require(driverPath);
} catch (err) {
  emit({
    ok: false,
    phase: 'driver-load',
    attemptsAfterImport,
    attempts: attempts.slice(),
    error: errorInfo(err),
  });
}

// 2. Non-lazy surface — must work with the heavy deps still guarded.
let nonLazyResult = null;
try {
  nonLazyResult = driver.nonLazy(targetExports, fixture);
} catch (err) {
  emit({
    ok: false,
    phase: 'nonLazy',
    attemptsAfterImport,
    attempts: attempts.slice(),
    error: errorInfo(err),
  });
}

const attemptsAfterNonLazy = attempts.slice();

if (stopAfter === 'nonLazy') {
  emit({
    ok: true,
    phase: 'nonLazy',
    attemptsAfterImport,
    attemptsAfterNonLazy,
    nonLazyResult,
  });
}

// 3 + 4. Disarm, then first real use of the lazy path — the heavy dep must
// now be requested AND resolve successfully.
armed = false;
let lazyResult = null;
try {
  lazyResult = driver.lazy(targetExports, fixture);
} catch (err) {
  emit({
    ok: false,
    phase: 'lazy',
    attemptsAfterImport,
    attemptsAfterNonLazy,
    attempts: attempts.slice(),
    error: errorInfo(err),
  });
}

emit({
  ok: true,
  phase: 'lazy',
  attemptsAfterImport,
  attemptsAfterNonLazy,
  attemptsAfterLazy: attempts.slice(),
  nonLazyResult,
  lazyResult,
});
