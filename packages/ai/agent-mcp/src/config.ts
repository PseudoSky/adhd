/**
 * config.ts — the ONLY `process.env` reader in agent-mcp.
 *
 * All 26 scattered reads in the previous implementation are replaced by
 * references to `config.<ns>.<field>` or the dynamic methods below.
 *
 * Init model (§1):
 *   • loadEnvHierarchy() runs at module load, populating process.env from
 *     ~/.adhd/.env → <cwd>/.adhd/.env → <cwd>/.env (most-specific wins).
 *   • loadConfig(env) is a pure, testable factory: reads `env` once, validates
 *     with Zod, and deep-freezes the result.
 *   • The singleton `config` is exported as the app entry-point for all callers.
 *
 * Dynamic methods (§1.2) close over the frozen env snapshot and are themselves
 * frozen on the returned object — the snapshot is never re-read.
 */

import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadEnvHierarchy } from "./utils/load-env.js";

// ── Load .env hierarchy once, before the snapshot is taken ───────────────────
// This mutates process.env (dotenv), so the singleton below sees the hydrated
// values. Runs once at module load; subsequent imports hit the module cache.
loadEnvHierarchy();

// ── Types ─────────────────────────────────────────────────────────────────────

/** Options for getProviderConfig — each `secret`/`url`/`model` is an env-var NAME. */
export type GetProviderConfigOpts = {
    provider: "openai" | "anthropic" | "claudecli";
    /** env-var NAME from agentConfig.env.secret (an ADHD_AGENT_* pointer) */
    secret?: string;
    /** env-var NAME from agentConfig.env.base_url */
    url?: string;
    /** env-var NAME from agentConfig.env.model */
    model?: string;
    /** Fallback literal baseURL from agentConfig.baseURL (inline, not env-mapped) */
    inlineBaseURL?: string;
    /** Fallback literal model from agentConfig.model (inline) */
    inlineModel?: string;
};

/** Resolved concrete values returned by getProviderConfig. */
export type ProviderConfigResolved = {
    secret?: string;
    baseURL?: string;
    model?: string;
};

/** The full config surface. Static fields are deep-frozen; methods close over
 *  the frozen env snapshot. */
export interface Config {
    readonly db: { readonly path: string };
    readonly logging: { readonly level: string };
    readonly queue: { readonly concurrency: number };
    readonly server: {
        readonly maxDepth: number;
        readonly maxToolLoops: number;
        readonly defaultMaxTokens: number;
        readonly contextLimit: number;
        readonly allowedAgents: readonly string[] | undefined;
        readonly registryDbPath: string;
    };
    readonly transport: { readonly kind: string; readonly port: number };
    readonly sse: { readonly port: number; readonly host: string; readonly baseUrl: string };
    readonly plugins: { readonly configPath: string | undefined; readonly entries: readonly string[] };
    readonly security: { readonly envAllowlist: readonly string[] };

    /**
     * Resolve an agent's provider `env` block into concrete credential / url /
     * model values, merging: env-name override → inline literal → provider
     * default. A missing required secret on a non-localhost baseURL throws with
     * a clear diagnostic. Closes over the frozen env snapshot.
     */
    getProviderConfig(opts: GetProviderConfigOpts): ProviderConfigResolved;

    /**
     * Resolve one env-var NAME against the frozen snapshot. Throws if the name
     * is disallowed by the §6 prefix guard.
     */
    resolveEnvRef(name: string): string | undefined;

    /**
     * §6 prefix guard — true iff `name` starts with `ADHD_AGENT_` OR is an
     * explicit operator opt-in from ADHD_AGENT_ENV_ALLOWLIST.
     */
    isEnvNameAllowed(name: string): boolean;

    /**
     * Startup verification: given the env-var names referenced across all agent
     * env blocks, return which are missing from the frozen snapshot and which
     * violate the §6 guard.
     */
    verifyEnvRefs(names: string[]): { missing: string[]; disallowed: string[] };

    /**
     * Return the frozen env snapshot as a plain string map for subprocess
     * passthrough (Class 3 reads: stdio-client, claudecli). Raw passthrough —
     * external servers and the claude CLI need their own env (PATH, HOME, …).
     */
    subprocessEnv(): Record<string, string>;
}

// ── Base-URL normalisation (§3) ───────────────────────────────────────────────

/** Append /v1 when the URL has no explicit path; explicit paths are respected. */
function normalizeBaseUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.pathname === "/" || parsed.pathname === "") {
            parsed.pathname = "/v1";
            // toString() may add trailing slash; strip it for cleanliness
            return parsed.toString().replace(/\/v1\/$/, "/v1");
        }
        return url;
    } catch {
        return url; // not a valid URL — pass through; provider will surface the error
    }
}

function isLocalhostUrl(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const { hostname } = new URL(url);
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
        return false;
    }
}

// ── Provider default template env-var names (§1.1) ────────────────────────────

const PROVIDER_DEFAULTS: Record<string, { secret: string; baseUrl: string; model: string }> = {
    openai: {
        secret:  "ADHD_AGENT_OPENAI_SECRET",
        baseUrl: "ADHD_AGENT_OPENAI_BASE_URL",
        model:   "ADHD_AGENT_OPENAI_MODEL",
    },
    anthropic: {
        secret:  "ADHD_AGENT_ANTHROPIC_SECRET",
        baseUrl: "ADHD_AGENT_ANTHROPIC_BASE_URL",
        model:   "ADHD_AGENT_ANTHROPIC_MODEL",
    },
    deepseek: {
        secret:  "ADHD_AGENT_DEEPSEEK_SECRET",
        baseUrl: "ADHD_AGENT_DEEPSEEK_BASE_URL",
        model:   "ADHD_AGENT_DEEPSEEK_MODEL",
    },
};

// ── Deep-freeze helper ────────────────────────────────────────────────────────

function deepFreeze<T>(obj: T): T {
    if (obj === null || typeof obj !== "object") return obj;
    Object.getOwnPropertyNames(obj).forEach(name => {
        const val = (obj as Record<string, unknown>)[name];
        if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
            deepFreeze(val);
        }
    });
    return Object.freeze(obj);
}

// ── Raw env → Zod schema input ────────────────────────────────────────────────

function rawFromEnv(env: NodeJS.ProcessEnv) {
    return {
        db:       { path: env["ADHD_AGENT_DATABASE_PATH"] },
        logging:  { level: env["ADHD_AGENT_LOG_LEVEL"] },
        queue:    { concurrency: env["ADHD_AGENT_QUEUE_CONCURRENCY"] },
        server: {
            maxDepth:         env["ADHD_AGENT_MAX_DEPTH"],
            maxToolLoops:     env["ADHD_AGENT_MAX_TOOL_LOOPS"],
            defaultMaxTokens: env["ADHD_AGENT_DEFAULT_MAX_TOKENS"],
            contextLimit:     env["ADHD_AGENT_CONTEXT_LIMIT"],
            allowedAgents:    env["ADHD_AGENT_ALLOWED_AGENTS"],
            registryDbPath:   env["ADHD_AGENT_REGISTRY_DB_PATH"],
        },
        transport: {
            kind: env["ADHD_AGENT_TRANSPORT"],
            port: env["ADHD_AGENT_PORT"],
        },
        sse: {
            port:    env["ADHD_AGENT_SSE_PORT"],
            host:    env["ADHD_AGENT_SSE_HOST"],
            baseUrl: env["ADHD_AGENT_SSE_BASE_URL"],
        },
        plugins: {
            configPath: env["ADHD_AGENT_CONFIG"],
            entries:    env["ADHD_AGENT_PLUGINS"],
        },
        security: {
            envAllowlist: env["ADHD_AGENT_ENV_ALLOWLIST"],
        },
    };
}

// ── Zod schema ────────────────────────────────────────────────────────────────

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
const TRANSPORT_KINDS = ["stdio", "http"] as const;

const configSchema = z.object({
    db: z.object({
        path: z.string().default(
            path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db")
        ),
    }),
    logging: z.object({
        level: z.enum(LOG_LEVELS).default("info"),
    }),
    queue: z.object({
        concurrency: z.coerce.number().int().positive().default(5),
    }),
    server: z.object({
        maxDepth:         z.coerce.number().int().positive().default(5),
        maxToolLoops:     z.coerce.number().int().positive().default(50),
        defaultMaxTokens: z.coerce.number().int().positive().default(8192),
        contextLimit:     z.coerce.number().int().nonnegative().default(0),
        allowedAgents:    z
            .string()
            .optional()
            .transform(v => v ? v.split(",").map(s => s.trim()).filter(Boolean) : undefined),
        registryDbPath:   z.string().default(
            path.join(os.homedir(), ".adhd", "agent-mcp", "registry.db")
        ),
    }),
    transport: z.object({
        kind: z.enum(TRANSPORT_KINDS).default("stdio"),
        port: z.coerce.number().int().positive().default(3000),
    }),
    sse: z.object({
        port:    z.coerce.number().int().positive().default(3001),
        host:    z.string().default("127.0.0.1"),
        baseUrl: z.string().optional(),
    }),
    plugins: z.object({
        configPath: z.string().optional(),
        entries:    z
            .string()
            .optional()
            .transform(v => v ? v.split(",").map(s => s.trim()).filter(Boolean) : []),
    }),
    security: z.object({
        envAllowlist: z
            .string()
            .optional()
            .transform(v => v ? v.split(",").map(s => s.trim()).filter(Boolean) : []),
    }),
});

// ── loadConfig ────────────────────────────────────────────────────────────────

/**
 * Pure, testable factory. Reads `env` once, validates with Zod (fails fast on
 * invalid input), deep-freezes the result. The app imports the `config`
 * singleton; tests call `loadConfig(fakeEnv)` for isolation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = configSchema.parse(rawFromEnv(env));

    // Build the resolved SSE base URL
    const sseBaseUrl =
        parsed.sse.baseUrl ?? `http://localhost:${parsed.sse.port}`;

    // Freeze the env snapshot — dynamic methods read from this, never live env
    const frozenEnv = deepFreeze({ ...env } as Record<string, string | undefined>);

    // Build the allowlist predicate from the security config
    const allowlistSet = new Set(parsed.security.envAllowlist);

    // ── §6 prefix guard ───────────────────────────────────────────────────────
    function isEnvNameAllowed(name: string): boolean {
        return name.startsWith("ADHD_AGENT_") || allowlistSet.has(name);
    }

    // ── resolveEnvRef ─────────────────────────────────────────────────────────
    function resolveEnvRef(name: string): string | undefined {
        if (!isEnvNameAllowed(name)) {
            throw new Error(
                `Env var "${name}" is not permitted as an agent env ref. ` +
                `Only ADHD_AGENT_-prefixed variables are allowed by default. ` +
                `Add it to ADHD_AGENT_ENV_ALLOWLIST to permit it explicitly.`
            );
        }
        return (frozenEnv as Record<string, string | undefined>)[name];
    }

    // ── getProviderConfig ─────────────────────────────────────────────────────
    function getProviderConfig(opts: GetProviderConfigOpts): ProviderConfigResolved {
        // claudecli is exempt — it drives the local `claude` CLI via subprocessEnv()
        // and has no API credential requirements of its own.
        if (opts.provider === "claudecli") {
            return {};
        }

        const defaults = PROVIDER_DEFAULTS[opts.provider];
        const snap = frozenEnv as Record<string, string | undefined>;

        // model: env-name override → inline literal → provider default template
        let model: string | undefined;
        if (opts.model)        model = resolveEnvRef(opts.model);
        if (!model && opts.inlineModel)              model = opts.inlineModel;
        if (!model && defaults)                       model = snap[defaults.model];

        // baseURL: env-name override → inline literal → provider default template → normalize
        let baseURL: string | undefined;
        if (opts.url)          baseURL = resolveEnvRef(opts.url);
        if (!baseURL && opts.inlineBaseURL)          baseURL = opts.inlineBaseURL;
        if (!baseURL && defaults)                     baseURL = snap[defaults.baseUrl];
        if (baseURL)                                  baseURL = normalizeBaseUrl(baseURL);

        // secret: env-name override → provider default template
        let secret: string | undefined;
        if (opts.secret)       secret = resolveEnvRef(opts.secret);
        if (!secret && defaults)                      secret = snap[defaults.secret];

        // Fail loud when no secret AND the target is not a local server (§3)
        if (!secret && !isLocalhostUrl(baseURL)) {
            const defaultSecretName =
                defaults?.secret ?? `ADHD_AGENT_${opts.provider.toUpperCase()}_SECRET`;
            const usedName = opts.secret ?? defaultSecretName;
            throw new Error(
                `No credential for ${opts.provider}` +
                (baseURL ? ` at ${baseURL}` : "") +
                `; set ${usedName} in your ~/.adhd/.env`
            );
        }

        return { secret, baseURL, model };
    }

    // ── verifyEnvRefs ─────────────────────────────────────────────────────────
    function verifyEnvRefs(
        names: string[]
    ): { missing: string[]; disallowed: string[] } {
        const missing: string[] = [];
        const disallowed: string[] = [];
        const snap = frozenEnv as Record<string, string | undefined>;
        for (const name of names) {
            if (!isEnvNameAllowed(name)) {
                disallowed.push(name);
            } else if (snap[name] === undefined) {
                missing.push(name);
            }
        }
        return { missing, disallowed };
    }

    // ── subprocessEnv ─────────────────────────────────────────────────────────
    function subprocessEnv(): Record<string, string> {
        const result: Record<string, string> = {};
        const snap = frozenEnv as Record<string, string | undefined>;
        for (const [k, v] of Object.entries(snap)) {
            if (v !== undefined) result[k] = v;
        }
        return result;
    }

    // Build the static shape, attach methods, then deep-freeze the whole object
    const obj: Config = {
        db: { path: parsed.db.path },
        logging: { level: parsed.logging.level },
        queue: { concurrency: parsed.queue.concurrency },
        server: {
            maxDepth:         parsed.server.maxDepth,
            maxToolLoops:     parsed.server.maxToolLoops,
            defaultMaxTokens: parsed.server.defaultMaxTokens,
            contextLimit:     parsed.server.contextLimit,
            allowedAgents:    parsed.server.allowedAgents as string[] | undefined,
            registryDbPath:   parsed.server.registryDbPath,
        },
        transport: { kind: parsed.transport.kind, port: parsed.transport.port },
        sse: { port: parsed.sse.port, host: parsed.sse.host, baseUrl: sseBaseUrl },
        plugins: {
            configPath: parsed.plugins.configPath,
            entries:    parsed.plugins.entries as string[],
        },
        security: { envAllowlist: parsed.security.envAllowlist as string[] },
        getProviderConfig,
        resolveEnvRef,
        isEnvNameAllowed,
        verifyEnvRefs,
        subprocessEnv,
    };

    return deepFreeze(obj);
}

// ── App singleton ─────────────────────────────────────────────────────────────
/** Eager frozen singleton — constructed once at module load with the live env. */
export const config: Config = loadConfig();
