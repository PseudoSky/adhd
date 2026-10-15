# @adhd/apigen-plugin-policy

An apigen Layer that gates every served operation behind an authorization decision. It depends only on `@adhd/apigen-core-client` (the plugin contract) and `@adhd/apigen-base-errors`; the decider is a port (`IPolicyDecider`) satisfied structurally by any implementation, so this package never imports a policy engine.

## Configuring a decider

`makePolicyPlugin(options)` returns a plugin (id `policy`) whose `layer` capability is a `createLayer(opts)` factory (SPEC §7.1, adhd ADR-0019 D1). Each call returns an independent plugin: nothing is held in module scope, so any number of configurations coexist in one process.

Load a configured plugin through a module of your own:

```js
// policy.plugin.mjs
import { makePolicyPlugin } from '@adhd/apigen-plugin-policy';

export default makePolicyPlugin({ decider: await createMyDecider(), timeoutMs: 5000 });
```

```
adhd-apigen run --source api.ts --type mcp --use ./auth.mjs --use ./policy.plugin.mjs
```

Top-level `await` is valid there because the host `import()`s each `--use` module.

`IPolicyLayerOptions`:

| Option | Meaning |
| --- | --- |
| `decider` | An `IPolicyDecider` object. Required for any call to be allowed. |
| `ask` | An `IPolicyAskHandler` that resolves an `ask` decision. Without one, `ask` denies. |
| `timeoutMs` | Deadline for one decision, in milliseconds: a finite number greater than 0. Any other value throws `ApiError('invalid_argument')` from `makePolicyPlugin`. |
| `onError` | Observer for every fail-closed denial caused by an error (see below). |

The host calls `createLayer(opts)` once per invocation with its flat `--opt` bag. The plugin reads one key from it, `timeoutMs` (declared in `optionsSchema`), and ignores every other key, since the bag is shared by all `--use` plugins. `--opt` delivers strings, so `--opt timeoutMs=5000` is accepted as well as a number; either form must be greater than 0, otherwise `createLayer` throws `ApiError('invalid_argument')` and the invocation fails before serving. A `timeoutMs` in the bag overrides the one given to `makePolicyPlugin`.

## The bare plugin denies everything

The default export is `makePolicyPlugin()`: a plugin with no decider. A bare `--use @adhd/apigen-plugin-policy` therefore refuses every call with `ApiError('permission_denied')` (details `{ code: 'policy-not-configured' }`) whose message says how to configure a decider. It never allows a call.

## Behaviour (one call)

1. `call.transport` must be `http`, `grpc`, `mcp` or `cli`; anything else is denied.
2. The request is `{ tool, args, envelope, transport, attributes }`. `args` (from `call.data`) and `envelope` are frozen shallow copies, so a decider cannot alter the real call. `attributes` are the values of the call's `PolicyAttributes` (see below), and only if every value is a string, a finite number or a string array; any other shape, or an own `__proto__` key, means "no attributes". The validated object has a null prototype and is frozen.
3. The decision is raced against `timeoutMs` (when set). On expiry the call is denied and the `AbortSignal` passed to `decide` is aborted.
4. The answer must be `allow`, `ask` or `deny` (and `set`, when present, a plain object); anything else denies.
5. `allow` merges `set` over the call's domain arguments (`call.data`, the object dispatch receives), then continues. If the arguments cannot be modified (a frozen or sealed object) the merge throws `ApiError('internal')` inside the guarded section and the call is denied with the standard shape. `ask` consults the ask handler: only `'allow-once'` continues; no handler, any other answer, or a throw denies. `deny` throws `ApiError('permission_denied', reason ?? 'denied by policy', { code: 'policy-denied' })`.

Any failure (throw, timeout, malformed output, failed merge) denies with the generic message `policy decision failed`. The cause goes to `onError(error, { phase })`, where `phase` is `decide`, `timeout`, `shape` or `merge`; the default handler writes one stderr line (phase and error class, never argument values). A throwing handler is ignored. No state is kept between calls. Streaming results are returned untouched.

## Attributes travel on `ctx`

Attributes reach the decider only through the call's typed `ctx` (SPEC §8.1 rule 3), under the `PolicyAttributes` class key. An earlier Layer (an auth layer) writes them:

```ts
import { PolicyAttributes } from '@adhd/apigen-plugin-policy';

call.ctx.set(PolicyAttributes, new PolicyAttributes({ team: 'core', scopes: ['read'] }));
```

`call.envelope` is never read for attributes. The envelope is client-supplied transport metadata; `ctx` is created per call by the host and only Layers write it, so a client cannot supply attributes through any transport.

The class is the key, so the writer and the policy Layer must use the same module instance. Import `PolicyAttributes` only from `@adhd/apigen-plugin-policy`; a separately bundled copy of this package is a different class, its value is not found, and the decider sees no attributes.

## Ordering rule (LP-14)

Declare this plugin after any layer that writes `PolicyAttributes` (an auth layer). Layers run in `--use` declaration order, so:

```
adhd-apigen run --use <auth layer> --use ./policy.plugin.mjs --type mcp -- <sources>
```

## Programmatic use

```ts
import { makePolicyPlugin } from '@adhd/apigen-plugin-policy';

const policy = makePolicyPlugin({
  decider: { decide: async () => ({ decision: 'allow', set: { tag: 'policy' } }) },
  timeoutMs: 2000,
});
const layer = policy.capabilities.layer?.createLayer?.({});
```

## Building

`nx build apigen-plugin-policy`; `nx run apigen-plugin-policy:verify-dist-load`.
