/**
 * Best-effort path for errors no deterministic rule matched
 * (docs/plan/provider-failure/SPEC.md §1.3). Pure.
 *
 * Contract: this module NEVER promotes. A hit yields `class:'unknown'` plus a
 * `suspectedClass`, a `confidence` in high|medium|low and the scrubbed
 * `evidence` that was seen. Rule authoring replaces a heuristic hit; it does not
 * widen the heuristic.
 */
import type {
  Confidence,
  FailureEvidence,
  ProviderFailureClass,
} from '@adhd/agent-base-types';

export type SuspectableClass = Extract<
  ProviderFailureClass,
  'billing' | 'auth' | 'rate_limited' | 'overloaded' | 'unavailable' | 'context_length' | 'timeout'
>;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]'],
  [/\bAIza[A-Za-z0-9_-]{10,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{6,}/g, '[REDACTED]'],
  [/(\b(?:api[_-]?key|x-api-key|authorization|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}&]{4,}/gi, '$1[REDACTED]'],
];

/** Replace anything that looks like a credential with `[REDACTED]`. Total. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Cut to `max` chars (no ellipsis; the bound is the contract). */
export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Ordered by tie-break priority (earlier wins on equal score). */
const TOKENS: ReadonlyArray<readonly [SuspectableClass, readonly string[]]> = [
  ['billing', ['insufficient credit', 'credit balance', 'out of credits', 'billing', 'payment required', 'usage limit', 'spend limit', 'quota', 'budget', 'purchase credits']],
  ['auth', ['invalid api key', 'invalid x-api-key', 'unauthorized', 'authentication', 'expired token', 'invalid token', 'api key']],
  ['rate_limited', ['rate limit', 'rate_limit', 'too many requests', 'throttl', 'requests per minute', 'tokens per minute']],
  ['overloaded', ['overloaded', 'at capacity', 'capacity']],
  ['context_length', ['prompt is too long', 'context length', 'context window', 'maximum context', 'too many tokens', 'token limit']],
  ['timeout', ['timed out', 'timeout', 'deadline exceeded']],
  ['unavailable', ['service unavailable', 'bad gateway', 'temporarily unavailable', 'connection reset', 'upstream', 'internal server error']],
];

/** Weak status affinity: contributes a signal, never fires the heuristic alone for row 18. */
function statusAffinity(status: number | undefined): SuspectableClass | undefined {
  switch (status) {
    case 401: return 'auth';
    case 402: return 'billing';
    case 413: return 'context_length';
    case 429: return 'rate_limited';
    case 408: case 504: return 'timeout';
    case 529: return 'overloaded';
    default: return status !== undefined && status >= 500 ? 'unavailable' : undefined;
  }
}

export interface HeuristicInput {
  status?: number;
  errorName?: string;
  providerErrorType?: string;
  providerErrorCode?: string;
  /** Already-scrubbed message. */
  message: string;
  /** Already-scrubbed body text (JSON or string). */
  bodyText?: string;
}

export interface HeuristicResult {
  /** `class` is ALWAYS `'unknown'`: heuristics never promote. */
  class: 'unknown';
  suspectedClass?: SuspectableClass;
  confidence: Exclude<Confidence, 'certain'>;
  evidence: FailureEvidence;
  /** True only when at least one text/type token matched (status alone does not "fire"). */
  tokenFired: boolean;
}

/** Score the error text; always returns a result (possibly `low` with no suspect). Total. */
export function classifyHeuristically(input: HeuristicInput): HeuristicResult {
  const typeText = `${input.providerErrorType ?? ''} ${input.providerErrorCode ?? ''} ${input.errorName ?? ''}`.toLowerCase();
  const text = `${input.message} ${input.bodyText ?? ''}`.toLowerCase();
  const affinity = statusAffinity(input.status);

  let best: { cls: SuspectableClass; tokens: string[]; score: number; viaType: boolean; viaText: boolean; viaStatus: boolean } | undefined;
  for (const [cls, list] of TOKENS) {
    const tokens: string[] = [];
    let viaType = false;
    let viaText = false;
    for (const t of list) {
      const inType = typeText.includes(t);
      const inText = text.includes(t);
      if (inType || inText) {
        tokens.push(t);
        viaType ||= inType;
        viaText ||= inText;
      }
    }
    const viaStatus = affinity === cls;
    const score = tokens.length + (viaStatus ? 1 : 0);
    if (score === 0) continue;
    if (!best || score > best.score) best = { cls, tokens, score, viaType, viaText, viaStatus };
  }

  const evidence: FailureEvidence = { matchedTokens: best?.tokens ?? [] };
  if (input.status !== undefined) evidence.status = input.status;
  if (input.errorName) evidence.errorName = input.errorName;
  const source = input.bodyText || input.message;
  if (source) evidence.bodySnippet = truncate(source, 300);

  if (!best) return { class: 'unknown', confidence: 'low', evidence, tokenFired: false };

  const signals = Number(best.viaStatus) + Number(best.viaType) + Number(best.viaText);
  const tokenFired = best.tokens.length > 0;
  let confidence: HeuristicResult['confidence'] = 'low';
  if (signals >= 2) confidence = 'high';
  else if (tokenFired) confidence = 'medium';
  return { class: 'unknown', suspectedClass: best.cls, confidence, evidence, tokenFired };
}
