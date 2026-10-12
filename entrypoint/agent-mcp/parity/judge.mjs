// PARITY-INSTRUMENT-ONLY
// Blind judge (R5). Brief builder, normalizer and the call wrapper. NO live call is made by anything here unless a caller passes a real client.
// PAID THIRD-PARTY EXCEPTION (R5.AC8, AGENTS.md "Live testing is mandatory"): the judge is a paid model call. It is invoked ONLY by the driver in a
// live round, after the owner approved the round (ledger.approvedBy, a quoted owner message); there is no env flag. Owner: the repository owner
// (skywinstonsk@gmail.com), documented here, in parity/README.md and in the experiment LOG (NOT in the published entrypoint/agent-mcp/AGENTS.md).
// The judge sees ONLY: the task spec (both prompts + ticket), the artifact diff, and the transcript normalized to role/text/tool category/results.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUBRIC, RUBRIC_TEXT, parseJudgeOutput, qualityMean } from './quality.mjs';
import { isModelAlias } from './ledger.mjs';
import { rateCardFor } from './lib.mjs';

export const JUDGE_MODEL = 'claude-haiku-4-5';          // pinned id recorded in every judge record (R5.AC5). SEPARATE from the arms' model pin (fixtures.mjs PIN_MODEL, claude-sonnet-5-5 since R7): the judge stays on the cheapest tier by owner direction (R7-model AC1)
export const JUDGE_MAX_TOKENS = 1500;
/**
 * R8-judge AC1: the judge request carries NO sampling parameters. Newer models (claude-haiku-5-5) reject `temperature` with HTTP 400 ("`temperature` is deprecated for this
 * model"), so it is omitted for every judge model rather than retried on a 400 (a retry would spend a second paid call on a string match). Judge scores are therefore ONE sample
 * at the model's default sampling and a re-judge of the same brief can differ; this string is written into every judge record so the claim is never implied to be deterministic.
 */
export const JUDGE_SAMPLING = 'model default (temperature not sent)';
/**
 * Brief format version, recorded in every judge record. 1 = results of server-executed tools (web_fetch/web_search) were blank when never captured (every R5 judge
 * record has no briefFormat); 2 (R5-scorefix AC3) = those results are rendered when captured and a visible "(result not captured)" marker otherwise.
 */
export const BRIEF_FORMAT = 2;
/** USD per million tokens for the pinned judge model (billing figure for ledger.judgeCalls; excluded from the arm cost metric). */
export const JUDGE_PRICE_PER_MTOK = Object.freeze({ input: 1, output: 5 });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Identifying tokens that must never reach the judge (R5.AC2). Order matters: longer first. */
const IDENTIFYING = [
  [/mcp__[A-Za-z0-9_.-]+/g, 'tool'], [/claude -p\b/gi, 'cli'], [/agent-mcp/gi, 'host'], [/claudecli/gi, 'provider'], [/anthropic/gi, 'provider'],
  [/claude-(?:haiku|sonnet|opus)-[\w.-]+/gi, 'model'], [/\bclaude(?:-code)?\b/gi, 'cli'], [/\b(?:haiku|sonnet|opus)\b/gi, 'model'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'], [/\bsess(?:ion)?[_-]?[0-9A-Za-z]{8,}\b/gi, '<id>'],
  [/\bshell_execute\b/g, 'shell'], [/\bTask(?:Output)?\b(?=\s*[({])/g, 'delegate'], [/\b(?:r2info)\b/g, 'tickets'],
];
/** Replace identifying tokens with neutral words. Pure. */
export function normalizeText(text) {
  let s = String(text ?? '');
  for (const [re, rep] of IDENTIFYING) s = s.replace(re, rep);
  return s.replace(/\/Users\/[^\s"']+/g, '<HOME>').replace(/\/private\/tmp\/[^\s"']+/g, '<TMP>');
}

/** Map any arm's tool spelling to one of shell/read/write/search/delegate/web (R5.AC1). */
export function toolCategory(name) {
  const n = String(name);
  if (/(^|__)(web_fetch|web_search|WebFetch|WebSearch)$/.test(n)) return 'web';
  if (/(^|__)(Agent|Task|agent|task|tasks_batch)$/.test(n)) return 'delegate';
  if (/(^|__)(Bash|shell_execute|shell)$/.test(n)) return 'shell';
  if (/(^|__)(Write|write_file|Edit|edit_file|MultiEdit)$/.test(n)) return 'write';
  if (/(^|__)(Glob|Grep|search|search_files|list_directory)$/.test(n)) return 'search';
  if (/(^|__)(Read|read_text_file|read_multiple_files|read_file|get_ticket)$/.test(n)) return 'read';
  return 'read';
}

/** Normalize transcript turns [{role, text?, tool?, result?}] to role/text/category/result with identifying tokens removed. */
export function normalizeTranscript(turns) {
  return turns.map((t) => ({ role: t.role === 'assistant' ? 'assistant' : t.role === 'user' ? 'user' : 'tool', text: normalizeText(t.text ?? ''), ...(t.tool ? { category: toolCategory(t.tool) } : {}), ...(t.result != null ? { result: normalizeText(String(t.result)).slice(0, 2000) } : {}) }));
}

/** Random arm label per judging (never the arm id). rng is injectable for tests. */
export function randomLabel(rng = Math.random) { return `Candidate-${Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0')}`; }

/**
 * Build the blind brief for ONE arm: spec + diff + normalized transcript + the rubric. Returns { brief, briefSha, label }.
 * Never includes arm id, provider, model, oracle results, cost, duration, thresholds or the other arm's output.
 */
export function buildBrief({ prompts, ticketText, diff, transcript, label = randomLabel() }) {
  const body = [
    `You are reviewing one candidate's work (${label}). Score it on each quality below, as an integer 1-100.`,
    '## Qualities', ...RUBRIC.map((k, i) => `${i + 1}. ${k}: ${RUBRIC_TEXT[k]}`),
    '## Task spec (verbatim)', '### Phase 1 prompt', normalizeText(prompts.phase1), '### Phase 2 prompt', normalizeText(prompts.phase2), '### Ticket', normalizeText(ticketText),
    '## Artifact: unified diff of the final repo against the scenario start (plus new files)', normalizeText(diff),
    '## Transcript (role, text, tool category, result)', JSON.stringify(normalizeTranscript(transcript), null, 1),
    '## Output', 'Reply with exactly one JSON object and nothing else: {"scores": {"<quality>": <int 1-100>, ...}, "notes": {"<quality>": "<one sentence>", ...}} with exactly the 8 keys above in both objects.',
  ].join('\n\n');
  return { brief: body, briefSha: sha256(body), label };
}

/** Eligibility (R5.AC7): judge only when A and the judged arm both genuinely succeeded. */
export function judgeEligible({ aGenuine, armGenuine }) { return aGenuine === true && armGenuine === true; }

/**
 * USD for one judge call. Without `model` the pinned judge's list price (JUDGE_PRICE_PER_MTOK). With `model` (R8-model AC4: the id the API reported, i.e. the RESOLVED
 * id) the rate card of that id (lib.mjs RATE_CARDS); a model with no card is null (unmeasured), never another model's price.
 */
export function judgeCostUsd(inputTokens, outputTokens, model) {
  if (model == null) return (inputTokens * JUDGE_PRICE_PER_MTOK.input + outputTokens * JUDGE_PRICE_PER_MTOK.output) / 1e6;
  const r = rateCardFor(model)?.rates; return r ? (inputTokens * r.input + outputTokens * r.output) / 1e6 : null;
}
/**
 * R8-model AC4: the id the judge call is SENT with. A concrete id is sent as is. An ALIAS (`haiku`) is a claude CLI shorthand the Messages API does not resolve, so it is
 * resolved from the concrete ids the round's arms actually reported (`candidates`, first match of the `claude-<alias>-` family); with none to resolve from it THROWS (the
 * driver records judge-failed, no paid call is made).
 */
export function resolveJudgeModel(requested, candidates = []) {
  if (!isModelAlias(requested)) return requested;
  const family = `claude-${requested}-`; const hit = candidates.map(String).find((m) => m.startsWith(family));
  if (!hit) throw new Error(`judge: model alias "${requested}" is not a Messages API model id and no arm of this round reported a concrete ${family}* id to resolve it from: no call made`);
  return hit;
}

/**
 * Run one judge call through an INJECTED client ({ complete({model, maxTokens, prompt}) => {text, inputTokens, outputTokens} }); no `temperature` is passed (R8-judge AC1, JUDGE_SAMPLING).
 * The caller (the driver, live round only) supplies the client; tests supply a fake. Logs the call via `onCall` (ledger) and writes the record.
 * @returns {Promise<{ok:true, scores, notes, record} | {ok:false, code:string, record}>}
 */
export async function runJudge({ client, arm, brief, briefSha, outDir, onCall, briefFormat = BRIEF_FORMAT, model = JUDGE_MODEL, modelRequested = model }) {
  const reply = await client.complete({ model, maxTokens: JUDGE_MAX_TOKENS, prompt: brief });
  const resolved = reply.model ?? null;   // R8-model AC4: the id the API reported for the call; it prices the call and is what the record names
  const record = { arm, modelId: resolved ?? model, ...(modelRequested !== model || resolved ? { modelRequested, modelSent: model, modelResolved: resolved } : {}), briefFormat, briefSha, sampling: JUDGE_SAMPLING, rawResponse: reply.text, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd: judgeCostUsd(reply.inputTokens, reply.outputTokens, resolved ?? model) };
  let parsed = null; try { parsed = parseJudgeOutput(reply.text); } catch (e) { record.error = e.code ?? String(e.message); }
  if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `${arm}.json`), JSON.stringify({ ...record, ...(parsed ?? {}) }, null, 2)); }
  if (onCall) onCall({ arm, modelId: record.modelId, inputTokens: record.inputTokens, outputTokens: record.outputTokens, costUsd: record.costUsd, briefSha });
  return parsed ? { ok: true, ...parsed, record } : { ok: false, code: record.error, record };
}

/**
 * R5-judge AC3: offline re-parse of a saved judge record (`<dir>/<arm>.json`) that failed to parse. NO model call and NO ledger write (judgeCalls is untouched: the paid call was already logged).
 * Only records that carry `error` and `rawResponse` are re-parsed. On success the file gains `scores`, `notes`, `reparsedFromRaw: true`, `originalError` (the code it was rejected with) and loses `error`.
 * @returns {{arm:string, status:'reparsed'|'skipped'|'still-invalid', code?:string, mean?:number, scores?:object}}
 */
export function reparseJudgeRecord(file) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')); const arm = rec.arm ?? path.basename(file, '.json');
  if (!rec.error || typeof rec.rawResponse !== 'string') return { arm, status: 'skipped', code: rec.error ? 'NO_RAW' : 'ALREADY_SCORED' };
  let parsed; try { parsed = parseJudgeOutput(rec.rawResponse); } catch (e) { return { arm, status: 'still-invalid', code: e.code ?? String(e.message) }; }
  const { error, ...rest } = rec;
  fs.writeFileSync(file, JSON.stringify({ ...rest, ...parsed, reparsedFromRaw: true, originalError: error }, null, 2));
  return { arm, status: 'reparsed', mean: qualityMean(parsed.scores), scores: parsed.scores };
}

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SECRET_KEY = 'ADHD_AGENT_ANTHROPIC_SECRET'; // pragma: allowlist secret

/** Value of one KEY in a dotenv-style file (quotes stripped); null when the file or key is absent. Only the requested key is ever read out of the file. */
function dotenvValue(file, key) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] !== key) continue;
    let v = m[2]; if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    found = v;
  }
  return found;
}

/**
 * Resolve the judge credential WITHOUT any network call and without exposing it: ANTHROPIC_API_KEY, else ADHD_AGENT_ANTHROPIC_SECRET (the credential arm C uses)
 * from process env, then the agent-mcp .env cascade (<cwd>/.env, <cwd>/.adhd/.env, ~/.adhd/.env; most specific wins), exactly as config.getProviderConfig sees it.
 * An empty value counts as unset. Returns `{ present, source }` plus a non-enumerable `secret`, so logging/JSON-serialising the result cannot leak it.
 */
export function resolveJudgeCredential({ env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const out = (secret, source) => { const r = { present: Boolean(secret), source: secret ? source : null }; Object.defineProperty(r, 'secret', { value: secret || null, enumerable: false }); return r; };
  if (env.ANTHROPIC_API_KEY) return out(env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY (env)');
  if (env[SECRET_KEY]) return out(env[SECRET_KEY], `${SECRET_KEY} (env)`);
  for (const [file, label] of [[path.join(cwd, '.env'), '<cwd>/.env'], [path.join(cwd, '.adhd', '.env'), '<cwd>/.adhd/.env'], [path.join(home, '.adhd', '.env'), '~/.adhd/.env']]) {
    const v = dotenvValue(file, SECRET_KEY); if (v) return out(v, `${SECRET_KEY} (${label})`);
  }
  return out(null, null);
}

/** Request headers + system blocks for a secret, chosen by token prefix exactly as providers/anthropic.ts buildAnthropicClient does. */
export function judgeAuthShape(secret) {
  const base = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (secret.startsWith('sk-ant-api')) return { headers: { ...base, 'x-api-key': secret }, system: undefined };
  const oauth = secret.startsWith('sk-ant-oat');
  return { headers: { ...base, authorization: `Bearer ${secret}`, ...(oauth ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}) }, system: oauth ? [{ type: 'text', text: CLAUDE_CODE_IDENTITY }] : undefined };
}

/**
 * The LIVE judge client: one Anthropic Messages API call (paid third-party service, R5.AC8). The credential is the arm-C credential path
 * (R5-harness AC6): ANTHROPIC_API_KEY, else ADHD_AGENT_ANTHROPIC_SECRET via process env / the .env cascade; the auth shape follows the token prefix.
 * It fails loudly (before any fetch) when no credential exists and never prints the secret. Only the driver in an owner-approved live round constructs it.
 * `temperature` is never sent, even if a caller still passes it (R8-judge AC1): the destructuring below does not read it, so it cannot reach the wire.
 * @returns {{complete(args:{model:string,maxTokens:number,prompt:string}):Promise<{text:string,inputTokens:number,outputTokens:number,model?:string|null}>}}
 */
export function liveJudgeClient({ apiKey, env = process.env, cwd = process.cwd(), home = os.homedir(), fetchImpl = globalThis.fetch } = {}) {
  return {
    async complete({ model, maxTokens, prompt }) {
      const secret = apiKey || resolveJudgeCredential({ env, cwd, home }).secret;
      if (!secret) throw new Error('judge: no credential (set ANTHROPIC_API_KEY or ADHD_AGENT_ANTHROPIC_SECRET in the environment or ~/.adhd/.env); the judge is a paid API call');
      const shape = judgeAuthShape(secret);
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', { method: 'POST', headers: shape.headers,
        body: JSON.stringify({ model, max_tokens: maxTokens, ...(shape.system ? { system: shape.system } : {}), messages: [{ role: 'user', content: prompt }] }) });
      if (!res.ok) throw new Error(`judge: HTTP ${res.status} ${String(await res.text()).slice(0, 200)}`);
      const b = await res.json();
      return { text: (b.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join(''), inputTokens: b.usage?.input_tokens ?? 0, outputTokens: b.usage?.output_tokens ?? 0, model: typeof b.model === 'string' ? b.model : null };
    },
  };
}
