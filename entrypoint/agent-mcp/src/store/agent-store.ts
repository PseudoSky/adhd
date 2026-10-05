import { eq } from 'drizzle-orm';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { agentsTable } from '../db/schema.js';
import { sessionsTable } from '@adhd/agent-store-runtime';
import { logger } from '../logger.js';
import {
  agentDefinitionStoredSchema,
  ToolError,
} from '@adhd/agent-engine-orchestrator';
import type {
  AgentCreateInput,
  AgentDefinition,
  AgentUpdateInput,
} from '@adhd/agent-engine-orchestrator';
import { nowIso } from '@adhd/agent-store-runtime';
import type { IHookRegistry } from '@adhd/agent-base-types';
import { withBusyRetry } from '@adhd/agent-core-env';

type McpServerConfig = NonNullable<AgentDefinition['mcpServers']>[string];
type McpServersPatch = NonNullable<AgentUpdateInput['patch']['mcpServers']>;

/**
 * Applies an `mcpServers` patch with delete semantics: a `null` value removes
 * that key, any other value upserts it, and keys absent from the patch are
 * left untouched. This is what makes a key rename expressible —
 * `{ agent: null, 'agent-mcp': {...} }` deletes the old key and adds the new
 * one, instead of a plain record-merge that would leave the old key stranded
 * forever (BUG: agent_update cannot remove/rename an mcpServers key).
 */
function mergeMcpServers(
  existing: AgentDefinition['mcpServers'],
  patch: McpServersPatch
): AgentDefinition['mcpServers'] {
  const next: Record<string, McpServerConfig> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

export class AgentStore {
  constructor(
    private readonly db: BetterSQLite3Database<Record<string, never>>,
    private readonly hooks?: IHookRegistry
  ) {}

  create(input: AgentCreateInput): AgentDefinition {
    const now = nowIso();
    const definition: AgentDefinition = {
      ...input,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Check-then-insert is a read-modify-write: run it inside ONE
    // `BEGIN IMMEDIATE` transaction so a concurrent creator cannot slip a row
    // in between the SELECT and the INSERT (backlog 331508ac AC4), and retry a
    // bounded number of times on a lost lock race (AC5). Without IMMEDIATE the
    // deferred transaction reads a pre-commit snapshot and the INSERT then
    // fails with a raw SQLITE_CONSTRAINT_UNIQUE instead of the clean
    // AGENT_ALREADY_EXISTS this path promises.
    withBusyRetry(() =>
      this.db.transaction(
        (tx) => {
          const existing = tx
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.name, input.name))
            .get();

          if (existing) {
            throw new ToolError(
              'AGENT_ALREADY_EXISTS',
              `Agent '${input.name}' already exists`
            );
          }

          tx.insert(agentsTable)
            .values({
              name: definition.name,
              version: definition.version,
              data: JSON.stringify(definition),
              createdAt: now,
              updatedAt: now,
            })
            .run();
        },
        { behavior: 'immediate' }
      )
    );

    logger.info({ agentName: input.name }, 'Agent created');
    return definition;
  }

  read(name: string): AgentDefinition {
    const row = this.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.name, name))
      .get();

    if (!row) {
      throw new ToolError('AGENT_NOT_FOUND', `Agent '${name}' not found`);
    }

    return agentDefinitionStoredSchema.parse(JSON.parse(row.data));
  }

  update(input: AgentUpdateInput): AgentDefinition {
    // read-then-write: the SELECT that produces the next version and the UPDATE
    // that persists it must run in ONE `BEGIN IMMEDIATE` transaction, or two
    // concurrent updates both read `version: N` and the second clobbers the
    // first (a lost update). `withBusyRetry` replays only on a lost lock race
    // (backlog 331508ac AC4 + AC5).
    const updated: AgentDefinition = withBusyRetry(() =>
      this.db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.name, input.name))
            .get();

          if (!row) {
            throw new ToolError(
              'AGENT_NOT_FOUND',
              `Agent '${input.name}' not found`
            );
          }

          const existing = agentDefinitionStoredSchema.parse(
            JSON.parse(row.data)
          );

          const definedPatch = Object.fromEntries(
            Object.entries(input.patch).filter(
              ([key, v]) => v !== undefined && key !== 'mcpServers'
            )
          );

          const next: AgentDefinition = {
            ...existing,
            ...definedPatch,
            mcpServers: input.patch.mcpServers
              ? mergeMcpServers(existing.mcpServers, input.patch.mcpServers)
              : existing.mcpServers,
            permissions: input.patch.permissions
              ? { ...existing.permissions, ...input.patch.permissions }
              : existing.permissions,
            name: existing.name,
            createdAt: existing.createdAt,
            version: existing.version + 1,
            updatedAt: nowIso(),
          };

          tx.update(agentsTable)
            .set({
              version: next.version,
              data: JSON.stringify(next),
              updatedAt: next.updatedAt,
            })
            .where(eq(agentsTable.name, input.name))
            .run();

          return next;
        },
        { behavior: 'immediate' }
      )
    );

    logger.info(
      { agentName: input.name, version: updated.version },
      'Agent updated'
    );
    void this.hooks?.emit('agent:mutated', {
      agent: updated,
      operation: 'update',
    });
    return updated;
  }

  delete(name: string): void {
    // read (exists?) → check active sessions → delete, in ONE `BEGIN IMMEDIATE`
    // transaction: the active-session guard and the DELETE must not interleave
    // with a concurrent session open, and the whole write replays on a lost
    // lock race (backlog 331508ac AC4 + AC5).
    const definition = withBusyRetry(() =>
      this.db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(agentsTable)
            .where(eq(agentsTable.name, name))
            .get();

          if (!row) {
            throw new ToolError('AGENT_NOT_FOUND', `Agent '${name}' not found`);
          }

          const def = agentDefinitionStoredSchema.parse(JSON.parse(row.data));

          const activeSessionCheck = tx
            .select()
            .from(sessionsTable)
            .where(eq(sessionsTable.agentName, name))
            .all()
            .find((s) => s.status === 'active');

          if (activeSessionCheck) {
            throw new ToolError(
              'AGENT_HAS_ACTIVE_SESSIONS',
              `Agent '${name}' has active sessions and cannot be deleted`
            );
          }

          tx.delete(agentsTable).where(eq(agentsTable.name, name)).run();
          return def;
        },
        { behavior: 'immediate' }
      )
    );

    logger.info({ agentName: name }, 'Agent deleted');
    void this.hooks?.emit('agent:mutated', {
      agent: definition,
      operation: 'delete',
    });
  }

  list(): AgentDefinition[] {
    const rows = this.db.select().from(agentsTable).all();
    return rows.map((row) =>
      agentDefinitionStoredSchema.parse(JSON.parse(row.data))
    );
  }
}
