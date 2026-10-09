/**
 * Loud default-plugin loading for e2e specs (backlog c536ce29 E2E-PREREQ, plan
 * 9ed453c1-b113-473d-8c35-fc6dc2541306).
 *
 * The default plugins (tracing, budget) are loaded by BARE SPECIFIER and resolve through each
 * package's `main` -> `./dist/index.js`. dist/ is gitignored, so in a fresh checkout/worktree the
 * engine loader logs an error and SKIPS the plugin; a no-op logger then hides it, nothing
 * registers, and a spec fails far downstream with an empty diff and a timeout. These helpers make
 * that prerequisite failure immediate and named.
 */
import type { IHookRegistry } from "@adhd/agent-base-types";
import type { EngineLogger } from "@adhd/agent-engine-orchestrator";

import { loadDefaultPlugins, type LoadDefaultPluginsOverrides } from "../plugins/load-defaults.js";

/** A logger that records every error-level call instead of dropping it. */
export interface ICollectingLogger extends EngineLogger {
    readonly errors: readonly string[];
}

/** Builds a {@link ICollectingLogger}; info/warn/debug are discarded, errors are kept. */
export function collectingLogger(): ICollectingLogger {
    const errors: string[] = [];
    const render = (a: unknown[]): string =>
        a
            .map((x) =>
                typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (v instanceof Error ? v.message : v))
            )
            .join(" ");
    return {
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        error: (...a: unknown[]) => {
            errors.push(render(a));
        },
        errors,
    } as ICollectingLogger;
}

/** Message thrown when a default plugin did not load; names the plugin and the build command. */
export function pluginPrereqMessage(pluginPackage: string, details: readonly string[]): string {
    const project = pluginPackage.replace(/^@adhd\//, "");
    return (
        `e2e prerequisite missing: default plugin ${pluginPackage} did not load, so its hooks are not registered. ` +
        `Build it first: npx nx build ${project} (the agent-mcp \`e2e\` target does this via dependsOn; ` +
        `a bare \`vitest run\` does not). Loader said: ${details.join(" | ") || "(nothing logged)"}`
    );
}

/**
 * Like `loadDefaultPlugins`, but throws a named, actionable error when any plugin was skipped.
 * `required` lists the package names the spec cannot run without (default: tracing).
 */
export async function loadDefaultPluginsOrFail(
    hooks: IHookRegistry,
    db: unknown,
    overrides: LoadDefaultPluginsOverrides,
    required: readonly string[] = ["@adhd/agent-plugin-tracing"]
): Promise<void> {
    const logger = collectingLogger();
    await loadDefaultPlugins(hooks, db, logger, { stderr: { write: () => true }, ...overrides });
    for (const pkg of required) {
        const hit = logger.errors.filter((e) => e.includes(pkg));
        if (hit.length > 0) throw new Error(pluginPrereqMessage(pkg, hit));
    }
    if (logger.errors.length > 0) {
        throw new Error(`e2e prerequisite: a plugin failed to load: ${logger.errors.join(" | ")}`);
    }
}
