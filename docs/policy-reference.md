# Policy file reference

A policy file is YAML (or JSON) that decides whether a tool call is allowed. It is read by `@adhd/policy-core-client` and enforced by `adhd-policy` (`check`, `run`, `serve`) and by the `@adhd/apigen-plugin-policy` Layer. Caller attributes are described in [attributes.md](./attributes.md).

Every example below loads through `adhd-policy verify` and decides as stated through `adhd-policy check --input '<json>'`.

## Document shape

```yaml
version: 1
attributes:
  role: name
  read_roots: paths
  write_roots: paths
  customers: names
  max_refund: number
defaults:
  - set: { role: guest, read_roots: [], write_roots: [], customers: [], max_refund: 0 }
  - where: { role: { _eq: dev } }
    set: { max_refund: 5 }
permissions:
  - tool: files/read
    args: { path: { _within: $attributes.read_roots } }
  - tool: files/write
    context: { role: { _eq: dev } }
    args: { path: { _within: $attributes.write_roots } }
    set: { overwrite: false }
  - tool: files/*
    effect: deny
    args: { path: { _regex: '(^|/)\.env$' } }
  - tool: [notes/add, notes/list]
  - tool: billing/refund
    effect: ask
    context: { role: { _eq: support } }
    args:
      _and:
        - { customer: { _in: $attributes.customers } }
        - { amount: { _lte: $attributes.max_refund } }
  - tool: bin/touch
    args: { argv: { _contained_in: [a.txt, b.txt] } }
```

| Key | Meaning |
| --- | --- |
| `version` | Required. Always `1` (`IPolicyDocument.version`, `packages/policy/policy-core-client/src/spec/policy.ts:56`). |
| `attributes` | Declares the attribute names a policy reads and their kinds: `name` (one string), `names` (list of strings), `paths` (list of path strings), `number`. Optional. |
| `runtime` | Declares consumer-supplied runtime fields (`number` or `name`) that a `context` may read as `runtime.<field>`. A permission that reads `runtime` denies with `runtime-unavailable` when the caller supplied none. |
| `defaults` | Rules that fill attributes the caller did not supply. Each rule has an optional `where` filter over the supplied attributes and a `set` of values. The last matching rule that sets an attribute wins. An explicit empty value (`[]`) stops inheritance. |
| `permissions` | The ordered list of permission entries. Required. |

A `defaults` rule in a project layer cannot set an absolute path (`layer-violation`, rule LY-05); put absolute roots in the global or local layer, or supply them as attributes. `runtime` is never read or set by `defaults`.

## Tool ids

`tool:` names the operation a permission governs. An operation id joins its segments with `/`:

| Source | Operation id | Example |
| --- | --- | --- |
| An MCP upstream served through `adhd-policy serve` | `<source name>/<tool>` | `notes/add` |
| A command run through `adhd-policy run bin:<cmd>` | `bin/<command basename>` | `bin/touch` |
| An apigen package | the extracted operation id | `transform/humanize/humanize-bytes` |

The source name is the `--name` alias, else the command basename (ADR-0017 D3, `packages/apigen/apigen-engine-gateway/src/lib/sources/mcp-source.ts:114`; the argv id is built at `argv-operation.ts:67-89`).

Each segment is tokenised into words joined by `-`, so an upstream tool named `read_file` has the id `notes/read-file`. A `tool:` value matches the rendered id exactly; `adhd-policy migrate` writes values in rendered form.

`tool:` takes one id, a list of ids, or an id ending in `*` that matches every id with that prefix (`files/*`). The `*` is accepted only at the end.

A `.`-separated value (`files.read`) is rejected when the policy loads, with the message

```
tool "files.read" uses the old separator; use "files/read" (`adhd-policy migrate <file>` rewrites the file)
```

`verify` reports every such value; `check`, `run` and `serve` fail with `policy failed to compile` (`packages/policy/policy-core-client/src/core/compile/tool-ids.ts:70-73`, `:125`). Dotted attribute and context paths (`child.read_roots`, `runtime.calls`) are field paths, not tool ids, and are not affected.

`adhd-policy migrate <file>...` rewrites every `tool:` value of the named files to its canonical id in place, keeping comments and quoting, and prints one `file:line: tool "from" -> "to"` line per change (`entrypoint/policy/src/wrapper/verbs/migrate.ts:82-170`). A file with nothing to change is reported on stderr and left alone.

## Effects and precedence

`effect` is `allow` (the default), `ask` or `deny`. Across all permissions that match a call, deny beats ask beats allow. A call that no permission allows is denied with `no-match`.

| Decision | Where it surfaces |
| --- | --- |
| `allow` | `check` exits 0; `run` starts the command; `serve` forwards the call. `set` values are merged over the call arguments. |
| `ask` | Treated as a refusal (`permission_denied`, exit 3) unless a host supplies an ask handler. |
| `deny` | `permission_denied`, exit 3. `denial.code` is `explicit-deny`, `no-match`, `eval-error` or `runtime-unavailable`. |

Two permissions that force different values for the same `set` key deny with `eval-error`. A permission whose `context` or `args` cannot be evaluated (an uncompilable regular expression, including one that arrives through an attribute) denies the whole call with `eval-error`, naming the permission id.

Permission ids are `<layer>:<n>` with `n` 0-based inside that layer's `permissions` array. `check` and `evaluate` list every matching id in `matched`, in evaluation order.

## `context` and `args`

Both are filters in the `@adhd/data-query-engine` syntax.

- `context` is matched against the caller's effective attributes plus `runtime`. It decides whether the permission applies to this caller.
- `args` is matched against the tool-call arguments. `$attributes.<name>` leaves are replaced by the caller's attribute value before matching. A dotted key (`child.read_roots`) reads a nested field.
- Several keys in one object are ANDed.

Supported operators: `_and`, `_or`, `_not`, `_eq`, `_ne`, `_neq`, `_in`, `_nin`, `_gt`, `_lt`, `_gte`, `_lte`, `_like`, `_nlike`, `_ilike`, `_nilike`, `_similar`, `_nsimilar`, `_contains`, `_contained_in`, `_has_key`, `_has_keys_any`, `_has_keys_all`, `_is_null`, `_regex`, `_iregex`, `_nregex`, `_niregex`, `_in_datetimerange`, `_nin_datetimerange`, `_overlaps`, `_between`, `_nbetween` and the policy extension `_within` (`packages/policy/policy-core-client/src/core/engine/validate.ts:11-18`). An unknown operator is a compile error (`unknown-operator`). `_period` is excluded because it reads the clock.

Semantics worth knowing:

- `_like` / `_nlike` are substring tests; `%` and `_` are literal. Use `_regex` for anchored matches.
- `_within` is lexical path containment against a list of roots. An empty list is false. A relative path is resolved against the call's `cwd` argument when present. Symlinks are not resolved.
- A comparison on an absent attribute is false, `_ne` and `_nin` included. `_not` negates it. `_is_null: true` is the presence test. A `deny` conditioned on a missing attribute therefore does not fire; pair it with a positive guard.

See `packages/policy/policy-core-client/README.md` for the full list.

## Narrowing arguments with `set`

`set` forces argument values onto an allowed call:

```yaml
- tool: files/write
  args: { path: { _within: $attributes.write_roots } }
  set: { overwrite: false }
```

`set` writes keys as literal top-level properties. For `bin/touch`, `set: { argv: [forced.txt] }` replaces the whole `argv` array; a dotted key such as `argv.0` is not an index and is ignored on the `set` side (the `args` filter side does read dotted paths).

## The argv operation

`adhd-policy run bin:<cmd>` exposes one operation, `bin/<base>`, whose input is `{ argv: string[], cwd: string }`. `argv` excludes the command; `cwd` is absolute. `args` filters match against that object. Policy decisions on a `bin:` source gate the whole invocation: nothing starts until the call is allowed.

## Layers and discovery

A policy is up to three layers evaluated together, named by position: `global`, `project`, `local`. Discovery order (`packages/policy/policy-core-client/src/service/config/layer-source.ts:178-225`):

1. Explicit files: `--spec <file>` (repeatable) on `run` and `serve`, or `ADHD_POLICY_FILES` (comma-separated). They are assigned to `global`, `project`, `local` by position; more than three is an error. Explicit files win over discovery.
2. Otherwise: the user-global `global.yaml` in the policy config directory, then `workspace-policy.yaml` found by walking up from the working directory (stopping at the user's home directory when the working directory is inside it, and at the filesystem root), then `local.yaml` in the config directory. Files that do not exist are skipped.
3. With no file found, the built-in deny-all layer (`version: 1`, no permissions) is used.

A file that exists but cannot be parsed makes every operation fail closed with an error naming the file. The source of each load is announced on stderr as `policy: <path or built-in>`. Files are re-checked on every call; an edit is picked up without a restart.

## Commands

| Command | Purpose |
| --- | --- |
| `adhd-policy verify` | Lists every authoring error and warning. Exit 0 when there are no errors, 2 otherwise. |
| `adhd-policy check --input '{"tool":"files/read","args":{"path":"/work/a.md"},"attributes":{"role":"dev","read_roots":["/work"]}}'` | Allow exits 0; deny or ask exits 3. |
| `adhd-policy explain --input '<same input>'` | The decision plus every permission considered. |
| `adhd-policy migrate <file>...` | Rewrites `tool:` values to canonical ids. |
| `adhd-policy run bin:<cmd> --spec <file> -- <args>` | Runs one command behind the policy. |
| `adhd-policy serve bin:<mcp server> --spec <file> -- <args>` | Serves an upstream MCP server behind the policy. |

Calling convention, exit codes and settings: [`entrypoint/policy/README.md`](../entrypoint/policy/README.md).
