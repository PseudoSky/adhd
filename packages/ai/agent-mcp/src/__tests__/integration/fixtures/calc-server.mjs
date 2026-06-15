#!/usr/bin/env node
// Minimal stdio MCP server exposing a single `calculate` tool.
// Safe arithmetic evaluator (no eval on raw input): tokenizes, then shunting-yard.
// Every call is appended to a log file (CALC_LOG env, default ./calc-server.log)
// so tool invocations are observable even when the caller (e.g. an ephemeral
// agent-mcp task) persists nothing.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const LOG_PATH =
    process.env.CALC_LOG ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "calc-server.log");

function log(entry) {
    try {
        appendFileSync(
            LOG_PATH,
            JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n"
        );
    } catch {
        // never let logging break the tool
    }
}

function evaluate(expr) {
    if (!/^[0-9+\-*/^().\s]+$/.test(expr)) {
        throw new Error(`unsupported characters in expression: ${expr}`);
    }
    const tokens = expr.match(/\d+\.?\d*|[+\-*/^()]/g);
    if (!tokens) throw new Error(`no tokens in: ${expr}`);
    const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };
    const rightAssoc = { "^": true };
    const out = [];
    const ops = [];
    for (const t of tokens) {
        if (/^\d/.test(t)) out.push(parseFloat(t));
        else if (t === "(") ops.push(t);
        else if (t === ")") {
            while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop());
            ops.pop();
        } else {
            while (
                ops.length &&
                ops[ops.length - 1] !== "(" &&
                (prec[ops[ops.length - 1]] > prec[t] ||
                    (prec[ops[ops.length - 1]] === prec[t] && !rightAssoc[t]))
            )
                out.push(ops.pop());
            ops.push(t);
        }
    }
    while (ops.length) out.push(ops.pop());
    const st = [];
    for (const tok of out) {
        if (typeof tok === "number") st.push(tok);
        else {
            const b = st.pop();
            const a = st.pop();
            st.push(
                tok === "+" ? a + b : tok === "-" ? a - b : tok === "*" ? a * b : tok === "/" ? a / b : Math.pow(a, b)
            );
        }
    }
    if (st.length !== 1) throw new Error(`malformed expression: ${expr}`);
    return st[0];
}

const server = new Server({ name: "calc", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "calculate",
            description:
                "Evaluate a single arithmetic expression given as text (supports + - * / ^ and parentheses) and return the numeric result.",
            inputSchema: {
                type: "object",
                properties: { expression: { type: "string", description: "e.g. '12 * 12' or '2 ^ 8'" } },
                required: ["expression"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "calculate") {
        log({ event: "unknown_tool", tool: req.params.name });
        throw new Error(`unknown tool: ${req.params.name}`);
    }
    const expr = String(req.params.arguments?.expression ?? "");
    try {
        const result = evaluate(expr);
        log({ event: "calculate", expression: expr, result });
        return { content: [{ type: "text", text: String(result) }] };
    } catch (e) {
        log({ event: "calculate_error", expression: expr, error: e.message });
        return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
    }
});

log({ event: "startup", logPath: LOG_PATH });
await server.connect(new StdioServerTransport());
