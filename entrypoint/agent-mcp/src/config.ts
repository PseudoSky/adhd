import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadEnvHierarchy } from "./utils/load-env.js";
import type { EngineConfig } from "@adhd/agent-engine-orchestrator";

loadEnvHierarchy();

export type GetProviderConfigOpts = {
    provider: "openai" | "anthropic" | "claudecli";
    secret?: string;
    url?: string;
    model?: string;
    inlineBaseURL?: string;
    inlineModel?: string;
};

export type ProviderConfigResolved = {
    secret?: string;
    baseURL?: string;
    model?: string;
};

export interface Config extends EngineConfig {
    readonly db: { readonly path: string };
    readonly logging: { readonly level: string };
    readonly server: EngineConfig["server"] & {
        readonly maxDepth: number;
        readonly maxToolLoops: number;
        readonly allowedAgents: readonly string[] | undefined;
        readonly registryDbPath: string;
    };
    readonly transport: { readonly kind: string; readonly port: number };
    readonly sse: EngineConfig["sse"] & {
        readonly port: number;
        readonly host: string;
    };
    readonly security: { readonly envAllowlist: readonly string[] };
    readonly queue: EngineConfig["queue"];
    readonly plugins: EngineConfig["plugins"];
    getProviderConfig(opts: GetProviderConfigOpts): ProviderConfigResolved;
    resolveEnvRef(name: string): string | undefined;
    verifyEnvRefs(names: string[]): { missing: string[]; disallowed: string[] };
    subprocessEnv(): Record<string, string>;
}

function normalizeBaseUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.pathname === "/" || parsed.pathname === "") {
            parsed.pathname = "/v1";
            return parsed.toString().replace(/\/v1\/$/, "/v1");
        }
        return url;
    } catch {
        return url;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = configSchema.parse(rawFromEnv(env));

    const sseBaseUrl =
        parsed.sse.baseUrl ?? `http://localhost:${parsed.sse.port}`;

    const frozenEnv = deepFreeze({ ...env } as Record<string, string | undefined>);

    const allowlistSet = new Set(parsed.security.envAllowlist);

    function isEnvNameAllowed(name: string): boolean {
        return name.startsWith("ADHD_AGENT_") || allowlistSet.has(name);
    }

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

    function getProviderConfig(opts: GetProviderConfigOpts): ProviderConfigResolved {
        if (opts.provider === "claudecli") {
            return {};
        }

        const defaults = PROVIDER_DEFAULTS[opts.provider];
        const snap = frozenEnv as Record<string, string | undefined>;

        let model: string | undefined;
        if (opts.model)        model = resolveEnvRef(opts.model);
        if (!model && opts.inlineModel)              model = opts.inlineModel;
        if (!model && defaults)                       model = snap[defaults.model];

        let baseURL: string | undefined;
        if (opts.url)          baseURL = resolveEnvRef(opts.url);
        if (!baseURL && opts.inlineBaseURL)          baseURL = opts.inlineBaseURL;
        if (!baseURL && defaults)                     baseURL = snap[defaults.baseUrl];
        if (baseURL)                                  baseURL = normalizeBaseUrl(baseURL);

        let secret: string | undefined;
        if (opts.secret)       secret = resolveEnvRef(opts.secret);
        if (!secret && defaults)                      secret = snap[defaults.secret];

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

    function subprocessEnv(): Record<string, string> {
        const result: Record<string, string> = {};
        const snap = frozenEnv as Record<string, string | undefined>;
        for (const [k, v] of Object.entries(snap)) {
            if (v !== undefined) result[k] = v;
        }
        return result;
    }

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

export const config: Config = loadConfig();
