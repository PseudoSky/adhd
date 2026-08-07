import { and, eq } from 'drizzle-orm';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { agentToolsTable } from '../db/schema.js';

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/**
 * The permission level granted to an agent for a canonical tool.
 *
 * Plain text value — NOT a SQL enum ([inv:lookup-not-enum]).
 * Allowed values: full | read_only | restricted.
 */
export type PermissionLevel = 'full' | 'read_only' | 'restricted';

/**
 * One agent_tools junction row: an agent_slug granted access to a tool_name
 * at a typed permission level, with an optional context_condition.
 *
 * agent_slug is a LOGICAL key into agent-registry's `agents` table — it is
 * NOT a SQLite FK ([inv:no-cross-pkg-fk]). The linkage is resolved at compile
 * time by @adhd/agent-engine-compiler. Accepts any string slug, even one with no
 * matching row in the agents table (there is no such table in this package).
 */
export interface AgentToolGrant {
  agentSlug: string;
  toolName: string;
  permission: PermissionLevel;
  /** null means the grant always applies. */
  contextCondition: Record<string, unknown> | null;
}

/** Input for granting a tool to an agent. */
export interface AgentToolGrantInput {
  agentSlug: string;
  toolName: string;
  /**
   * Omit to fall back to `DEFAULT_PERMISSION_LEVEL` ('full').
   *
   * Design decision (BUG-REGISTRY-002): the import flow (agent-registry-
   * migration's frontmatter parser) has no source signal for permission
   * level — a frontmatter `tools: Bash, Read, Write` list carries no
   * full/read_only/restricted qualifier. Defaulting to 'full' preserves the
   * pre-migration behavior (the tool was simply usable, unrestricted, on the
   * source platform) rather than silently *introducing* a restriction the
   * original agent never had — the migration's whole point is round-trip
   * equivalence ([inv:zero-loss-before-removal]), and an invented
   * 'restricted'/'read_only' default would be a fabricated capability loss.
   * `@adhd/agent-engine-compiler`'s `resolveTools` does not currently gate
   * tool-header emission on `permission` at all (only binding `availability`
   * does), so this default is inert today and only becomes load-bearing once
   * permission-aware enforcement is added — 'full' is still the correct
   * choice then, for the same round-trip reason.
   */
  permission?: PermissionLevel;
  /** Omit or pass null to mean "always applies". */
  contextCondition?: Record<string, unknown> | null;
}

/**
 * The permission level `AgentToolStore.grant()` applies when `permission` is
 * omitted from the input. See `AgentToolGrantInput.permission` for the
 * rationale (BUG-REGISTRY-002).
 */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'full';

// ──────────────────────────────────────────────
// Typed error codes
// ──────────────────────────────────────────────

export type AgentToolStoreErrorCode =
  | 'GRANT_ALREADY_EXISTS'
  | 'GRANT_NOT_FOUND';

export class AgentToolStoreError extends Error {
  constructor(public readonly code: AgentToolStoreErrorCode, message: string) {
    super(message);
    this.name = 'AgentToolStoreError';
  }
}

// ──────────────────────────────────────────────
// AgentToolStore
//
// Thin Drizzle queries over agent_tools.
// Mirrors the pattern in entrypoint/agent-mcp's AgentStore (agent-cache-store pattern).
// Constructor accepts a BetterSQLite3Database so tests can inject their own
// connection without touching the production singleton in client.ts.
//
// CRITICAL: grant() persists an EXPLICITLY-SUPPLIED `permission` argument
// verbatim — it must never coerce a caller-supplied value to some other
// level. Do not hardcode the persisted value — the [dod.3] negative-control
// breaks on exactly this. `permission` is optional as of BUG-REGISTRY-002:
// when omitted, and ONLY when omitted, grant() falls back to
// DEFAULT_PERMISSION_LEVEL ('full') — see AgentToolGrantInput.permission.
// ──────────────────────────────────────────────

export class AgentToolStore {
  constructor(
    private readonly db: BetterSQLite3Database<Record<string, never>>
  ) {}

  /**
   * Grant a canonical tool to an agent at a typed permission level.
   *
   * agent_slug is a LOGICAL reference — no FK check is performed against any
   * agents table ([inv:no-cross-pkg-fk]). Any string is accepted.
   *
   * `permission` may be omitted; it then defaults to `DEFAULT_PERMISSION_LEVEL`
   * ('full') — see `AgentToolGrantInput.permission` for the rationale
   * (BUG-REGISTRY-002). When supplied, it is persisted verbatim.
   *
   * Throws GRANT_ALREADY_EXISTS if the (agent_slug, tool_name) pair exists.
   */
  grant(input: AgentToolGrantInput): AgentToolGrant {
    const existing = this.db
      .select()
      .from(agentToolsTable)
      .where(
        and(
          eq(agentToolsTable.agentSlug, input.agentSlug),
          eq(agentToolsTable.toolName, input.toolName)
        )
      )
      .get();

    if (existing) {
      throw new AgentToolStoreError(
        'GRANT_ALREADY_EXISTS',
        `Grant for agent '${input.agentSlug}' on tool '${input.toolName}' already exists`
      );
    }

    const grant: AgentToolGrant = {
      agentSlug: input.agentSlug,
      toolName: input.toolName,
      // Persist an explicitly-supplied value verbatim — CRITICAL for the
      // [dod.3] negative-control. Only fall back to the default when the
      // caller omitted `permission` entirely (BUG-REGISTRY-002).
      permission: input.permission ?? DEFAULT_PERMISSION_LEVEL,
      contextCondition: input.contextCondition ?? null,
    };

    this.db
      .insert(agentToolsTable)
      .values({
        agentSlug: grant.agentSlug,
        toolName: grant.toolName,
        permission: grant.permission,
        contextCondition: grant.contextCondition,
      })
      .run();

    return grant;
  }

  /**
   * Return all grants for a given agent slug.
   *
   * Returns an empty array if no grants exist (or if the slug has never
   * been granted any tool — agent_slug carries no FK constraint).
   */
  listForAgent(agentSlug: string): AgentToolGrant[] {
    const rows = this.db
      .select()
      .from(agentToolsTable)
      .where(eq(agentToolsTable.agentSlug, agentSlug))
      .all();

    return rows.map((row) => ({
      agentSlug: row.agentSlug,
      toolName: row.toolName,
      permission: row.permission as PermissionLevel,
      contextCondition: row.contextCondition as Record<string, unknown> | null,
    }));
  }

  /**
   * Revoke a tool grant from an agent.
   * Throws GRANT_NOT_FOUND if the (agent_slug, tool_name) pair does not exist.
   */
  revoke(agentSlug: string, toolName: string): void {
    const existing = this.db
      .select()
      .from(agentToolsTable)
      .where(
        and(
          eq(agentToolsTable.agentSlug, agentSlug),
          eq(agentToolsTable.toolName, toolName)
        )
      )
      .get();

    if (!existing) {
      throw new AgentToolStoreError(
        'GRANT_NOT_FOUND',
        `Grant for agent '${agentSlug}' on tool '${toolName}' not found`
      );
    }

    this.db
      .delete(agentToolsTable)
      .where(
        and(
          eq(agentToolsTable.agentSlug, agentSlug),
          eq(agentToolsTable.toolName, toolName)
        )
      )
      .run();
  }
}
