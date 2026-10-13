import { HookRegistry, registerTaskEventHooks, type ITaskEventSink } from "@adhd/agent-engine-orchestrator";
import { registerEolPreserve } from "./eol-hook.js";
import { registerOpsLog, type ChannelSource } from "./ops-log.js";
import { registerToolResultNotes } from "./tool-result-notes.js";

/**
 * Build the host's hook registry with every always-on host hook registered. This is the host wiring seam:
 * `main()` obtains the registry the stores, plugins and engine share from here, so a host-level test can
 * drive the same registration the shipped server performs (20772a0b review-M1).
 *
 *  - ops log (`registerOpsLog`)
 *  - CRLF preservation across the adopted fs server's LF-normalizing writes (8dd148cf)
 *  - model-visible tool-result notes (R10 S4): the fs write/edit "no read-back needed" note and the shell
 *    policy-rejection recovery line, applied to the outgoing request only, never to history or hook payloads
 *  - task events: `budget:unpriced_model` and `provider:builtin_bypass` persisted via `taskStore`
 *    (20772a0b AC2/AC3)
 *
 * @param taskStore Where the typed task events are persisted (the host's `TaskStore`).
 * @param opsChannel Override of the ops log channel (tests); defaults to the initialised ops channel.
 */
export function createHostHooks(taskStore: ITaskEventSink, opsChannel?: ChannelSource): HookRegistry {
    const hooks = new HookRegistry();
    registerOpsLog(hooks, opsChannel);
    registerEolPreserve(hooks);
    registerToolResultNotes(hooks);
    registerTaskEventHooks(hooks, taskStore);
    return hooks;
}
