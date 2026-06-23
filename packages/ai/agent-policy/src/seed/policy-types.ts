/**
 * Seed data for the `policy_policy_types` lookup table.
 *
 * Each entry is a controlled-vocabulary slug with a description.
 * New policy types are added by seeding a row — never by altering the column
 * type or writing a migration. [inv:lookup-not-enum]
 *
 * Source: SEED_DATA.md §3 — Policy Types.
 */

export interface PolicyTypeSeedRow {
    slug:        string;
    description: string;
}

/**
 * The seven canonical policy types that ship with the agent registry.
 * `INSERT OR IGNORE` semantics — running this list twice is a no-op.
 */
export const POLICY_TYPES: readonly PolicyTypeSeedRow[] = [
    {
        slug:        "permission",
        description: "What tools or agent delegations are allowed",
    },
    {
        slug:        "safety",
        description: "What content, actions, or outputs are forbidden",
    },
    {
        slug:        "audit",
        description: "What must be logged, traced, or recorded",
    },
    {
        slug:        "rate",
        description: "Token, call count, time, or rework limits",
    },
    {
        slug:        "scope",
        description: "Accessible file paths, domains, or ticket types",
    },
    {
        slug:        "compliance",
        description: "Regulatory or organizational requirements",
    },
    {
        slug:        "quality",
        description: "Output quality invariants enforced at gate time",
    },
] as const;
