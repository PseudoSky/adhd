/**
 * enrichment.ts — FEAT-BACKLOG-006: best-effort citation blast-radius
 * enrichment. A citation that names a `symbol` is decorated with a snapshot
 * of `gitnexus impact <symbol>`'s risk assessment — "what breaks if this
 * symbol changes" — computed once, at write time, and never refreshed.
 *
 * `gitnexus` is NOT a declared dependency of this package (it is a globally
 * installed dev tool, `@adhd`'s own code-intelligence CLI — see the
 * top-level CLAUDE.md's GitNexus section). That makes every failure mode —
 * binary missing, repo not indexed, symbol not found, timeout — a routine,
 * expected outcome here, not an error condition: this module NEVER throws,
 * and its caller (`lifecycle.ts`'s citation write paths) NEVER blocks a
 * citation write on it beyond the bounded timeout below.
 */
import { execFile } from 'node:child_process';
import type { Citation, CitationBlastRadius } from '../model.js';

/**
 * Bounded so a hung/slow `gitnexus` process can never turn a citation write
 * (a routine, frequent operation) into a multi-second stall. `gitnexus impact`
 * on this very repo (79 impacted symbols, CRITICAL risk) returns in well
 * under a second when the index is warm — 2.5s leaves ample headroom for a
 * cold index without letting a genuinely stuck process hang the caller.
 */
const ENRICHMENT_TIMEOUT_MS = 2500;

const KNOWN_RISKS: ReadonlySet<string> = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

interface GitnexusImpactOutput {
  impactedCount?: unknown;
  risk?: unknown;
  direction?: unknown;
}

function parseImpactOutput(stdout: string): CitationBlastRadius {
  const parsed = JSON.parse(stdout) as GitnexusImpactOutput;
  const risk = typeof parsed.risk === 'string' && KNOWN_RISKS.has(parsed.risk) ? (parsed.risk as CitationBlastRadius['risk']) : 'UNKNOWN';
  const blastRadius: CitationBlastRadius = { risk, computedAt: new Date().toISOString() };
  if (typeof parsed.impactedCount === 'number') blastRadius.impactedCount = parsed.impactedCount;
  if (parsed.direction === 'upstream' || parsed.direction === 'downstream') blastRadius.direction = parsed.direction;
  return blastRadius;
}

/**
 * Returns `citation` unchanged (never rejects) unless `gitnexus impact` runs
 * to completion within the timeout AND produces parseable, well-formed JSON
 * — in every other case this degrades silently to "not enriched," which is
 * exactly what `Citation.blastRadius`'s doc comment tells a caller to expect
 * from its absence.
 *
 * @param citation the citation to enrich — untouched unless `citation.symbol` is a non-empty string
 * @param repo the backlog repo slug, passed straight through as `gitnexus impact --repo` — a best-effort hint, not validated against gitnexus's own repo registry
 */
export async function enrichCitationBlastRadius(citation: Citation, repo: string): Promise<Citation> {
  if (typeof citation.symbol !== 'string' || citation.symbol.trim().length === 0) return citation;

  return new Promise<Citation>((resolve) => {
    execFile(
      'gitnexus',
      ['impact', citation.symbol as string, '--repo', repo],
      { timeout: ENRICHMENT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          // Binary missing (ENOENT), repo not indexed, symbol not found,
          // killed on timeout — every one of these is routine, not a bug.
          resolve(citation);
          return;
        }
        try {
          resolve({ ...citation, blastRadius: parseImpactOutput(stdout) });
        } catch {
          // Malformed/unexpected JSON shape — degrade the same way a
          // missing binary does, never throw out of a best-effort path.
          resolve(citation);
        }
      }
    );
  });
}

/** Enriches every citation in `citations` concurrently — same best-effort, never-throws contract as `enrichCitationBlastRadius` itself. */
export async function enrichCitationsBlastRadius(citations: readonly Citation[], repo: string): Promise<Citation[]> {
  return Promise.all(citations.map((citation) => enrichCitationBlastRadius(citation, repo)));
}
