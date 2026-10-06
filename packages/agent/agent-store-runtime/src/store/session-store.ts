import { and, eq, ne } from 'drizzle-orm';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { messagesTable, sessionBindingTable, sessionsTable } from '../db/schema.js';
import { logger } from '../logger.js';
import type {
  AgentDefinition,
  Message,
  Session,
} from '../validation/schemas.js';
import {
  agentDefinitionStoredSchema,
  sessionSchema,
} from '../validation/schemas.js';
import type { SessionListInput } from '../validation/schemas.js';
import { ToolError } from '../validation/errors.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';
import type { IHookRegistry, PartialBinding } from '@adhd/agent-base-types';

const PROVIDER_TYPES = new Set(['anthropic', 'openai', 'claudecli']);

export class SessionStore {
  constructor(
    private readonly db: BetterSQLite3Database<Record<string, never>>,
    private readonly hooks?: IHookRegistry
  ) {}

  create(input: {
    agentName: string;
    agentDefinition: AgentDefinition;
    composedPromptId?: string;
    /** Initial session-held provider binding (providerType / modelRef / models). */
    binding?: PartialBinding;
  }): Session {
    const now = nowIso();
    const id = generateId();

    this.db
      .insert(sessionsTable)
      .values({
        id,
        agentName: input.agentName,
        agentVersion: input.agentDefinition.version,
        agentData: JSON.stringify(input.agentDefinition),
        status: 'active',
        createdAt: now,
        updatedAt: now,
        composedPromptId: input.composedPromptId ?? null,
      })
      .run();

    if (input.binding !== undefined && Object.keys(input.binding).length > 0) {
      this.updateSelection(id, input.binding);
    }

    logger.info(
      { sessionId: id, agentName: input.agentName },
      'Session created'
    );

    const session = this.read(id);
    void this.hooks?.emit('session:created', { session });
    return session;
  }

  read(id: string): Session {
    const row = this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, id))
      .get();

    if (!row) {
      throw new ToolError('SESSION_NOT_FOUND', `Session '${id}' not found`);
    }

    return sessionSchema.parse({
      id: row.id,
      agentName: row.agentName,
      agentVersion: row.agentVersion,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt ?? undefined,
    });
  }

  getAgentDefinition(sessionId: string): AgentDefinition {
    const row = this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();

    if (!row) {
      throw new ToolError(
        'SESSION_NOT_FOUND',
        `Session '${sessionId}' not found`
      );
    }

    return agentDefinitionStoredSchema.parse(JSON.parse(row.agentData)) as AgentDefinition;
  }

  /**
   * The session-held provider binding — the `session` tier of the selection
   * chain `task ?? session ?? agent ?? global` — or `null` when the session
   * holds none. Persisted, so it survives a host restart.
   */
  getSelection(sessionId: string): PartialBinding | null {
    this.read(sessionId); // SESSION_NOT_FOUND for an absent session
    // An unmigrated `sessions` table (no 0011 columns) raises here by design
    // (aafd6561 AC-e / ADR-0002 D1): the caller must migrate, not get a null.
    const row = this.db
      .select()
      .from(sessionBindingTable)
      .where(eq(sessionBindingTable.id, sessionId))
      .get();
    if (!row) return null;
    const binding: PartialBinding = {};
    if (row.providerType !== null) {
      binding.providerType = row.providerType as PartialBinding['providerType'];
    }
    if (row.modelRef !== null) binding.modelRef = row.modelRef;
    if (row.models !== null) binding.models = JSON.parse(row.models) as string[];
    return Object.keys(binding).length > 0 ? binding : null;
  }

  /**
   * Swap the session-held binding. Only the fields supplied are written
   * (`providerType`, `modelRef`, `models`); the rest of the binding is left as
   * is. The read-validate-write runs in one `BEGIN IMMEDIATE` transaction
   * (ADR-0001 D3) so concurrent processes never interleave a half-update.
   * Throws `SESSION_NOT_FOUND` / `SESSION_CLOSED` / `VALIDATION_ERROR`.
   */
  updateSelection(sessionId: string, binding: PartialBinding): PartialBinding | null {
    if (
      binding.providerType !== undefined &&
      !PROVIDER_TYPES.has(binding.providerType)
    ) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Unknown providerType '${String(binding.providerType)}'; expected one of ${[...PROVIDER_TYPES].join(', ')}`
      );
    }
    this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.id, sessionId))
          .get();
        if (!row) {
          throw new ToolError('SESSION_NOT_FOUND', `Session '${sessionId}' not found`);
        }
        if (row.status === 'closed') {
          throw new ToolError('SESSION_CLOSED', `Session '${sessionId}' is closed`);
        }
        const set: Partial<typeof sessionBindingTable.$inferInsert> = {};
        if (binding.providerType !== undefined) set.providerType = binding.providerType;
        if (binding.modelRef !== undefined) set.modelRef = binding.modelRef;
        if (binding.models !== undefined) set.models = JSON.stringify(binding.models);
        if (Object.keys(set).length > 0) {
          tx.update(sessionBindingTable).set(set).where(eq(sessionBindingTable.id, sessionId)).run();
        }
        tx.update(sessionsTable).set({ updatedAt: nowIso() }).where(eq(sessionsTable.id, sessionId)).run();
      },
      { behavior: 'immediate' }
    );
    logger.info({ sessionId }, 'Session selection updated');
    return this.getSelection(sessionId);
  }

  list(input: SessionListInput): Session[] {
    const conditions = [];

    if (input.agentName) {
      conditions.push(eq(sessionsTable.agentName, input.agentName));
    }

    if (input.status) {
      conditions.push(eq(sessionsTable.status, input.status));
    }

    const rows =
      conditions.length > 0
        ? this.db
            .select()
            .from(sessionsTable)
            .where(and(...conditions))
            .all()
        : this.db.select().from(sessionsTable).all();

    return rows.map((row) =>
      sessionSchema.parse({
        id: row.id,
        agentName: row.agentName,
        agentVersion: row.agentVersion,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        closedAt: row.closedAt ?? undefined,
      })
    );
  }

  /**
   * Close a session.
   *
   * The leading `read()` exists only to preserve `SESSION_NOT_FOUND` for a
   * truly-absent session — a bare conditional UPDATE cannot distinguish
   * "absent" from "already closed". The authoritative transition is the
   * single UPDATE below: `WHERE id = ? AND status != 'closed'` folds the
   * "already closed" guard into the same statement as the write, so of two
   * concurrent closers exactly one observes a returned row and the other
   * reliably raises `SESSION_CLOSED` — `closedAt` is written at most once.
   */
  close(id: string): Session {
    this.read(id);

    const now = nowIso();
    const closed: typeof sessionsTable.$inferSelect | undefined = this.db
      .update(sessionsTable)
      .set({
        status: 'closed',
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(sessionsTable.id, id), ne(sessionsTable.status, 'closed')))
      .returning()
      .get();

    if (closed === undefined) {
      throw new ToolError(
        'SESSION_CLOSED',
        `Session '${id}' is already closed`
      );
    }

    logger.info({ sessionId: id }, 'Session closed');
    const session = this.read(id);
    // Observational (TRACE-2, f376e27a): fire-and-forget like `session:created`;
    // a throwing/rejecting registry can never change close()'s outcome.
    try {
      void Promise.resolve(this.hooks?.emit('session:closed', { session })).catch(
        (err: unknown) => {
          logger.warn({ sessionId: id, err }, 'session:closed hook emit failed (ignored)');
        }
      );
    } catch (err) {
      logger.warn({ sessionId: id, err }, 'session:closed hook emit failed (ignored)');
    }
    return session;
  }

  /**
   * Clear a session's message history.
   *
   * The leading `read()` preserves `SESSION_NOT_FOUND`; the authoritative
   * status guard then re-runs *inside* the same transaction as the DELETE.
   * `behavior: 'immediate'` (`BEGIN IMMEDIATE`) takes SQLite's write lock at
   * BEGIN rather than deferring it to the first write, so a concurrent
   * `close()` cannot commit between the guard and the delete — the two can
   * never interleave, and a closed session's context cannot be cleared.
   */
  clearMessages(sessionId: string): number {
    this.read(sessionId);

    const cleared = this.db.transaction(
      (tx) => {
        const row: { status: string } | undefined = tx
          .select({ status: sessionsTable.status })
          .from(sessionsTable)
          .where(eq(sessionsTable.id, sessionId))
          .get();

        if (row === undefined) {
          throw new ToolError(
            'SESSION_NOT_FOUND',
            `Session '${sessionId}' not found`
          );
        }

        if (row.status === 'closed') {
          throw new ToolError(
            'SESSION_CLOSED',
            `Session '${sessionId}' is closed; cannot clear context`
          );
        }

        const result = tx
          .delete(messagesTable)
          .where(eq(messagesTable.sessionId, sessionId))
          .run();

        return result.changes;
      },
      { behavior: 'immediate' }
    );

    logger.info({ sessionId, cleared }, 'Session context cleared');
    return cleared;
  }

  appendMessage(sessionId: string, message: Message): void {
    this.db
      .insert(messagesTable)
      .values({
        id: message.id,
        sessionId,
        role: message.role,
        content: message.content ?? null,
        toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        toolResults: message.toolResults
          ? JSON.stringify(message.toolResults)
          : null,
        createdAt: message.createdAt,
      })
      .run();
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .all();

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      role: row.role as Message['role'],
      content: row.content ?? undefined,
      toolCalls: row.toolCalls ? JSON.parse(row.toolCalls) : undefined,
      toolResults: row.toolResults ? JSON.parse(row.toolResults) : undefined,
      createdAt: row.createdAt,
    }));
  }
}

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => {
      return (
        sum +
        (m.content?.length ?? 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) +
        (m.toolResults ? JSON.stringify(m.toolResults).length : 0)
      );
    }, 0) / 4
  );
}

export function windowMessages(
  messages: Message[],
  tokenLimit: number
): Message[] {
  if (tokenLimit <= 0) return messages;
  if (estimateTokens(messages) <= tokenLimit) return messages;

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const systemBudget = estimateTokens(systemMessages);
  const remaining = Math.max(0, tokenLimit - systemBudget);

  const selected: Message[] = [];
  let used = 0;

  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const msg = nonSystemMessages[i];
    const cost = estimateTokens([msg]);
    if (used + cost > remaining && selected.length > 0) break;
    selected.unshift(msg);
    used += cost;
  }

  return [...systemMessages, ...selected];
}
