# Architect spec: apigen sources (`remote`, `bin`) and wrapping

Status: draft for owner review. Behaviors only; creates no package. Companion to `architect-spec.md`. Owner direction: foreign MCP servers, remote APIs and commands are governed by extending apigen with two source kinds, `remote` and `bin`, not by hand-written policy shells. A source is extracted to apigen's IR (JSON Schema 2020-12 operations) and executed through an invoker; every host and Layer, including the policy Layer (`architect-spec-layer.md`), then works on it unchanged. The work belongs to apigen (OD-32); this file records what policy needs from it. Format, status codes and ID resolution: see `architect-spec.md`.

Transparent means: an unmodified host and an unmodified upstream work through it, and the operation names the host sees are unchanged.

## 1. Sources (SRC)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| SRC-01 | apigen MUST accept two source kinds beside source files: `remote:<url>` and `bin:<command>`. Both extract to the same IR as file sources, so every host, Layer and plugin works on them unchanged. Source-kind code lives in apigen, not in policy. | owner direction | O |
| SRC-02 | `remote` MUST detect the upstream protocol by probing the URL. v1 supports MCP (`tools/list`) and OpenAPI. GraphQL and gRPC (reflection) are later (OD-31). | owner direction | O |
| SRC-03 | An extracted remote operation MUST carry the upstream's JSON Schema `input` and `output`, its description, and any hints the protocol provides (MCP `readOnlyHint` and `destructiveHint`; OpenAPI `format`, parameter location and security schemes). | MCP tool schema; OpenAPI | O |
| SRC-04 | Executing a `remote` operation MUST go through a network invoker that translates the IR call into the upstream protocol call and returns the upstream result or error. | owner direction | O |
| SRC-05 | `bin` MUST classify the command: script or source in a supported language goes to the existing extractor for that language; anything else goes to a help-text extractor; when no interface can be extracted it falls back to one operation `{ argv: string[], cwd }` (SV-20). Compiled binaries get only the fallback in v1. | owner direction | O |
| SRC-06 | Extracting a `bin` MUST be static where possible. Running the binary (for example `--help`) executes unreviewed code and MUST be explicit, MUST never happen silently at serve time, and SHOULD run confined when a launcher is available. | (new) | O |
| SRC-07 | Executing a `bin` operation MUST spawn the command with argv built from the IR arguments, preserving stdio, environment and exit code. | (new) | O |
| SRC-08 | Every extracted argument MUST carry a `kind` (for example `path`, `url`, `host`, `command`, `id`) and a `provenance` of `declared` or `inferred`. Inference from a name or description is a heuristic and MUST be marked `inferred`. Policy may match on `kind`. | owner direction | O |
| SRC-09 | Operation names pass through unchanged from the upstream. A configured source name is used only to match permissions (`<name>.<operation>`). | GW-03 (moved) | S |
| SRC-10 | A remote IR carries a version (etag, document hash or tool-list hash). A change notification (`list_changed`) or a changed version MUST invalidate the IR. A call to an operation absent from the current IR MUST fail, and an operation with no matching permission is denied (GW-09). | (new); OD-33 | O |
| SRC-11 | `adhd-policy draft` (the `draft` operation) MUST take an IR and produce a draft policy: read or write class from the hints, argument kinds from SRC-08 (marked inferred), and a deny entry for secret-path patterns. The author reviews and edits it; a draft is never loaded as a default. | owner direction | O |
| SRC-12 | The invoker MUST expose a credential seam: given the operation and the call's attributes it asks a provider for upstream credentials. apigen and policy store and forward none themselves; the provider is the auth layer or a broker. Forwarding an inbound token as-is is decided by the auth layer (open in `research-auth-mechanisms.md`). | SC-03(d) | O |
| SRC-13 | The IR represents request-and-response operations only. Resources, prompts, sampling, streaming, GraphQL selection sets and gRPC streams are not represented in v1; a source that offers them exposes only its operations and says so once on stderr (GW-10). | (new) | O |
| SRC-14 | Hints from a remote (annotations, descriptions) are the upstream's claims. A hostile upstream can lie, so hint-derived classes are a guardrail, not a security boundary (SC-08). | SC-08 | S |

## 2. Wrapping behavior (GW)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| GW-01 | The policy Layer MUST see every call of every operation of a source before the invoker runs it. | D3 > How a call is evaluated | S |
| GW-02 | It MUST work with an unmodified upstream. | D3 > Gateway guarantees and limits | S |
| GW-03 | The names the host sees MUST equal the upstream's names (SRC-09). | D4 > File 2 | S |
| GW-04 | For each call the Layer MUST build the row from the call's arguments, select applicable permissions, substitute `$attributes.*`, evaluate with the query engine, and decide. | D3 > How a call is evaluated | S |
| GW-05 | Allowed calls MUST be forwarded with `set` values applied. Denied calls MUST NOT reach the upstream. | D3 > How a call is evaluated | S |
| GW-06 | A denial MUST be returned to the caller as an error with a reason (`permission_denied`). | D3 > How a call is evaluated | S |
| GW-07 | The serving process MUST run outside the sandbox of the agent whose calls it mediates, and be reachable from inside it. | D4 > Trace; D3 > Gateway limits | S |
| GW-08 | A child's serving process MUST be started by the parent's side, never by the child. | D4 > Rules > 2 | S |
| GW-09 | An operation with no matching permission MUST be denied. | D3 > Gateway limits > 7 | S |
| GW-10 | Resources, prompts and server-initiated requests are not forwarded in v1 (SRC-13) and the wrapper MUST say so, never silently drop them. | D3 > Gateway limits > 6 | S |
| GW-11 | Wrapping MUST NOT claim to filter responses. | D3 > Gateway limits > 5 | S |
| GW-12 | Wrapping MUST NOT claim to narrow unstructured arguments (free text, manifests, SQL). Such operations are denied or fronted by an adapter. | D3 > Gateway limits > 4 | S |
| GW-13 | Calls that bypass the wrapper (servers launched directly, host built-in tools) are not governed. Every server in `.mcp.json` MUST route through it. | D3 > Gateway limits > 1 | S |
| GW-14 | Wrapping MUST NOT claim to contain what an operation does internally. | D3 > Gateway limits > 2, 3 | S |
| GW-15 | Wrapping MUST NOT claim to close the window between checking an argument and the upstream using it. Only the kernel layer does. | D3 > Gateway limits > 9 | S |
| GW-16 | The wrapper adds a hop per call. Its latency MUST be measured (tracing plugin, IN-15) before any performance claim. | D3 > Gateway limits | U |
| GW-17 | Every allow, ask and deny decision MUST come from the client's `evaluate`. Source and invoker code MUST NOT contain evaluation code. | `architect-spec.md` SV-02 | S |
| GW-18 | The wrapper keeps no counters. When a runtime provider is configured, evaluation goes through the client's service layer, which observes through that provider (RT-08, SV-07). | RT-08 | S |
| GW-19 | A starting wrapper MUST take its attributes from the sources of LC-01 and MUST start with the empty set when none are given (AT-09). It MUST refuse to start if supplied attributes are not a JSON object. | LC-01, AT-09 | S |
| GW-20 | For an operation the policy declares child-creating, the Layer MUST call `narrow`, enforce a denial, and deliver the child attributes by a channel the deployer configures (DL-02). The wrapper invents no reference. | NR-02, DL-01, DL-02 | S |

## 3. Ask and human approval (AK)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| AK-01 | An `ask` decision MUST send the call to the host for approval. Until apigen has an approval-required result (OD-16), a host without an approval channel treats `ask` as `permission_denied`. | D4 > File 1; D3 > ask | S |
| AK-02 | The prompt MUST offer allow once, allow always for this context, and deny. | D3 > ask | S |
| AK-03 | If no host can prompt, or nobody answers, the call MUST be denied. It MUST NOT hang and MUST NOT be allowed. | D3 > ask | S |
| AK-04 | "Allow always" MUST write to the local user-only layer. Agents MUST NOT be able to add allow rules. | D3 > ask; D4 > File 1b | S |
| AK-05 | A deny from any layer MUST NOT be turned into an allow by an answer. | D4 > Reference vocabulary | S |
| AK-06 | How a child's ask reaches its dispatcher (as opposed to the host) is not specified. | (not covered) | O |

## 4. Wrapping the `.mcp.json` (WM)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| WM-01 | A wrapped entry has the form `command: adhd-policy`, `args: [serve, <source>, --spec <file>]`, where `<source>` is `bin:<original command and args>` or, for an entry that had a `url`, `remote:<url>`. The host sees a normal stdio MCP server entry. | D4 > File 2 | S |
| WM-02 | The wrapper speaks stdio to the host because WM-01 replaces the entry with a command. Upstream traffic goes through the source's extractor and invoker (SRC-02, SRC-04, SRC-07). | D4 > File 2 | S |
| WM-04 | `adhd-policy mcp-json init` MUST rewrite an existing `.mcp.json` to wrap every server entry, MUST write a backup of the original, and MUST be reversible (`--undo`). It is the only wrapper command that writes a file. It is an ordinary operation of the wrapper with no policy logic. | PD-11, D4 > File 2 | S |
| WM-05 | An entry already wrapped MUST NOT be wrapped twice. | WM-04 | S |
| WM-06 | A `bin` upstream is started through apigen's spawn runner, so a launcher can confine it without changing the wrapper (GW-07, SB-*). | architect-spec-sandbox.md | S |
| WM-07 | The wrapper MUST resolve its configuration (policy location, log directory, attribute source) through the environment package, the same cascade as every other entrypoint. | EV-01 | S |
| WM-08 | Wrapping needs the policy wrapper package, its apigen dependencies and the policy Layer. It MUST NOT require a running policy server, a sandbox, agent-mcp, a database server, an auth layer, or any other process. A remote upstream needs network access to that upstream. | D4 > File 2 | S |
| WM-09 | Wrapping MUST NOT require any change to the host, to the upstream server, or to the policy-governed agent definitions. The only edit is the `.mcp.json` entry (WM-01), and it is reversible (WM-04). | D4 > File 2 | S |
| WM-10 | The wrapper MUST call the client in-process (library), compiling the policy once and memoizing it (CC-01). The remote path through the MCP or HTTP entrypoint is an optional alternative, never a default. | GW-17 | S |
| WM-11 | With no policy file present, a wrapped upstream MUST run under the built-in default policy (PD-04, EV-06), and the wrapper MUST say so once on stderr. | PD-04 | S |

## Rows moved from the policy spec (GM)

| ID | Behavior | Demo reference | Status |
|---|---|---|---|
| PD-11 | The wrapper's `mcp-json init` MUST wrap every server in an existing `.mcp.json` and back up the original file. | D3 > .mcp.json; D4 > File 2 | S |
| RT-05 | A runtime provider that supplies `mode` MUST derive it from the credential the invoker injected (test or live), not from anything the caller supplies. | D4 > Reference vocabulary | U |
| CC-09 | A running wrapper MUST either keep the policy it started with or reload on a verified change. It MUST define which, and MUST NOT mix two versions inside one decision. | (new) | O |

## Non-goals moved (GN)

| ID | Statement | Demo reference |
|---|---|---|
| NG-01 | Wrapping does not filter responses. | D3 > Gateway limits > 5 |
| NG-04 | The system does not govern host built-in tools or servers launched directly. | D3 > Gateway limits > 1 |

## Proof suite (GPS)

| ID | Test | Behaviors covered | Negative control |
|---|---|---|---|
| PS-04 | Three-level chain through a stub child-creating operation behind a `remote:` stub: the grandchild never exceeds the root. | NR-01, NR-07 | Remove the narrowing deny entry |
| PS-05 | Supplied attributes that are not a JSON object make the wrapper refuse to start; none supplied starts it with the empty set. | GW-19, AT-09 | Accept any value |
| PS-08 | An unanswered `ask` denies. | AK-03, FC-04 | Default the answer to allow |
| PS-13 | Wrapper latency per call is measured and reported. | GW-16 | Not applicable |
| PS-19 | A plain MCP client driving `serve remote:<stub MCP>` with the policy Layer: a child that exceeds the parent is rejected, and one within it is forwarded with the child attributes delivered by the configured channel. | GW-*, NR-*, DL-* | Remove the narrowing check |
| PS-21 | A real `.mcp.json` entry wrapped by `mcp-json init`, with only the wrapper installed and no other process: allowed calls to a stub stdio server behave exactly as unwrapped, a denied call never reaches it, a forced `set` value arrives, an `ask` with no channel denies, and `init` then `init --undo` restores the original file byte for byte. | WM-01 to WM-11, SV-14 | Wrap a policy-free pass-through (denied call reaches the server) |
| PS-25 | `remote:<stub MCP>` and `remote:<stub OpenAPI>` extract to the same IR shape and a deny works identically on both. | SRC-02, SRC-03, GW-04 | Evaluate only on the MCP path |
| PS-26 | The real filesystem MCP server behind `serve remote:`/`bin:` with a draft policy from `draft`: a read inside the read roots is allowed, a write is denied for a read-only caller, `.env` is denied on every path-kind argument including `source` and `destination`, and the 13 tools needed no hand mapping. | SRC-08, SRC-11 | Drop the `kind` match |
| PS-27 | A changed remote tool list invalidates the IR; a call to a removed tool fails and a new tool with no permission is denied. | SRC-10, GW-09 | Cache the IR forever |
| PS-28 | `bin:` extraction of an unknown binary does not execute it unless explicitly asked. | SRC-06 | Run `--help` implicitly |

## Open decisions (GO)

| ID | Decision | Current default | Affects |
|---|---|---|---|
| GO-01 | Bin name. The owner named it `adhd-policy`: the wrapper, with the apigen verbs plus `run`, `serve` and `mcp-json`. Whether `adhd-policy` is a thin alias of `apigen` with the Layer preloaded is IF-11. | `adhd-policy` | all |
| OD-13 | Whether a running wrapper hot-reloads on policy change. | Keep the version it started with | CC-09 |
