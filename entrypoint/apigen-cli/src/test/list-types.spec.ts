import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import type { OutputPlugin } from '@adhd/apigen-core-client';
import { registerListTypesCommand } from '../lib/commands/list-types';

function makePlugin(id: string, opts: { run?: boolean } = {}): OutputPlugin {
  return {
    id,
    description: `${id} description`,
    generate: () => ({ files: [] }),
    ...(opts.run ? { run: async () => undefined } : {}),
  };
}

function makeProgram(): Command {
  const program = new Command().name('apigen-cli').exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  return program;
}

describe('[cli-list-types] `apigen list-types` command', () => {
  it('prints every registered plugin id with description and capability', async () => {
    const plugins: Record<string, OutputPlugin> = {
      mcp: makePlugin('mcp', { run: true }),
      jsonschema: makePlugin('jsonschema'),
    };

    let output = '';
    const program = makeProgram();
    registerListTypesCommand(program, plugins, (text) => {
      output += text;
    });

    await program.parseAsync(['node', 'apigen-cli', 'list-types']);

    expect(output).toContain('mcp');
    expect(output).toContain('mcp description');
    expect(output).toMatch(/mcp\s+\(generate, run\)/);
    expect(output).toContain('jsonschema');
    expect(output).toContain('jsonschema description');
    expect(output).toMatch(/jsonschema\s+\(generate\)/);
  });

  it('output changes when a plugin is added to the registry — proves it is derived, not hardcoded', async () => {
    async function listTypesOutput(
      plugins: Record<string, OutputPlugin>
    ): Promise<string> {
      let output = '';
      const program = makeProgram();
      registerListTypesCommand(program, plugins, (text) => {
        output += text;
      });
      await program.parseAsync(['node', 'apigen-cli', 'list-types']);
      return output;
    }

    const before = await listTypesOutput({ mcp: makePlugin('mcp') });
    expect(before).not.toContain('new-plugin');

    const after = await listTypesOutput({
      mcp: makePlugin('mcp'),
      'new-plugin': makePlugin('new-plugin', { run: true }),
    });
    expect(after).toContain('new-plugin');
    expect(after).toMatch(/new-plugin\s+\(generate, run\)/);
  });

  it('output changes when a plugin is removed from the registry', async () => {
    async function listTypesOutput(
      plugins: Record<string, OutputPlugin>
    ): Promise<string> {
      let output = '';
      const program = makeProgram();
      registerListTypesCommand(program, plugins, (text) => {
        output += text;
      });
      await program.parseAsync(['node', 'apigen-cli', 'list-types']);
      return output;
    }

    const full = await listTypesOutput({
      mcp: makePlugin('mcp'),
      jsonschema: makePlugin('jsonschema'),
    });
    expect(full).toContain('jsonschema');

    const reduced = await listTypesOutput({ mcp: makePlugin('mcp') });
    expect(reduced).not.toContain('jsonschema');
  });
});
