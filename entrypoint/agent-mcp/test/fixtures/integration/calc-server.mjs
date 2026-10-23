#!/usr/bin/env node
/**
 * calc-server.mjs — a REAL stdio MCP server (JSON-RPC over stdio) exposing one
 * tool, `calculate`, used by the gated live DAG/budget e2e suites
 * (`live-dag.e2e.test.ts`, `live-budget.e2e.test.ts`).
 *
 * Why this file exists (backlog 305a63d4): both suites wire a real stdio MCP
 * server at `<integration>/fixtures/calc-server.mjs` — the worker agent's `calc`
 * server, asserted to expose `calc__calculate` (the registry prefixes the tool
 * with the `mcpServers` key). The path was DANGLING (no such file anywhere in
 * the repo) and went undetected because the suites are gated behind a paid
 * model, so a live run would fail at MCP connect. This is the missing fixture.
 *
 * It evaluates a restricted arithmetic grammar (+, -, *, /, parentheses, unary
 * sign) with a hand-written recursive-descent parser — NEVER `eval`/`Function`,
 * so a model-authored expression can not execute arbitrary code on the test
 * host. A malformed expression is returned as an MCP tool error, never a crash.
 *
 * When `CALC_LOG` is set (the e2e tests point it at a temp file so the repo is
 * never written to), every call appends a `calculate <expression> = <result>`
 * line — the evidence those tests rely on.
 */
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Evaluates a restricted arithmetic expression. Supports `+ - * /`, unary
 * sign, parentheses, decimals and whitespace. Throws on anything else.
 * @param {unknown} raw
 * @returns {number}
 */
function evaluate(raw) {
  const s = String(raw ?? '');
  let i = 0;

  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  };
  const isDigit = (c) => c >= '0' && c <= '9';

  function parseNumber() {
    skipWs();
    const start = i;
    while (i < s.length && (isDigit(s[i]) || s[i] === '.')) i += 1;
    if (i === start) {
      throw new Error(`expected a number at position ${start} in "${s}"`);
    }
    const text = s.slice(start, i);
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw new Error(`invalid number "${text}"`);
    }
    return value;
  }

  function parseFactor() {
    skipWs();
    if (s[i] === '(') {
      i += 1;
      const value = parseExpression();
      skipWs();
      if (s[i] !== ')') throw new Error(`unbalanced parentheses in "${s}"`);
      i += 1;
      return value;
    }
    if (s[i] === '-' || s[i] === '+') {
      const sign = s[i];
      i += 1;
      const value = parseFactor();
      return sign === '-' ? -value : value;
    }
    return parseNumber();
  }

  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      skipWs();
      const op = s[i];
      if (op !== '*' && op !== '/') break;
      i += 1;
      const rhs = parseFactor();
      value = op === '*' ? value * rhs : value / rhs;
    }
    return value;
  }

  function parseExpression() {
    let value = parseTerm();
    for (;;) {
      skipWs();
      const op = s[i];
      if (op !== '+' && op !== '-') break;
      i += 1;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  const value = parseExpression();
  skipWs();
  if (i !== s.length) {
    throw new Error(`unexpected token at position ${i} in "${s}"`);
  }
  return value;
}

const server = new Server(
  { name: 'calc-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'calculate',
      description:
        'Evaluate a basic arithmetic expression (+, -, *, /, parentheses) and return the numeric result.',
      inputSchema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const expression = String(req.params.arguments?.expression ?? '');
  let text;
  let isError = false;
  try {
    const result = evaluate(expression);
    text = String(result);
    const log = process.env.CALC_LOG;
    if (log) {
      try {
        appendFileSync(log, `calculate ${expression} = ${text}\n`, 'utf8');
      } catch {
        /* the log is best-effort evidence; never fail a call over it */
      }
    }
  } catch (err) {
    isError = true;
    text = `calculate: ${err.message}`;
  }
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
});

await server.connect(new StdioServerTransport());
