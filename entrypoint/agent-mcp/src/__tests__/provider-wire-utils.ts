/**
 * Shared scaffold for the c536ce29 P1 provider-wire tests (unit + e2e): loopback-only HTTP servers,
 * a base `fetch` that FAILS LOUDLY on any non-loopback host, real channel installation over an
 * isolated temp dir, and a reader for the api records it wrote.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env, toEngineConfig, type LogRoots } from "../config.js";
import { closeLogChannels, getLogChannels, initLogChannels } from "../wire/channels.js";
import { createWireSeams } from "../wire/seams.js";

export type Rec = Record<string, unknown> & { event: string };

export interface ISeen {
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body: Buffer;
}

export interface ILoopback {
    readonly origin: string;
    readonly seen: ISeen[];
    close(): Promise<void>;
}

/** Starts a 127.0.0.1 server; `handler` receives every request with its fully read body. */
export async function startLoopback(
    handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void
): Promise<ILoopback> {
    const seen: ISeen[] = [];
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            handler(req, res, body);
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
}

/** The platform fetch captured at import, before any test replaces `globalThis.fetch` with the guard. */
export const REAL_FETCH: typeof fetch = globalThis.fetch;

/** A base fetch that records (and rejects) any request whose host is not 127.0.0.1/localhost. */
export function makeGuardFetch(leaks: string[]): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
            leaks.push(url.href);
            throw new Error(`NON-LOOPBACK EGRESS BLOCKED: ${url.href}`);
        }
        return REAL_FETCH(input, init);
    }) as typeof fetch;
}

export interface IChannelFixture {
    roots: LogRoots;
    /** Flushes and returns every api record written so far (file order). */
    records(): Promise<Rec[]>;
    rawText(): Promise<string>;
    dispose(): Promise<void>;
}

/** Installs real process-wide channels over a fresh temp dir (api = on). */
export function installChannels(): IChannelFixture {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "p1-wire-")));
    const roots: LogRoots = {
        root: base,
        api: join(base, "api"),
        ops: join(base, "ops"),
        trace: join(base, "trace"),
        temp: join(base, "temp"),
    };
    initLogChannels({ roots, logging: loggingOn() });
    const rawText = async (): Promise<string> => {
        await getLogChannels().flush();
        try {
            return readdirSync(roots.api)
                .filter((f) => f.includes(".jsonl"))
                .sort()
                .map((f) => readFileSync(join(roots.api, f), "utf8"))
                .join("");
        } catch {
            return "";
        }
    };
    return {
        roots,
        rawText,
        async records() {
            return (await rawText()).split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Rec);
        },
        async dispose() {
            await closeLogChannels();
            rmSync(base, { recursive: true, force: true });
        },
    };
}

function loggingOn(): typeof env.config.logging {
    return { ...env.config.logging, api: "on" } as typeof env.config.logging;
}

/** Production engine config, with the base fetch swapped for the loopback-only guard. */
export function guardedEngineConfig(leaks: string[]): ReturnType<typeof toEngineConfig> {
    return { ...toEngineConfig(), wire: createWireSeams({ fetch: makeGuardFetch(leaks) }) };
}
