// PARITY-INSTRUMENT-ONLY
// Web-path preflight (R2). Zero model calls. Legs are DERIVED from each arm's declared web surface (fixtures/drive WEB_SURFACE, R3), never hard-coded here:
// a leg is probeable only if its surface declares a `probe` ({ launch:{command,args,env}, tool, args(targetUrl) }), i.e. a fetch tool reachable by a real MCP client
// against the stack as shipped. No instrument-added allowlist entry or srt domain (R3). A surface without a probe is NOT_PROBEABLE and is covered by the
// silent-egress detector instead (detectors.mjs). If an arm cannot fetch as shipped that is a product finding, not something to patch in the instrument.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CODES = Object.freeze(['GREEN', 'LAUNCH_FAIL', 'EMPTY_FALSE_SUCCESS', 'TOOL_ERROR', 'MARKER_MISSING', 'EGRESS_DENIED', 'TIMEOUT', 'NOT_PROBEABLE']);
export const DEFAULT_SPEC = Object.freeze({ targetUrl: 'https://example.com', marker: '<title>Example Domain</title>', minBytes: 200, minWallMs: 150, timeoutMs: 120_000 });

const EGRESS_RE = /curl: \(6\)|Could not resolve|blocked|403 Forbidden|CONNECT tunnel failed/i;
const blank = (t) => String(t ?? '').replace(/\s+/g, '') === '';

/**
 * Derive the legs from the declared per-arm web surface. `surface` = { A: {tools:[...], probe?}, B: {...}, C: {...} }.
 * @returns {Array<{arm:string, tools:string[], probeable:boolean, probe?:object, why?:string}>}
 */
export function deriveLegs(surface) {
  return Object.keys(surface).sort().map((arm) => {
    const s = surface[arm] ?? {};
    return s.probe ? { arm, tools: s.tools ?? [], probeable: true, probe: s.probe } : { arm, tools: s.tools ?? [], probeable: false, why: s.why ?? 'no zero-model probe exists for this surface' };
  });
}

/**
 * Classify one leg's outcome. `outcome` = { launched, listed (tool present in listTools), timedOut, isError, text, wallMs }.
 * Order matters: the R4 silent failure (blank text, isError false, 13-23 ms) is EMPTY_FALSE_SUCCESS.
 */
export function classifyLeg(outcome, spec = DEFAULT_SPEC) {
  const s = { ...DEFAULT_SPEC, ...spec };
  if (outcome.timedOut) return { code: 'TIMEOUT', detail: `no result within ${s.timeoutMs} ms` };
  if (!outcome.launched || outcome.listed === false) return { code: 'LAUNCH_FAIL', detail: outcome.launched ? 'fetch tool not listed' : 'stack failed to launch' };
  const text = String(outcome.text ?? '');
  if (outcome.isError) return { code: EGRESS_RE.test(text) ? 'EGRESS_DENIED' : 'TOOL_ERROR', detail: text.slice(0, 200) };
  if (blank(text)) return { code: 'EMPTY_FALSE_SUCCESS', detail: `blank content with isError false after ${outcome.wallMs} ms` };
  if (EGRESS_RE.test(text) && !text.includes(s.marker)) return { code: 'EGRESS_DENIED', detail: text.slice(0, 200) };
  if (Buffer.byteLength(text) < s.minBytes) return { code: 'MARKER_MISSING', detail: `only ${Buffer.byteLength(text)} bytes (< ${s.minBytes})` };
  if (!text.includes(s.marker)) return { code: 'MARKER_MISSING', detail: `marker ${s.marker} not in the result` };
  if (!(outcome.wallMs > s.minWallMs)) return { code: 'EMPTY_FALSE_SUCCESS', detail: `returned in ${outcome.wallMs} ms (<= ${s.minWallMs}): a real TLS fetch cannot` };
  return { code: 'GREEN', detail: `${Buffer.byteLength(text)} bytes in ${outcome.wallMs} ms` };
}

/** CLI exit: 0 only if every probeable leg is GREEN, else 3 (usage errors are 2, decided by the CLI). NOT_PROBEABLE legs do not fail the exit. */
export function exitCodeFor(legVerdicts) { return legVerdicts.filter((v) => v.code !== 'NOT_PROBEABLE').every((v) => v.code === 'GREEN') ? 0 : 3; }

/**
 * Run the preflight. `probeLeg(leg, spec)` is injected (the real one drives the SDK Client + StdioClientTransport; tests pass a table).
 * @returns {Promise<{ok:boolean, exitCode:number, legs:Array<{arm:string,code:string,detail:string,probeable:boolean}>}>}
 */
export async function runPreflight(surface, spec, probeLeg) {
  const s = { ...DEFAULT_SPEC, ...spec }; const legs = [];
  for (const leg of deriveLegs(surface)) {
    if (!leg.probeable) { legs.push({ arm: leg.arm, probeable: false, code: 'NOT_PROBEABLE', detail: leg.why }); continue; }
    let outcome; const t0 = Date.now();
    try { outcome = await probeLeg(leg, s); } catch (e) { outcome = { launched: false, text: String(e?.message || e), wallMs: Date.now() - t0 }; }
    legs.push({ arm: leg.arm, probeable: true, ...classifyLeg(outcome, s) });
  }
  const exitCode = exitCodeFor(legs);
  return { ok: exitCode === 0, exitCode, legs };
}

/** Receipt (R2.AC6): identity of what was probed. Written to tmp/agent-mcp/parity/<round>/preflight-receipt.json. */
export function buildReceipt({ spec, distEntry, nativeToolingVersion, srtVersion, policyText, legs }) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  let distSha = null; try { distSha = sha(fs.readFileSync(distEntry)); } catch { /* absent dist is recorded as null */ }
  return { at: new Date().toISOString(), targetUrl: spec.targetUrl, marker: spec.marker, agentMcpDistSha: distSha, nativeToolingVersion: nativeToolingVersion ?? null, srtVersion: srtVersion ?? null, policySha: policyText == null ? null : sha(policyText), legs };
}
export function writeReceipt(dir, receipt) { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'preflight-receipt.json'); fs.writeFileSync(f, JSON.stringify(receipt, null, 2)); return f; }

/** Real leg prober over the official MCP SDK (used by the driver; never imported by unit tests). `sdk` = { Client, StdioClientTransport }. */
export async function probeLegViaSdk(sdk, leg, spec) {
  const t0 = Date.now(); let client;
  const timeout = new Promise((r) => setTimeout(() => r({ timedOut: true, wallMs: Date.now() - t0 }), spec.timeoutMs));
  const work = (async () => {
    const transport = new sdk.StdioClientTransport({ command: leg.probe.launch.command, args: leg.probe.launch.args, env: leg.probe.launch.env, stderr: 'pipe' });
    client = new sdk.Client({ name: 'parity-preflight', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    if (!tools.includes(leg.probe.tool)) return { launched: true, listed: false, wallMs: Date.now() - t0 };
    const c0 = Date.now();
    const r = await client.callTool({ name: leg.probe.tool, arguments: leg.probe.args(spec.targetUrl) }, undefined, { timeout: spec.timeoutMs });
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
    return { launched: true, listed: true, isError: !!r.isError, text, wallMs: Date.now() - c0 };
  })();
  try { return await Promise.race([work, timeout]); } finally { try { await client?.close(); } catch { /* ignore */ } }
}
