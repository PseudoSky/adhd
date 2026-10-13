# CDP Protocol Overview

## Versioning

CDP uses a major.minor version scheme declared at the top of the PDL files:

```
version
  major 1
  minor 3
```

Current version: **1.3** (Chrome 149+ tip-of-tree). The version is returned by `Browser.getVersion()` or by querying `/json/version`:

```json
{
  "Protocol-Version": "1.3",
  "Browser": "Chrome/149.0.0.0",
  "User-Agent": "...",
  "V8-Version": "..."
}
```

## Transport

CDP supports three transport mechanisms:

### WebSocket (primary)

The browser exposes WebSocket endpoints for both browser-level and page-level debugging:

- **Browser-level WS**: from `/json/version` → `webSocketDebuggerUrl`
- **Page-level WS**: from `/json/list` → each target's `webSocketDebuggerUrl`
- **Pattern**: `ws://host:port/devtools/browser/<browserId>` or `ws://host:port/devtools/page/<targetId>`

### STDIO (headless, pipe)

When Chrome is launched with `--remote-debugging-pipe`, CDP messages flow over stdin/stdout as newline-delimited JSON. Used in headless automation where WebSocket loopback isn't desired.

### HTTP (legacy, REST-like)

Some endpoints are accessible via HTTP fetch:
- `GET /json/version` — browser metadata
- `GET /json/list` — page target list
- `PUT /json/new?url=<url>` — create a new page target
- `GET /json/close/<targetId>` — close a target

These use a simple command ID protocol and are less reliable than WebSocket for ongoing sessions.

## Message Format (JSON-RPC)

CDP uses a JSON-RPC 2.0-like protocol over WebSocket:

### Commands (Client → Browser)

```json
{"id": 1, "method": "Target.createTarget", "params": {"url": "about:blank"}}
```

- `id`: integer — unique per session, matched in response
- `method`: string — `Domain.methodName`
- `params`: object — optional, method-specific parameters

### Command Responses (Browser → Client)

```json
{"id": 1, "result": {"targetId": "..."}}
```

```json
{"id": 1, "error": {"code": -32601, "message": "Method not found"}}
```

- `id`: matches the request
- `result`: object — optional, method-specific return values
- `error`: object — `{code, message, data?}` on failure (JSON-RPC error codes)

### Events (Browser → Client, unsolicited)

```json
{"method": "Target.targetCreated", "params": {"targetInfo": {...}}}
```

- `method`: string — `Domain.eventName`
- `params`: object — event-specific payload
- No `id` field (distinguishes events from responses)

## Session Model

### Flat vs Non-Flat Sessions

When attaching to a target via `Target.attachToTarget`, there are two session modes:

**Non-flat (legacy, deprecated):** Child session messages are relayed through `Target.sendMessageToTarget` / `Target.receivedMessageFromTarget`. The parent must wrap/unwrap messages manually.

**Flat (recommended):** When `flatten: true` is passed to `attachToTarget`, the child session gets a `sessionId`. All commands to the child session include the `sessionId` parameter in the CDP message:

```json
{"id": 2, "sessionId": "...", "method": "Page.navigate", "params": {"url": "..."}}
```

Events from the child session also include `sessionId`. This avoids the indirection of `sendMessageToTarget`/`receivedMessageFromTarget`.

Flat mode is required for `attachToBrowserTarget` and is the future of the protocol. Our `CdpSession` always uses the flat pattern by connecting directly to the target's WebSocket URL, bypassing the session multiplexing entirely.

### Browser-Level Session

Connected to `webSocketDebuggerUrl` from `/json/version`. Can:
- List, create, close, and inspect targets (`Target.*`)
- Query browser-wide state (`Browser.*`, `SystemInfo.*`)
- Subscribe to target lifecycle events (`Target.setDiscoverTargets`)
- Query aggregate histograms (`Browser.getHistograms`)

### Page-Level Session

Connected to a specific page target's `webSocketDebuggerUrl`. Can:
- Navigate and interact with the page (`Page.*`)
- Capture network traffic (`Network.*`)
- Execute JavaScript (`Runtime.*`, `Debugger.*`)
- Query page performance (`Performance.*`)
- Access DOM (`DOM.*`)

Page-level sessions are one-per-target. To interact with multiple pages, open multiple sessions.

## Command/Event/Type Structure

Every CDP domain is organized into three kinds of declarations:

### Commands

Request-response interactions initiated by the client. Each command:
- Has a unique name within its domain (`DomainName.commandName`)
- Accepts optional parameters
- Returns optional result values
- May be `experimental` (unstable, may change)
- May be `deprecated` (removed in future versions, often with a `redirect` to the replacement)

### Events

Unsolicited notifications sent from the browser to the client. Each event:
- Has a unique name within its domain (`DomainName.eventName`)
- Carries event-specific parameters
- Fires only after the domain is `enable`d (or in some cases, after specific commands)
- May be `experimental` or `deprecated`

### Types

Shared data structures:
- `string` — simple string alias, possibly with enum values
- `integer` — integer alias
- `number` — float alias
- `object` — structured type with properties
- `array of <type>` — array type
- `binary` — base64-encoded binary data
- `any` — arbitrary JSON value

Types may `extend` a primitive (e.g., `type NodeId extends integer`) or reference types from other domains (e.g., `Runtime.ScriptId`).

## Domain Dependencies

Domains frequently depend on other domains for their type definitions. For example:
- `DOM` depends on `Runtime` and `Network`
- `Page` depends on `Debugger`, `DOM`, `IO`, `Network`, `Runtime`
- `Accessibility` depends on `DOM`

When a domain is `enable`d, its dependencies are not automatically enabled — you must enable each domain explicitly.
