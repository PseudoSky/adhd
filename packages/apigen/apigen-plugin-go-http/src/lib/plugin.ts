import type {
  Plugin,
  Descriptor,
  Harness,
  Server,
  Call,
  Next,
  Result,
  Chunk,
  File,
} from '@adhd/apigen-core';

// Plugin-specific options — extend as needed.
export interface GoHttpOptions {
  // e.g. port?: number
}

/**
 * Serve Go public functions over HTTP (stdlib extractor, codegen-woven dispatch)
 *
 * Implements the v2 Plugin interface (SPEC §7.1) with a `target` capability.
 * The `layer` capability is included as a skeleton — remove it if this plugin
 * only generates files and does not need to wrap operations.
 */
export const goHttpPlugin: Plugin<GoHttpOptions> = {
  id: 'go-http',
  description:
    'Serve Go public functions over HTTP (stdlib extractor, codegen-woven dispatch)',

  optionsSchema: {
    type: 'object',
    properties: {
      // TODO: declare plugin-specific option schemas here
    },
  },

  capabilities: {
    // ------------------------------------------------------------------
    // target — project the descriptor to files (generate) and/or run a
    //          live server (serve). Remove `serve` for codegen-only plugins.
    // ------------------------------------------------------------------
    target: {
      name: 'go-http',

      generate(descriptor: Descriptor, _opts: GoHttpOptions): File[] {
        // TODO: walk `descriptor.operations` and emit files.
        void descriptor;
        return [];
      },
    },

    // ------------------------------------------------------------------
    // layer — optional onion wrapping all operations (SPEC §8 / §8.1).
    //         Remove this block if the plugin has no cross-cutting concerns.
    // ------------------------------------------------------------------
    layer: {
      layer(call: Call, next: Next): Promise<Result> | AsyncIterable<Chunk> {
        // TODO: add cross-cutting logic (auth, logging, tracing, …).
        void call;
        return next();
      },
    },
  },
};

export default goHttpPlugin;
