import type {
  OutputPlugin,
  PluginInput,
  PluginOutput,
  RunInput,
} from '@adhd/apigen-core-client';
import { generate } from './generate';
import { run } from './run';

export const cliPlugin: OutputPlugin = {
  id: 'cli',
  description:
    'Emit a Commander CLI program where each exported function becomes a subcommand',
  language: 'ts',
  optionsSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', default: 'cli' },
      version: { type: 'string', default: '0.1.0' },
      // Delivery mechanism for `run()`'s argv — populated natively by `apigen
      // run --type cli -- <command> <args>`'s `--` positional passthrough
      // (BACKLOG DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001, RESOLVED) or
      // settable directly as a `string[]` via the programmatic
      // `@adhd/apigen-core-client` API; a shell-tokenized `string` (the older
      // `--opt argv=…` CLI delivery path) is also still accepted for
      // back-compat.
      argv: {
        anyOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'string' },
        ],
      },
    },
  },
  generate(input: PluginInput): PluginOutput {
    return generate(input);
  },
  run(input: RunInput): Promise<void> {
    return run(input);
  },
};

export default cliPlugin;
