# @adhd/apigen-plugin-policy

An apigen Layer that gates every served operation behind an authorization decision. It depends only on `@adhd/apigen-engine-runtime` and `@adhd/apigen-base-errors`; the decider is a port (`IPolicyDecider`) satisfied structurally by any implementation, so this package never imports a policy engine.

## Behaviour (one call)

1. The decider is resolved once. A load failure is memoised, so every call is then denied.
2. `call.transport` must be `http`, `grpc`, `mcp` or `cli`; anything else is denied.
3. The request is `{ tool, args, envelope, transport, attributes }`. `attributes` come only from `call.envelope.attributes` and only if every value is a string, a finite number or a string array; any other shape means "no attributes". The Layer offers a caller no other way to supply them.
4. The decision is raced against `timeoutMs` (when set); expiry denies.
5. The answer must be `allow`, `ask` or `deny` (and `set`, when present, a plain object); anything else denies.
6. `allow` merges `set` over the call's domain arguments, then continues. `ask` consults the ask handler: only `'allow-once'` continues; no handler, any other answer, or a throw denies. `deny` throws `ApiError('permission_denied', reason ?? 'denied by policy', { code: 'policy-denied' })`.

Any failure (throw, timeout, malformed output, unloadable decider) denies. No state is kept between calls. Streaming results are returned untouched.

## Ordering rule (LP-14)

Declare this Layer after any layer that writes `call.envelope.attributes` (an auth layer). Layers run in `--use` declaration order, so:

```
adhd-apigen run --use <auth layer> --use @adhd/apigen-plugin-policy --type mcp -- <sources>
```

## Options channel (D-14)

A host hands `--use` options only to a plugin's `mount.operations` capability, never to `layer`. The default export therefore captures its options in a `mount.operations` capability (which returns no operations) and its `layer` capability builds the real Layer from them. If no options ever arrive, the layer throws `ApiError('internal', 'apigen-plugin-policy: no decider configured')` and the call fails.

Options: `decider` (an object, or a module specifier / path exporting `createDecider(options)`), `deciderOptions`, `timeoutMs`. A bare specifier resolves from this package's location; a `./`, `../` or absolute path resolves against the working directory.

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
