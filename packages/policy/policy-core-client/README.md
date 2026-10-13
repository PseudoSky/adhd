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
- In a permission `context`, a comparison on an attribute that is absent is false, including `_ne`, `_nin` and `_nlike`. `_is_null: true` is the presence test and is true for an absent attribute.
