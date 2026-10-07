/**
 * session-flows-doc.spec.ts — 91a8c640 B-AC8: `docs/plan/backlog-consolidation/session-flows.md`
 * carries a Mermaid diagram of >=3 flows, each citing session ids, with an embedded
 * evidence block that agrees with the diagram and the prose.
 *
 * Static half (default lane). The doc's evidence is re-derived from a fresh drive of the
 * built bin and compared in `session-flows-doc.e2e.ts`.
 * Resource lane: the re-derivation spawns the built bin per call.
 *
 * Negative control (run once, restored): editing one session id in the Mermaid fence
 * (`S-flow-2.1` -> `S-flow-9.9`) turns the cross-check red.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDoc, toMermaid } from './test/helpers/session-flows-evidence.js';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'plan', 'backlog-consolidation', 'session-flows.md');

describe('91a8c640 B-AC8 — session-flows.md', () => {
  const text = readFileSync(DOC, 'utf8');
  const { evidence, mermaid } = parseDoc(text);

  it('has >=3 flows, each citing session ids, and >=5 distinct sessions overall', () => {
    expect(evidence.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(evidence.flatMap((f) => [f.sessionId, ...f.children]));
    expect(ids.size).toBeGreaterThanOrEqual(5);
    for (const f of evidence) expect(text).toContain(`**${f.name}** cites`);
  });

  it('the mermaid diagram is exactly the diagram derived from the evidence, and every evidence session id appears in it', () => {
    expect(mermaid).toBe(toMermaid(evidence));
    for (const f of evidence) for (const id of [f.sessionId, ...f.children]) expect(mermaid).toContain(id);
  });

  it('every session id named in the prose is one the evidence covers', () => {
    const covered = new Set(evidence.flatMap((f) => [f.sessionId, ...f.children, ...f.ops.map((o) => o.sessionId)]));
    for (const m of text.matchAll(/`(S-flow-[0-9.]+)`/g)) expect(covered.has(m[1]!)).toBe(true);
  });
});
