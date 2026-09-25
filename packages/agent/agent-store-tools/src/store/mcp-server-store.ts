import { eq } from 'drizzle-orm';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { mcpServersTable } from '../db/schema.js';

// ──────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────

/**
 * An MCP server registration row.
 *
 * transport is one of: stdio | SSE | HTTP (plain text, not an enum).
 * providedToolIds is a JSON array of canonical tool names — logical references
 * resolved at compile time; no SQLite FK ([inv:no-cross-pkg-fk]).
 * configSchema is a JSON-Schema object for this server's configuration.
 */
export interface McpServer {
  id: string;
  transport: string;
  name: string;
  providedToolIds: string[];
  configSchema: Record<string, unknown>;
}

/** Input for registering an MCP server. */
export interface McpServerCreateInput {
  id: string;
  transport: string;
  name: string;
  providedToolIds?: string[];
  configSchema?: Record<string, unknown>;
}

// ──────────────────────────────────────────────
// Typed error codes
// ──────────────────────────────────────────────

export type McpServerStoreErrorCode =
  | 'MCP_SERVER_ALREADY_EXISTS'
  | 'MCP_SERVER_NOT_FOUND';

export class McpServerStoreError extends Error {
  constructor(public readonly code: McpServerStoreErrorCode, message: string) {
    super(message);
    this.name = 'McpServerStoreError';
  }
}

// ──────────────────────────────────────────────
// McpServerStore
//
// Thin Drizzle queries over mcp_servers.
// Mirrors the pattern in entrypoint/agent-mcp's AgentStore (agent-cache-store pattern).
// Constructor accepts a BetterSQLite3Database so tests can inject their own
// connection without touching the production singleton in client.ts.
// ──────────────────────────────────────────────

export class McpServerStore {
  constructor(
    private readonly db: BetterSQLite3Database<Record<string, never>>
  ) {}

  /**
   * Register an MCP server.
   *
   * Uniqueness is enforced by the `id` primary key, not a `SELECT` pre-check:
   * `onConflictDoNothing()` lets SQLite arbitrate a concurrent duplicate, and a
   * zero-row-changed result means the id was already registered — translated
   * into the documented `MCP_SERVER_ALREADY_EXISTS` so a racing second writer
   * can never surface the driver's raw `SqliteError` to the caller.
   *
   * @throws {McpServerStoreError} MCP_SERVER_ALREADY_EXISTS if the id PK
   *   already exists.
   */
  create(input: McpServerCreateInput): McpServer {
    const server: McpServer = {
      id: input.id,
      transport: input.transport,
      name: input.name,
      providedToolIds: input.providedToolIds ?? [],
      configSchema: input.configSchema ?? {},
    };

    const result = this.db
      .insert(mcpServersTable)
      .values({
        id: server.id,
        transport: server.transport,
        name: server.name,
        providedToolIds: server.providedToolIds,
        configSchema: server.configSchema,
      })
      .onConflictDoNothing()
      .run();

    if (result.changes === 0) {
      throw new McpServerStoreError(
        'MCP_SERVER_ALREADY_EXISTS',
        `MCP server '${input.id}' already exists`
      );
    }

    return server;
  }

  /**
   * Read an MCP server by id.
   * Throws MCP_SERVER_NOT_FOUND if absent.
   */
  read(id: string): McpServer {
    const row = this.db
      .select()
      .from(mcpServersTable)
      .where(eq(mcpServersTable.id, id))
      .get();

    if (!row) {
      throw new McpServerStoreError(
        'MCP_SERVER_NOT_FOUND',
        `MCP server '${id}' not found`
      );
    }

    return {
      id: row.id,
      transport: row.transport,
      name: row.name,
      providedToolIds: row.providedToolIds as string[],
      configSchema: row.configSchema as Record<string, unknown>,
    };
  }

  /** List all registered MCP servers. */
  list(): McpServer[] {
    const rows = this.db.select().from(mcpServersTable).all();
    return rows.map((row) => ({
      id: row.id,
      transport: row.transport,
      name: row.name,
      providedToolIds: row.providedToolIds as string[],
      configSchema: row.configSchema as Record<string, unknown>,
    }));
  }
}
