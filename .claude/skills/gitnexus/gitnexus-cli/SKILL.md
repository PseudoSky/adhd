---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

All commands work via `npx` — no global install required.

## Commands

### analyze — Build or refresh the index

```bash
npx gitnexus analyze
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.gitnexus/`, and generates CLAUDE.md / AGENTS.md context files.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--force`      | Force full re-index even if up to date                           |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |

**When to run:** First time in a project, after major code changes, or when `gitnexus://repo/{name}/context` reports the index is stale. In Claude Code, a PostToolUse hook detects staleness after `git commit` and `git merge` and notifies the agent to run `analyze` — the hook does not run analyze itself, to avoid blocking the agent for up to 120s and risking KuzuDB corruption on timeout.

### status — Check index freshness

```bash
npx gitnexus status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
npx gitnexus clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
npx gitnexus wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.gitnexus/config.json` on first use).

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist      |

### list — Show all indexed repos

```bash
npx gitnexus list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding

## Concurrency contract for `gitnexus-singleton.sh` (backlog 2cd99264)

`~/.local/bin/gitnexus-singleton.sh` is a **kill-and-replace** wrapper, not a
multiplexer. Its body is exactly:

```bash
pkill -f 'node.*gitnexus mcp' 2>/dev/null || true
exec npx gitnexus mcp
```

**Contract: it supports exactly ONE live client.** Every invocation first
`pkill`s any running `node … gitnexus mcp` process, then `exec`s a fresh one.
There is no `flock`, no pidfile, no shared-socket queue. Consequences:

- N concurrent clients (e.g. N `claude` CLI subprocesses each configured with
  `mcpServers.gitnexus` → this script, as happened in the 29-way agent-mcp
  backlog-triage dispatch) do **not** share one server. Each new connection
  kills the others' server, which surfaces as repeated
  **"MCP server disconnected" / reconnected** notices in *every* client —
  including an interactive session that merely shares the same script.
- The reconnects correlate with, and can be mistaken for, a gitnexus bug or a
  task timeout; the root cause is this kill-and-replace behaviour, not GitNexus.

**Safe patterns:**

1. **Interactive session** → point `mcpServers.gitnexus.command` at a plain,
   long-lived `npx gitnexus mcp` (or `gitnexus mcp`) entry, *not* this script;
   the host owns one server per client and never re-kills it.
2. **Fan-out of dispatched agents** → give the agents an **isolated** GitNexus
   instance each (their own command entry), or have them share the *interactive*
   server via a transport that multiplexes (a single long-lived stdio server
   cannot be shared by two processes anyway — stdio is 1:1). Do **not** wire
   every agent to the same kill-and-replace script.
3. **One shared index, many readers** → prefer a long-lived HTTP/SSE GitNexus
   server (if your build supports it) so readers attach without spawning.

There is no supported concurrent-client count for the kill-and-replace script:
the correct answer is N = 1. Any wiring that fans this script out to N clients
is misconfigured; fixing the wiring, not the script, is the remedy.

