# Attributes: who is asking

Attributes are the facts about a caller that a policy decides on (`role`, `read_roots`, `max_refund`, ...). A policy file declares their names and kinds; the host supplies the values. Policy syntax is in [policy-reference.md](./policy-reference.md).

## Kinds and values

| Kind | Value |
| --- | --- |
| `name` | one string |
| `names` | list of strings |
| `paths` | list of path strings |
| `number` | finite number |

A supplied value must be a string, a finite number or a list of strings. Anything else (a nested object, a boolean, `null`, a list holding a non-string) is refused. Attributes are optional everywhere: a policy that reads an attribute nobody supplied sees it as absent (see the absent-attribute rule in the policy reference), or as the value a `defaults` rule gives it.

Supplied attributes are final. A `defaults` rule fills only attributes the caller did not supply.

## Where attributes come from

| Entry point | Source | Precedence |
| --- | --- | --- |
| `adhd-policy check`, `evaluate`, `explain`, `resolve`, `show`, `narrow` | the `attributes` property of the `--input` JSON | the input only |
| `adhd-policy run`, `adhd-policy serve` | `--adhd-attributes <json\|@file>` | the flag, else `ADHD_POLICY_ATTRIBUTES`, else none |
| `@adhd/apigen-plugin-policy` Layer | the call's `ctx`, under the `PolicyAttributes` key | whatever an earlier Layer wrote |

### The `--adhd-attributes` flag and `ADHD_POLICY_ATTRIBUTES`

For `run` and `serve`, `--adhd-attributes` takes a JSON object or `@<path>` naming a file that holds one. When the flag is absent, `ADHD_POLICY_ATTRIBUTES` (same forms) is used. The two are never merged: with both present the decision uses the flag's attributes only, and the environment value contributes nothing, not even keys the flag lacks (`entrypoint/policy/src/wrapper/attributes-source.ts:47-80`).

```bash
adhd-policy run bin:touch --spec gate.yaml --adhd-attributes '{"role":"dev","write_roots":["/work/out"]}' -- /work/out/a.txt
adhd-policy serve bin:node --spec gate.yaml --adhd-attributes @/etc/policy/attrs.json -- ./server.js
```

- `--adhd-attributes` may be given once; a second occurrence exits 2. Its value may not start with `--`.
- A relative `@file` path resolves against the working directory.
- A `@file` is re-read on every call, so a changed file changes the next decision inside one `serve` session.
- A value that is not valid JSON, is not an object, or holds an unsupported value type refuses to start: exit 2 with a message that begins `attributes:`. The same check runs once at startup, before anything is launched (`entrypoint/policy/src/wrapper/attributes-from-flags.ts`).
- A failure to read the source on a later call (the `@file` was deleted or corrupted) refuses that call with `permission_denied` (exit 3 for `run`, an `isError` tool result for `serve`) (`entrypoint/policy/src/wrapper/attributes-layer.ts:30`).
- `--adhd-*` flags are consumed by the wrapper and never reach the child. The gated child's environment carries only `PATH HOME USER LANG LC_ALL TMPDIR TERM SHELL`, so it never sees `ADHD_POLICY_ATTRIBUTES`.

### The `PolicyAttributes` ctx key

Inside apigen, the policy Layer reads attributes from the call's typed `ctx` and nowhere else. An earlier Layer (an auth Layer, or the wrapper's attributes Layer) writes them:

```ts
import { PolicyAttributes } from '@adhd/apigen-plugin-policy';

call.ctx.set(PolicyAttributes, new PolicyAttributes({ team: 'core', scopes: ['read'] }));
```

The policy Layer passes the values to the decider as `IPolicyDecideRequest.attributes` when every value is a string, a finite number or a string array. Any other shape, or an own `__proto__` key, means "no attributes"; the validated object has a null prototype and is frozen (`packages/apigen/apigen-plugin-policy/src/plugin.ts:114`, `:266`).

Two properties follow from using `ctx`:

- **A client cannot supply attributes.** `call.envelope` is client-supplied transport metadata and is never read for attributes. `ctx` is created per call by the host and only Layers write it (SPEC §8.1 rule 3).
- **The class is the key.** The writer and the policy Layer must use the same module instance. Import `PolicyAttributes` only from `@adhd/apigen-plugin-policy`; a separately bundled copy is a different class, its value is not found, and the decider sees no attributes.

Order matters: declare the Layer that writes `PolicyAttributes` before the policy Layer, because Layers run in `--use` declaration order. The wrapper builds this stack as tracing, attributes, policy (`entrypoint/policy/src/wrapper/gate.ts:64`).

## Trust

Attributes are self-asserted by whoever launches the process. They are not authentication. The source must be outside the control of the process being gated: a launcher-owned `@file`, or a flag set by the host that starts the wrapper, never a file or environment variable the gated command or model can write.

The values supplied to `narrow` are final too: a key the policy narrows (`narrowingCovered`) must lie within the parent when a child is created, and `narrow` refuses an exceeding grant with `exceeds-parent`.
