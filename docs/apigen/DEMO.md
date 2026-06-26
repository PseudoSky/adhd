# apigen — A Guided Tour (from zero)

This document assumes you have **never seen apigen**. It explains what it is, the problem it removes,
and then walks every capability we built — step by step — telling you, for each one, **how to use it**
and **why it exists (the goal)**.

---

## What apigen is

You write ordinary functions:

```ts
export async function quote(amount: Decimal, asOf: Date): Promise<Quote> { … }
```

Normally, to expose that over an API you'd hand-write an MCP server, *or* a REST controller, *or* a CLI,
*or* a gRPC service — and you'd re-describe the types in a schema, and you'd discover that a `Date` or a
`Decimal` doesn't survive JSON cleanly. You'd do that again for the next protocol, and again in the next
language.

**apigen reads your unmodified source and projects it into an API surface — any protocol — with the rich
types preserved, in any language, behind one endpoint.**

Two goals drive everything:

1. **Write once, expose everywhere — without changing your code.** The protocol (MCP, HTTP, CLI, gRPC) is
   a deployment choice, never a rewrite. Your code is the single source of truth.
2. **Rich types and polyglot fidelity.** A `Date`, a `Decimal`, a 64-bit integer, a custom class, a union
   — they round-trip intact, and they mean the *same bytes* whether the function runs in TypeScript or
   Python.

## How it works in one breath

apigen **extracts** a language-neutral *descriptor* from your source (function names, parameter types,
return types), then **projects** that descriptor onto whatever surface you ask for. Rich types are carried
by a **canonical wire contract** (one exact encoding per type), so every transport and every language agree
on the bytes. Mixed-language apps run each source in its own runtime behind a **gateway**.

## Setup — build the CLI, then everything below is runnable

`apigen` is **not** preinstalled. In this repo you build it from source, alias it, and create the small
sample files the tour uses. **This guide is runnable end-to-end — execute each Part's commands and read
the output to see exactly what works.**

```bash
# 1. build the CLI
cd /Users/nix/dev/node/adhd
npx nx build apigen-cli                  # → dist/packages/apigen/cli/index.js (the runnable CLI)

# 2. expose it as `apigen` (absolute path, so it works from any directory)
alias apigen='node /Users/nix/dev/node/adhd/dist/packages/apigen/cli/index.js'
apigen --help                            # verify it runs

# 3. a scratch workspace UNDER the repo (so deps like decimal.js resolve) + the sample files
mkdir -p /Users/nix/dev/node/adhd/tour && cd /Users/nix/dev/node/adhd/tour

cat > hello.ts <<'EOF'
export async function greet(name: string): Promise<string> { return `hello, ${name}`; }
EOF

cat > myapi.ts <<'EOF'
import Decimal from 'decimal.js';
export async function echoString(s: string): Promise<string> { return s; }
export async function echoBigInt(n: bigint): Promise<bigint> { return n; }
export async function echoDate(d: Date): Promise<Date> { return d; }
export async function echoDecimal(d: Decimal): Promise<Decimal> { return d; }
export async function echoBytes(b: Uint8Array): Promise<Uint8Array> { return b; }
export async function echoReadonlyArray(xs: readonly string[]): Promise<readonly string[]> { return xs; }
export interface Dog { kind: 'dog'; bark: string } export interface Cat { kind: 'cat'; meow: string }
export async function describeAnimal(a: Dog | Cat): Promise<string> {
  return a.kind === 'dog' ? `woof:${a.bark}` : `purr:${a.meow}`;
}
export class Wallet {
  constructor(public owner: string, public balance: Decimal) {}
  async deposit(x: Decimal): Promise<Decimal> { this.balance = this.balance.plus(x); return this.balance; }
  toJSON() { return { owner: this.owner, balance: this.balance.toString() }; }
}
export async function makeWallet(owner: string, opening: Decimal): Promise<Wallet> { return new Wallet(owner, opening); }
EOF

cat > orders.ts <<'EOF'
export async function placeOrder(sku: string, qty: number): Promise<{ sku: string; qty: number; ok: boolean }> {
  return { sku, qty, ok: qty > 0 };
}
EOF
```

**Run every example below from `/Users/nix/dev/node/adhd/tour`**, in a shell where the `apigen` alias is
set (re-run the alias line if needed, or substitute the full
`node /Users/nix/dev/node/adhd/dist/packages/apigen/cli/index.js`).

> The published `@adhd/apigen-cli` on npm is older (`0.1.0`, and its bin is `apigen-cli`); the rich-type
> features in this guide need the local build above.

---

## Part 1 · Your very first API

Take a plain file, `hello.ts`:

```ts
export async function greet(name: string): Promise<string> {
  return `hello, ${name}`;
}
```

Serve it live — no build, no schema, no edits:

```bash
apigen run --source hello.ts --type api-fastify --opt port=8080
curl -sX POST localhost:8080/hello/greet -H 'content-type: application/json' -d '{"data":{"name":"ada"}}'
# → hello, ada
```

> **Goal — code-first (Tenet 1).** Your existing function *is* the API. apigen never asks you to annotate,
> decorate, or restate types. What you wrote is what gets served.

`run` serves immediately (great for the dev loop). `generate` writes a real project to disk you can ship
(Part 6). Same descriptor, two outputs.

> **Goal — fast loop *and* shippable artifact.** `run` = instant feedback; `generate` = a deployable package.

---

## Part 2 · One definition → every protocol

The same `--source`, a different `--type`:

```bash
apigen generate --source hello.ts --type mcp         --out-dir ./out/mcp        # AI tool server (stdio/SSE/streamable-HTTP)
apigen generate --source hello.ts --type api-fastify --out-dir ./out/fastify    # HTTP (Fastify)
apigen generate --source hello.ts --type api-express --out-dir ./out/express    # HTTP (Express)
apigen generate --source hello.ts --type cli         --out-dir ./out/cli        # a command-line tool
apigen generate --source hello.ts --type cli-output  --out-dir ./out/cli2       # a runnable CLI binary
apigen generate --source hello.ts --type jsonschema  --out-dir ./out/schema     # the input/output schemas
```

> **Goal — write once, expose everywhere.** MCP for AI agents, HTTP for services, CLI for scripts — all
> from one function set. Switching or adding a protocol is a flag, never a rewrite.

The schema apigen emits was **inferred** from your real types. A surface using rich types shows their
logical formats with zero annotations from you:

```
"format": "date-time"   "format": "int64"   "format": "decimal"   "format": "byte"
```

> **Goal — the schema is derived, not authored.** You never maintain a separate API spec that drifts from
> the code. The code is the spec.

---

## Part 3 · The types that normally break

Plain JSON quietly mangles real-world types: a `Date` becomes `{}` or a non-UTC string, a 64-bit integer
loses precision past 2⁵³, a `Decimal` becomes a lossy float, bytes have no representation. apigen carries
each through a **canonical wire encoding**, so they survive.

```ts
export async function echoBig(n: bigint): Promise<bigint> { return n; }        // 64-bit integer
export async function when(d: Date): Promise<Date> { return d; }                // instant
export async function price(d: Decimal): Promise<Decimal> { return d; }         // exact decimal
```

```bash
curl … /demo/echoBig  -d '{"data":{"n":"9007199254740993"}}'   # → 9007199254740993   (exact, past 2^53)
curl … /demo/when     -d '{"data":{"d":"2024-01-15T12:00:00.000Z"}}'   # → RFC3339 UTC, unchanged
curl … /demo/price    -d '{"data":{"d":"123.456"}}'   # → 123.456   (never a float)
```

Per type, the goal:

- **`Date` → RFC3339 UTC string.** *Goal: instants survive with timezone-correct, millisecond fidelity.*
- **`bigint`/int64 → decimal string.** *Goal: no silent precision loss for large integers.*
- **`Decimal` → decimal string.** *Goal: money/precision math stays exact, never a binary float.*
- **`bytes` → base64.** *Goal: binary data has a real, lossless wire form.*
- **`UUID`, durations, number specials (`NaN`/`±Infinity`).** *Goal: every common type has one unambiguous encoding.*

### Custom classes and unions

```ts
export class Wallet { constructor(public owner: string, public balance: Decimal) {} … }
export type Animal = { kind: 'dog'; bark: string } | { kind: 'cat'; meow: string };
```

- **Nominal classes** are reconstructed as **real instances** on decode (not bare objects).
  *Goal: your domain types survive serialization with their identity and methods intact.*
- **Discriminated unions** dispatch to the correct variant by the wire discriminator.
  *Goal: polymorphism works across the wire — `Dog|Cat` arrives as the right thing.*

### Same value, every language

```bash
python3 -m apigen_python.gateway_adapter --module myapi.py --namespace py
```

The Python host encodes the **same canonical wire** as TypeScript. A `Decimal("123.456")` produces the
*identical bytes* on both — proven by a cross-language conformance suite that fails if any host drifts.

> **Goal — polyglot, one wire.** A type means the same thing in every language. This is what makes a
> mixed TS/Python (later Rust/Go/Java) API actually safe, not just superficially connected.

### Two correctness guarantees worth knowing

- **Schema-less positions still work.** At a genuinely `any` position, a rich value is carried in a small
  self-describing `$apigen` envelope. *Goal: no fidelity loss even where the schema can't disambiguate.*
- **Structure is authoritative; hints are only accelerators.** apigen adds optional `x-apigen-*` hints, but
  it produces the identical result with them stripped. *Goal: correctness never depends on annotations —
  the same promise as Tenet 1.*

---

## Part 4 · Shape behavior without editing your code

Everything here is added **out of source** — your function never changes.

- **`ctx` convention.** A first parameter named `ctx` is excluded from the public schema and injected at
  runtime. `getUser(ctx, userId)` exposes only `userId`.
  *Goal: pass runtime context (db handle, auth) into your function without leaking it into the API.*

- **Envelope from transport metadata.** Session/auth fields come from **headers** (`x-adhd-<field>`), not
  the body; the same field in the body is ignored.
  *Goal: keep the payload clean and put context/identity where it belongs — the transport.*

- **Central validation Layer.** Invalid input is rejected before your function runs.
  *Goal: your function only ever sees valid, well-typed input.*

- **Layer & mount plugins via `--use`.** Compose cross-cutting behavior at run time:

  ```bash
  apigen run --source myapi.ts --type api-fastify --use logger --use health
  ```

  `logger` adds per-operation logging; `health` adds a health endpoint; you can add your own.
  *Goal: logging, health, auth, rate-limiting — added by composition, never by editing business logic.*

- **HTTP verb derivation, overridable out of source.** Safe operations become `GET`, others `POST`; you can
  flip a specific one via a projection override (`--opt http.verb.<op>=GET` or a config file) with no code
  change. *Goal: idiomatic HTTP semantics, tunable without touching the source.*

- **Collision is a hard error.** Two operations that would project to the same name/route fail at extract
  time. *Goal: no silent shadowing — naming conflicts are caught immediately, never last-writer-wins.*

- **Streaming.** A streaming function yields chunks; an error after the first chunk arrives in-band; a
  mid-stream cancel runs cleanup. *Goal: real-time/streaming APIs straight from generator functions.*

- **Class exports.** Static methods dispatch as operations; opt-in instances let you construct then call
  instance methods. *Goal: expose class-based code, not just free functions.*

---

## Part 5 · From one file to a whole system

- **A whole directory as one API.** Discover packages by tag and wire them into a single surface:

  ```bash
  apigen run-registry --packages-dir ./services --tag api --type mcp
  ```

  *Goal: expose an entire service folder as one API, with non-`api`-tagged code staying private.*

- **Polyglot behind one front (gateway).** Operations are tagged with their owning host; the gateway routes
  each to its runtime (TypeScript in-process, Python as a sidecar), presents one transport, and survives a
  dead host — only that host's operations report `unavailable`, the rest keep serving.
  *Goal: a mixed-language app behaves as one robust API, with isolated failure (it's a distributed system,
  handled like one).*

- **One command for the whole app (coming — `apigen serve`).**

  ```bash
  apigen serve --source myapi.ts --source orders.py --type api-fastify --type mcp --type py-flask --type py-grpc
  ```

  Many sources, many languages, many transports, one front, prefix-mounted.
  *Goal: your whole polyglot, multi-protocol app from a single command.*

---

## Part 6 · Ship it

```bash
apigen generate --source myapi.ts --type api-fastify --out-dir ./dist-api --link-workspace
cd dist-api && npm install && npx tsx routes.ts
```

- The generated `package.json` declares **only the dependencies your code actually used** (e.g. `decimal.js`
  if and only if you used `Decimal`). *Goal: a minimal, correct, installable package — no dependency bloat.*
- **Honest, actionable errors at startup:**
  - wrong file (no functions) → *"0 functions found … looks like generated output or the wrong source file."*
  - uses `Decimal` but `decimal.js` isn't installed → *"function quote takes a Decimal; install `decimal.js`."*
  *Goal: fail fast with a fix, never a cryptic mid-call crash.*

---

## Part 7 · Make apigen yours

- **Author a new output target (plugin).** `apigen` ships an Nx generator that scaffolds a buildable plugin
  package implementing the output-plugin interface. *Goal: teach apigen a new protocol/format without
  forking it.*
- **Add a new host language (runbook).** A scaffolder emits a new host's conformance harness and an empty,
  "red-by-construction" manifest; a completeness gate refuses to go green until every canonical type is
  handled. *Goal: extending to a new language is a bounded, enforced checklist — not a research project.*
- **Monorepo-native.** The codegen runs as a cache-aware Nx target. *Goal: fits real build pipelines;
  regeneration is incremental and reproducible.*

---

## Appendix · Every feature, the plan it came from, and its goal

| Feature path | Plan | Goal |
|---|---|---|
| Code-first / no annotations (Tenet 1) | client-generation | Your unmodified code is the API definition |
| Multi-transport projection (mcp/http/express/cli/jsonschema) | client-generation | Write once → every protocol |
| `run` (serve in-process) vs `generate` (deployable project) | client-generation | Fast dev loop + shippable artifact |
| Export-shape handling (named/renamed/default/anonymous/CJS) | client-generation | Works with however you exported |
| `ctx` convention | client-generation | Inject runtime context without leaking it into the API |
| Envelope from transport headers | client-generation | Identity/context lives in the transport, not the body |
| Central validation Layer | client-generation | Functions only see valid input |
| Layer/mount plugins via `--use` (logger, health, custom) | client-generation | Cross-cutting behavior by composition |
| HTTP verb from `safe`, overridable out-of-source | client-generation | Idiomatic HTTP, tunable without code edits |
| Projection collision = hard error | client-generation | No silent name shadowing |
| Streaming (chunks, in-band errors, cancel) | client-generation | Real-time APIs from generators |
| Class exports (static + opt-in instances) | client-generation | Expose class-based code |
| `run-registry` / `generate-registry` (by tag) | client-generation | A whole package dir as one API |
| Nx generator + cache-aware executor | client-generation | Author plugins; monorepo-native build |
| Deployable output + per-surface dep manifest | client-generation | A real, minimal, installable package |
| Mixed-host gateway + partial availability | client-generation | Polyglot behind one robust transport |
| Rich scalars (Date/int64/Decimal/bytes/UUID/specials) | logical-types | Types that break JSON survive intact |
| Canonical wire contract (one encoding per type) | logical-types | Unambiguous, identical bytes everywhere |
| Nominal classes + discriminated unions | logical-types | Domain types & polymorphism survive the wire |
| Cross-host fidelity (TS ↔ Python, byte-equal) | logical-types | A type means the same thing in every language |
| Conformance vectors + gate (with teeth) | logical-types | The contract can't silently drift |
| Schema-less `$apigen` envelope | logical-types | No fidelity loss even at `any` positions |
| Hints-advisory invariant | logical-types | Correctness never depends on annotations |
| ajv-formats validation of rich values | logical-types | Malformed rich values rejected |
| Fail-fast (0 functions / missing optional lib) | logical-types | Actionable startup errors, not crashes |
| Host generator + "no empty cells" runbook | logical-types | Adding a language is bounded & enforced |
| `apigen serve` (many sources/langs, one front) | multi-host-serve *(planned)* | The whole polyglot app from one command |
| Native `py-flask` / `py-grpc` targets | multi-host-serve *(planned)* | Idiomatic per-language servers |
| Gateway prefix-mount + pass-through | multi-host-serve *(planned)* | Compose independent services robustly |

---

## Status (honest)

Most of the above runs today (Parts 1–7 core). A few items are in progress and worth knowing before you
rely on them: validation and `--use health` enforce in-process but are **not yet wired into the live
`apigen run` HTTP path**; `readonly T[]` currently loses its element type; and `apigen serve` /
`py-flask` / `py-grpc` are the next milestone. These are tracked in the project backlog.
