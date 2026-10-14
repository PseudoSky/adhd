/**
 * tool-result-notes.ts — short factual notes the host adds to what the MODEL sees of two kinds of
 * tool result (R10 S4, P3 and P4), without ever changing what is stored or what embedders observe.
 *
 *  - P3: after a successful write/edit by the adopted (catalog) fs server, "the file was written; there
 *    is no need to read it back to verify". Claude Code's Edit/Write results say the same; without it a
 *    worker spends a round re-reading what it just wrote.
 *  - P4: after the adopted shell server rejects a command by its default security policy, a recovery line
 *    that says what to do instead (the fs tools; the project's own scripts through an allowed runner). The
 *    runners it names come from the agent's RESOLVED shell server (cafe9a17 AC1); a custom shell server or an
 *    unreadable config names none.
 *
 * Delivery is model-visible ONLY, by construction:
 *
 *  1. `post:tool_call` (observational) DECIDES: it sees the call's input, the raw result and the error flag,
 *     records `callId -> note` and sets `payload.noteAppended` (trace signal). It does not touch the result.
 *  2. An ENFORCEMENT handler on `pre:model_request` APPLIES. The engine hands enforcement handlers a COPY of
 *     the history array (never its live `currentMessages`) and sends the provider whatever that copy holds
 *     afterwards, so the handler replaces the affected message ELEMENT of the copy with a message that
 *     carries the note. Nothing else ever sees a note: the original message objects (the ones the session
 *     store persisted and `message:appended` delivered), the history array, the observational
 *     `pre:model_request` payload (tracing, ops log, the compaction summariser) and the engine's
 *     `toolResultBytesIn` all stay byte-identical to what the tool returned, on every turn, including the
 *     turns after the call. The next request re-applies the same note to a fresh copy, so the request
 *     prefix stays stable. A `pause_turn` continuation is enforced on a throwaway copy, so it cannot reach
 *     the history either.
 *
 * `transform:tool_result` is deliberately NOT used: the orchestrator persists its output into the session
 * history, which is exactly what these notes must stay out of.
 *
 * claudecli: its tools run inside the CLI's own loop and come back through the engine's bridge as
 * `executeTool` returns; the result the CLI streams back is what the engine persists as that turn's
 * `toolResults`. A note added there would land in the history, and the history's CLI tool results are never
 * `role: 'tool'` messages the request copy could carry a note on, so a claudecli call gets no note and
 * `noteAppended` stays unset for it (the trace must not claim a delivery that cannot happen).
 *
 * `noteAppended` is written by the `post:tool_call` handler on the shared payload object, so a plugin that
 * reads it from its own `post:tool_call` handler sees it only if this module's handler ran first, i.e. the
 * host hooks must be registered on the registry before that plugin (`createHostHooks` runs before
 * `loadDefaultPlugins`; `r10-s4-notes-history.test.ts` pins both sides of it). The registry has no handler priority, so the
 * order is the only mechanism there is.
 *
 * Gates (a note is never added when any of these fails):
 *  - fs: the tool is `fs__write_file`/`fs__edit_file`, the result is not an error, the call is not a
 *    `dryRun` (a dry run applies nothing; "[applied]" would be false), and the agent's `fs` server is the
 *    ADOPTED catalog server (its launch carries the pinned server bin). A user server that merely happens
 *    to be named `fs` has unknown semantics and gets no note.
 *  - shell: the tool is `shell__shell_execute` and the error text carries the adopted server's exact
 *    policy-rejection marker. Any other result, including other errors, is untouched.
 *
 * Process-local state is a bounded map (oldest evicted first), kept for the life of the process so a later
 * task that reloads the same session history re-applies the same note and the request prefix stays stable.
 * It holds no data a second process needs: a process that never saw the call (a resumed session elsewhere)
 * simply sends the tool result without the note, which is safe (ADR-0012: no shared mutable state).
 */
import type {
  ExecutionContext,
  IHookRegistry,
  Message,
  PostToolCallPayload,
  PreModelRequestPayload,
} from '@adhd/agent-base-types';
import { resolveFsServerLaunch } from '@adhd/agent-core-native-tooling';
import { selectionOf, shellRejectionNote } from '@adhd/agent-engine-orchestrator';

/** Note for a successful `fs__write_file`. Plain ASCII, factual, no instruction beyond not re-reading. */
export const FS_WRITE_NOTE = '[Note: the file was written; there is no need to read it back to verify.]';
/** Note for a successful, non-dry-run `fs__edit_file`. */
export const FS_EDIT_NOTE = '[Note: the edit was applied; there is no need to read the file back to verify.]';

/** The adopted shell server's policy-rejection marker (see `default-shell-allowlist.e2e.test.ts`). */
export const SHELL_POLICY_REJECTION = /Command rejected by default security policy(?::\s*([A-Za-z0-9_./+-]+))?/;

/** Default cap on remembered `callId -> note` entries. */
export const NOTE_MAX_ENTRIES = 4096;

/** Tunables and test seams for {@link registerToolResultNotes}. All optional. */
export interface IToolResultNotesOptions {
  /** Max remembered notes (default {@link NOTE_MAX_ENTRIES}); the oldest is evicted first. */
  maxEntries?: number;
  /**
   * True when the context's `fs` server is the adopted catalog server. Default: the agent's resolved
   * `mcpServers.fs` launches the pinned catalog bin ({@link isCatalogFsServer}). Test seam.
   */
  isCatalogFs?: (executionContext: ExecutionContext) => boolean;
}

/** Handle returned by {@link registerToolResultNotes}. */
export interface IToolResultNotesHandle {
  /** Number of `callId -> note` entries currently remembered. */
  size(): number;
}

/**
 * True when the call ran over the claudecli bridge, where a note cannot reach the model (see the module
 * header). Fails open (false) when the context's provider cannot be resolved: the engine always resolves it.
 */
function isBridgedProvider(executionContext: ExecutionContext): boolean {
  try {
    return selectionOf(executionContext).providerType === 'claudecli';
  } catch {
    return false;
  }
}

let catalogFsBin: string | null | undefined;

/** The pinned catalog fs server bin path, or `null` when it cannot be resolved (then no fs note is ever added). */
function pinnedFsBin(): string | null {
  if (catalogFsBin === undefined) {
    try {
      catalogFsBin = resolveFsServerLaunch().args[0] ?? null;
    } catch {
      catalogFsBin = null;
    }
  }
  return catalogFsBin;
}

/**
 * True when the agent's resolved `fs` server is the ADOPTED catalog server: a stdio server whose command or
 * argv (also under the `srt` sandbox wrapper) carries the pinned server bin the catalog resolves. A custom
 * `mcpServers.fs` replaces the builtin and does not carry it. Fails closed (false) on any resolution error.
 */
export function isCatalogFsServer(executionContext: ExecutionContext): boolean {
  try {
    const bin = pinnedFsBin();
    if (bin === null) return false;
    const cfg = executionContext.agentDefinition?.mcpServers?.['fs'];
    if (cfg?.transport !== 'stdio') return false;
    return [cfg.command, ...(cfg.args ?? [])].includes(bin);
  } catch {
    return false;
  }
}

/** True unless the call asks for a preview: `dryRun` true/"true" (or anything not clearly false) applies nothing. */
function isApplied(toolInput: unknown): boolean {
  if (toolInput === null || typeof toolInput !== 'object') return true;
  const d = (toolInput as { dryRun?: unknown }).dryRun;
  return d === undefined || d === null || d === false || d === 'false';
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return '';
  }
}

interface ITextBlock {
  type: 'text';
  text: string;
}
const isTextBlock = (b: unknown): b is ITextBlock =>
  b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string';

/**
 * Return `result` with `note` appended as a trailing text part, or `undefined` when the result has a shape
 * a note cannot be added to without guessing (then no note is added at all). Idempotent: a result that
 * already ends with the note is returned as `undefined` too ("nothing to do"). Never mutates `result`.
 */
export function withNote(result: unknown, note: string): unknown | undefined {
  if (typeof result === 'string') {
    return result.endsWith(note) ? undefined : `${result}\n\n${note}`;
  }
  if (Array.isArray(result)) {
    const last = result[result.length - 1];
    if (isTextBlock(last) && last.text === note) return undefined;
    return result.every((b) => b !== null && typeof b === 'object')
      ? [...result, { type: 'text', text: note } satisfies ITextBlock]
      : undefined;
  }
  if (result !== null && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const next = withNote(content, note);
      return next === undefined ? undefined : { ...(result as object), content: next };
    }
  }
  return undefined;
}

/** True when `result` can carry a note (a string, a content array, or an object with a content array). */
function canCarryNote(result: unknown): boolean {
  return withNote(result, '\u0000probe') !== undefined;
}

/** The note a finished call earns, or `undefined`. Pure; the gates are documented on the module. */
export function noteFor(
  payload: Pick<PostToolCallPayload, 'executionContext' | 'toolName' | 'toolInput' | 'result' | 'isError'>,
  isCatalogFs: (executionContext: ExecutionContext) => boolean = isCatalogFsServer
): string | undefined {
  const { toolName, toolInput, result, isError, executionContext } = payload;
  if (toolName === 'fs__write_file' || toolName === 'fs__edit_file') {
    if (isError || !isApplied(toolInput) || !isCatalogFs(executionContext)) return undefined;
    return toolName === 'fs__write_file' ? FS_WRITE_NOTE : FS_EDIT_NOTE;
  }
  if (toolName === 'shell__shell_execute' && isError) {
    const m = SHELL_POLICY_REJECTION.exec(resultText(result));
    if (!m) return undefined;
    // cafe9a17 AC1: runners are named from THIS agent's resolved shell server, never the catalog defaults.
    return `[Note: ${shellRejectionNote(m[1], executionContext?.agentDefinition?.mcpServers)}]`;
  }
  return undefined;
}

/**
 * Apply the remembered notes to the tool-result messages of `messages` by element replacement only. `messages`
 * MUST be the engine's per-request COPY of the history array (the `pre:model_request` enforcement payload),
 * never the live history: this replaces elements of the array it is given and never mutates a message object.
 */
function applyNotes(messages: Message[], notes: ReadonlyMap<string, string>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || !m.toolResults?.length) continue;
    let changed = false;
    const toolResults = m.toolResults.map((tr) => {
      const note = notes.get(tr.toolCallId);
      if (note === undefined) return tr;
      const next = withNote(tr.result, note);
      if (next === undefined) return tr;
      changed = true;
      return { ...tr, result: next };
    });
    if (changed) messages[i] = { ...m, toolResults };
  }
}

/**
 * Register the P3/P4 note hooks on `hooks`. See the module header for the delivery contract.
 *
 * @returns A handle exposing the number of remembered notes (tests, diagnostics).
 */
export function registerToolResultNotes(
  hooks: IHookRegistry,
  options: IToolResultNotesOptions = {}
): IToolResultNotesHandle {
  const maxEntries = Math.max(1, options.maxEntries ?? NOTE_MAX_ENTRIES);
  const isCatalogFs = options.isCatalogFs ?? isCatalogFsServer;
  /** callId -> note; Map iteration is insertion order, so the oldest entry is first. */
  const notes = new Map<string, string>();

  hooks.register('post:tool_call', (p) => {
    try {
      if (isBridgedProvider(p.executionContext)) return;
      const note = noteFor(p, isCatalogFs);
      if (note === undefined || !canCarryNote(p.result)) return;
      notes.delete(p.callId);
      while (notes.size >= maxEntries) {
        const oldest = notes.keys().next();
        if (oldest.done) break;
        notes.delete(oldest.value);
      }
      notes.set(p.callId, note);
      p.noteAppended = true;
    } catch {
      // fail-open: a note is a courtesy and must never affect the call
    }
  });

  hooks.registerEnforcement('pre:model_request', (p: PreModelRequestPayload) => {
    if (notes.size === 0) return;
    try {
      applyNotes(p.messages, notes);
    } catch {
      // fail-open: never block a model request over a note
    }
  });

  return { size: () => notes.size };
}
