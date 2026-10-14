# @adhd/apigen-plugin-policy

An apigen Layer that gates every served operation behind an authorization decision. It depends only on `@adhd/apigen-engine-runtime` and `@adhd/apigen-base-errors`; the decider is a port (`IPolicyDecider`) satisfied structurally by any implementation, so this package never imports a policy engine.

## Behaviour (one call)

1. The decider is resolved once. A load failure is memoised, so every call is then denied.
2. `call.transport` must be `http`, `grpc`, `mcp` or `cli`; anything else is denied.
3. The request is `{ tool, args, envelope, transport, attributes }`. `args` and `envelope` are frozen shallow copies, so a decider cannot alter the real call. `attributes` come only from `call.envelope.attributes` and only if every value is a string, a finite number or a string array; any other shape, or an own `__proto__` key, means "no attributes". The validated object has a null prototype and is frozen. The Layer offers a caller no other way to supply them.
4. The decision is raced against `timeoutMs` (when set). On expiry the call is denied and the `AbortSignal` passed to `decide` is aborted.
5. The answer must be `allow`, `ask` or `deny` (and `set`, when present, a plain object); anything else denies.
6. `allow` merges `set` over the call's domain arguments, then continues. If the arguments cannot be modified (a frozen or sealed object) the merge throws `ApiError('internal')` inside the guarded section and the call is denied with the standard shape. `ask` consults the ask handler: only `'allow-once'` continues; no handler, any other answer, or a throw denies. `deny` throws `ApiError('permission_denied', reason ?? 'denied by policy', { code: 'policy-denied' })`.

Any failure (throw, timeout, malformed output, unloadable decider, failed merge) denies with the generic message `policy decision failed`. The cause goes to `onError(error, { phase })`, where `phase` is `load`, `decide`, `timeout`, `shape` or `merge`; the default handler writes one stderr line (phase and error class, never argument values). No state is kept between calls. Streaming results are returned untouched.

## The attributes channel is not client-writable

`call.envelope` is built by each host from the operation's DECLARED envelope fields only: `computeEnvelopeFields` (`apigen-engine-runtime/src/lib/op-plan.ts:240`) turns the composed input schema's top-level properties other than `data` into `plan.envelope`, and those properties come solely from plugins' `envelope` declarations (`apigen-core-client/src/lib/compose-schemas.ts:196-204`). The MCP (`apigen-plugin-mcp/src/lib/run.ts:287-291`), Fastify (`apigen-plugin-api-fastify/src/lib/run.ts:232-236`), Express (`apigen-plugin-api-express/src/lib/run.ts:190-194`) and CLI (`apigen-plugin-cli-output/src/lib/run.ts:367-446`, flags from the same table) hosts copy a header, `_meta` key, flag or env var into the envelope only for such a declared field. The policy plugin declares no envelope field, so a client cannot create `attributes` through any host. This holds only while no other `--use` plugin declares an envelope field named `attributes`; do not add one. A code path that builds a `Call` directly (an in-process embedder) is trusted by construction.

## Ordering rule (LP-14)

Declare this Layer after any layer that writes `call.envelope.attributes` (an auth layer). Layers run in `--use` declaration order, so:

```
adhd-apigen run --use <auth layer> --use @adhd/apigen-plugin-policy --type mcp -- <sources>
```

## Options channel (D-14)

A host hands `--use` options only to a plugin's `mount.operations` capability, never to `layer`. The default export therefore captures its options in a `mount.operations` capability (which returns no operations) and its `layer` capability builds the real Layer from them. If no options ever arrive, the layer throws `ApiError('internal', 'apigen-plugin-policy: no decider configured')` and the call fails.

Options: `decider` (an object, or a module specifier / path exporting `createDecider(options)`), `deciderOptions`, `ask`, `timeoutMs` (a finite number greater than 0; anything else throws at construction or capture), `onError`. A bare specifier resolves from this package's location; a `./`, `../` or absolute path resolves against the working directory.

The default export holds ONE configuration per process: options live in module scope, a later `mount.operations` that carries options replaces them, and one that carries none (`undefined`) is ignored once a configuration is captured. Use `createPolicyLayerPlugin` for several independently configured instances.

## Programmatic use

```ts
import { createPolicyLayerPlugin } from '@adhd/apigen-plugin-policy';

const policy = createPolicyLayerPlugin({
  decider: { decide: async () => ({ decision: 'allow', set: { tag: 'policy' } }) },
  timeoutMs: 2000,
});
```

## Building

`nx build apigen-plugin-policy`; `nx run apigen-plugin-policy:verify-dist-load`.
