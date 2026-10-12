// PARITY-INSTRUMENT-ONLY
// Experiment model configuration (SCOPE-R9-model-config): which model each arm and the judge runs is DATA, not code.
// parity/experiment.json defines the groups (A native `claude -p`, B agent-mcp claudecli provider, C agent-mcp anthropic provider, the judge)
// with a provider and a FULL model id each. Environment variables override it; precedence, highest first:
//   1. the per-group variable   PARITY_MODEL_A | PARITY_MODEL_B | PARITY_MODEL_C | PARITY_JUDGE_MODEL
//   2. PARITY_MODEL             (every group; all groups are Anthropic-backed)
//   3. the JSON file            (parity/experiment.json, or the file named by PARITY_EXPERIMENT_FILE)
// Validation is strict and fail-fast (ExperimentConfigError names the offending key): unknown keys, non-string / empty ids, aliases (`haiku`, `sonnet`, or any id
// without the `claude-` prefix and a version digit) and any id containing `opus` (the owner forbids opus) are refused BEFORE a round plans, gates or spends anything.
// A round opts in with `ledger.profile.modelConfig: "experiment"` (ledger.profileOf); rounds R5-R8 never read this module, so shell variables cannot change their output.
// Pure apart from reading the JSON file: `env` and `file` are parameters, process.env is only the default.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXPERIMENT_FILE = path.join(HERE, 'experiment.json');
export const GROUPS = Object.freeze(['A', 'B', 'C', 'judge']);
/** The provider each group runs through. The JSON `provider` must equal it, so the field cannot silently describe something the driver does not do. */
export const GROUP_PROVIDER = Object.freeze({ A: 'claude-cli', B: 'claudecli', C: 'anthropic', judge: 'anthropic' });
/** Every provider in GROUP_PROVIDER is Anthropic-backed, so PARITY_MODEL applies to all groups. */
export const ENV_ALL = 'PARITY_MODEL';
export const ENV_GROUP = Object.freeze({ A: 'PARITY_MODEL_A', B: 'PARITY_MODEL_B', C: 'PARITY_MODEL_C', judge: 'PARITY_JUDGE_MODEL' });
export const ENV_FILE = 'PARITY_EXPERIMENT_FILE';
const KNOWN_ENV = new Set([ENV_ALL, ENV_FILE, ...Object.values(ENV_GROUP)]);
const ROOT_KEYS = new Set(['schema', 'description', 'groups']);
const GROUP_KEYS = new Set(['provider', 'model']);
export const SCHEMA = 'parity-experiment/1';

export class ExperimentConfigError extends Error { constructor(m) { super(`experiment config: ${m}`); this.name = 'ExperimentConfigError'; } }

/**
 * Validate one full model id; returns it trimmed. Throws ExperimentConfigError naming `key`.
 * Order: type, empty, whitespace, opus (anywhere, case-insensitive), alias (no `claude-` prefix, or no version digit).
 */
export function validateModelId(id, key) {
  const bad = (why) => { throw new ExperimentConfigError(`${key}: ${why} (got ${JSON.stringify(id)})`); };
  if (typeof id !== 'string') bad('model id must be a string');
  const m = id.trim();
  if (!m) bad('model id must not be empty');
  if (/\s/.test(m)) bad('model id must not contain whitespace');
  if (/opus/i.test(m)) bad('opus models are forbidden by the owner');
  if (!/^claude-/i.test(m) || !/\d/.test(m)) bad('model id must be a FULL versioned id such as claude-haiku-5-5, not an alias like haiku or sonnet');
  return m;
}

/** Read and validate one experiment JSON file. `key` names where the path came from (for errors). */
export function loadExperimentFile(file, key = 'experiment file') {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new ExperimentConfigError(`${key}: cannot read ${file}: ${e.code ?? e.message}`); }
  let j; try { j = JSON.parse(text); } catch (e) { throw new ExperimentConfigError(`${key}: ${file} is not valid JSON (${e.message})`); }
  const bad = (m) => { throw new ExperimentConfigError(`${path.basename(file)}: ${m}`); };
  if (!j || typeof j !== 'object' || Array.isArray(j)) bad('must be a JSON object');
  for (const k of Object.keys(j)) if (!ROOT_KEYS.has(k)) bad(`unknown top-level key "${k}" (allowed: ${[...ROOT_KEYS].join(', ')})`);
  if (j.schema !== SCHEMA) bad(`"schema" must be "${SCHEMA}", got ${JSON.stringify(j.schema)}`);
  if (!j.groups || typeof j.groups !== 'object' || Array.isArray(j.groups)) bad('"groups" must be an object');
  for (const g of Object.keys(j.groups)) if (!GROUPS.includes(g)) bad(`unknown group key "${g}" (allowed: ${GROUPS.join(', ')})`);
  const groups = {};
  for (const g of GROUPS) {
    const e = j.groups[g];
    if (e == null || typeof e !== 'object' || Array.isArray(e)) bad(`groups.${g} is missing or not an object`);
    for (const k of Object.keys(e)) if (!GROUP_KEYS.has(k)) bad(`groups.${g}: unknown key "${k}" (allowed: ${[...GROUP_KEYS].join(', ')})`);
    if (e.provider !== GROUP_PROVIDER[g]) bad(`groups.${g}.provider must be "${GROUP_PROVIDER[g]}", got ${JSON.stringify(e.provider)}`);
    groups[g] = { provider: e.provider, model: validateModelId(e.model, `groups.${g}.model`) };
  }
  return { groups, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

/**
 * Resolve the experiment: the JSON file plus the environment overrides.
 * @param {{env?:Record<string,string|undefined>, file?:string}} [o] `file` (explicit) > env PARITY_EXPERIMENT_FILE > the shipped default.
 * @returns {{file:string, fileSource:'default'|'env'|'param', sha256:string, groups:Record<string,{provider:string, model:string, source:'json'|'env', envVar:string|null}>, models:Record<string,string>}}
 */
export function resolveExperiment({ env = process.env, file } = {}) {
  for (const k of Object.keys(env)) if (/^PARITY_(MODEL|JUDGE)(_.*)?$/.test(k) && !KNOWN_ENV.has(k)) {
    throw new ExperimentConfigError(`env ${k}: unknown group variable (known: ${[ENV_ALL, ...Object.values(ENV_GROUP)].join(', ')})`);
  }
  const envFile = env[ENV_FILE];
  if (envFile !== undefined && !String(envFile).trim()) throw new ExperimentConfigError(`env ${ENV_FILE}: set but empty`);
  const chosen = file ?? (envFile !== undefined ? path.resolve(envFile) : DEFAULT_EXPERIMENT_FILE);
  const fileSource = file ? 'param' : envFile !== undefined ? 'env' : 'default';
  const loaded = loadExperimentFile(chosen, file ? 'experiment file' : envFile !== undefined ? `env ${ENV_FILE}` : 'experiment file');
  const fromEnv = (name) => { const v = env[name]; if (v === undefined) return null; return validateModelId(v, `env ${name}`); };   // set-but-empty / alias / opus all throw, naming the variable
  const all = fromEnv(ENV_ALL);
  const groups = {}; const models = {};
  for (const g of GROUPS) {
    const own = fromEnv(ENV_GROUP[g]);
    const base = loaded.groups[g];
    groups[g] = own != null ? { provider: base.provider, model: own, source: 'env', envVar: ENV_GROUP[g] }
      : all != null ? { provider: base.provider, model: all, source: 'env', envVar: ENV_ALL }
        : { provider: base.provider, model: base.model, source: 'json', envVar: null };
    models[g] = groups[g].model;
  }
  return { file: chosen, fileSource, sha256: loaded.sha256, groups, models };
}

/**
 * The equal-model guard, config level (checked before any reservation or spend): the arms a round plans must resolve to the SAME pricing id, because a cost / duration
 * ratio between different models is not a parity measure. `pricingIdOf(id)` maps an id to the rate card it is priced by (default identity). A round whose profile records
 * `modelDifferenceReason` (a deliberate, owner-approved difference) passes and the reason is returned.
 * @returns {{ok:boolean, reasons:string[], deliberate:string|null}}
 */
export function modelConsistency({ arms, models, pricingIdOf = (id) => id, differenceReason = null }) {
  const byArm = arms.map((a) => ({ arm: a, id: models?.[a], price: pricingIdOf(models?.[a]) }));
  const missing = byArm.filter((x) => typeof x.id !== 'string' || !x.id);
  if (missing.length) return { ok: false, reasons: [`no resolved model id for arm(s) ${missing.map((x) => x.arm).join(', ')}: refusing before any spend`], deliberate: null };
  const prices = new Set(byArm.map((x) => x.price));
  if (prices.size <= 1) return { ok: true, reasons: [], deliberate: null };
  const detail = byArm.map((x) => `${x.arm}=${x.id}${x.price !== x.id ? ` (priced as ${x.price})` : ''}`).join(', ');
  if (String(differenceReason ?? '').trim()) return { ok: true, reasons: [], deliberate: String(differenceReason).trim() };
  return { ok: false, reasons: [`arms resolve to different pricing ids [${detail}]: a comparison needs the same model on every arm; set the same id (PARITY_MODEL) or record ledger.profile.modelDifferenceReason for a deliberate difference. Refusing before any spend`], deliberate: null };
}

/** Plan / record lines for a resolved experiment. */
export function describeExperiment(ex, { arms = GROUPS.filter((g) => g !== 'judge'), indent = '  ' } = {}) {
  const row = (g) => `${indent}${g === 'judge' ? 'judge' : `arm ${g}`}: provider ${ex.groups[g].provider}  model ${ex.groups[g].model}  source ${ex.groups[g].source}${ex.groups[g].envVar ? ` (${ex.groups[g].envVar})` : ''}`;
  return [...arms.map(row), row('judge')];
}
