import type {
    AgentCreateInput,
    AgentDefinition,
    AgentDeleteInput,
    AgentListInput,
    AgentReadInput,
    AgentUpdateInput,
} from "../validation/index.js";

/**
 * The one multi-KB field that must never be dumped unless explicitly requested.
 * See the acceptance criterion "MCP tools may not dump full records of system
 * prompts for agents — a full record must be EXPLICITLY requested".
 */
const AGENT_PROMPT_FIELD = 'systemPrompt' as const;

/** Projection options accepted by `agent_read` / `agent_list`. */
export interface AgentProjectionOptions {
    /** Return the full record, `systemPrompt` included. Default: false. */
    full?: boolean;
    /**
     * Whitelist of fields to return (plus `name`, always kept). Naming
     * `systemPrompt` here is the alternative explicit opt-in for the body.
     */
    fields?: readonly string[];
}

/**
 * Project an agent definition for an MCP response.
 *
 * - default (no options): every field EXCEPT `systemPrompt` — the prompt body
 *   is omitted, so an unrequested read never returns the multi-KB record.
 * - `full: true`: the full record, `systemPrompt` included.
 * - `fields: [...]`: only those fields (plus `name`); `fields: ['systemPrompt']`
 *   is the explicit opt-in for the body.
 *
 * Pure — exported for tests.
 */
export function projectAgentRecord<T extends Record<string, unknown>>(
    record: T,
    opts: AgentProjectionOptions = {}
): Record<string, unknown> {
    if (opts.fields && opts.fields.length > 0) {
        const out: Record<string, unknown> = {};
        if ('name' in record) out['name'] = record['name'];
        for (const field of opts.fields) {
            if (field === 'name') continue;
            if (field in record) out[field] = record[field];
        }
        return out;
    }
    if (opts.full) {
        return { ...record };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (key === AGENT_PROMPT_FIELD) continue;
        out[key] = value;
    }
    return out;
}

export interface AgentStore {
    create(input: AgentCreateInput): AgentDefinition;
    read(name: string): AgentDefinition;
    update(input: AgentUpdateInput): AgentDefinition;
    delete(name: string): void;
    list(): AgentDefinition[];
}

export interface SessionStoreForCrud {
    list(filter: { agentName: string; status: string }): Array<{ id: string }>;
    close(sessionId: string): void;
}

export interface AgentCrudDeps {
    agentStore: AgentStore;
    sessionStore: SessionStoreForCrud;
}

/**
 * The projected agent record returned by the MCP CRUD read surface. Every
 * `AgentDefinition` field is present except that `systemPrompt` is omitted
 * unless explicitly requested — the shape is dynamic (a `fields[]` projection
 * can narrow it), so callers must treat it as an opaque record and read only
 * the fields they asked for.
 */
export type AgentRecord = Record<string, unknown>;

export function agentCreate(input: AgentCreateInput, deps: AgentCrudDeps): AgentRecord {
    return projectAgentRecord(
        deps.agentStore.create(input) as unknown as Record<string, unknown>
    );
}

export function agentRead(input: AgentReadInput, deps: AgentCrudDeps): AgentRecord {
    const definition = deps.agentStore.read(input.name);
    return projectAgentRecord(
        definition as unknown as Record<string, unknown>,
        input
    );
}

/**
 * The `agent_update` result: the updated definition PLUS the ids of every
 * currently-ACTIVE session on that agent that will NOT receive this update.
 *
 * A session snapshots its agent definition at creation (documented, intended),
 * so an update silently never reaches already-open sessions — the operator only
 * discovers it later when a retry on the old `session_id` reproduces the exact
 * failure they just fixed (backlog 301f040a). Surfacing the open session ids
 * on the update response makes that visible up front: close/reopen the listed
 * sessions (or open fresh ones) to pick up the new definition.
 */
export type AgentUpdateResult = AgentRecord & {
    openSessionsNotUpdated: string[];
};

export function agentUpdate(input: AgentUpdateInput, deps: AgentCrudDeps): AgentUpdateResult {
    const updated = deps.agentStore.update(input);

    // Read AFTER the write: any session active at this point was created from
    // the pre-update snapshot, so it will keep running on the old definition.
    const openSessions = deps.sessionStore.list({
        agentName: input.name,
        status: "active",
    });

    return {
        ...projectAgentRecord(updated as unknown as Record<string, unknown>),
        openSessionsNotUpdated: openSessions.map((s) => s.id),
    };
}

export function agentDelete(input: AgentDeleteInput, deps: AgentCrudDeps): { success: true } {
    if (input.force) {
        const activeSessions = deps.sessionStore.list({ agentName: input.name, status: "active" });
        for (const session of activeSessions) {
            try {
                deps.sessionStore.close(session.id);
            } catch {
                // Already closed in a race — ignore
            }
        }
    }
    deps.agentStore.delete(input.name);
    return { success: true };
}

/**
 * List agents, projected. By default every returned record omits
 * `systemPrompt`; pass `full: true` (or `fields: ['systemPrompt']`) to opt in.
 */
export function agentList(
    input: AgentListInput | undefined,
    deps: AgentCrudDeps
): AgentRecord[] {
    const opts = input ?? {};
    return deps.agentStore
        .list()
        .map((definition) =>
            projectAgentRecord(
                definition as unknown as Record<string, unknown>,
                opts
            )
        );
}
