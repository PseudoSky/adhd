/**
 * Seed data for the `policy_policy_templates` table.
 *
 * Every entry carries REAL `rules` JSON from SEED_DATA.md §9.  Placeholders
 * defeat idempotency and the round-trip proof. [seed-and-roundtrip.2]
 *
 * Key invariants honoured here:
 *  - `enforcement` is ALWAYS a JSON array — never a scalar string.
 *    [inv:enforcement-is-array]
 *  - `no-credentials` carries `enforcement: ["agent","ci"]` — the multi-value
 *    case that round-trip tests must exercise.
 *  - `sox-audit-trail` is seeded as `hook_type: "observational"` (Decision 2 —
 *    its hook point is TOOL_CALL, not pre:model_request, so it must NOT be
 *    registered via registerEnforcement).
 *  - All entries are `is_system: true, version: 1`.
 *  - `INSERT OR IGNORE` semantics in the seeder keep re-runs as no-ops.
 *    [seed-and-roundtrip.1]
 *
 * Source: SEED_DATA.md §9 — Policy Templates.
 */

export interface PolicyTemplateSeedRow {
    slug:        string;
    type:        string;  // FK to policy_policy_types.slug
    description: string;
    rules:       Record<string, unknown>;
    enforcement: string[];  // JSON array — never a scalar
    version:     number;
    isSystem:    boolean;
}

/**
 * The system policy templates that ship with the agent registry.
 *
 * Includes:
 *  - `reviewer-posture`  — safety, ["agent"]
 *  - `no-credentials`    — safety, ["agent","ci"]  ← multi-value case
 *  - `sox-audit-trail`   — audit,  ["hook"]         ← observational only (Decision 2)
 *  - `max-rework-3`      — rate,   ["runtime"]
 *  - `evidence-required` — quality, ["runtime"]
 *  - `read-only`         — permission, ["settings"]
 *  - `phase-gate-required` — compliance, ["runtime","ci"]
 *  - `originality-check` — quality, ["ci"]
 *  - `allowed-delegation` — permission, ["runtime"]
 */
export const POLICY_TEMPLATES: readonly PolicyTemplateSeedRow[] = [
    // ── safety ────────────────────────────────────────────────────────────────

    {
        slug:        "reviewer-posture",
        type:        "safety",
        description: "Default skeptic posture: NEEDS-WORK unless evidence confirms each criterion",
        rules: {
            default_verdict:                       "NEEDS_WORK",
            requires_explicit_pass_justification:  true,
            minimum_evidence_per_criterion:        1,
            components_to_inject:                  ["default-skeptic", "reviewer-boundary"],
        },
        enforcement: ["agent"],
        version:     1,
        isSystem:    true,
    },

    {
        slug:        "no-credentials",
        type:        "safety",
        description: "Prevent credential leakage in files, task output, and handoff text",
        rules: {
            forbidden_patterns: [
                "sk-[a-zA-Z0-9]{32,}",
                "AKIA[0-9A-Z]{16}",
                "-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----",
                "password\\s*=\\s*['\"][^'\"]{4,}",
            ],
            ci_scan_targets:     ["committed_files", "task_output", "handoff_text"],
            components_to_inject: ["no-credentials"],
        },
        // The multi-value enforcement that the round-trip test must verify.
        // [inv:enforcement-is-array]
        enforcement: ["agent", "ci"],
        version:     1,
        isSystem:    true,
    },

    // ── audit ─────────────────────────────────────────────────────────────────

    {
        slug:        "sox-audit-trail",
        type:        "audit",
        description: "Log io and compute tool calls for SOX-compliant audit trail",
        rules: {
            hook_event:          "TOOL_CALL",
            log_tool_types:      ["io", "compute"],
            require_task_event_on: ["file_write", "file_edit", "shell_exec"],
            // Decision 2: this hook is observational, not blocking.  It is NOT
            // registered via registerEnforcement("pre:model_request") — only via
            // the observational hooks.register() path. [decisions.md Decision 2]
            hook_type:           "observational",
        },
        enforcement: ["hook"],
        version:     1,
        isSystem:    true,
    },

    // ── rate ─────────────────────────────────────────────────────────────────

    {
        slug:        "max-rework-3",
        type:        "rate",
        description: "Cap rework attempts at 3; escalate to janitor on breach",
        rules: {
            max_rework:                   3,
            check_at:                     "cmd_gate_changes_requested",
            escalation_target:            "janitor",
            escalation_template_component: "sox-escalation-report",
            inject_attempt_framing:       true,
            attempt_framing_component:    "attempt-framing",
        },
        enforcement: ["runtime"],
        version:     1,
        isSystem:    true,
    },

    // ── quality ───────────────────────────────────────────────────────────────

    {
        slug:        "evidence-required",
        type:        "quality",
        description: "Block verdict if required evidence fields are absent or empty",
        rules: {
            validator_agent_slug:        "evidence-validator",
            validator_default_verdict:   "EVIDENCE_INSUFFICIENT",
            required_fields:             ["changed_files", "acceptance_criteria_addressed", "test_results"],
            required_fields_except: {
                test_results: ["SPIKE", "CHORE"],
            },
            block_verdict_if_insufficient: true,
        },
        enforcement: ["runtime"],
        version:     1,
        isSystem:    true,
    },

    {
        slug:        "originality-check",
        type:        "quality",
        description: "Block duplicate agent commits above 0.85 similarity threshold",
        rules: {
            check_on:             "new_agent_commit",
            similarity_threshold: 0.85,
            comparison_fields:    ["role_component_content", "capability_component_content"],
            action_on_duplicate:  "block_commit",
            suggest_extend_existing: true,
        },
        enforcement: ["ci"],
        version:     1,
        isSystem:    true,
    },

    // ── permission ────────────────────────────────────────────────────────────

    {
        slug:        "read-only",
        type:        "permission",
        description: "Restrict agent to read-only tool access; forbid compute tools",
        rules: {
            allowed_tool_permissions: ["read_only"],
            disallow_tool_types:      ["compute"],
            disallow_tools:           ["file_write", "file_edit", "shell_exec"],
        },
        enforcement: ["settings"],
        version:     1,
        isSystem:    true,
    },

    {
        slug:        "allowed-delegation",
        type:        "permission",
        description: "Allowlist sub-agent delegation targets; empty = unrestricted",
        rules: {
            mode:      "allowlist",
            allowlist: [],
            note:      "Empty allowlist = unrestricted delegation. Populate per-agent via AGENT_POLICY.override_config.",
        },
        enforcement: ["runtime"],
        version:     1,
        isSystem:    true,
    },

    // ── compliance ────────────────────────────────────────────────────────────

    {
        slug:        "phase-gate-required",
        type:        "compliance",
        description: "Require passing phase gate before ticket creation for next phase",
        rules: {
            gate_command:                      "sox gate phase",
            block_ticket_creation_for_next_phase: true,
            gate_criteria_source:              "PHASE.gate_id",
            require_all_criteria_met:          true,
        },
        enforcement: ["runtime", "ci"],
        version:     1,
        isSystem:    true,
    },
] as const;
