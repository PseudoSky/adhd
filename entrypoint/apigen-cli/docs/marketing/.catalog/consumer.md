# Consumer Documentation Report — @adhd/apigen-cli

**Role:** Documentation Consumer (fresh eyes, docs only)
**Date:** 2026-07-03
**Scope:** `/Users/nix/dev/node/adhd/entrypoint/apigen-cli`

---

## Task 1 — Serve `hello.ts` as MCP server on SSE transport, port 3000

- **task:** Serve a single TypeScript file as an MCP server with SSE transport on port 3000, then verify it works.
- **outcome:** PARTIAL
- **steps you could take from docs:**

  1. **Exact command found immediately** — README.md, `apigen run` section, Quickstart examples:
     ```bash
     npx @adhd/apigen-cli run --source hello.ts --type mcp --opt transport=sse --opt port=3000
     ```
     All flags are explained in the adjacent flag table.

  2. **`--opt` keys table** confirms the keys and defaults (Common flags section):
     > | `transport` | `mcp` | `stdio` | `stdio` \| `sse` \| `streaming-http` |
     > | `port` | `mcp` (HTTP transports), `api-fastify`, `api-express`, `py-flask` | `3000` | Listen port |

  3. **Install/launch instructions** in Install section:
     ```bash
     npx @adhd/apigen-cli run --source hello.ts --type api-fastify --opt port=8080
     ```

- **gaps:**
  1. **No verification step is documented for MCP over SSE.** The docs show `curl` probes for HTTP servers and `/_meta/health` for `serve`, but for MCP nothing tells the user how to confirm the server is alive. What URL to hit? What MCP client to use?
  2. **How to stop the server?** Mentioned only indirectly ("handles SIGINT/SIGTERM") — a new user might wonder.

- **reader-search signal:**
  - At verification: I wanted to see an endpoint URL or MCP client command to confirm the server is running.

- **verdict:** The docs give the exact invocation but fail to tell the user how to verify the server is running. A new user can **start** the server but cannot **confirm** it works without guessing or reading source.

---

## Task 2 — Generate a runnable Fastify server to disk with workspace deps

- **task:** Generate a Fastify server from TypeScript source to an output directory, including workspace dependency linking, then run the output.
- **outcome:** PARTIAL
- **steps you could take from docs:**

  1. **Base generate command** — README.md, `apigen generate` section:
     ```bash
     apigen generate --source hello.ts --type api-fastify --out-dir ./out/http
     cd ./out/http && npm install && npx tsx server.ts
     ```

  2. **`--link-workspace` flag** documented in the flag table:
     > Emit workspace-linked `node_modules` (for monorepo dev before publish)

  3. **Generated project structure** shown with a tree diagram:
     ```
     ./out/api/
     ├── package.json          # only the deps your code actually uses
     ├── tsconfig.json         # ready to compile
     ├── node_modules/         # linked (with --link-workspace) or via npm install
     ├── server.ts             # the generated server entry point
     └── routes.ts             # generated route handlers
     ```

  4. **Per-surface dependency manifest** is auto-patched:
     > if your function uses `Decimal`, only then does `decimal.js` appear as a dependency.

- **gaps:**
  1. **The `npm install` path and the `--link-workspace` path are both mentioned but the distinction could be clearer.** The tree shows `node_modules/` as "linked (with --link-workspace) or via npm install", which is helpful but the workflow branch is implicit.
  2. **What "workspace deps" are being linked?** The `--link-workspace` section mentions `@adhd/apigen-*` packages, but a new user may not know what those are or that they're needed at runtime.

- **reader-search signal:**
  - Minimal — the docs give a complete end-to-end workflow.

- **verdict:** Docs are sufficient to complete this task. The generate command, output structure, and post-generation workflow are all documented with examples.

---

## Task 3 — One port serving TS (Express) + Python (gRPC) sources

- **task:** Mount a TypeScript source using Express and a Python source using gRPC behind a single port, verify health, and understand failure behavior.
- **outcome:** COMPLETED_DOC_ONLY
- **steps you could take from docs:**

  1. **Command structure** — README.md, `apigen serve` section:
     ```bash
     apigen serve --source <path> [--source ...] --port <port> [--mount <ns>=<plugin> ...]
     ```

  2. **Default plugin mapping**: `.ts` → api-fastify, `.py` → py-flask

  3. **`--mount` explicit assignment** documented:
     > `--mount <ns>=<plugin>` | Pin namespace to specific plugin (repeatable; e.g. `ledger=py-grpc`)
     > **Namespace by default** is the source filename stem.

  4. **Full example** with four frameworks:
     ```bash
     apigen serve \
       --source money.ts \
       --source orders.ts \
       --source billing.py \
       --source ledger.py \
       --port 8080 \
       --mount orders=api-express \
       --mount ledger=py-grpc
     ```

  5. **Health check:**
     ```bash
     curl http://localhost:8080/_meta/health
     ```

  6. **Failure behavior documented:**
     > A dead child fails only its `/<ns>/*` routes (503 HTTP, UNAVAILABLE gRPC).

- **gaps:**
  - None. The namespace derivation ("source filename stem") is documented, the `--mount` syntax is shown, health and failure behavior are clear.

- **reader-search signal:**
  - None.

- **verdict:** Docs are fully sufficient to complete this task.

---

## Summary

| Task | Outcome | Gaps |
|------|---------|------|
| 1. MCP/SSE server on port 3000 | **PARTIAL** | No verification step for MCP over SSE |
| 2. Generate Fastify to disk with workspace deps | **PARTIAL** | Minor clarity on --link-workspace vs npm install branch |
| 3. TS+Python on one port (Express + gRPC) | **COMPLETED_DOC_ONLY** | None |

**Overall:** 2 of 3 tasks are completable from docs alone (Task 3 fully, Task 2 with minor inference). Task 1 needs a verification example for MCP/SSE transport. The `npx @adhd/apigen-cli` command is used throughout, which is the primary consumer path.
