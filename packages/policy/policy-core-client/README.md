# policy-core-client

This library was generated with [Nx](https://nx.dev).

## Building

Run `nx build policy-core-client` to build the library.

## Running unit tests

Run `nx test policy-core-client` to execute the unit tests via [Vitest](https://vitest.dev/).

## Filter semantics worth knowing

Filters use `@adhd/data-query-engine` operators with these exact meanings:

- `_like` / `_nlike` are substring tests, not SQL patterns: `%` and `_` are literal characters. Use `_regex` for anchored matches (`^https://staging\.shop\.example/`).
- `_contained_in` with a scalar field is list membership; with a list field the policy library resolves it as "every element is in the operand".
- `_within` (policy extension) is lexical path containment against a list of roots; an empty list is false.
- `_regex` / `_iregex` / `_nregex` / `_niregex` operands must compile. A pattern that does not (including one that arrives through `$attributes.<name>`) makes the permission unevaluable, and an unevaluable permission denies the whole call with `eval-error` naming the permission id: a `deny` that cannot run never reads as "does not match".

## Absent attributes: two-valued, present-only

Every comparison on an attribute (or field) that is absent is **false**, including the negative operators (`_ne`, `_nin`, `_nlike`). This applies to a permission `context` and to `defaults[].where`; `args` rows keep plain engine semantics.

- A `deny` whose `context` is `{ mode: { _ne: 'x' } }` does **not** fire when no `mode` attribute exists. Pair it with a positive guard (a rule that denies when `mode` is absent, using `_is_null: true`) when "missing" must also be refused.
- `_not` negates the (false) comparison, so `_not: { mode: { _eq: 'x' } }` is true when `mode` is absent. Logic is two-valued; there is no "unknown".
- `_is_null: true` is the presence test: true for an absent attribute, false for a present one (`_is_null: false` is the inverse).

## Trust notes

- `contentHash` detects corruption of a stored compiled policy, not tampering: anyone who can rewrite the file can recompute the hash. `loadCompiled` also validates every stored expression and every `index` entry, but a stored artifact is only as trusted as the place it is stored.
- `_within` resolves a relative path against the call's `cwd` argument. The target tool must honour that same `cwd`, otherwise the policy checks one directory and the tool acts in another. Paths are compared lexically (no filesystem access, symlinks are not resolved).
- Supplied attributes are final and are trusted as given (SC-08): whoever can pass `attributes` to `evaluate` chooses them. A key the policy narrows (`narrowingCovered`) must still lie within the parent when a child is created (`narrow` refuses it with `exceeds-parent`); other keys, such as a `role`, pass through. The host must take supplied attributes from a source the model cannot write.
- A policy file is discovered by walking up from the working directory. Pass `stopAt` (the user's home directory) to `createFsLayerSource` / `createPolicyCtx` so a file in a directory above it is never adopted as the project layer.
- The filesystem layer source caches a policy file by `(mtimeMs, size)`: an unchanged file is not re-read, re-parsed or recompiled. A rewrite that keeps both values identical is invisible to it.
