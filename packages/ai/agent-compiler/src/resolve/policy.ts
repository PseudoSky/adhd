import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { AgentPolicyStore, PolicyTemplateStore } from '@adhd/agent-policy';

// ──────────────────────────────────────────────
// resolvePolicyConstraints — fold agent_policy rows into rendered constraint text.
//
// Calls AgentPolicyStore.resolveForAgent (the 3-query merge: direct rows +
// category memberships + category policies) to get the complete effective policy
// set for the agent.  For each returned AgentPolicyRow, reads the policy template
// via PolicyTemplateStore.read(policySlug) and renders the constraint text the
// compiler emits into the header/body.
//
// Reuses AgentPolicyStore.resolveForAgent ([ref:store-read]) — does NOT
// re-implement the 3-query inheritance join.  The [dod.3] negative-control
// "return empty constraints" bites here: agent_policy must be the SINGLE source
// of the constraint block — no hardcoded per-slug branches.
//
// The constraint text is the policy template's `description` combined with the
// overrideConfig (shallow-merged via resolveEffectiveRules) for the specific
// agent attachment.  Both direct and inherited policy rows produce constraints;
// inherited rows include the `inheritedFrom` category slug for traceability.
// ──────────────────────────────────────────────

/** A resolved policy constraint ready for header/body rendering. */
export interface Constraint {
  /** The policy template slug (e.g. 'no-credentials'). */
  policySlug: string;
  /** The human-readable constraint text rendered into the compiled output. */
  text: string;
  /** True when this constraint is mandatory (cannot be overridden). */
  isMandatory: boolean;
  /**
   * Category slug this constraint was inherited from, or null for direct-attach.
   * Surfaces the provenance of inherited constraints in compiled output.
   */
  inheritedFrom: string | null;
}

/**
 * Resolve all effective policy constraints for an agent (direct + inherited).
 *
 * Delegates the full 3-query merge (direct rows + category memberships + category
 * policies) to {@link AgentPolicyStore.resolveForAgent} — this function does NOT
 * re-implement the inheritance join.  The [dod.3] negative-control is:
 * "return empty constraints when no agent_policy rows exist" — the constraint block
 * is keyed exclusively on the agent_policy table.
 *
 * Each resolved row is joined to its template via {@link PolicyTemplateStore.read}
 * and rendered as a {@link Constraint}.  The constraint text = the template's
 * `description`, which is the human-readable summary the compiler emits.
 *
 * @param db         - The shared registry Drizzle handle (all table prefixes).
 * @param agentSlug  - Slug of the agent whose policy constraints to resolve.
 * @returns Ordered list of constraints (direct first, then inherited by category).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolvePolicyConstraints(
  db: BetterSQLite3Database<any>,
  agentSlug: string
): Constraint[] {
  // Step 1: full effective policy set — direct + inherited.
  // resolveForAgent is the SINGLE place the 3-query merge lives ([ref:store-read]).
  const agentPolicyStore = new AgentPolicyStore(db);
  const rows = agentPolicyStore.resolveForAgent(agentSlug);

  // Step 2: for each row, read the policy template and render the constraint text.
  const templateStore = new PolicyTemplateStore(db);
  const constraints: Constraint[] = [];

  for (const row of rows) {
    const template = templateStore.read(row.policySlug);

    // Constraint text = the template's description.
    // This is the consumer-visible text the compiler renders into the header/body
    // ([def:policy-constraint], [inv:platform-shaped-observable]).
    const text = template.description;

    constraints.push({
      policySlug:   row.policySlug,
      text,
      isMandatory:  row.isMandatory,
      inheritedFrom: row.inheritedFrom,
    });
  }

  return constraints;
}
