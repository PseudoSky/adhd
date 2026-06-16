#!/usr/bin/env node
/**
 * Code-tasking study runner.
 *
 * Drives the published @adhd/agent-mcp server over stdio MCP and replays the
 * study's tests (runner/plan.json) against ANY provider/model, recording the
 * full response text per step to results/runs.<label>.jsonl. Usage telemetry is
 * persisted by the server itself (task_usage); export it separately with
 * `sqlite3` (see results/README.md) and join on the prompt text.
 *
 * The plan is provider-agnostic; the provider is injected here, so the ONLY
 * thing that varies between a 14B run, a sonnet-4.6 run, and a qwen3.5-9b run is
 * the model. Same system prompts, same prompts, same topology.
 *
 * Usage:
 *   node run-study.mjs --label qwen35-9b \
 *       --provider lmstudio --model qwen3.5-9b-...-mxfp8 --tests all
 *   node run-study.mjs --label anthropic-sonnet46 \
 *       --provider anthropic --model claude-sonnet-4-6 --tests 1,3,4,5,9,10,11,12,13,14,15,16,17
 *
 * --tests: "all" | "remaining" (tests without results/runs.anthropic*.jsonl) | csv of ids
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const STUDY = join(__dir, "..");
const DB = "/Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents-published.db";

// ---- args ----
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const LABEL = arg("label");
const PROVIDER = arg("provider", "lmstudio"); // lmstudio | anthropic
const MODEL = arg("model");
const TESTS = arg("tests", "all");
const TIMEOUT = parseInt(arg("timeout", PROVIDER === "anthropic" ? "90000" : "180000"), 10);
const DRYRUN = argv.includes("--dry-run");
if (!LABEL || !MODEL) {
  console.error("required: --label <str> --model <str> [--provider lmstudio|anthropic] [--tests all|csv]");
  process.exit(2);
}

const providerObj = () =>
  PROVIDER === "anthropic"
    ? { type: "anthropic", model: MODEL, authTokenEnv: "ANTHROPIC_AUTH_TOKEN", timeoutMs: TIMEOUT }
    : { type: "lmstudio", model: MODEL, timeoutMs: TIMEOUT };

const plan = JSON.parse(readFileSync(join(__dir, "plan.json"), "utf8"));

// Source LM Studio creds from .mcp.json (authoritative) rather than inheriting a
// stray process.env value — a leaked OpenAI sk-proj- key here causes LM Studio to
// 401 "Malformed token". Never hard-code the secret in this script.
let LMS_KEY = process.env.LMSTUDIO_API_KEY ?? "";
let LMS_URL = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
try {
  const mcp = JSON.parse(readFileSync("/Users/nix/dev/node/adhd/.mcp.json", "utf8"));
  const e = mcp.mcpServers?.["agent-mcp-published"]?.env ?? {};
  if (e.LMSTUDIO_API_KEY) LMS_KEY = e.LMSTUDIO_API_KEY;
  if (e.LMSTUDIO_BASE_URL) LMS_URL = e.LMSTUDIO_BASE_URL;
} catch { /* fall back to env */ }

let selected;
if (TESTS === "all") selected = plan.tests.map((t) => t.id);
else selected = TESTS.split(",").map((s) => parseInt(s.trim(), 10));
const runTests = plan.tests.filter((t) => selected.includes(t.id));

// child env the server (and any lead-spawned child server) inherits
const childEnv = {
  ...process.env,
  DATABASE_PATH: DB,
  SSE_PORT: "0", // avoid clashing with the interactive server (BUG-001 fix also covers this)
  LMSTUDIO_API_KEY: LMS_KEY,
  LMSTUDIO_BASE_URL: LMS_URL,
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const textOf = (res) =>
  (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
// the task tool returns a JSON envelope {task_id,status,result}; unwrap to the model text
const unwrap = (raw) => {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && "result" in o)
      return { text: o.result ?? "", task_id: o.task_id ?? null, status: o.status ?? null };
  } catch {}
  return { text: raw, task_id: (raw.match(UUID) ?? [null])[0], status: null };
};

async function main() {
  console.log(`[runner] label=${LABEL} provider=${PROVIDER} model=${MODEL} tests=[${selected.join(",")}] timeout=${TIMEOUT}ms`);
  if (DRYRUN) {
    for (const t of runTests) console.log(`  would run test-${t.id} (${t.mode}) ${t.posing}`);
    return;
  }
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@adhd/agent-mcp@latest"],
    env: childEnv,
    stderr: "inherit",
  });
  const client = new Client({ name: "study-runner", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const call = (name, args) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT + 30000 });

  const created = new Set();
  const ensureAgent = async (name) => {
    const spec = plan.agents[name];
    if (!spec) throw new Error(`no agent spec for ${name}`);
    const mcpServers = JSON.parse(JSON.stringify(spec.mcpServers ?? {}));
    // a lead-style agent spawns its own child server: give it the same DB + creds
    if (mcpServers["agent-mcp"]) {
      mcpServers["agent-mcp"].env = {
        DATABASE_PATH: DB,
        SSE_PORT: "0",
        LMSTUDIO_API_KEY: LMS_KEY,
        LMSTUDIO_BASE_URL: LMS_URL,
        ...(process.env.ANTHROPIC_AUTH_TOKEN ? { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN } : {}),
      };
    }
    try { await call("agent_delete", { name }); } catch {}
    await call("agent_create", {
      name, provider: providerObj(), systemPrompt: spec.systemPrompt,
      mcpServers, permissions: spec.permissions ?? {},
    });
    created.add(name);
  };

  const records = [];
  for (const t of runTests) {
    const needs = new Set(t.needs);
    if (t.mode === "orchestrate") {
      (plan.agents[t.agent]?.permissions?.allowedAgents ?? []).forEach((a) => needs.add(a));
      needs.add(t.agent);
    }
    process.stdout.write(`\n[test-${t.id}] ${t.mode} (${t.posing}) — agents: ${[...needs].join(", ")}\n`);
    try {
      for (const n of needs) await ensureAgent(n);

      if (t.mode === "multiturn") {
        const sess = textOf(await call("agent", { name: t.agent }));
        const session_id = (sess.match(UUID) ?? [])[0];
        if (!session_id) throw new Error(`could not parse session_id from: ${sess.slice(0, 200)}`);
        let step = 0;
        for (const prompt of t.prompts) {
          const u = unwrap(textOf(await call("task", { session_id, prompt })));
          records.push(rec(t, step++, t.agent, prompt, u));
          process.stdout.write(`  step ${step} ok (${u.text.length} chars)\n`);
        }
        try { await call("session_close", { session_id }); } catch {}
      } else {
        // single + orchestrate: one task per prompt against the (lead) agent by name
        let step = 0;
        for (const prompt of t.prompts) {
          const u = unwrap(textOf(await call("task", { agent_name: t.agent, prompt })));
          records.push(rec(t, step++, t.agent, prompt, u));
          process.stdout.write(`  step ${step} ok (${u.text.length} chars)\n`);
        }
      }
    } catch (e) {
      process.stdout.write(`  ERROR: ${e.message}\n`);
      records.push({ ...rec(t, -1, t.agent, t.prompts[0] ?? "", { text: "", task_id: null, status: null }), error: String(e.message) });
    }
  }

  // cleanup created agents — close any active sessions first (an orchestration
  // delegation can leave a sub-agent session open, which blocks agent_delete)
  for (const n of created) {
    try {
      const sl = JSON.parse(textOf(await call("session_list", { agentName: n, status: "active" })) || "[]");
      for (const s of sl) { try { await call("session_close", { session_id: s.id }); } catch {} }
    } catch {}
    try { await call("agent_delete", { name: n }); } catch {}
  }
  await client.close();

  mkdirSync(join(STUDY, "results"), { recursive: true });
  const out = join(STUDY, "results", `runs.${LABEL}.jsonl`);
  writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`\n[runner] wrote ${records.length} step records -> results/runs.${LABEL}.jsonl`);
  const errs = records.filter((r) => r.error);
  if (errs.length) console.log(`[runner] ${errs.length} step(s) errored: tests ${errs.map((e) => e.test).join(",")}`);
}

function rec(t, step, agent, prompt, u) {
  return { label: LABEL, provider: PROVIDER, model: MODEL, test: t.id, scenario: t.scenario,
    tier: t.tier, posing: t.posing, mode: t.mode, step, agent, prompt,
    result: u.text, result_task_id: u.task_id, result_status: u.status };
}

main().catch((e) => { console.error(e); process.exit(1); });
