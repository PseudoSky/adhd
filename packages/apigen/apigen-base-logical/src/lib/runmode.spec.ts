import { describe, expect, it, vi } from 'vitest';
import { buildTranscoder, tryRegister } from './runmode';
import { createRegistry } from './registry';
import type {
  LogicalTypeCodec,
  SchemaNode,
  TranscodeCtx,
  Wire,
} from './contracts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal stub codec: identity encode/decode over a tagged scalar. */
function makeStubCodec(
  id: string,
  format: string,
  transform: { encode: (v: unknown) => Wire; decode: (w: Wire) => unknown }
): LogicalTypeCodec {
  return {
    id,
    kind: 'scalar',
    schema: { type: 'string', format },
    matches: (node: SchemaNode) => node['format'] === format,
    encode: (value, _node, _ctx) => transform.encode(value),
    decode: (wire, _node, _ctx) => transform.decode(wire),
  };
}

/** A codec that wraps/unwraps a value in a marker object so we can prove the
 *  transcoder path actually touched it. */
const MARKED_FORMAT = 'x-test-marked';
const markedCodec: LogicalTypeCodec = makeStubCodec(
  MARKED_FORMAT,
  MARKED_FORMAT,
  {
    encode: (v) => `encoded(${String(v)})`,
    decode: (w) => `decoded(${String(w)})`,
  }
);

// ---------------------------------------------------------------------------
// buildTranscoder
// ---------------------------------------------------------------------------

describe('buildTranscoder', () => {
  describe('scalar codec round-trip', () => {
    it('delegates to the registered codec for a matching schema node', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = { type: 'string', format: MARKED_FORMAT };
      const wire = transcoder.encode('hello', schema);
      expect(wire).toBe('encoded(hello)');

      const host = transcoder.decode(wire, schema);
      expect(host).toBe('decoded(encoded(hello))');
    });

    it('round-trips a value through encode → decode', () => {
      // A "lossless" codec: encode prepends a tag, decode strips it.
      const codec = makeStubCodec('tagged', 'x-tagged', {
        encode: (v) => `T:${String(v)}`,
        decode: (w) => String(w).slice(2), // strip "T:"
      });
      const registry = createRegistry();
      registry.register(codec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = { type: 'string', format: 'x-tagged' };
      const original = 'round-trip-me';
      const wire = transcoder.encode(original, schema);
      const recovered = transcoder.decode(wire, schema);
      expect(recovered).toBe(original);
    });
  });

  describe('plain JSON passthrough', () => {
    it('passes through a plain string when no codec matches', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());
      const schema: SchemaNode = { type: 'string' };
      expect(transcoder.encode('hello', schema)).toBe('hello');
      expect(transcoder.decode('hello', schema)).toBe('hello');
    });

    it('passes through a plain number', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());
      const schema: SchemaNode = { type: 'number' };
      expect(transcoder.encode(42, schema)).toBe(42);
      expect(transcoder.decode(42, schema)).toBe(42);
    });

    it('passes through null', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());
      const schema: SchemaNode = { type: 'string' };
      expect(transcoder.encode(null, schema)).toBeNull();
      expect(transcoder.decode(null, schema)).toBeNull();
    });
  });

  describe('object properties walk', () => {
    it('recurses into object properties applying codecs per-property', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'object',
        properties: {
          label: { type: 'string' },
          tag: { type: 'string', format: MARKED_FORMAT },
        },
      };
      const wire = transcoder.encode({ label: 'hi', tag: 'value' }, schema);
      expect(wire).toEqual({ label: 'hi', tag: 'encoded(value)' });

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toEqual({ label: 'hi', tag: 'decoded(encoded(value))' });
    });

    it('omits undefined properties', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
        },
      };
      // Only 'a' is present
      const wire = transcoder.encode({ a: 'x' }, schema);
      expect(wire).toEqual({ a: 'x' });
    });

    // BUG-APIGEN-DECODE-UNKNOWN-KEY-STRIP-001: decodeNode's object branch
    // used to silently DROP any wire key not declared in `schema.properties`
    // instead of passing it through. On a schema whose Ajv validation
    // permits extra keys (no `additionalProperties: false`), a caller's
    // unrecognized-but-accepted key would validate successfully at the
    // Ajv layer and then vanish before the domain function ever saw it —
    // e.g. `@adhd/backlog`'s `query` op silently accepted-and-ignored
    // unrecognized optional flags like `full`/`view` instead of surfacing
    // them at all (BUG-BACKLOG-QUERY-001's actual root mechanism, upstream
    // in apigen — see runmode.ts's decodeNode doc comment).
    it('passes through a wire key NOT declared in schema.properties instead of dropping it', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'object',
        properties: {
          a: { type: 'string' },
        },
      };
      const wire = { a: 'x', unknownKey: 'y' } as unknown as Wire;
      const host = transcoder.decode(wire, schema);
      expect(host).toEqual({ a: 'x', unknownKey: 'y' });
    });

    it('still applies a declared property\'s own codec while passing an undeclared sibling through unchanged', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'object',
        properties: {
          tag: { type: 'string', format: MARKED_FORMAT },
        },
      };
      const wire = { tag: 'encoded(value)', extra: 42 } as unknown as Wire;
      const host = transcoder.decode(wire, schema);
      expect(host).toEqual({ tag: 'decoded(encoded(value))', extra: 42 });
    });
  });

  describe('array items walk', () => {
    it('recurses into array items applying the codec per-element', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'array',
        items: { type: 'string', format: MARKED_FORMAT },
      };
      const wire = transcoder.encode(['a', 'b', 'c'], schema);
      expect(wire).toEqual(['encoded(a)', 'encoded(b)', 'encoded(c)']);

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toEqual([
        'decoded(encoded(a))',
        'decoded(encoded(b))',
        'decoded(encoded(c))',
      ]);
    });

    it('passes through array elements when no items schema is given', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = { type: 'array' };
      const wire = transcoder.encode([1, 'two', true], schema);
      expect(wire).toEqual([1, 'two', true]);
    });

    // REGRESSION: tuple/positional `items` (an ARRAY of per-index schemas) must
    // be walked position-by-position — NOT treated as a single element schema
    // (which made encodeSchemaless envelope every element: the BUG-013 tuple bug
    // surfaced as `[{"$apigen":"int64","v":"x"},…]`).
    it('walks positional (tuple) items array by index, no per-element envelope', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      // Tuple [marked, plain-number, plain-boolean]: only position 0 has a codec.
      const schema: SchemaNode = {
        type: 'array',
        items: [
          { type: 'string', format: MARKED_FORMAT },
          { type: 'number' },
          { type: 'boolean' },
        ],
        minItems: 3,
        maxItems: 3,
      };
      const wire = transcoder.encode(['x', 1, true], schema);
      // Position 0 goes through the codec; positions 1 & 2 pass through as-is.
      // Teeth: a wrong impl envelopes element 0 → {$apigen:…}; here it must be a string.
      expect(wire).toEqual(['encoded(x)', 1, true]);

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toEqual(['decoded(encoded(x))', 1, true]);
    });

    it('plain tuple of scalars (no logical types) round-trips untouched', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        minItems: 3,
        maxItems: 3,
      };
      const wire = transcoder.encode(['x', 1, true], schema);
      expect(wire).toEqual(['x', 1, true]);
      expect(transcoder.decode(wire as Wire, schema)).toEqual(['x', 1, true]);
    });

    it('positional items: elements past the tuple length pass through', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'array',
        items: [{ type: 'string' }],
      };
      const wire = transcoder.encode(['a', 2, 3], schema);
      expect(wire).toEqual(['a', 2, 3]);
    });
  });

  describe('$ref resolution', () => {
    it('resolves a $ref through the ctx.resolve override', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const defs: Record<string, SchemaNode> = {
        '#/$defs/Tag': { type: 'string', format: MARKED_FORMAT },
      };
      const refSchema: SchemaNode = { $ref: '#/$defs/Tag' };

      const wire = transcoder.encode('original', refSchema, {
        resolve: (ref) => defs[ref] ?? {},
      });
      expect(wire).toBe('encoded(original)');
    });

    it('throws when $ref cannot be resolved without a ctx.resolve override', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      expect(() => transcoder.encode('x', { $ref: '#/$defs/Missing' })).toThrow(
        /\$ref/
      );
    });
  });

  describe('oneOf / discriminated union', () => {
    it('picks the branch matching the discriminator tag and encodes through it', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        oneOf: [{ $ref: '#/$defs/Dog' }, { $ref: '#/$defs/Cat' }],
        discriminator: {
          propertyName: 'kind',
          mapping: { dog: '#/$defs/Dog', cat: '#/$defs/Cat' },
        },
      };
      const defs: Record<string, SchemaNode> = {
        '#/$defs/Dog': {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            name: { type: 'string', format: MARKED_FORMAT },
          },
        },
        '#/$defs/Cat': {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            lives: { type: 'number' },
          },
        },
      };

      const resolve = (ref: string): SchemaNode => defs[ref] ?? {};
      const dogWire = transcoder.encode({ kind: 'dog', name: 'Rex' }, schema, {
        resolve,
      });
      // Dog branch: name is MARKED_FORMAT so codec runs
      expect(dogWire).toEqual({ kind: 'dog', name: 'encoded(Rex)' });
    });

    // ── Structural branch selection (BUG-BACKLOG-V2-ENVELOPE-DATA-STRIPPED-001) ──
    //
    // TypeScript unions reaching apigen are overwhelmingly UNDISCRIMINATED
    // (`A | B`); `ts-json-schema-generator` emits them as a bare `oneOf` with
    // no `discriminator`. `pickUnionBranch` used to fall straight through to
    // `oneOf[0]` for those, and because `encodeNode`'s object arm projects
    // ONLY the chosen branch's declared `properties`, every field absent from
    // that arbitrary first branch was SILENTLY DELETED from the wire.
    //
    // The shape below is `@adhd/backlog`'s real `IOutcomeEnvelope<T>`: an
    // error arm FIRST, a success arm second. Encoding a SUCCESS value against
    // it used to yield exactly `{ok:true}` — `data` and `meta` gone — over
    // every transport, while the in-process call returned them correctly.
    //
    // NEGATIVE CONTROL (verified, not assumed): restore the old one-line body
    // `return oneOf[0] ?? {}` in `pickUnionBranch` and the first test below
    // fails with `{ok:true}`, exactly reproducing the shipped bug.
    const OUTCOME_ENVELOPE: SchemaNode = {
      oneOf: [
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'object' },
            warnings: { type: 'array' },
          },
          required: ['ok', 'error'],
        },
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: { type: 'object' },
            warnings: { type: 'array' },
            meta: { type: 'object' },
          },
          required: ['ok', 'data'],
        },
      ],
    };

    it('an UNDISCRIMINATED union encodes through the branch the value actually satisfies, preserving every field', () => {
      const transcoder = buildTranscoder(createRegistry().freeze());

      const success = {
        ok: true,
        data: { created: true, humanId: 'BUG-001' },
        meta: { total: 1 },
      };

      // Must select branch 1 (`required:['ok','data']`) even though the error
      // arm is declared first. Before structural matching this returned
      // `{ok:true}`.
      expect(transcoder.encode(success, OUTCOME_ENVELOPE)).toEqual(success);
    });

    it('the SAME union still routes an error value through the error arm', () => {
      const transcoder = buildTranscoder(createRegistry().freeze());

      const failure = {
        ok: false,
        error: { code: 'item_not_found', message: 'nope' },
      };

      // Proves the fix is a real discriminating test, not a blanket
      // "always take the last branch" that would merely invert the bug.
      expect(transcoder.encode(failure, OUTCOME_ENVELOPE)).toEqual(failure);
    });

    it('an explicit discriminator still wins over structural scoring', () => {
      // Regression guard for the resolution ORDER: a value that structurally
      // fits the WRONG branch better must still follow its discriminator tag.
      const transcoder = buildTranscoder(createRegistry().freeze());

      const schema: SchemaNode = {
        oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }],
        discriminator: {
          propertyName: 'kind',
          mapping: { a: '#/$defs/A', b: '#/$defs/B' },
        },
      };
      const defs: Record<string, SchemaNode> = {
        '#/$defs/A': {
          type: 'object',
          properties: { kind: { type: 'string' }, only: { type: 'string' } },
        },
        '#/$defs/B': {
          type: 'object',
          properties: { kind: { type: 'string' } },
        },
      };
      const resolve = (ref: string): SchemaNode => defs[ref] ?? {};

      // `only` makes branch A the better STRUCTURAL fit, but the tag says B —
      // so `only` is legitimately projected away by B's declared properties.
      expect(
        transcoder.encode({ kind: 'b', only: 'x' }, schema, { resolve })
      ).toEqual({ kind: 'b' });
    });

    it('a branch missing a required key is never chosen, even when declared first', () => {
      const transcoder = buildTranscoder(createRegistry().freeze());

      const schema: SchemaNode = {
        oneOf: [
          {
            type: 'object',
            properties: { id: { type: 'string' }, gone: { type: 'string' } },
            required: ['gone'],
          },
          {
            type: 'object',
            properties: { id: { type: 'string' }, kept: { type: 'string' } },
            required: ['kept'],
          },
        ],
      };

      // Branch 0 requires `gone`, which the value lacks ⇒ disqualified.
      expect(transcoder.encode({ id: '1', kept: 'yes' }, schema)).toEqual({
        id: '1',
        kept: 'yes',
      });
    });

    it('falls back to the first branch when nothing matches, rather than throwing', () => {
      const transcoder = buildTranscoder(createRegistry().freeze());

      const schema: SchemaNode = {
        oneOf: [{ type: 'string' }, { type: 'number' }],
      };

      // A boolean inhabits neither branch. The walk must degrade to plain-JSON
      // passthrough, never crash a live request.
      expect(transcoder.encode(true, schema)).toBe(true);
    });

    it('decode uses the same structural selection, so the envelope round-trips', () => {
      const transcoder = buildTranscoder(createRegistry().freeze());

      const success = { ok: true, data: { humanId: 'BUG-001' }, meta: { total: 1 } };
      const wire = transcoder.encode(success, OUTCOME_ENVELOPE);

      // `pickUnionBranch` is shared by encodeNode and decodeNode — a fix to one
      // that missed the other would surface as an asymmetric round-trip here.
      expect(transcoder.decode(wire, OUTCOME_ENVELOPE)).toEqual(success);
    });

    // ── BUG-APIGEN-RUNMODE-DISCRIMINATOR-DEREF-001 ──────────────────────────
    //
    // A discriminator whose `mapping` values point at branches by `$ref`
    // (`"#/oneOf/N"`, OpenAPI 3 style) goes silently inert once every `$ref`
    // in the schema has been inlined — a real, load-bearing shape: a host
    // that dispatches through THIS run-mode transcoder cannot resolve `$ref`
    // at all (`buildCtx`'s default `resolve` unconditionally throws — see its
    // doc comment above), so any host wanting run-mode dispatch to work must
    // inline every `$ref` before the schema ever reaches `encode`/`decode`.
    // `@adhd/backlog`'s own `dereferenceSchema` (entrypoint/backlog/src/
    // server.ts) does exactly this. Once branches carry no `$ref` key,
    // `oneOf.find((b) => b['$ref'] === ref)` always returns `undefined` and
    // the discriminator match silently no-ops, falling through to structural
    // scoring (step 2) — which only checks required-key PRESENCE, not the
    // literal tag value, so sibling branches sharing the exact same property
    // NAMES score an identical tie and the earliest-declared branch always
    // wins regardless of the real tag.
    //
    // Live-reproduced against `@adhd/backlog`'s real `backlog_admin` output
    // union: `IAdminResult`'s `prune`/`archive`/`merge`/`import`/`batch`/
    // `reconcile_repo` arms (six actions, not just the one first reported —
    // BUG-BACKLOG-RECONCILE-REPO-EMPTY-REPORT-001) all share `doctor`'s
    // `{action,report}` shape; every one of them was silently re-encoded as
    // `doctor`'s (empty, for a fresh store) report — `{"action":"prune",
    // "report":{}}` — over the built CLI, dropping every real field the
    // in-process call actually returned.
    //
    // NEGATIVE CONTROL (verified, not assumed): reverting `pickUnionBranch`'s
    // step 1b (the resolved-branch `const`/`enum` match added for this fix)
    // makes this test fail with `report: {}` — reproducing the shipped bug
    // exactly, byte for byte.
    it('an inlined (post-dereference) discriminator still routes by the tag, not by structural tie-break', () => {
      const transcoder = buildTranscoder(createRegistry().freeze());

      // Two sibling branches with IDENTICAL property names (`action`,
      // `report`) — only their `action` enum and their `report` shape
      // differ. Every `$ref` has already been inlined (dereferenceSchema's
      // exact output shape): no branch carries a `$ref` key, but the
      // discriminator's `mapping` — copied from the PRE-dereference schema —
      // still exists and still names `#/oneOf/N`-style pointers that no
      // longer resolve against anything.
      const schema: SchemaNode = {
        oneOf: [
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['doctor'] },
              report: {
                type: 'object',
                properties: { scannedItems: { type: 'number' } },
                required: ['scannedItems'],
              },
            },
            required: ['action', 'report'],
          },
          {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['reconcile_repo'] },
              report: {
                type: 'object',
                properties: {
                  fromRepo: { type: 'string' },
                  toRepo: { type: 'string' },
                  dryRun: { type: 'boolean' },
                },
                required: ['fromRepo', 'toRepo', 'dryRun'],
              },
            },
            required: ['action', 'report'],
          },
        ],
        discriminator: {
          propertyName: 'action',
          mapping: { doctor: '#/oneOf/0', reconcile_repo: '#/oneOf/1' },
        },
      };

      const value = {
        action: 'reconcile_repo',
        report: { fromRepo: 'legacy-repo', toRepo: 'canonical-repo', dryRun: true },
      };

      // Both branches require exactly {action,report} and value has
      // exactly those two keys, so structural scoring alone ties — the
      // discriminator's OWN declared tag (`report`'s enum on branch 1) must
      // decide, not declaration order.
      expect(transcoder.encode(value, schema)).toEqual(value);
    });
  });

  describe('schema-less envelope (any position)', () => {
    it('wraps a value in the $apigen envelope when a codec matches at schema-less position', () => {
      const registry = createRegistry();
      // Codec that always claims to encode objects
      const anyCodec: LogicalTypeCodec = {
        id: 'x-any',
        kind: 'scalar',
        schema: {},
        matches: () => false, // does NOT match via resolve — only used in schema-less path
        ownsValue: () => true, // explicitly claims every value at a schema-less node
        encode: (v) => `wrapped(${String(v)})`,
        decode: (w) => `unwrapped(${String(w)})`,
      };
      registry.register(anyCodec);
      const transcoder = buildTranscoder(registry.freeze());

      // A schema-less node (type absent)
      const schema: SchemaNode = {};
      const wire = transcoder.encode('payload', schema);
      // Envelope: { $apigen: 'x-any', v: 'wrapped(payload)' }
      expect(wire).toEqual({ $apigen: 'x-any', v: 'wrapped(payload)' });

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toBe('unwrapped(wrapped(payload))');
    });

    it('falls back to passthrough when no codec can encode the value at schema-less position', () => {
      const registry = createRegistry();
      // Codec whose encode always throws (simulates "not my type")
      const picky: LogicalTypeCodec = {
        id: 'x-picky',
        kind: 'scalar',
        schema: {},
        matches: () => false,
        encode: () => {
          throw new Error('not my value');
        },
        decode: (w) => w,
      };
      registry.register(picky);
      const transcoder = buildTranscoder(registry.freeze());

      const wire = transcoder.encode('plain', {});
      expect(wire).toBe('plain');
    });

    // ── BUG-APIGEN-SCHEMALESS-CODEC-ROULETTE ────────────────────────────────
    // `encodeSchemaless` used to claim a value for the first codec whose
    // `encode` did not throw. Several real codecs are TOTAL (`int64` is
    // `String(value)`), so the winner was decided by registry order and then
    // REWROTE the value: a whole object at a `{}` node came back as
    // `{$apigen:'int64', v:'[object Object]'}`. That is the schemaless path,
    // which exists precisely because the schema cannot describe the value —
    // so the corruption was silent and total.
    it('a TOTAL codec never claims a value it does not own', () => {
      const registry = createRegistry();
      // Faithful to the real int64 codec: encode is String(), never throws.
      const totalCodec: LogicalTypeCodec = {
        id: 'int64',
        kind: 'scalar',
        schema: { type: 'string', format: 'int64' },
        matches: (n) => n['format'] === 'int64',
        ownsValue: (v) => typeof v === 'bigint',
        encode: (v) => String(v),
        decode: (w) => BigInt(String(w)),
      };
      registry.register(totalCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const card = { humanId: 'BUG-001', title: 'a card', tags: [] };
      // The exact consumer-visible outcome: the card comes back as the card.
      expect(transcoder.encode(card, {})).toEqual(card);
    });

    it('a value a codec DOES own is still enveloped at a schema-less node', () => {
      const registry = createRegistry();
      const totalCodec: LogicalTypeCodec = {
        id: 'int64',
        kind: 'scalar',
        schema: { type: 'string', format: 'int64' },
        matches: (n) => n['format'] === 'int64',
        ownsValue: (v) => typeof v === 'bigint',
        encode: (v) => String(v),
        decode: (w) => BigInt(String(w)),
      };
      registry.register(totalCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const wire = transcoder.encode(42n, {});
      expect(wire).toEqual({ $apigen: 'int64', v: '42' });
      expect(transcoder.decode(wire as Wire, {})).toBe(42n);
    });

    it('an owned value NESTED in a plain payload is enveloped, and round-trips', () => {
      const registry = createRegistry();
      const totalCodec: LogicalTypeCodec = {
        id: 'int64',
        kind: 'scalar',
        schema: { type: 'string', format: 'int64' },
        matches: (n) => n['format'] === 'int64',
        ownsValue: (v) => typeof v === 'bigint',
        encode: (v) => String(v),
        decode: (w) => BigInt(String(w)),
      };
      registry.register(totalCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const host = { humanId: 'BUG-001', nodeId: 7n, tags: ['a'], nested: { count: 9n } };
      const wire = transcoder.encode(host, {});
      expect(wire).toEqual({
        humanId: 'BUG-001',
        nodeId: { $apigen: 'int64', v: '7' },
        tags: ['a'],
        nested: { count: { $apigen: 'int64', v: '9' } },
      });
      // Symmetry: decode must recurse too, or the host gets the raw bag back.
      expect(transcoder.decode(wire as Wire, {})).toEqual(host);
    });

    it('claiming is independent of registration order', () => {
      // Two total codecs; whichever is registered first previously swallowed
      // every value. Both orders must now yield the untouched payload.
      const build = (order: 'a-first' | 'b-first') => {
        const registry = createRegistry();
        const mk = (id: string): LogicalTypeCodec => ({
          id,
          kind: 'scalar',
          schema: { type: 'string', format: id },
          matches: (n) => n['format'] === id,
          ownsValue: (v) => typeof v === 'bigint',
          encode: (v) => String(v),
          decode: (w) => BigInt(String(w)),
        });
        const [x, y] = order === 'a-first' ? ['int64', 'decimal'] : ['decimal', 'int64'];
        registry.register(mk(x));
        registry.register(mk(y));
        return buildTranscoder(registry.freeze());
      };
      const payload = { title: 'order-independent' };
      expect(build('a-first').encode(payload, {})).toEqual(payload);
      expect(build('b-first').encode(payload, {})).toEqual(payload);
    });

    it('a JSON-native value is never rewritten at a schema-less node', () => {
      const registry = createRegistry();
      // uuid/decimal are branded STRINGS — JSON-native, so they declare no
      // ownsValue and must leave a plain string exactly as it arrived.
      const uuidLike: LogicalTypeCodec = {
        id: 'uuid',
        kind: 'scalar',
        schema: { type: 'string', format: 'uuid' },
        matches: (n) => n['format'] === 'uuid',
        encode: (v) => String(v).toLowerCase(),
        decode: (w) => w,
      };
      registry.register(uuidLike);
      const transcoder = buildTranscoder(registry.freeze());

      expect(transcoder.encode('A-B-C', {})).toBe('A-B-C');
    });
  });

  describe('ctx partial override', () => {
    it('respects the mode override threaded through the context', () => {
      const registry = createRegistry();
      let capturedMode: string | undefined;
      const modeCapture: LogicalTypeCodec = {
        id: 'x-capture',
        kind: 'scalar',
        schema: { type: 'string', format: 'x-capture' },
        matches: (n: SchemaNode) => n['format'] === 'x-capture',
        encode: (_v, _n, ctx: TranscodeCtx) => {
          capturedMode = ctx.mode;
          return 'enc';
        },
        decode: (w) => w,
      };
      registry.register(modeCapture);
      const transcoder = buildTranscoder(registry.freeze());

      transcoder.encode(
        'x',
        { type: 'string', format: 'x-capture' },
        { mode: 'lossy' }
      );
      expect(capturedMode).toBe('lossy');
    });
  });
});

// ---------------------------------------------------------------------------
// tryRegister
// ---------------------------------------------------------------------------

describe('tryRegister', () => {
  it('registers a codec when the loader succeeds', () => {
    const registry = createRegistry();
    tryRegister(registry, 'test-ok', () => markedCodec);
    expect(registry.get(MARKED_FORMAT)).toBe(markedCodec);
  });

  it('silently skips when the loader throws MODULE_NOT_FOUND (lib absent)', () => {
    const registry = createRegistry();

    const notFound = Object.assign(new Error('Cannot find module'), {
      code: 'MODULE_NOT_FOUND',
    });
    tryRegister(registry, 'decimal', () => {
      throw notFound;
    });

    // Registry must still be empty — no crash
    expect(registry.ids()).toHaveLength(0);
  });

  it('re-throws when the loader throws a non-MODULE_NOT_FOUND error', () => {
    const registry = createRegistry();
    const boom = new Error('unexpected failure');

    expect(() =>
      tryRegister(registry, 'x', () => {
        throw boom;
      })
    ).toThrow(boom);
  });

  it('does not crash the process when multiple codecs are attempted and one is absent', () => {
    const registry = createRegistry();

    // Codec A is present
    tryRegister(registry, MARKED_FORMAT, () => markedCodec);
    // Codec B is absent
    const absent = Object.assign(new Error('Cannot find module'), {
      code: 'MODULE_NOT_FOUND',
    });
    tryRegister(registry, 'absent-lib', () => {
      throw absent;
    });

    // Only A registered
    expect(registry.ids()).toEqual([MARKED_FORMAT]);
  });

  it('re-throws loader errors that are non-Error objects', () => {
    const registry = createRegistry();
    expect(() =>
      tryRegister(registry, 'x', () => {
        throw 'string-error';
      })
    ).toThrow();
  });

  it('uses the loader to construct the codec (not the _id param)', () => {
    const registry = createRegistry();
    // _id parameter is informational — the codec's own id governs registration
    const codecA = makeStubCodec('actual-id', 'x-actual', {
      encode: (v) => v as Wire,
      decode: (w) => w,
    });
    tryRegister(registry, 'does-not-matter', () => codecA);
    expect(registry.get('actual-id')).toBe(codecA);
    expect(registry.get('does-not-matter')).toBeUndefined();
  });

  describe('negative-control: lazy-register skips a codec whose loader throws MODULE_NOT_FOUND', () => {
    it('registry has no codecs registered after a MODULE_NOT_FOUND loader', () => {
      const registry = createRegistry();
      const missingLib = Object.assign(
        new Error("Cannot find module 'decimal.js'"),
        { code: 'MODULE_NOT_FOUND' }
      );
      tryRegister(registry, 'decimal', () => {
        throw missingLib;
      });

      // Negative control: if tryRegister DID NOT swallow MODULE_NOT_FOUND,
      // the test would throw before reaching this assertion.
      expect(registry.ids()).toHaveLength(0);
    });

    it('a transcoder built over an empty registry passes plain values through (no crash)', () => {
      const registry = createRegistry();
      // Simulate failed lazy-load
      const missingLib = Object.assign(new Error('Cannot find module'), {
        code: 'MODULE_NOT_FOUND',
      });
      tryRegister(registry, 'decimal', () => {
        throw missingLib;
      });

      const transcoder = buildTranscoder(registry.freeze());
      // No codec registered; plain string passthrough must not throw
      expect(
        transcoder.encode('1.23', { type: 'string', format: 'decimal' })
      ).toBe('1.23');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: stub codec round-trip through a full schema tree
// ---------------------------------------------------------------------------

describe('buildTranscoder (integration)', () => {
  it('full encode→decode round-trip through a nested object with a custom scalar', () => {
    const codec = makeStubCodec('tagged', 'x-tagged', {
      encode: (v) => `ENC[${String(v)}]`,
      decode: (w) => String(w).replace(/^ENC\[(.+)\]$/, '$1'),
    });
    const registry = createRegistry();
    registry.register(codec);
    const transcoder = buildTranscoder(registry.freeze());

    const schema: SchemaNode = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        items: {
          type: 'array',
          items: { type: 'string', format: 'x-tagged' },
        },
      },
    };

    const original = { name: 'test', items: ['alpha', 'beta'] };
    const wire = transcoder.encode(original, schema);
    expect(wire).toEqual({ name: 'test', items: ['ENC[alpha]', 'ENC[beta]'] });

    const host = transcoder.decode(wire as Wire, schema);
    expect(host).toEqual(original);
  });

  it('vi.spyOn verifies the codec is actually called during round-trip', () => {
    const codec = makeStubCodec('spied', 'x-spied', {
      encode: (v) => String(v),
      decode: (w) => w,
    });
    const encodeSpy = vi.spyOn(codec, 'encode');
    const decodeSpy = vi.spyOn(codec, 'decode');

    const registry = createRegistry();
    registry.register(codec);
    const transcoder = buildTranscoder(registry.freeze());

    const schema: SchemaNode = { type: 'string', format: 'x-spied' };
    transcoder.encode('hello', schema);
    transcoder.decode('hello', schema);

    expect(encodeSpy).toHaveBeenCalledOnce();
    expect(decodeSpy).toHaveBeenCalledOnce();
  });
});
