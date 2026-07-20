import { Command } from 'commander';
import type { OutputPlugin } from '@adhd/apigen-core-client';
import { formatTypesList } from '../plugin-registry';

/**
 * `apigen list-types` — the only discovery mechanism for valid `--type`
 * values before FEAT-APIGEN-019 was reading source, hitting an error, or
 * already knowing them. Output is derived live from the same `plugins` map
 * every other command receives, so it can never drift from what's actually
 * registered (see `../plugin-registry`).
 */
export function registerListTypesCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  }
): void {
  program
    .command('list-types')
    .description(
      'List every registered --type plugin id, its description, and generate/run capability'
    )
    .action(() => {
      write(formatTypesList(plugins) + '\n');
    });
}
