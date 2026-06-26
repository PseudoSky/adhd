/**
 * seed/prompt-types.ts
 *
 * Every system prompt type that ships with @adhd/agent-registry.
 * These map 1:1 to rows in registry_prompt_types (is_system = true).
 *
 * Source: docs/plan/agent-registry/SEED_DATA.md §1
 * [inv:lookup-not-enum] — types are rows, not SQL enums. Adding a new type
 * is a seed operation, not a migration.
 */

import type { PromptType } from "../store/component-store.js";

/**
 * All system prompt types for the registry.
 * Array ordering is cosmetic — types are keyed by slug in the DB.
 */
export const PROMPT_TYPES: PromptType[] = [
    {
        slug: "role",
        description: "Fundamental agent identity — what the agent is",
        isSystem: true,
    },
    {
        slug: "identity",
        description:
            "Mission, refusal boundaries, communication style, learning posture",
        isSystem: true,
    },
    {
        slug: "capability",
        description: "Domain knowledge and specialization claims",
        isSystem: true,
    },
    {
        slug: "rule",
        description: "Hard invariants and constraints that must always apply",
        isSystem: true,
    },
    {
        slug: "style",
        description:
            "Tone, formatting conventions, output structure preferences",
        isSystem: true,
    },
    {
        slug: "personality",
        description:
            "Behavioral characteristics that persist across interaction types",
        isSystem: true,
    },
    {
        slug: "process",
        description:
            "Step-by-step workflow the agent follows when invoked",
        isSystem: true,
    },
    {
        slug: "invocation",
        description:
            "Activation card: trigger phrase, required inputs, expected outputs, deliverable",
        isSystem: true,
    },
    {
        slug: "success_criteria",
        description:
            "Typed criteria for evaluating agent output — gate-readable",
        isSystem: true,
    },
    {
        slug: "handoff",
        description: "Section template for inter-agent state transfer",
        isSystem: true,
    },
    {
        slug: "escalation",
        description: "Structured report template for escalation events",
        isSystem: true,
    },
    {
        slug: "posture",
        description:
            "Default verdict stance for reviewers (NEEDS-WORK vs. APPROVE)",
        isSystem: true,
    },
    {
        slug: "boundary",
        description: "Explicit declarations of what the agent will not do",
        isSystem: true,
    },
    {
        slug: "convergence",
        description:
            "N-agent synthesis pattern: fan-out → synthesizer → decision",
        isSystem: true,
    },
    {
        slug: "deliverable",
        description: "Concrete output format template with annotated example",
        isSystem: true,
    },
    {
        slug: "evidence",
        description:
            "Typed evidence fields required before a verdict is accepted",
        isSystem: true,
    },
    {
        slug: "context_pull",
        description:
            "Pull-loop pattern: claim ticket → read context → work → finish with handoff",
        isSystem: true,
    },
    {
        slug: "risk_posture",
        description:
            "Risk category awareness and escalation trigger conditions",
        isSystem: true,
    },
];
