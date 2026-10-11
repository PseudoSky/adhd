/**
 * Docs contract for backlog 261c9544 (B4 provider-parity docs, PP-DOCS AC1-AC6).
 *
 * `docs/agent/provider-parity.md` is the behavior x provider matrix. A doc that cites file paths and symbols rots
 * silently, so this suite reads the REAL docs and the REAL source and fails with the exact missing path / symbol /
 * claim when the doc and the code drift. No spawn, no network; pure file reads from the repo root.
 *
 * One `it` per acceptance criterion, named `261c9544 AC<n>: ...` so the backlog item can cite them.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const abs = (rel: string): string => join(REPO_ROOT, rel);
const read = (rel: string): string => readFileSync(abs(rel), "utf8");

const DOC = "docs/agent/provider-parity.md";
const BUDGET_README = "packages/agent/agent-plugin-budget/README.md";
const ORCH_README = "packages/agent/agent-engine-orchestrator/README.md";
const AGENT_MCP_README = "entrypoint/agent-mcp/README.md";
const AGENT_MCP_LLMS = "entrypoint/agent-mcp/llms.txt";
const STORE_README = "packages/agent/agent-store-runtime/README.md";

/** Docs that surface the parity doc (README / llms.txt). */
const LINKING_DOCS = [AGENT_MCP_README, AGENT_MCP_LLMS, ORCH_README, BUDGET_README, STORE_README];

/** Every behavior row the matrix must carry (matched as a substring of the row label). */
const MATRIX_ROWS = [
  "Session resume",
  "Tool-call concurrency",
  "`readOnlyHint`",
  "Token estimator",
  "Bounded token count",
  "Tool-result size cap",
  "EOL/CRLF preservation hook",
  "Budget atomic `toolCalls` reservation",
  "Budget `cost` pricing",
  "Unpriced-model signal",
  "`provider:builtin_bypass` warning",
  "`reasoningTokens` reporting",
  "Partial usage on failed attempts",
  "`AGENT_NOT_FOUND` roster listing",
  "`usage_query` id chunking",
  "`task_events` index",
];

const ORCH_SRC = "packages/agent/agent-engine-orchestrator/src";

/** Symbols the doc cites, with the source file that must define or use them. */
const CITED_SYMBOLS: ReadonlyArray<readonly [file: string, symbols: readonly string[]]> = [
  [`${ORCH_SRC}/engine/tool-limiter.ts`, ["createToolLimiter"]],
  [
    `${ORCH_SRC}/engine/orchestrator.ts`,
    ["createToolLimiter", "toolLimiter.map", "toolLimiter.run", "readPartialUsage", "estimateToolResultTokens", "capOrSpillToolResult"],
  ],
  [
    `${ORCH_SRC}/providers/claudecli.ts`,
    ["CONCURRENCY_HINT_TOOLS", "sessionKey", "sessionResumable", "reportBuiltinBypass", "computeClaudeBuiltinArgs", "attachPartialUsage"],
  ],
  [`${ORCH_SRC}/providers/claudecli-bypass.ts`, ["BUILTIN_SKIPPED_BEHAVIOURS"]],
  [`${ORCH_SRC}/engine/tool-result-tokens.ts`, ["estimateToolResultTokens", "boundedTokenCount"]],
  [`${ORCH_SRC}/engine/bounded-token-count.ts`, ["boundedTokenCount"]],
  [`${ORCH_SRC}/providers/anthropic-cache.ts`, ["boundedTokenCount"]],
  [`${ORCH_SRC}/engine/tool-result-spill.ts`, ["capOrSpillToolResult"]],
  [`${ORCH_SRC}/engine/tool-result-cap.ts`, ["DEFAULT_TOOL_RESULT_MAX_CHARS"]],
  [`${ORCH_SRC}/engine/task-event-hooks.ts`, ["registerTaskEventHooks"]],
  [`${ORCH_SRC}/providers/factory.ts`, ["createProvider"]],
  [`${ORCH_SRC}/providers/construct.ts`, ["buildProviderForSelection"]],
  [`${ORCH_SRC}/tools/usage.ts`, ["SQL_IN_CHUNK_SIZE"]],
  ["entrypoint/agent-mcp/src/host-hooks.ts", ["createHostHooks"]],
  ["entrypoint/agent-mcp/src/eol-hook.ts", ["FS_WRITE_TOOLS"]],
  ["packages/agent/agent-plugin-budget/src/index.ts", ["pricingModeSchema", "flatRatesOf", "requestedModelOf", "budget:unpriced_model"]],
  ["packages/agent/agent-core-provider/src/pricing/rate-card.ts", ["estimateCost"]],
];

/** Collapses whitespace so table cells / lines compare as plain text. */
const strip = (s: string): string => s.replace(/\s+/g, " ").trim();

/** One matrix row: label, the three provider cells, and the evidence cell. */
interface IMatrixRow {
  label: string;
  anthropic: string;
  openai: string;
  claudecli: string;
  evidence: string;
}

function matrixRows(doc: string): IMatrixRow[] {
  const section = doc.split(/^## Matrix\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const rows: IMatrixRow[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map(strip);
    if (cells.length !== 5) continue;
    if (cells[0] === "Behavior" || /^-+$/.test(cells[0]!)) continue;
    rows.push({ label: cells[0]!, anthropic: cells[1]!, openai: cells[2]!, claudecli: cells[3]!, evidence: cells[4]! });
  }
  return rows;
}

/** Backtick spans in a document. */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

/** Basenames of every `*.test.ts` under the agent packages (the matrix lists sibling tests by bare name). */
function testFileIndex(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".nx") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".test.ts")) names.add(entry);
    }
  };
  walk(abs("packages/agent"));
  walk(abs("entrypoint/agent-mcp/src"));
  return names;
}

/** Relative markdown link targets in a file, resolved against that file's directory. */
function relativeLinks(file: string): Array<{ raw: string; resolved: string; fragment: string | undefined }> {
  const out: Array<{ raw: string; resolved: string; fragment: string | undefined }> = [];
  for (const m of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, mailto:
    const [target, fragment] = raw.split("#");
    out.push({ raw, resolved: target ? resolve(dirname(abs(file)), target) : abs(file), fragment });
  }
  return out;
}

/** GitHub-style heading anchors of a markdown file. */
function anchors(file: string): Set<string> {
  const set = new Set<string>();
  for (const m of read(file).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    set.add(
      m[1]!
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s/g, "-"),
    );
  }
  return set;
}

describe("261c9544 provider-parity docs contract", () => {
  const doc = existsSync(abs(DOC)) ? read(DOC) : "";

  it("261c9544 AC1: the budget README states the shared per-task limiter and D6 child-limiter semantics, and no longer says the bridge is outside the bound", () => {
    expect(existsSync(abs(DOC)), `${DOC} must exist`).toBe(true);
    const readme = read(BUDGET_README);
    expect(readme).not.toMatch(/outside the bound/i);
    expect(readme).not.toContain("native tool-loop property only");
    expect(readme).toContain("The `toolCallConcurrency - 1` bound holds on every provider.");
    expect(readme).toContain("one per-task limiter keyed on `toolCallConcurrency`");
    expect(readme).toMatch(/`claudecli` loopback MCP bridge/);
    expect(readme).toContain("serialises bridged calls as well");
    // D6: a bridged task call runs its child in the child's own limiter (no deadlock at toolCallConcurrency 1); HITL bypasses the pool.
    expect(readme).toMatch(/child in the child's own limiter/);
    expect(readme).toMatch(/never deadlocks on a slot its child needs/);
    expect(readme).toMatch(/`request_human_input` calls never enter the pool/);
    // The parity doc agrees.
    expect(doc).toMatch(/A child task spawned by a bridged `task` call has its own limiter/);
    expect(doc).toMatch(/`toolLimiter\.run`/);
    expect(doc).toMatch(/`request_human_input` calls bypass the pool/);
  });

  it("261c9544 AC2: the matrix covers every behavior row across anthropic, openai-compatible/DeepSeek and claudecli, with owning tests, paths, symbols, events and the CRLF caveat matching the code", () => {
    const rows = matrixRows(doc);
    expect(rows.length, "matrix must carry at least the 14 spec rows").toBeGreaterThanOrEqual(14);

    // The three provider columns.
    const header = doc
      .split(/^## Matrix\s*$/m)[1]!
      .split("\n")
      .find((l) => l.startsWith("| Behavior"))!;
    expect(header).toMatch(/\|\s*anthropic\s*\|/);
    expect(header).toMatch(/\|\s*openai \/ DeepSeek\s*\|/);
    expect(header).toMatch(/\|\s*claudecli\s*\|/);

    for (const wanted of MATRIX_ROWS) {
      const row = rows.find((r) => r.label.includes(wanted));
      expect(row, `matrix row missing: ${wanted}`).toBeDefined();
      for (const col of ["anthropic", "openai", "claudecli"] as const) {
        expect(row![col], `row "${wanted}" has no applies/n/a/gap verdict in its ${col} cell`).toMatch(/\b(applies|n\/a|gap)\b/);
      }
      expect(row!.evidence.length, `row "${wanted}" cites no evidence`).toBeGreaterThan(20);
    }

    // The three providers are named; OpenAI-compatible/DeepSeek is the openai adapter plus a baseURL override.
    expect(doc).toMatch(/\| anthropic\s+\| `anthropic`/);
    expect(doc).toMatch(/\| openai \/ DeepSeek\s+\| `openai`/);
    expect(doc).toMatch(/\| claudecli\s+\| `claudecli`/);
    expect(doc).toMatch(/`baseURL` override/);

    // Every package-qualified file path the doc cites exists (resolved from the repo root).
    const cited = new Set(
      codeSpans(doc)
        .filter((s) => /^(packages|entrypoint|docs)\/[^\s#]+\.[a-z]+(#[\w-]+)?$/.test(s))
        .map((s) => s.split("#")[0]!),
    );
    expect(cited.size).toBeGreaterThan(30);
    const missing = [...cited].filter((p) => !existsSync(abs(p)));
    expect(missing, `doc cites paths that do not exist: ${missing.join(", ")}`).toEqual([]);

    // Bare `name.test.ts` references resolve to a real test file.
    const bareTests = codeSpans(doc).filter((s) => /^[\w.-]+\.test\.ts$/.test(s));
    expect(bareTests.length).toBeGreaterThan(5);
    const index = testFileIndex();
    const missingTests = bareTests.filter((n) => !index.has(n));
    expect(missingTests, `doc cites test files that do not exist: ${missingTests.join(", ")}`).toEqual([]);

    // Cited symbols exist in the cited file AND are still mentioned by the doc (deleting the claim also goes red).
    const symbolProblems: string[] = [];
    for (const [file, symbols] of CITED_SYMBOLS) {
      const src = existsSync(abs(file)) ? read(file) : "";
      for (const symbol of symbols) {
        if (!src.includes(symbol)) symbolProblems.push(`${file} lacks ${symbol}`);
        if (!doc.includes(symbol.split(".")[0]!)) symbolProblems.push(`doc no longer cites ${symbol}`);
      }
    }
    expect(symbolProblems).toEqual([]);

    // Code claims the matrix rests on: attachPartialUsage is not called by the API adapters; only openai itemises reasoning.
    for (const f of ["anthropic.ts", "openai.ts"]) {
      expect(read(`${ORCH_SRC}/providers/${f}`), `${f} now attaches partial usage; update the matrix`).not.toContain("attachPartialUsage");
    }
    expect(read(`${ORCH_SRC}/providers/openai.ts`)).toContain("reasoning_tokens");
    expect(read(`${ORCH_SRC}/providers/anthropic.ts`)).not.toContain("reasoningTokens");
    expect(read(`${ORCH_SRC}/providers/claudecli.ts`)).not.toContain("reasoningTokens");

    // The two typed task event names are documented and equal the code constants / enums.
    const bypassSrc = read(`${ORCH_SRC}/providers/claudecli-bypass.ts`);
    const bypassName = /BUILTIN_BYPASS_EVENT\s*=\s*"([^"]+)"/.exec(bypassSrc)?.[1];
    expect(bypassName).toBe("provider:builtin_bypass");
    const enumSrc = read(`${ORCH_SRC}/validation/task.ts`);
    const dbSrc = read("packages/agent/agent-store-runtime/src/db/schema.ts");
    for (const ev of ["budget:unpriced_model", bypassName!]) {
      expect(doc, `doc must document ${ev}`).toContain(`\`${ev}\``);
      expect(enumSrc, `TaskEventType must contain ${ev}`).toContain(`'${ev}'`);
      expect(dbSrc, `task_events DB enum must contain ${ev}`).toContain(`"${ev}"`);
    }
    expect(doc).toMatch(/^## Task events\s*$/m);
    expect(doc).toContain("`source` (`allowedBuiltinTools` | `compiledTools` | `agent-spec`)");
    for (const source of ["allowedBuiltinTools", "compiledTools", "agent-spec"]) expect(bypassSrc).toContain(source);

    // The CRLF mixed-ending caveat is documented where built-ins are described and flagged as a gap in the matrix.
    expect(doc).toMatch(/^## Built-ins \(claudecli\)\s*$/m);
    expect(doc).toMatch(/strips every CR from a mixed-ending file/);
    expect(doc).toMatch(/Treat built-in Edit\/Write as unsafe for mixed-ending files/);
    expect(doc).toMatch(/preserves a uniformly CRLF file/);
    expect(rows.find((r) => r.label.includes("EOL/CRLF"))!.claudecli).toMatch(/\*\*gap\*\* for CLI built-in Edit\/Write on mixed-ending files/);
  });

  it("261c9544 AC3: reasoningTokens 0/absent means not itemised, Anthropic folds thinking into output tokens, cost is unaffected", () => {
    expect(doc).toMatch(/`reasoningTokens` of 0 or absent means "not itemised by the provider", not "no reasoning"/);
    expect(doc).toMatch(/Anthropic folds thinking tokens into `output_tokens`/);
    expect(doc).toMatch(/Only the `openai` adapter itemises/);
    expect(doc).toMatch(/Cost is unaffected/);
    const row = matrixRows(doc).find((r) => r.label.includes("`reasoningTokens` reporting"))!;
    expect(row.anthropic).toMatch(/n\/a/);
    expect(row.openai).toMatch(/applies/);
    expect(row.claudecli).toMatch(/n\/a/);
    expect(row.evidence).toMatch(/reasoning is a subset of output tokens/);
    expect(read("packages/agent/agent-core-provider/src/pricing/rate-card.ts")).toMatch(/reasoning/i);
  });

  it("261c9544 AC4: the budget README documents pricing modes, precedence, unpriced behavior and the host behavior change with a migration note, matching the code", () => {
    const readme = read(BUDGET_README);
    expect(readme).toMatch(/^### Cost pricing\s*$/m);

    // The three pricing modes in the docs equal the zod enum in the plugin source.
    const src = read("packages/agent/agent-plugin-budget/src/index.ts");
    const modes = [...(/pricingModeSchema\s*=\s*z\.enum\(\[([^\]]+)\]\)/.exec(src)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(modes).toEqual(["auto", "rate-card", "flat"]);
    for (const mode of modes) {
      expect(readme, `budget README must document pricing mode ${mode}`).toContain(`\`${mode}\``);
      expect(doc, `parity doc must document pricing mode ${mode}`).toContain(`\`${mode}\``);
    }
    expect(readme).toMatch(/`auto` \(default\)/);
    expect(doc).toMatch(/`auto` \(default\)/);

    // Precedence (D2), in both documents.
    expect(readme).toMatch(/Per-agent and per-provider rate overrides[^\n]*take precedence over `defaults`/);
    expect(doc).toMatch(/Precedence: explicit per-agent \/ per-provider rate override, then `defaults\.costPer\*Token`, then the rate card/);

    // Unpriced behavior (D3): never a silent $0, one event per task and model.
    for (const text of [readme, doc]) {
      expect(text).toMatch(/never a silent \$0/);
      expect(text).toContain("`budget:unpriced_model`");
      expect(text).toContain("`usedFlatRates`");
    }

    // Host behavior change (D4) + migration note.
    expect(readme).toMatch(/Migration note: the default changed/);
    expect(readme).toMatch(/\*\*Host default\.\*\*[^\n]*`ADHD_AGENT_BUDGET_COST_USD`[^\n]*`pricing: "rate-card"`/);
    expect(readme).toMatch(/set explicit `costPerInputToken` \/ `costPerOutputToken`/);
    expect(doc).toMatch(/sets `pricing: "rate-card"` for that cap instead of injecting flat Sonnet rates/);
    const cfg = read("entrypoint/agent-mcp/src/config.ts");
    expect(cfg).toContain("ADHD_AGENT_BUDGET_COST_USD");
    expect(cfg).toMatch(/pricing:\s*['"]rate-card['"]/);
  });

  it("261c9544 AC5: no doc claims single-writer / single-process behavior (repo hard rule: parallel-process enabled)", () => {
    const claim = /single[- ](writer|process)|not safe (for|under) (concurrent|multiple)[- ]process|only one process (may|can) (write|open)/i;
    const offenders: string[] = [];
    for (const file of [DOC, ...LINKING_DOCS]) {
      read(file)
        .split("\n")
        .forEach((line, i) => {
          if (claim.test(line)) offenders.push(`${file}:${i + 1}: ${strip(line).slice(0, 120)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("261c9544 AC6: READMEs and llms.txt link the parity doc and every markdown link in the touched docs resolves (file and heading anchor)", () => {
    for (const file of [AGENT_MCP_README, ORCH_README, BUDGET_README, STORE_README]) {
      const links = relativeLinks(file).filter((l) => l.resolved === abs(DOC));
      expect(links.length, `${file} must link ${DOC}`).toBeGreaterThan(0);
    }
    expect(read(AGENT_MCP_LLMS), `${AGENT_MCP_LLMS} must name ${DOC}`).toContain(DOC);

    // Executed link check (files and anchors) over the parity doc and every markdown doc that links it.
    const broken: string[] = [];
    for (const file of [DOC, ...LINKING_DOCS.filter((f) => f.endsWith(".md"))]) {
      for (const link of relativeLinks(file)) {
        if (!existsSync(link.resolved)) {
          broken.push(`${file}: ${link.raw} -> missing file`);
          continue;
        }
        if (link.fragment && link.resolved.endsWith(".md") && !statSync(link.resolved).isDirectory()) {
          const rel = link.resolved.slice(REPO_ROOT.length + 1);
          if (!anchors(rel).has(link.fragment)) broken.push(`${file}: ${link.raw} -> missing anchor #${link.fragment}`);
        }
      }
    }
    expect(broken).toEqual([]);

    // Backtick-cited `path.md#anchor` references in the parity doc resolve too (e.g. the budget README cost-pricing anchor).
    const refs = codeSpans(doc).filter((s) => /^(packages|entrypoint|docs)\/[^\s#]+\.md#[\w-]+$/.test(s));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const [p, frag] = ref.split("#");
      expect(anchors(p!).has(frag!), `${ref}: anchor not found`).toBe(true);
    }
  });
});
