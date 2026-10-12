// PARITY-INSTRUMENT-ONLY
// Per-round run ledger (R0.AC4, R0.AC8, R5.AC6). Tracked file parity/ledger/<round>.json, so the cap survives a fresh checkout.
// Cap 3 runs (A, B, C); a 4th or later run needs `extraRunReason`. A live round needs a non-empty `approvedBy` (the owner message, quoted).
// Arm A is reserved first; B and C are reserved only after A's correctness passed (void rule). Atomic write + lock; corrupt file fails closed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN_CAP = 3;
export const JUDGE_CAP = 3;
export const LEDGER_DIR = path.join(HERE, 'ledger');
export const ledgerPathFor = (round, dir = LEDGER_DIR) => path.join(dir, `${round}.json`);

export class LedgerError extends Error { constructor(m) { super(m); this.name = 'LedgerError'; } }
export class ModelRunCapError extends LedgerError { constructor(m) { super(m); this.name = 'ModelRunCapError'; } }

const nowIso = () => new Date().toISOString();

function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`; let fd = null;
  for (let i = 0; i < 200 && fd == null; i++) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  if (fd == null) throw new LedgerError(`could not take the ledger lock ${lock} (stale? remove it only if no driver is running): refusing (fail closed)`);
  try { return fn(); } finally { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(lock); } catch { /* gone */ } }
}

/** A fresh, empty ledger object. */
export function emptyLedger(round) {
  return { round, cap: RUN_CAP, approvedBy: '', extraRunReason: '', runs: [], judgeCalls: [], scenarioSha: '', scopeChanges: [], armOrder: [], startedAt: null, armA: null, releases: [] };
}

/** Parse + validate a ledger document; throws LedgerError (fail closed) when it cannot be trusted. */
export function parseLedger(text, where = 'ledger') {
  let led;
  try { led = JSON.parse(text); } catch (e) { throw new LedgerError(`${where} is unreadable (${e.message}): refusing (fail closed)`); }
  if (!led || typeof led !== 'object' || !Array.isArray(led.runs) || !Array.isArray(led.judgeCalls)) throw new LedgerError(`${where} has no runs/judgeCalls arrays: refusing (fail closed)`);
  return led;
}

export function readLedger(round, dir = LEDGER_DIR) {
  const f = ledgerPathFor(round, dir);
  if (!fs.existsSync(f)) return emptyLedger(round);
  return parseLedger(fs.readFileSync(f, 'utf8'), f);
}

function writeAtomic(file, led) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(led, null, 2) + '\n'); fs.renameSync(tmp, file); }

/** Run cap in force: one run per profile arm when the ledger carries a profile (R8: a B-only round is ONE run), else RUN_CAP. */
export const capOf = (led) => { const p = profileOf(led); return p ? p.arms.length : RUN_CAP; };
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const ARM_LETTERS = Object.freeze(['A', 'B', 'C']);
/** A model value is an ALIAS (resolved by the claude CLI at run time, e.g. `haiku`) unless it is a concrete first-party id (`claude-...`). */
export const isModelAlias = (m) => typeof m === 'string' && m.trim() !== '' && !/^claude-/i.test(m.trim());
/**
 * R8 round profile: `ledger.profile` narrows or re-points a round without touching module constants (the R5/R7 pins stay the defaults of every other round).
 * Fields: `arms` (subset of A,B,C, in run order), `armAWaiver` (REQUIRED, the owner direction quoted, whenever arm A is not in `arms`: the A-first
 * reference gate is then not applied, and the waiver is recorded instead of faking `armA.genuine`), `model` / `judgeModel` (a concrete id or an alias),
 * `effort` (low|medium|high|xhigh|max, set explicitly on every arm that can take it), `capture` (wire capture forced ON for the round).
 * Fails CLOSED (LedgerError) on any malformed profile; returns null when the ledger carries none.
 * @returns {{arms:string[], armAWaiver:string|null, model:string|null, judgeModel:string|null, effort:string|null, capture:boolean}|null}
 */
export function profileOf(led) {
  const p = led?.profile; if (p == null) return null;
  const bad = (m) => { throw new LedgerError(`ledger.profile ${m}: refusing (fail closed)`); };
  if (typeof p !== 'object' || Array.isArray(p)) bad('must be an object');
  if (!Array.isArray(p.arms) || p.arms.length === 0) bad('.arms must be a non-empty array of A/B/C');
  const arms = []; for (const a of p.arms) { if (!ARM_LETTERS.includes(a)) bad(`.arms entry ${JSON.stringify(a)} is not one of A, B, C`); if (arms.includes(a)) bad(`.arms lists ${a} twice`); arms.push(a); }
  const waiver = String(p.armAWaiver ?? '').trim();
  if (!arms.includes('A') && !waiver) bad('omits arm A without a non-empty armAWaiver (the owner direction, quoted): the A-first gate may only be waived on the record');
  for (const k of ['model', 'judgeModel']) if (p[k] != null && (typeof p[k] !== 'string' || !p[k].trim())) bad(`.${k} must be a non-empty string`);
  if (p.effort != null && !EFFORT_LEVELS.includes(p.effort)) bad(`.effort ${JSON.stringify(p.effort)} is not one of ${EFFORT_LEVELS.join('|')}`);
  if (p.capture != null && typeof p.capture !== 'boolean') bad('.capture must be a boolean');
  if (isModelAlias(p.model) && arms.includes('C')) bad(`.model ${JSON.stringify(p.model)} is an alias the claude CLI resolves; arm C calls the Messages API directly with provider.model and an alias is not resolved there: use a concrete id for a round that includes C`);
  return { arms, armAWaiver: waiver || null, model: p.model ?? null, judgeModel: p.judgeModel ?? null, effort: p.effort ?? null, capture: p.capture === true };
}

/** Read-only precondition for a live round (no write): approvedBy present, cap not reached. Used by the gate before anything runs. */
export function checkLedgerForLive(round, dir = LEDGER_DIR) {
  const led = readLedger(round, dir);
  const reasons = [];
  if (!String(led.approvedBy || '').trim()) reasons.push('ledger.approvedBy is empty: a live round must be asked for and the owner message quoted in approvedBy');
  let cap = RUN_CAP; try { profileOf(led); cap = capOf(led); } catch (e) { reasons.push(e.message); }
  if (led.runs.length >= cap && !String(led.extraRunReason || '').trim()) reasons.push(`run cap ${led.runs.length}/${cap} reached and extraRunReason is empty`);
  return { ok: reasons.length === 0, reasons, ledger: led };
}

/** Set approvedBy / scenarioSha / scopeChanges on the round's ledger (creates it). */
export function initRound(round, patch, dir = LEDGER_DIR) {
  const f = ledgerPathFor(round, dir);
  return withLock(f, () => {
    const led = fs.existsSync(f) ? parseLedger(fs.readFileSync(f, 'utf8'), f) : emptyLedger(round);
    Object.assign(led, patch); led.startedAt ??= nowIso();
    writeAtomic(f, led); return led;
  });
}

/**
 * Reserve one agent run BEFORE anything is spawned.
 * Rules: needs approvedBy; run 4+ needs extraRunReason; the first run must be arm A; B/C need A recorded as a genuine success.
 * R8: a `profile` (profileOf) restricts the arms, caps the round at one run per profile arm, and, only when it omits arm A and records an armAWaiver, skips the two A rules.
 */
export function reserveRun(round, { arm, runId, dir = LEDGER_DIR }) {
  const f = ledgerPathFor(round, dir);
  return withLock(f, () => {
    const led = fs.existsSync(f) ? parseLedger(fs.readFileSync(f, 'utf8'), f) : emptyLedger(round);
    if (!String(led.approvedBy || '').trim()) throw new LedgerError(`ledger ${f}: approvedBy is empty: refusing ${runId}`);
    if (led.runs.length >= capOf(led) && !String(led.extraRunReason || '').trim()) throw new ModelRunCapError(`model-run cap reached: ${led.runs.length}/${capOf(led)} (ledger ${f}); an extra run needs extraRunReason; refusing ${runId}`);
    const prof = profileOf(led);   // R8: a profile that omits arm A (with its recorded armAWaiver) is the ONLY way the A-first gate is not applied
    if (prof && !prof.arms.includes(arm)) throw new LedgerError(`arm ${arm} is not in ledger.profile.arms [${prof.arms.join(',')}]: refusing ${runId}`);
    if (!(prof && !prof.arms.includes('A'))) {
      if (led.runs.length === 0 && arm !== 'A') throw new LedgerError(`arm A runs first: refusing ${runId} (arm ${arm})`);
      if (arm !== 'A' && !(led.armA && led.armA.genuine === true)) throw new LedgerError(`arm A did not genuinely succeed: the round is void, refusing ${runId}`);
    }
    led.runs.push({ runId, arm, at: nowIso(), pid: process.pid, ...(led.runs.length >= capOf(led) ? { extra: true } : {}) });
    if (!led.armOrder.includes(arm)) led.armOrder.push(arm);
    writeAtomic(f, led);
    return { used: led.runs.length, cap: capOf(led) };
  });
}

/**
 * Release a reserved run that provably never reached a model (a harness fault before any spawn). Audited, never silent: the removed run entry and the
 * reason are appended to `releases[]` (so the cap cannot be quietly dodged), the arm order is rebuilt from the remaining runs, and if the released run was
 * arm A, `armA` is reset (a harness fault is not a model-variance void). `startedAt` is kept. A reason is mandatory; an unknown runId is refused.
 */
export function releaseRun(round, runId, reason, dir = LEDGER_DIR) {
  if (!String(reason ?? '').trim()) throw new LedgerError(`releaseRun(${runId}): a non-empty reason is required`);
  const f = ledgerPathFor(round, dir);
  return withLock(f, () => {
    const led = fs.existsSync(f) ? parseLedger(fs.readFileSync(f, 'utf8'), f) : emptyLedger(round);
    const idx = led.runs.findIndex((r) => r.runId === runId);
    if (idx < 0) throw new LedgerError(`releaseRun: ${runId} is not reserved in ${f}: refusing`);
    const [run] = led.runs.splice(idx, 1);
    if (!Array.isArray(led.releases)) led.releases = [];
    led.releases.push({ runId, arm: run.arm, reservedAt: run.at, reason: String(reason), releasedAt: nowIso(), pid: process.pid });
    if (run.arm === 'A') led.armA = null;
    led.armOrder = led.armOrder.filter((a) => led.runs.some((r) => r.arm === a));
    writeAtomic(f, led);
    return { used: led.runs.length, cap: RUN_CAP, released: led.releases[led.releases.length - 1] };
  });
}

/** Record arm A's correctness verdict (void rule). `genuine` = every content item green, not INVALID, no defect signal. */
export function recordArmA(round, genuine, detail = '', dir = LEDGER_DIR) {
  const f = ledgerPathFor(round, dir);
  return withLock(f, () => {
    const led = fs.existsSync(f) ? parseLedger(fs.readFileSync(f, 'utf8'), f) : emptyLedger(round);
    led.armA = { genuine: genuine === true, detail: String(detail).slice(0, 400), at: nowIso() };
    writeAtomic(f, led); return led.armA;
  });
}

/**
 * R5-retry: the owner-directed retry plan. `led.retryPlan` = [{arm:'B',rep:2},{arm:'C',rep:2}] replaces the seeded plan (the CLI still cannot slice it). It fails CLOSED:
 * only with a non-empty `extraRunReason`, never arm A (A1 stays the native reference), rep >= 2 (rep 1 is the original run), no duplicate arm/rep.
 * @returns {{arm:string, rep:number}[] | null} null when the ledger carries no retry plan.
 */
export function retryPlanOf(led) {
  const rp = led?.retryPlan; if (rp == null || (Array.isArray(rp) && rp.length === 0)) return null;
  if (!Array.isArray(rp)) throw new LedgerError('ledger.retryPlan must be an array: refusing (fail closed)');
  if (!String(led.extraRunReason || '').trim()) throw new LedgerError('ledger.retryPlan needs a non-empty extraRunReason (the owner direction): refusing (fail closed)');
  const seen = new Set();
  for (const e of rp) {
    if (!e || !['B', 'C'].includes(e.arm)) throw new LedgerError(`ledger.retryPlan entry ${JSON.stringify(e)}: only arms B and C can be retried (arm A is the native reference and is never rerun): refusing`);
    if (!Number.isInteger(e.rep) || e.rep < 2) throw new LedgerError(`ledger.retryPlan entry ${JSON.stringify(e)}: rep must be an integer >= 2: refusing`);
    const k = `${e.arm}${e.rep}`; if (seen.has(k)) throw new LedgerError(`ledger.retryPlan lists ${k} twice: refusing`); seen.add(k);
  }
  return rp.map((e) => ({ arm: e.arm, rep: e.rep }));
}

/** Judge-call cap in force: JUDGE_CAP, plus `judgeCapExtra` calls only when `judgeCapReason` is non-empty (the documented reason). */
export function effectiveJudgeCap(led) {
  const extra = Number.isInteger(led?.judgeCapExtra) && led.judgeCapExtra > 0 && String(led.judgeCapReason || '').trim() ? led.judgeCapExtra : 0;
  return JUDGE_CAP + extra;
}

/** Alternate the B/C order between rounds (A is always first). `roundIndex` is the round's numeric order. */
export function armOrderFor(roundIndex) { return roundIndex % 2 === 0 ? ['A', 'B', 'C'] : ['A', 'C', 'B']; }

/**
 * Judge calls that count toward the cap: every entry EXCEPT one recorded with `paidCallAttempted: false` (a judge failure before any request left the harness, R8-judge AC2).
 * A request that went out and was rejected or errored counts: the cap is a spend bound and a rejected request is not provably free (fail closed).
 */
export function judgeCallsUsed(led) { return led.judgeCalls.filter((c) => c?.paidCallAttempted !== false).length; }

/**
 * Log a judge call (R5.AC6): at most JUDGE_CAP per round unless `reason` is given. Excluded from the run cap.
 * R8-judge AC2: a FAILED judge is logged too, as `{status:'failed', error, paidCallAttempted}` (tokens 0, cost null = unmeasured), so a judge-failed quality is never invisible in the ledger.
 * A scored call carries no `status` (every pre-R8 entry is such a call). `rejudgeOf` names the earlier failure a re-judge replaces.
 */
export function recordJudgeCall(round, call, { reason = '', dir = LEDGER_DIR } = {}) {
  const f = ledgerPathFor(round, dir);
  return withLock(f, () => {
    const led = fs.existsSync(f) ? parseLedger(fs.readFileSync(f, 'utf8'), f) : emptyLedger(round);
    const cap = effectiveJudgeCap(led); const used = judgeCallsUsed(led); const counts = call.paidCallAttempted !== false;
    if (counts && used >= JUDGE_CAP && !String(reason).trim()) throw new ModelRunCapError(`judge-call cap ${used}/${JUDGE_CAP} reached without a documented reason`);
    if (counts && used >= cap) throw new ModelRunCapError(`judge-call cap ${used}/${cap} reached (ledger judgeCapExtra/judgeCapReason bound the documented extension)`);
    const rec = { arm: call.arm, modelId: call.modelId, inputTokens: call.inputTokens, outputTokens: call.outputTokens, costUsd: call.costUsd, briefSha: call.briefSha, at: nowIso(), ...(reason ? { reason } : {}),
      ...(call.status ? { status: call.status } : {}), ...(call.error ? { error: String(call.error).slice(0, 300) } : {}), ...(call.paidCallAttempted === false ? { paidCallAttempted: false } : call.status ? { paidCallAttempted: true } : {}),
      ...(call.rejudgeOf ? { rejudgeOf: String(call.rejudgeOf).slice(0, 300) } : {}) };
    led.judgeCalls.push(rec); writeAtomic(f, led); return rec;
  });
}
