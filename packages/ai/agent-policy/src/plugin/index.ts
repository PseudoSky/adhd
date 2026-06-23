/**
 * @adhd/agent-policy enforcement plugin.
 *
 * Mirrors @adhd/agent-mcp-budget exactly in plugin shape:
 *   - exports configSchema (zod)
 *   - exports createPlugin (named) + default createPlugin
 *   - install() registers observational handlers (try/caught) AND one
 *     hooks.registerEnforcement("pre:model_request", ...) with NO try/catch
 *     so the throw propagates to the orchestrator.
 *
 * Enforcement scope: `rate`-type policies — enforces maxModelCalls per task.
 * EnforcementEvent is "pre:model_request"-ONLY (decisions.md Decision 2).
 */

import { z } from "zod";
import type {
    IHookRegistry,
    Plugin,
    PluginContext,
    PluginFactory,
    PreModelRequestPayload,
    PostModelResponsePayload,
    TaskStartPayload,
} from "@adhd/agent-mcp-types";
import { evaluateRatePolicy } from "./rate-policy.js";
import type { RatePolicyRules } from "./rate-policy.js";

// ── Config schema ─────────────────────────────────────────────────────────────

export const configSchema = z.object({
    /**
     * Max number of model (LLM) calls per task.
     * Reads from the effective rules after shallow-merging template.rules +
     * override_config (decisions.md Decision 3). Optional — no limit if absent.
     */
    maxModelCalls: z.number().int().positive().optional(),
});

export type RatePolicyConfig = z.infer<typeof configSchema>;

// ── In-memory per-task accumulator ───────────────────────────────────────────

interface TaskAccumulator {
    taskId: string;
    modelCalls: number;
}

// ── Plugin class ──────────────────────────────────────────────────────────────

class RatePolicyPlugin implements Plugin {
    readonly name = "agent-policy-rate";

    private readonly accumulators = new Map<string, TaskAccumulator>();

    constructor(
        private readonly db: unknown,
        private readonly cfg: RatePolicyConfig
    ) {}

    install(hooks: IHookRegistry): void {
        // Observational: initialise the per-task counter on task:start.
        hooks.register("task:start", (p) => {
            try {
                this.onTaskStart(p);
            } catch {
                /* observational — never kill a task */
            }
        });

        // Observational: increment model-call count after each completed model turn.
        hooks.register("post:model_response", (p) => {
            try {
                this.onPostModelResponse(p);
            } catch {
                /* observational */
            }
        });

        // Observational: clean up accumulator on terminal events.
        hooks.register("task:completed", (p) => {
            try {
                this.onTerminal(p.executionContext.taskId);
            } catch {
                /* observational */
            }
        });
        hooks.register("task:failed", (p) => {
            try {
                this.onTerminal(p.executionContext.taskId);
            } catch {
                /* observational */
            }
        });
        hooks.register("task:cancelled", (p) => {
            try {
                this.onTerminal(p.executionContext.taskId);
            } catch {
                /* observational */
            }
        });

        // Enforcement — throws propagate (NO try/catch wrapper).
        // decisions.md Decision 2: registerEnforcement only accepts "pre:model_request".
        hooks.registerEnforcement("pre:model_request", (p) => this.enforce(p));
    }

    // ── Observational handlers ────────────────────────────────────────────────

    private onTaskStart(p: TaskStartPayload): void {
        this.accumulators.set(p.executionContext.taskId, {
            taskId: p.executionContext.taskId,
            modelCalls: 0,
        });
    }

    private onPostModelResponse(p: PostModelResponsePayload): void {
        const acc = this.accumulators.get(p.executionContext.taskId);
        if (acc) acc.modelCalls += 1;
    }

    private onTerminal(taskId: string): void {
        this.accumulators.delete(taskId);
    }

    // ── Enforcement ───────────────────────────────────────────────────────────

    private enforce(p: PreModelRequestPayload): void {
        const acc = this.accumulators.get(p.executionContext.taskId);
        // No accumulator (task:start not seen) — be permissive, not crashy.
        if (!acc) return;

        const rules: RatePolicyRules = {
            maxModelCalls: this.cfg.maxModelCalls,
        };

        const violation = evaluateRatePolicy(rules, acc.modelCalls);
        if (violation !== null) throw violation;
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

const createPlugin: PluginFactory = ({ db, config }: PluginContext): Plugin => {
    return new RatePolicyPlugin(db, config as RatePolicyConfig);
};

export default createPlugin;
export { createPlugin };
