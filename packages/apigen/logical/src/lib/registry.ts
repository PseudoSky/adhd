import type { LogicalTypeCodec, LogicalTypeId, SchemaNode } from './contracts';

/** @stable Keyed by LogicalTypeId. Scalars register by `format`; nominal/union by qualified id. */
export interface LogicalTypeRegistry {
  /** Register a codec. Throws E_DUP_CODEC on duplicate id unless `{override:true}`. */
  register(codec: LogicalTypeCodec, opts?: { override?: boolean }): void;
  /** Resolve the codec owning a RESOLVED schema node, or undefined for a plain JSON node. */
  resolve(node: SchemaNode): LogicalTypeCodec | undefined;
  /** Direct lookup (for $ref / discriminator resolution). */
  get(id: LogicalTypeId): LogicalTypeCodec | undefined;
  /** Introspection (codegen, debugging). */
  ids(): readonly LogicalTypeId[];
  /** Frozen snapshot, safe to share across dispatch calls. */
  freeze(): LogicalTypeRegistry;
}

/** @stable E_DUP_CODEC carrier — thrown on duplicate codec registration without `{override:true}`. */
export class CodecRegistryError extends Error {
  /** Stable, transport-neutral error code for duplicate-codec registration. */
  readonly code = 'E_DUP_CODEC' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CodecRegistryError';
  }
}

/**
 * @stable Factory: a registry pre-loaded with the well-known scalar codecs.
 *
 * NOTE: This is the MINIMAL contract-spine stub. It provides the keyed-by-id
 * store and `register`/`get`/`ids`/`freeze`/`resolve` plumbing with
 * `E_DUP_CODEC` duplicate-detection only. Well-known scalar auto-loading
 * (`opts.wellKnown`) and structural `resolve(node)` dispatch are LATER states —
 * here `resolve` performs the trivial structural match the codec advertises via
 * `matches(node)` so the spine is internally consistent, and `wellKnown` is
 * accepted but not yet populated.
 */
export function createRegistry(opts?: { wellKnown?: boolean }): LogicalTypeRegistry {
  // `wellKnown` is part of the stable signature; loading the well-known scalar
  // codecs is a later state. Reference it so the option is not flagged unused.
  void opts?.wellKnown;

  const byId = new Map<LogicalTypeId, LogicalTypeCodec>();

  const registry: LogicalTypeRegistry = {
    register(codec, registerOpts) {
      if (byId.has(codec.id) && !registerOpts?.override) {
        throw new CodecRegistryError(
          `E_DUP_CODEC: a codec is already registered for id "${codec.id}"`,
        );
      }
      byId.set(codec.id, codec);
    },
    resolve(node) {
      for (const codec of byId.values()) {
        if (codec.matches(node)) return codec;
      }
      return undefined;
    },
    get(id) {
      return byId.get(id);
    },
    ids() {
      return [...byId.keys()];
    },
    freeze() {
      // Snapshot the current id->codec mapping; the snapshot rejects mutation.
      const snapshot = new Map(byId);
      const frozen: LogicalTypeRegistry = {
        register() {
          throw new CodecRegistryError(
            'E_DUP_CODEC: registry is frozen and cannot accept new codecs',
          );
        },
        resolve(node) {
          for (const codec of snapshot.values()) {
            if (codec.matches(node)) return codec;
          }
          return undefined;
        },
        get(id) {
          return snapshot.get(id);
        },
        ids() {
          return [...snapshot.keys()];
        },
        freeze() {
          return frozen;
        },
      };
      return frozen;
    },
  };

  return registry;
}
