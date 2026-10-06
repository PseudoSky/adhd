---
name: gitnexus-singleton
description: Use when running, wiring, or killing the gitnexus MCP server or CLI concurrently (multiple claude sessions, agent fan-out, or anything that launches `gitnexus mcp` via gitnexus-singleton.sh). Documents the one-live-client kill-and-replace contract and the safe patterns.
---

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

