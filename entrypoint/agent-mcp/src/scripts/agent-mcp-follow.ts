#!/usr/bin/env node
/**
 * agent-mcp-follow — a live SSE renderer for a single agent-mcp task.
 *
 *   agent-mcp-follow --task <taskId> [--base-url <url> | --port <n>]
 *                    [--json | --events] [--help]
 *
 * Subscribes to `GET /tasks/<taskId>/stream` on a running agent-mcp HTTP
 * (SSE) surface and prints the assistant's text as it is produced, exiting
 * when the task reaches a terminal state. Unlike `agent-mcp-tail` (which polls
 * the SQLite DB), this is a genuine SSE consumer — see `streaming/follow-renderer.ts`.
 *
 * Exit codes: 0 = task completed; 1 = task failed/cancelled or the stream
 * could not be followed; 2 = usage error.
 *
 * This bin is the agent-mcp-side half of c667a213. `dispatch-cli run --follow`
 * (the other half) wires a caller to this renderer.
 */
import { parseArgs } from "node:util";
import { followTaskStream, FollowUsageError, type FollowFormat } from "../streaming/follow-renderer.js";

const USAGE = `agent-mcp-follow — live SSE renderer for an agent-mcp task

Usage:
  agent-mcp-follow --task <taskId> [options]

Options:
  -t, --task <id>        Task id to follow (required; or pass positionally)
      --base-url <url>   agent-mcp HTTP base URL (default: http://localhost:<port>)
      --port <n>         SSE port (default: $ADHD_AGENT_SSE_PORT or 3001)
      --events           Print one line per stream event, not just assistant text
      --json             Print raw newline-delimited JSON events
      --help             Show this help

Port note: a standalone agent-mcp instance binds an OS-assigned ephemeral port
when its configured SSE port is already taken by another instance (see
startSseServer's EADDRINUSE fallback). This bin's default (3001 or
$ADHD_AGENT_SSE_PORT) can therefore differ from the port the instance you mean
to follow actually bound. When dispatch-cli spawns agent-mcp, it MUST pass that
instance's exact bound port via --base-url or --port; do not rely on the default.
`;

const { values, positionals } = parseArgs({
    options: {
        task:       { type: "string",  short: "t", default: "" },
        "base-url": { type: "string",  default: "" },
        port:       { type: "string",  default: "" },
        events:     { type: "boolean", default: false },
        json:       { type: "boolean", default: false },
        help:       { type: "boolean", default: false },
    },
    allowPositionals: true,
});

if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
}

const taskId = (values.task || positionals[0] || "").trim();
if (!taskId) {
    process.stderr.write("agent-mcp-follow: --task <taskId> is required\n\n" + USAGE);
    process.exit(2);
}

const port = (values.port || process.env["ADHD_AGENT_SSE_PORT"] || "3001").trim();
const baseUrl = (values["base-url"] || `http://localhost:${port}`).trim();
let format: FollowFormat = "text";
if (values.json) format = "json";
else if (values.events) format = "events";

/** Keep stdout clean for `--json`; human status chatter goes to stderr. */
const note = (line: string): void => {
    if (format !== "json") process.stderr.write(line);
};

note(`agent-mcp-follow: subscribing to ${baseUrl}/tasks/${taskId}/stream\n`);

followTaskStream({
    taskId,
    baseUrl,
    format,
    onStatus: (status) => note(`[status] ${status}\n`),
})
    .then((result) => {
        if (format !== "json") process.stdout.write("\n");
        note(
            `agent-mcp-follow: ${result.status ?? "unknown"} ` +
            `(tokens=${result.tokens}, events=${result.events})\n`
        );
        if (result.error) {
            process.stderr.write(`agent-mcp-follow: task error: ${result.error}\n`);
            process.exit(1);
        }
        // Only an explicit `completed` is success. `status === null` means the
        // terminal `done` event was never observed (the renderer now rejects on
        // a premature stream end, but keep this mapping defensive: a null status
        // must never look like success).
        process.exit(result.status === "completed" ? 0 : 1);
    })
    .catch((err: unknown) => {
        process.stderr.write(`agent-mcp-follow: ${err instanceof Error ? err.message : String(err)}\n`);
        // Usage errors (e.g. an unparseable --base-url) exit 2, distinct from
        // the runtime/stream failure exit 1.
        process.exit(err instanceof FollowUsageError ? 2 : 1);
    });
