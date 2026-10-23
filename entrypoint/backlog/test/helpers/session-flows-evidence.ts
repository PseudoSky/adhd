/**
 * session-flows-evidence.ts — the deterministic projection of `driveSessionFlows`
 * output that `docs/plan/backlog-consolidation/session-flows.md` embeds and that
 * `session-flows-doc.e2e.ts` re-derives (B-AC8, 91a8c640). Uids and timestamps
 * are dropped: session ids, agents and op sequences are the stable evidence.
 */
import type { ISessionFlowsResult } from './session-flows-driver.js';

export interface IFlowEvidence {
  name: string;
  sessionId: string;
  agent: string;
  parentSessionId: string | null;
  children: string[];
  ops: Array<{ sessionId: string; agent: string; op: string }>;
}

/** Project driven flows to their stable evidence rows. */
export function toEvidence(result: ISessionFlowsResult): IFlowEvidence[] {
  return result.flows.map((f) => ({
    name: f.name,
    sessionId: f.sessionId,
    agent: f.timeline.session.agent,
    parentSessionId: f.timeline.session.parentSessionId ?? null,
    children: f.timeline.children,
    ops: f.timeline.ops.map((o) => ({ sessionId: o.sessionId, agent: o.agent, op: o.op })),
  }));
}

/** Render the Mermaid sequence diagram for one flow (participants are agents, labelled with session ids). */
export function toMermaid(evidence: IFlowEvidence[]): string {
  const lines = ['sequenceDiagram', '  participant Store as backlog store (timeline)'];
  for (const f of evidence) {
    lines.push(`  Note over Store: ${f.name} [${[f.sessionId, ...f.children].join(', ')}]`);
    for (const o of f.ops) lines.push(`  ${o.agent.replace(/[^A-Za-z0-9]/g, '_')}->>Store: ${o.op} (${o.sessionId})`);
  }
  return lines.join('\n');
}

/** Extract the evidence rows and the mermaid body from the doc text. */
export function parseDoc(text: string): { evidence: IFlowEvidence[]; mermaid: string } {
  const json = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
  const mermaid = /```mermaid\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (json === undefined || mermaid === undefined) throw new Error('session-flows.md is missing its json evidence or mermaid fence');
  return { evidence: JSON.parse(json) as IFlowEvidence[], mermaid };
}

