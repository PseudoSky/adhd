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

    const existing = this.db
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

    this.db
      .insert(agentsTable)
      .values({
        name: definition.name,
        version: definition.version,
        data: JSON.stringify(definition),
        createdAt: now,
        updatedAt: now,
      })
      .run();

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
    const existing = this.read(input.name);

    const definedPatch = Object.fromEntries(
      Object.entries(input.patch).filter(
        ([key, v]) => v !== undefined && key !== 'mcpServers'
      )
    );

    const updated: AgentDefinition = {
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

    this.db
      .update(agentsTable)
      .set({
        version: updated.version,
        data: JSON.stringify(updated),
        updatedAt: updated.updatedAt,
      })
      .where(eq(agentsTable.name, input.name))
      .run();

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
    const definition = this.read(name);

    const activeSessionCheck = this.db
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

    this.db.delete(agentsTable).where(eq(agentsTable.name, name)).run();

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
