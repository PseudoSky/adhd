import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  messageProviderEchoTable,
  messagesTable,
  sessionBindingTable,
  sessionsTable,
} from '../db/schema.js';
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
import type {
  IHookRegistry,
  IProviderEcho,
  PartialBinding,
} from '@adhd/agent-base-types';

/** The `message_provider_echo.schema_v` this build reads; rows written by a newer format are ignored. */
export const ECHO_SCHEMA_VERSION = 1;
/** `message_id IN (...)` chunk size for {@link SessionStore.getMessageEchoes}. */
const ECHO_IN_CHUNK = 500;
/** Rows per immediate transaction in {@link SessionStore.sweepEchoes}. */
const ECHO_SWEEP_BATCH = 200;

/**
 * The ONE expiry rule for persisted tier S echo content (server-executed tool pairs): a session is expired when
 * it has been idle STRICTLY longer than the TTL, or when the TTL is not positive (`0` = never keep tier S).
 * A non-finite `idleMs` fails safe (expired). The reader ({@link SessionStore.getMessageEchoes}) and the
 * sweeper ({@link SessionStore.sweepEchoes}) both decide through this function, so they can never disagree.
 */
export function isEchoSessionExpired(idleMs: number, ttlMs: number): boolean {
  if (!(ttlMs > 0)) return true;
  return !(idleMs <= ttlMs);
}

/** Tier S = `server_tool_use` and every `*_tool_result` block (third-party bodies that expire). */
function isEchoServerBlock(block: Record<string, unknown>): boolean {
  const type = block['type'];
  return typeof type === 'string' && (type === 'server_tool_use' || type.endsWith('_tool_result'));
}

/**
 * Remove every tier S block (`server_tool_use` and every `*_tool_result`) from an echo's ordered blocks. Both
 * halves of a server tool pair are removed together, so what remains is still a valid Anthropic history. Pure.
 */
export function stripEchoServerBlocks(
  blocks: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return blocks.filter((block) => !isEchoServerBlock(block));
}

/** Parse a stored `blocks` column; `null` when it is not a JSON array of objects (a corrupt row). */
function parseEchoBlocks(raw: string): Array<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    for (const block of parsed) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
    }
    return parsed as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

let echoFailureWarned = false;

/**
 * Echo persistence is best-effort: the first failure per process logs ONE warning (operation + error code, never
 * block content) and every later failure is silent, so a missing table, a locked database or a corrupt row can
 * never fail or spam a task. Callers fall back to legacy (echo-less) history.
 */
function warnEchoFailureOnce(op: string, err: unknown): void {
  if (echoFailureWarned) return;
  echoFailureWarned = true;
  const code =
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : undefined;
  const message =
    code !== undefined && code.startsWith('SQLITE_') && err instanceof Error ? err.message : undefined;
  logger.warn(
    { op, ...(code !== undefined ? { errorCode: code } : {}), ...(message !== undefined ? { errorMessage: message } : {}) },
    'provider echo persistence failed; continuing with legacy history'
  );
}

/** Test seam: re-arms the once-per-process echo failure warning. */
export function resetEchoFailureWarningForTests(): void {
  echoFailureWarned = false;
}

/** Result of {@link SessionStore.sweepEchoes}. */
export interface IEchoSweepResult {
  /** Rows whose tier S content was removed (a row left with no blocks is deleted and counted here). */
  stripped: number;
  /** Rows whose message no longer exists (the `foreign_keys=OFF` / old-binary backstop). */
  orphansDeleted: number;
  /** Unparseable rows, which no reader can use; removed so a sweep never wedges on them. */
  corruptDeleted: number;
}

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

        // R9-hist: the session's persisted provider echo goes in the SAME immediate transaction, explicitly, so the
        // purge holds with `foreign_keys=OFF` (where the FK cascade is inert). A database that has not applied
        // migration 0017 has no table to purge; any other failure still fails the clear.
        const echoTable = tx.get<{ n: number }>(
          sql`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'message_provider_echo'`
        );
        if (echoTable !== undefined) {
          tx.delete(messageProviderEchoTable)
            .where(eq(messageProviderEchoTable.sessionId, sessionId))
            .run();
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

  /**
   * Persist the provider echo of one assistant message (R9-hist). A single keyed INSERT, never a
   * read-modify-write (ADR-0001/0012): a second append for the same message id is a no-op, so concurrent
   * processes converge. `bytes` is the length of the serialised `blocks`; `serverBytes` the tier S part of it.
   * Best-effort: a storage failure (missing table, locked database) logs one warning per process and returns.
   */
  appendMessageEcho(
    messageId: string,
    sessionId: string,
    echo: IProviderEcho,
    bytes: number,
    serverBytes: number
  ): void {
    if (
      !Number.isInteger(bytes) ||
      !Number.isInteger(serverBytes) ||
      bytes < 0 ||
      serverBytes < 0 ||
      serverBytes > bytes
    ) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Invalid echo sizes: bytes=${String(bytes)} serverBytes=${String(serverBytes)}`
      );
    }
    try {
      this.db
        .insert(messageProviderEchoTable)
        .values({
          messageId,
          sessionId,
          provider: echo.provider,
          model: echo.model,
          schemaV: ECHO_SCHEMA_VERSION,
          blocks: JSON.stringify(echo.blocks),
          bytes,
          serverBytes,
          createdAt: nowIso(),
        })
        .onConflictDoNothing()
        .run();
    } catch (err) {
      warnEchoFailureOnce('appendMessageEcho', err);
    }
  }

  /**
   * Load the persisted echoes for exactly the given assistant message ids (never "all of the session"; the
   * lookup is `message_id IN (...)` in chunks of 500). Pure read: no writes.
   *
   * Tier S expiry is all-or-nothing per session: when {@link isEchoSessionExpired}(`idleMs`, `ttlMs`) holds, EVERY
   * returned echo has its tier S blocks stripped in memory (correctness never depends on the sweeper); otherwise
   * every echo is returned whole. `idleMs` is the session's idle time computed by the caller from the messages it
   * loaded BEFORE appending the new prompt. Rows with `schema_v` above {@link ECHO_SCHEMA_VERSION}, another
   * provider, corrupt blocks, or nothing left after the strip are omitted (that message replays as legacy).
   * Best-effort: a storage failure logs one warning per process and yields an empty map.
   */
  getMessageEchoes(
    sessionId: string,
    messageIds: readonly string[],
    idleMs: number,
    ttlMs: number
  ): Map<string, IProviderEcho> {
    const out = new Map<string, IProviderEcho>();
    if (messageIds.length === 0) return out;
    try {
      const expired = isEchoSessionExpired(idleMs, ttlMs);
      const ids = [...new Set(messageIds)];
      let corrupt = 0;
      for (let i = 0; i < ids.length; i += ECHO_IN_CHUNK) {
        const rows = this.db
          .select()
          .from(messageProviderEchoTable)
          .where(
            and(
              eq(messageProviderEchoTable.sessionId, sessionId),
              inArray(messageProviderEchoTable.messageId, ids.slice(i, i + ECHO_IN_CHUNK))
            )
          )
          .all();
        for (const row of rows) {
          if (row.schemaV > ECHO_SCHEMA_VERSION || row.provider !== 'anthropic') continue;
          const blocks = parseEchoBlocks(row.blocks);
          if (blocks === null) {
            corrupt += 1;
            continue;
          }
          const kept = expired ? stripEchoServerBlocks(blocks) : blocks;
          if (kept.length === 0) continue;
          out.set(row.messageId, { provider: 'anthropic', model: row.model, blocks: kept });
        }
      }
      if (corrupt > 0) warnEchoFailureOnce('getMessageEchoes', new Error('corrupt echo row'));
      return out;
    } catch (err) {
      warnEchoFailureOnce('getMessageEchoes', err);
      return new Map();
    }
  }

  /** Tier S bytes currently persisted for a session (`SUM(server_bytes)`), for the soft per-session cap. 0 on failure. */
  getEchoSessionServerBytes(sessionId: string): number {
    try {
      const row = this.db
        .select({ total: sql<number>`coalesce(sum(${messageProviderEchoTable.serverBytes}), 0)` })
        .from(messageProviderEchoTable)
        .where(eq(messageProviderEchoTable.sessionId, sessionId))
        .get();
      return Number(row?.total ?? 0);
    } catch (err) {
      warnEchoFailureOnce('getEchoSessionServerBytes', err);
      return 0;
    }
  }

  /**
   * Reclaim persisted echo storage (R9-hist). Idempotent and convergent under concurrent sweepers (ADR-0012):
   *  1. DELETE orphans (`message_id` no longer in `messages`): the `foreign_keys=OFF` / old-binary backstop.
   *  2. Strip tier S from every row of a session that is expired by the SAME rule the reader uses
   *     ({@link isEchoSessionExpired}, `nowMs` minus the session's latest message `created_at`). The idle test is
   *     re-evaluated inside each guarded UPDATE, so a session another process is actively using is never touched.
   *  3. DELETE rows whose `blocks` cannot be parsed (no reader can use them).
   * Batches of 200 rows, one `BEGIN IMMEDIATE` transaction each. `ttlMs <= 0` strips all tier S. Never call this on
   * the request path of a model call. Best-effort: a failure logs one warning per process and returns zeros.
   */
  sweepEchoes(nowMs: number, ttlMs: number): IEchoSweepResult {
    const result: IEchoSweepResult = { stripped: 0, orphansDeleted: 0, corruptDeleted: 0 };
    try {
      for (;;) {
        const deleted = this.db.transaction(
          (tx) =>
            tx.run(sql`
              DELETE FROM message_provider_echo WHERE message_id IN (
                SELECT e.message_id FROM message_provider_echo e
                WHERE e.message_id NOT IN (SELECT id FROM messages) LIMIT ${ECHO_SWEEP_BATCH})`).changes,
          { behavior: 'immediate' }
        );
        result.orphansDeleted += deleted;
        if (deleted < ECHO_SWEEP_BATCH) break;
      }

      const cutoffIso = ttlMs > 0 ? new Date(nowMs - ttlMs).toISOString() : null;
      const lastActivity = (alias: string) =>
        sql.raw(`(SELECT max(m.created_at) FROM messages m WHERE m.session_id = ${alias}.session_id)`);
      for (;;) {
        const progressed = this.db.transaction(
          (tx) => {
            const idleClause =
              cutoffIso === null ? sql`1 = 1` : sql`${lastActivity('e')} < ${cutoffIso}`;
            const candidates = tx.all<{
              messageId: string;
              blocks: string;
              lastActivity: string | null;
            }>(sql`
              SELECT e.message_id AS messageId, e.blocks AS blocks, ${lastActivity('e')} AS lastActivity
              FROM message_provider_echo e
              WHERE e.server_bytes > 0 AND ${idleClause}
              LIMIT ${ECHO_SWEEP_BATCH}`);
            let changed = 0;
            for (const row of candidates) {
              const guard =
                cutoffIso === null ? sql`1 = 1` : sql`${lastActivity('message_provider_echo')} < ${cutoffIso}`;
              const idleMs =
                row.lastActivity === null ? Number.POSITIVE_INFINITY : nowMs - Date.parse(row.lastActivity);
              if (!isEchoSessionExpired(idleMs, ttlMs)) continue;
              const blocks = parseEchoBlocks(row.blocks);
              if (blocks === null) {
                const removed = tx.run(sql`
                  DELETE FROM message_provider_echo
                  WHERE message_id = ${row.messageId} AND server_bytes > 0 AND ${guard}`).changes;
                result.corruptDeleted += removed;
                changed += removed;
                continue;
              }
              const kept = stripEchoServerBlocks(blocks);
              const update =
                kept.length === 0
                  ? tx.run(sql`
                      DELETE FROM message_provider_echo
                      WHERE message_id = ${row.messageId} AND server_bytes > 0 AND ${guard}`)
                  : tx.run(sql`
                      UPDATE message_provider_echo
                      SET blocks = ${JSON.stringify(kept)}, bytes = ${Buffer.byteLength(JSON.stringify(kept))}, server_bytes = 0
                      WHERE message_id = ${row.messageId} AND server_bytes > 0 AND ${guard}`);
              result.stripped += update.changes;
              changed += update.changes;
            }
            return changed;
          },
          { behavior: 'immediate' }
        );
        if (progressed === 0) break;
      }
      return result;
    } catch (err) {
      warnEchoFailureOnce('sweepEchoes', err);
      return result;
    }
  }

  /**
   * Drop every persisted echo of a session (the self-heal after a provider rejected replayed echoes, so later
   * tasks do not each burn a failing request). Returns the number of rows removed; 0 on failure.
   */
  deleteMessageEchoes(sessionId: string): number {
    try {
      return this.db
        .delete(messageProviderEchoTable)
        .where(eq(messageProviderEchoTable.sessionId, sessionId))
        .run().changes;
    } catch (err) {
      warnEchoFailureOnce('deleteMessageEchoes', err);
      return 0;
    }
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
