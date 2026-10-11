import { isDeepStrictEqual } from 'node:util';

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

/** A definition minus the version/updatedAt bookkeeping, for no-op detection. */
function definitionBody(def: AgentDefinition): Record<string, unknown> {
  const body: Record<string, unknown> = { ...def };
  delete body['version'];
  delete body['updatedAt'];
  return body;
}

/** Max registered names echoed in an AGENT_NOT_FOUND message (1b947d91 AC1). */
export const AGENT_NOT_FOUND_NAME_CAP = 20;

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
      throw new ToolError(
        'AGENT_NOT_FOUND',
        `Agent '${name}' not found. ${this.describeRegisteredNames()}`
      );
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

    // No-op patch: when the merged definition is identical to the stored one
    // (ignoring the version/updatedAt bookkeeping), do not bump the version,
    // write, or emit a mutation hook.
    if (isDeepStrictEqual(definitionBody(existing), definitionBody(updated))) {
      logger.debug(
        { agentName: input.name, version: existing.version },
        'Agent update was a no-op; version unchanged'
      );
      return existing;
    }

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

  /**
   * Names-only roster for AGENT_NOT_FOUND (1b947d91 AC1): sorted, capped at
   * {@link AGENT_NOT_FOUND_NAME_CAP} with a "+N more" tail. Selects only the
   * `name` column so system prompts/definitions are never read or leaked.
   */
  private describeRegisteredNames(): string {
    const names = this.db
      .select({ name: agentsTable.name })
      .from(agentsTable)
      .all()
      .map((r) => r.name)
      .sort();
    if (names.length === 0) {
      return 'No agents are registered; call `agent_create` first.';
    }
    const shown = names.slice(0, AGENT_NOT_FOUND_NAME_CAP).join(', ');
    const more =
      names.length > AGENT_NOT_FOUND_NAME_CAP
        ? ` (+${names.length - AGENT_NOT_FOUND_NAME_CAP} more; use \`agent_list\` for the full roster)`
        : '';
    return `Registered agents: ${shown}${more}.`;
  }

  list(): AgentDefinition[] {
    const rows = this.db.select().from(agentsTable).all();
    return rows.map((row) =>
      agentDefinitionStoredSchema.parse(JSON.parse(row.data))
    );
  }
}
