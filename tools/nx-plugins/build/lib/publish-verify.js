'use strict';
/**
 * publish-verify.js — post-publish REGISTRY RETRIEVABILITY verification.
 *
 * WHY THIS EXISTS (defect 32af828b-fb78-467f-bbe9-cbf96061b258, HIGH):
 * `npm publish` exits 0 and prints "Your package is being processed…" (HTTP
 * 202) the moment the registry ACCEPTS the tarball — NOT when the version is
 * actually PROMOTED into the packument. Promotion can lag by many minutes
 * (observed ~20 minutes for one version). The publish executor used to treat
 * a zero npm exit status as proof-of-publish and IMMEDIATELY write the
 * `published-state.json` write-through entry. That has two bad consequences:
 *
 *   1. the package is silently WITHHELD (npm accepted it, but it may never
 *      promote — the release reports success anyway), and
 *   2. the cache is POISONED: every later run's zero-network existence check
 *      ("`cached.version === version` → skip, we're done") now trusts a
 *      version the registry never served, so the publish is never retried and
 *      the defect becomes permanent.
 *
 * This module answers exactly one question with a BOUNDED POLL: "is
 * `name@version` actually retrievable from the registry right now?" — and the
 * executor is only allowed to write the cache when the answer is YES.
 *
 * WHY A DIRECT GET, NOT `npm view`:
 * `npm view` reads the package PACKUMENT, which the client/library may serve
 * from a stale local cache — a real, separately-filed hazard (8c62416b). A
 * direct `GET https://registry.npmjs.org/<name>/<version>` with explicit
 * `cache-control: no-cache` + a cache-busting query reads the SPECIFIC
 * VERSION document through the same edge the CDN cannot serve stale (see
 * npm's registry API: `/<pkg>/<version>` returns the version's manifest, 404
 * when absent). That is the definitive "is it retrievable" signal, so it is
 * the default reader here.
 *
 * THE PURE DECISION (what the unit tests pin, no network):
 *   `versionManifestMatches(name, version, status, body)` — the whole
 *   "retrievable?" contract as a pure predicate: status MUST be 200 AND the
 *   parsed body's `version` MUST equal the requested version (and, when the
 *   body carries a name, it must match too). Everything else is an IO shell
 *   around it.
 *
 * THE POLL: `verifyVersionRetrievable` retries the reader until the predicate
 * passes or the budget elapses, returning `{retrievable, attempts, lastStatus}`.
 * Defaults: ~30 min total (observed promotion lag is ~20 min), ~15 s between
 * attempts. Both are env-overridable — `ADHD_PUBLISH_VERIFY_TIMEOUT_MS` and
 * `ADHD_PUBLISH_VERIFY_INTERVAL_MS` — so tests can pin them to 0 and never
 * sleep. `sleep`, `now`, and `readVersion` are all injectable so the poll
 * logic is testable with no wall-clock and no network.
 *
 * NEVER let this module throw outward on a network error: a failed read is
 * just "not retrievable THIS attempt", counted and retried like a 404, so a
 * transient DNS/TLS blip cannot abort a release that would otherwise promote.
 */

/** Total poll budget before declaring "not retrievable". ~30 min: promotion lag observed at ~20 min. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Delay between attempts. */
const DEFAULT_INTERVAL_MS = 15 * 1000;
/** Per-attempt HTTP timeout, so a hung connection cannot eat the whole budget in one read. */
const DEFAULT_PER_ATTEMPT_MS = 15 * 1000;

const REGISTRY_BASE = process.env.ADHD_NPM_REGISTRY_BASE || 'https://registry.npmjs.org';

/** Parse a non-negative integer env override, falling back when unset/invalid. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Registry URL for one specific version document. The package name is
 * URI-encoded per npm's registry API: a scoped `@scope/pkg` becomes
 * `@scope%2fpkg` (the `/` is encoded, the leading `@` is not).
 */
function versionUrl(name, version, cacheBust) {
  const encodedName = String(name).replace('/', '%2f');
  const base = `${REGISTRY_BASE}/${encodedName}/${encodeURIComponent(String(version))}`;
  // Cache-busting query param: belt-and-braces with the no-cache request
  // headers, so no intermediary can answer this GET from a cached 404.
  return cacheBust ? `${base}?_=${encodeURIComponent(cacheBust)}` : base;
}

/**
 * THE contract — pure, total, no IO. `true` iff the registry's answer for
 * `name@version` is a 200 whose body is that EXACT version's manifest.
 * A body missing `version`, a non-200 (notably a 404 while promotion lags),
 * or a name mismatch is `false`.
 *
 * @param {string} name
 * @param {string} version
 * @param {number|undefined} status HTTP status of the version-document GET
 * @param {unknown} body parsed JSON body (or null)
 * @returns {boolean}
 */
function versionManifestMatches(name, version, status, body) {
  if (status !== 200) return false;
  if (!body || typeof body !== 'object') return false;
  if (body.version !== version) return false;
  if (body.name !== undefined && body.name !== name) return false;
  return true;
}

/**
 * Default reader: a direct, cache-bypassing GET of the version document via
 * global `fetch` (Node 18+). Returns `{status, body}`; on any transport
 * failure returns `{status: 0, body: null, error}`` rather than throwing.
 */
async function defaultReadVersion({ name, version, perAttemptMs }) {
  const timeoutMs = perAttemptMs === undefined ? DEFAULT_PER_ATTEMPT_MS : perAttemptMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(versionUrl(name, version, `${Date.now()}-${Math.random().toString(36).slice(2)}`), {
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache', accept: 'application/json' },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null; // a non-JSON 404 body is still just "not retrievable"
    }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: null, error };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Test seam: the reader is module-level and swappable so specs can drive the
// poll deterministically with zero network and zero wall-clock. Production
// never calls the setters.
// ---------------------------------------------------------------------------
let readVersionImpl = defaultReadVersion;
function __setReadVersion(fn) {
  readVersionImpl = fn;
}
function __resetReadVersion() {
  readVersionImpl = defaultReadVersion;
}

/**
 * Poll the registry until `name@version`'s version document is a matching
 * 200, or the budget is exhausted. GUARANTEES AT LEAST ONE ATTEMPT.
 *
 * @returns {Promise<{retrievable: boolean, attempts: number, lastStatus: number}>}
 */
async function verifyVersionRetrievable(options = {}) {
  const { name, version } = options;
  const budget = options.timeoutMs !== undefined ? options.timeoutMs : envInt('ADHD_PUBLISH_VERIFY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const interval = options.intervalMs !== undefined ? options.intervalMs : envInt('ADHD_PUBLISH_VERIFY_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  const read = options.readVersion || readVersionImpl;
  const clock = options.now || (() => Date.now());
  const doSleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const started = clock();
  let attempts = 0;
  let lastStatus = 0;
  for (;;) {
    attempts += 1;
    let result;
    try {
      result = await read({ name, version });
    } catch (error) {
      result = { status: 0, body: null, error };
    }
    lastStatus = result && typeof result.status === 'number' ? result.status : 0;
    if (versionManifestMatches(name, version, lastStatus, result && result.body)) {
      return { retrievable: true, attempts, lastStatus };
    }
    // Budget is checked AFTER the attempt, so the loop always tries once even
    // when the budget is 0 (a deterministic "one shot" used by unit tests).
    if (clock() - started >= budget) {
      return { retrievable: false, attempts, lastStatus };
    }
    await doSleep(interval);
  }
}

module.exports = {
  verifyVersionRetrievable,
  versionManifestMatches,
  versionUrl,
  // test-only seam — never called in production
  __setReadVersion,
  __resetReadVersion,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_PER_ATTEMPT_MS,
};
