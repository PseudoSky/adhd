/**
 * fixtures.ts — real-row fixture seeder for agent-compiler e2e tests.
 *
 * Exports `seedFixtureAgent(db)` which seeds the `api-design-reviewer` fixture
 * agent (modelled after SEED_DATA.md §14 `code-reviewer`) into a shared SQLite
 * DB handle that already has all four package migrations applied.
 *
 * Seed coverage:
 *   - registry prefix : taxonomy category, agent, components, junction rows
 *   - tool prefix     : agent tool grants (file_read, file_grep, web_search)
 *   - provider prefix : model_hint = claude_sonnet_4_6 (seeded by seedProvider)
 *   - policy prefix   : no-credentials policy template + direct attachment
 *
 * The two `success_criteria` junction rows are conditioned:
 *   position=4 → code-review-criteria   (no context condition — general/review)
 *   position=5 → security-audit-criteria (context_condition={ticket_type:"security"})
 *
 * This mirrors the exact pattern from SEED_DATA.md §14 (code-reviewer, positions
 * 5+6) and USAGE.md "Context-Conditional Composition".
 *
 * [inv:one-db-handle]    — caller passes ONE shared DB handle, all four prefixes.
 * [inv:real-rows-not-mocks] — this function seeds real rows; no mocks needed.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  AgentStore,
  TaxonomyStore,
  ComponentStore,
  CompositionStore,
} from '@adhd/agent-registry';
import {
  AgentToolStore,
} from '@adhd/agent-tool-registry';
import {
  AgentPolicyStore,
} from '@adhd/agent-policy';

// ── exported fixture constants ─────────────────────────────────────────────

/** Slug of the seeded fixture agent. */
export const FIXTURE_AGENT_SLUG     = 'api-design-reviewer-e2e';
export const FIXTURE_CATEGORY_SLUG  = 'e2e-api-specialists';

// Component slugs from the shared registry seed (SEED_DATA.md §8).
// These must exist after seedRegistry() has run against the same DB.
export const COMP_ROLE              = 'generic-reviewer-role';      // position 1
export const COMP_IDENTITY          = 'reviewer-identity';          // position 2
export const COMP_RULE              = 'default-skeptic';            // position 3
export const COMP_REVIEW_CRITERIA   = 'code-review-criteria';       // position 4 – general
export const COMP_SECURITY_CRITERIA = 'security-audit-criteria';    // position 5 – {ticket_type:security}

// Tool slugs granted to the fixture agent.
export const TOOL_FILE_READ  = 'file_read';
export const TOOL_FILE_GREP  = 'file_grep';
export const TOOL_WEB_SEARCH = 'web_search';

// ── seedFixtureAgent ───────────────────────────────────────────────────────

/**
 * Seed the `api-design-reviewer-e2e` fixture agent into `db`.
 *
 * Prerequisites (caller must have already run against `db`):
 *   - All four package migrations applied.
 *   - seedRegistry(db)      — for components (generic-reviewer-role etc.)
 *   - seedToolRegistry(db)  — for tool catalog + platform bindings
 *   - seedProvider(db)      — for model_platform_bindings (claude_sonnet_4_6)
 *   - seedPolicy(db)        — for policy_policy_types + no-credentials template
 *
 * Idempotence: NOT idempotent — call once per test DB.  Tests create a fresh
 * temp file per suite so re-seed is never needed.
 *
 * @param db - The shared Drizzle handle (all four table prefixes).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function seedFixtureAgent(db: BetterSQLite3Database<any>): void {
  // ── 1. Taxonomy category ────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taxonomyStore = new TaxonomyStore(db as any);
  taxonomyStore.createCategory({
    slug:     FIXTURE_CATEGORY_SLUG,
    name:     'E2E API Specialists',
    position: 99,
  });

  // ── 2. Agent (model_hint = claude_sonnet_4_6, per spec) ─────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentStore = new AgentStore(db as any);
  agentStore.create({
    slug:             FIXTURE_AGENT_SLUG,
    displayName:      'API Design Reviewer (E2E Fixture)',
    description:      'Reviews REST and GraphQL API designs for correctness, security, and usability',
    modelHint:        'claude_sonnet_4_6',
    taxonomyCategory: FIXTURE_CATEGORY_SLUG,
  });

  // ── 3. Junction rows — ORDERED, context-conditioned ([def:junction-order]) ─
  //
  // Position layout (mirrors SEED_DATA.md §14 code-reviewer):
  //   1  generic-reviewer-role      — always included (role)
  //   2  reviewer-identity          — always included (identity)
  //   3  default-skeptic            — always included (rule)
  //   4  code-review-criteria       — always included (success_criteria, general/review)
  //   5  security-audit-criteria    — {ticket_type:"security"} only (success_criteria)
  //
  // No version_pin on any row — resolve latest at compile time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compositionStore = new CompositionStore(db as any);

  compositionStore.attach({
    agentSlug:     FIXTURE_AGENT_SLUG,
    componentSlug: COMP_ROLE,
    position:      1,
  });

  compositionStore.attach({
    agentSlug:     FIXTURE_AGENT_SLUG,
    componentSlug: COMP_IDENTITY,
    position:      2,
  });

  compositionStore.attach({
    agentSlug:     FIXTURE_AGENT_SLUG,
    componentSlug: COMP_RULE,
    position:      3,
  });

  // General success criteria — no context condition (always included).
  // This is the "review" path: present when context is empty OR {ticket_type:"review"}.
  compositionStore.attach({
    agentSlug:        FIXTURE_AGENT_SLUG,
    componentSlug:    COMP_REVIEW_CRITERIA,
    position:         4,
    contextCondition: null,
  });

  // Security success criteria — only included when {ticket_type:"security"}.
  compositionStore.attach({
    agentSlug:        FIXTURE_AGENT_SLUG,
    componentSlug:    COMP_SECURITY_CRITERIA,
    position:         5,
    contextCondition: JSON.stringify({ ticket_type: 'security' }),
  });

  // ── 4. Tool grants (registry prefix — [up:tools]) ───────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentToolStore = new AgentToolStore(db as any);

  agentToolStore.grant({
    agentSlug:  FIXTURE_AGENT_SLUG,
    toolName:   TOOL_FILE_READ,
    permission: 'read_only',
  });

  agentToolStore.grant({
    agentSlug:  FIXTURE_AGENT_SLUG,
    toolName:   TOOL_FILE_GREP,
    permission: 'read_only',
  });

  agentToolStore.grant({
    agentSlug:  FIXTURE_AGENT_SLUG,
    toolName:   TOOL_WEB_SEARCH,
    permission: 'full',
  });

  // ── 5. Policy attachment — no-credentials (direct attach) ───────────────
  // The policy template is in the seed data already (seedPolicy ran above).
  // Direct attach: inheritedFrom = null ([def:policy-constraint]).
  const agentPolicyStore = new AgentPolicyStore(db);

  agentPolicyStore.attach({
    agentSlug:   FIXTURE_AGENT_SLUG,
    policySlug:  'no-credentials',
    isMandatory: true,
  });
}
