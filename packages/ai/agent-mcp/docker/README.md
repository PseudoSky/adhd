# agent-mcp chat stack (Docker)

Chat with your **agent-mcp agents** through **LibreChat**, with tools / sub-agent
delegation / HITL running server-side. LibreChat talks to the OpenAI-compatible **chat
gateway** (`/v1/models` + `/v1/chat/completions`) that agent-mcp serves on its HTTP/SSE
server. See `../../../docs/agent-mcp-chat-gateway/SPEC.md` for the design.

```
docker/
  docker-compose.yml   agent-mcp gateway + LibreChat + mongo + meilisearch
  librechat.yaml       the custom-endpoint wiring (agents → models, session header)
  .env.example         secrets to fill in
```

## Quickstart (self-contained — needs @adhd/agent-mcp ≥ 2.1.0 on npm)

```bash
cd packages/ai/agent-mcp/docker
cp .env.example .env
# fill ADHD_AGENT_*_SECRET, and generate the LibreChat secrets:
#   CREDS_KEY=$(openssl rand -hex 32)  CREDS_IV=$(openssl rand -hex 16)
#   JWT_SECRET=$(openssl rand -hex 32) JWT_REFRESH_SECRET=$(openssl rand -hex 32)
#   MEILI_MASTER_KEY=$(openssl rand -hex 16)
docker compose up -d
open http://localhost:3080      # register a local account → pick the "agent-mcp" endpoint
```

The gateway's model picker is populated from your agents (`GET /v1/models`). Each LibreChat
conversation is bound to an agent-mcp **session** via the `X-AgentMcp-Session` header (its
`conversationId`); the gateway forwards only the new turn and agent-mcp owns the history.

**Agents:** a fresh `agentmcp_data` volume starts empty. To chat with agents you already
created, bind-mount your SQLite file — uncomment in `docker-compose.yml`:
```yaml
# - ../../../../data/agent-mcp/agents-dev.db:/data/agents.db
```
(The DB file is portable; the native driver is installed inside the container.) Otherwise
create agents first via the MCP tools (`agent_create`).

## Run the gateway from a local build (pre-2.1.0, or for dev)

The chat gateway ships in `@adhd/agent-mcp@2.1.0`. **Until that's published**, run the
gateway from your local build on the **host** and point LibreChat at it:

1. Start the gateway on the host (from the repo root):
   ```bash
   npx nx build agent-mcp
   ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db \
   ADHD_AGENT_SSE_HOST=0.0.0.0 ADHD_AGENT_SSE_PORT=3010 \
   node dist/packages/ai/agent-mcp/src/index.js
   ```
2. In `docker-compose.yml`, **comment out the `agent-mcp` service** (and its `depends_on`).
3. In `librechat.yaml`, set `baseURL: "http://host.docker.internal:3010/v1"`.
4. `docker compose up -d` (mongo + meilisearch + librechat only).

## Notes / caveats
- **`deepseek`** returns `402 Insufficient Balance` until that account is funded — use
  **`claude-oauth`** for a clean first test.
- **LibreChat specifics are version-sensitive.** The image tag, required env vars, and the
  `librechat.yaml` schema/version can change — confirm against
  https://docs.librechat.ai if a step misbehaves.
- **Secrets:** `.env` is gitignored; never commit real keys. The gateway never sees provider
  keys directly — agents reference them by `ADHD_AGENT_*` name, resolved from this `.env`.
- **Session persistence:** in the current build, the conversation→session binding is held in
  the gateway's memory and is lost on restart (a new session is created from resent history).
  Durable binding (`session_aliases`) is the P1 item in the SPEC.
