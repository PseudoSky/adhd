/**
 * BUG-APIGEN-CLI-OUTPUT-001 — `MountedOperation.input` → CLI-flag-compatible
 * schema projection.
 *
 * `run.ts`'s mount-registration loop calls `buildOpPlan({ op: mountedOp,
 * transport: 'cli' })` for every `--use` mount op (health, openapi, batch, or
 * any future mount plugin). `buildOpPlan` (`@adhd/apigen-engine-runtime`)
 * only computes `cliFlags` `if (schema)` is passed, and its internal
 * `dataSchemaProps` reads `schema.input.properties.data.{properties,
 * required}` — the `{ data: {...} }` envelope wrapper `composeSchemas()`
 * produces for every EXTRACTED source op. A `MountedOperation.input` is never
 * wrapped that way (it is the bare domain schema, e.g.
 * `@adhd/apigen-core-client`'s `buildBatchKindSchema` output — either a flat
 * `{type:'object', properties:{...}}` object, or, when ≥2 batchable ops share
 * a `kind`, a root-level `oneOf`+`discriminator` union). Passing a mount op's
 * `input` straight through as `buildOpPlan`'s `schema` param would therefore
 * silently resolve ZERO flags (mirroring today's bug) rather than fixing it.
 *
 * {@link projectMountInputSchema} is this path's own, dedicated projection:
 * it wraps (or, for a root union, MERGES then wraps) `MountedOperation.input`
 * into the `{ data: {...} }` shape `buildOpPlan`'s existing
 * `computeCliFlags`/`computeEnvelopeFields`/`describeParams` already know how
 * to read — so this is the ONLY piece of new logic needed; the rest of the
 * flag-typing/kebab-casing/§9.1-envelope machinery in `op-plan.ts` is reused
 * completely unchanged.
 *
 * Root-level `oneOf`+`discriminator` handling (batch's ≥2-ops-per-kind shape):
 * deliberately a per-property UNION merge across every branch, never a fan-out
 * into N synthetic subcommands (contrast with `generate.ts`'s STATIC codegen
 * `emitDiscriminatedCommand`, which renders one Commander subcommand per
 * branch because it knows every branch's discriminator literal at codegen
 * time and can bake it into the subcommand, letting the user omit the
 * discriminator field entirely). That approach does not fit this live-dispatch
 * seam for two independent reasons:
 *
 *   1. **The intended UX is a caller-supplied discriminator VALUE, not a
 *      caller-selected subcommand.** Batch's discriminator property
 *      (`operation`) is itself an ordinary domain field the caller passes as
 *      `--operation <opId>` (proven by `batch-plugin-cli-live-dispatch.spec.ts`'s
 *      documented intended invocation) — baking each branch's `operation`
 *      literal into a distinct subcommand name would change that contract for
 *      every existing/future caller, and `--operation`'s value (an arbitrary
 *      runtime op id, e.g. `catalog/getItem`) is not a clean, stable Commander
 *      subcommand token the way a codegen-time enum literal is.
 *   2. **Every batch branch already shares an IDENTICAL flag surface.**
 *      `apigen-core-client`'s `branchInputSchema` gives every branch of a
 *      `_batch/<kind>` mount the exact same control-plane properties
 *      (`operation`, `items`, `concurrency`, `mode`, `onItemError`,
 *      `itemTimeoutMs`) — only `items`' nested `items:` schema differs per
 *      branch, and that nested shape is irrelevant to CLI flag typing (an
 *      array-typed flag is always parsed as a JSON string regardless of its
 *      element shape, BUG-APIGEN-031). A union merge therefore loses no real
 *      per-branch flag fidelity for this mount, and generalizes to any future
 *      root-union mount schema whose branches are NOT identically shaped: a
 *      property present in every branch stays required; a property present in
 *      only some branches becomes optional (the caller may have selected a
 *      branch that doesn't need it) — never silently dropped.
 *
 * `matchCommand`/`registerRoute` therefore need no new synthetic-subcommand
 * mechanism at all: a mount still resolves to exactly ONE registered CLI
 * command, with its (possibly-merged) flags fully populated.
 */

import type { ComposedSchemas } from '@adhd/apigen-core-client';

/** Loose JSON-Schema shape — only what the projection needs to read. */
interface MountInputSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  oneOf?: MountInputSchema[];
  discriminator?: { propertyName: string; mapping: Record<string, string> };
}

/**
 * Projects a single mount-schema "branch" (or the whole schema, for the
 * non-union case) into its own `{ properties, required }` pair.
 */
function branchProps(branch: MountInputSchema): {
  props: Record<string, unknown>;
  required: string[];
} {
  return {
    props: branch.properties ?? {},
    required: branch.required ?? [],
  };
}

/**
 * Projects `MountedOperation.input` into a synthetic `ComposedSchemas[string]`
 * stand-in whose SOLE purpose is feeding `buildOpPlan`'s cliFlags/envelope/
 * params computation for a mount op — it is never registered against a
 * package's real `ComposedSchemas` map, and never reaches the validate-Layer
 * (mount dispatch's validate-Layer entry stays the schema-less
 * `MOUNT_PASSTHROUGH_SCHEMA`, `dispatch-for-plan.ts` — unaffected by this
 * projection either way, so a mount handler's OWN hand-validation, e.g.
 * `@adhd/apigen-plugin-batch`'s `parseBatchRequest`, remains the sole real
 * gatekeeper, exactly as before this fix).
 *
 * - **Flat domain schema** (health/openapi's trivial `{}`/`{type:'object'}`,
 *   or a single-branch `_batch/<kind>` mount): `properties`/`required` are
 *   used verbatim — this is the overwhelmingly common case, and resolves to
 *   the exact same zero-flag result health/openapi already got before this
 *   fix (never a regression for a mount that needs no arguments).
 * - **Root-level `oneOf`+`discriminator` domain schema** (a `_batch/<kind>`
 *   mount fanning out over ≥2 operations of that kind): every branch's own
 *   `properties` are merged (a later branch never overwrites an earlier
 *   branch's own prop entry for the same key — real production schemas keep
 *   a shared field's shape identical across branches, per this module's own
 *   doc comment above); a field is carried into the merged `required` list
 *   only when EVERY branch requires it (a field required by just one branch
 *   is, from the caller's perspective, optional — they may have selected a
 *   different branch).
 */
export function projectMountInputSchema(
  input: unknown
): ComposedSchemas[string] {
  const schema = (input ?? {}) as MountInputSchema;
  const isRootUnion = Array.isArray(schema.oneOf) && !!schema.discriminator;
  const branches: MountInputSchema[] = isRootUnion
    ? (schema.oneOf as MountInputSchema[])
    : [schema];

  const mergedProps: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  for (const branch of branches) {
    const { props, required } = branchProps(branch);
    for (const [key, prop] of Object.entries(props)) {
      if (!(key in mergedProps)) mergedProps[key] = prop;
    }
    for (const key of required) {
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }
  const mergedRequired = [...requiredCounts.entries()]
    .filter(([, count]) => count === branches.length)
    .map(([key]) => key);

  return {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: mergedProps,
          required: mergedRequired,
        },
      },
      required: ['data'],
    },
    output: {},
  } as unknown as ComposedSchemas[string];
}
