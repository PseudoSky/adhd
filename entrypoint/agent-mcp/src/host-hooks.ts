import { HookRegistry, registerTaskEventHooks, type ITaskEventSink } from "@adhd/agent-engine-orchestrator";
import { registerEolPreserve } from "./eol-hook.js";
import { registerOpsLog, type ChannelSource } from "./ops-log.js";

/**
 * Build the host's hook registry with every always-on host hook registered. This is the host wiring seam:
 * `main()` obtains the registry the stores, plugins and engine share from here, so a host-level test can
 * drive the same registration the shipped server performs (20772a0b review-M1).
 *
 *  - ops log (`registerOpsLog`)
 *  - CRLF preservation across the adopted fs server's LF-normalizing writes (8dd148cf)
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
    registerTaskEventHooks(hooks, taskStore);
    return hooks;
}
