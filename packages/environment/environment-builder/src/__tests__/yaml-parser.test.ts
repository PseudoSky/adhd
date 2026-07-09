import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SPEC_TEMPLATE, parseYamlSpec, projectEnvPrefix, validateYamlSpec, YamlSpecError } from '../yaml-parser';

describe('projectEnvPrefix', () => {
  it('"agent-mcp" -> "ADHD_AGENT_MCP"', () => {
    expect(projectEnvPrefix('agent-mcp')).toBe('ADHD_AGENT_MCP');
  });

  it('"decompile-cli" -> "ADHD_DECOMPILE_CLI"', () => {
    expect(projectEnvPrefix('decompile-cli')).toBe('ADHD_DECOMPILE_CLI');
  });
});

describe('parseYamlSpec', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhd-yaml-parser-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeYaml(contents: string): string {
    const filePath = join(dir, 'adhd.environment.yaml');
    writeFileSync(filePath, contents, 'utf8');
    return filePath;
  }

  it('parses a minimal valid YAML (only project.name) into a well-formed ParsedYamlSpec', () => {
    const filePath = writeYaml('project:\n  name: my-project\n');
    const spec = parseYamlSpec(filePath);
    expect(spec.project.name).toBe('my-project');
    expect(spec.orgNamespace).toBe('adhd');
    expect(spec.envPrefix).toBe('ADHD_MY_PROJECT');
    expect(spec.namespaces).toEqual(['default']);
    expect(spec.dirs).toEqual([]);
    expect(spec.config).toEqual({ system: {}, global: {}, project: {} });
  });

  it('throws when project.name is missing', () => {
    const filePath = writeYaml('project:\n  description: no name here\n');
    expect(() => parseYamlSpec(filePath)).toThrow(YamlSpecError);
  });

  it('throws on an invalid field type', () => {
    const filePath = writeYaml(
      'project:\n  name: my-project\nconfig:\n  project:\n    db.path:\n      type: not-a-real-type\n      default: x\n',
    );
    expect(() => parseYamlSpec(filePath)).toThrow(YamlSpecError);
  });

  it('defaults orgNamespace to "adhd" when absent', () => {
    const filePath = writeYaml('project:\n  name: my-project\n');
    expect(parseYamlSpec(filePath).orgNamespace).toBe('adhd');
  });

  it('uses an explicit orgNamespace when present', () => {
    const filePath = writeYaml('project:\n  name: my-project\n  orgNamespace: acme\n');
    expect(parseYamlSpec(filePath).orgNamespace).toBe('acme');
  });

  it('uses envPrefixOverride when present instead of inferring it', () => {
    const filePath = writeYaml('project:\n  name: agent-mcp\n  envPrefixOverride: ADHD_AGENT\n');
    expect(parseYamlSpec(filePath).envPrefix).toBe('ADHD_AGENT');
  });

  it('infers the env prefix from the project name when envPrefixOverride is absent', () => {
    const filePath = writeYaml('project:\n  name: agent-mcp\n');
    expect(parseYamlSpec(filePath).envPrefix).toBe('ADHD_AGENT_MCP');
  });

  it('defaults namespaces to ["default"] when absent', () => {
    const filePath = writeYaml('project:\n  name: my-project\n');
    expect(parseYamlSpec(filePath).namespaces).toEqual(['default']);
  });

  it('uses declared namespaces as-is (no automatic "default") when present', () => {
    const filePath = writeYaml('project:\n  name: my-project\nnamespaces:\n  - development\n  - production\n');
    expect(parseYamlSpec(filePath).namespaces).toEqual(['development', 'production']);
  });

  it('round-trips: parse then access every top-level field', () => {
    const filePath = writeYaml(
      [
        'project:',
        '  name: agent-mcp',
        '  description: ADHD Agent MCP Server',
        '  orgNamespace: adhd',
        '  envPrefixOverride: ADHD_AGENT',
        'namespaces:',
        '  - development',
        '  - production',
        'dirs:',
        '  - type: state.data',
        '    name: primary',
        '    scope: project',
        '    description: Main SQLite database',
        'config:',
        '  system:',
        '    log.level:',
        '      type: string',
        '      default: info',
        '      enum: [debug, info, warn, error]',
        '  global:',
        '    transport.kind:',
        '      type: string',
        '      default: stdio',
        '  project:',
        '    db.path:',
        '      type: string',
        '      default: ${HOME}/.adhd/agent-mcp/agents.db',
        '    providers.openai.secret:',
        '      type: string',
        '      default: ""',
        '      env: OPENAI_API_KEY',
        '      secret: true',
        '',
      ].join('\n'),
    );
    const spec = parseYamlSpec(filePath);
    expect(spec.project.name).toBe('agent-mcp');
    expect(spec.project.description).toBe('ADHD Agent MCP Server');
    expect(spec.orgNamespace).toBe('adhd');
    expect(spec.envPrefix).toBe('ADHD_AGENT');
    expect(spec.namespaces).toEqual(['development', 'production']);
    expect(spec.dirs).toEqual([
      { type: 'state.data', name: 'primary', path: undefined, scope: 'project', description: 'Main SQLite database' },
    ]);
    expect(spec.config.system['log.level']).toEqual({
      type: 'string',
      default: 'info',
      enum: ['debug', 'info', 'warn', 'error'],
    });
    expect(spec.config.global['transport.kind']).toEqual({ type: 'string', default: 'stdio' });
    expect(spec.config.project['db.path']).toEqual({
      type: 'string',
      default: '${HOME}/.adhd/agent-mcp/agents.db',
    });
    expect(spec.config.project['providers.openai.secret']).toEqual({
      type: 'string',
      default: '',
      env: 'OPENAI_API_KEY',
      secret: true,
    });
  });

  it('throws a descriptive YamlSpecError for malformed YAML syntax', () => {
    const filePath = writeYaml('project:\n  name: [unterminated\n');
    expect(() => parseYamlSpec(filePath)).toThrow(YamlSpecError);
  });

  it('throws a descriptive YamlSpecError when the file does not exist', () => {
    expect(() => parseYamlSpec(join(dir, 'does-not-exist.yaml'))).toThrow(YamlSpecError);
  });

  it('validates that dirs entries declare a recognized DirectoryType', () => {
    const filePath = writeYaml('project:\n  name: my-project\ndirs:\n  - type: not.a.real.type\n');
    expect(() => parseYamlSpec(filePath)).toThrow(YamlSpecError);
  });

  it('the DEFAULT_SPEC_TEMPLATE itself parses and validates successfully', () => {
    const filePath = writeYaml(DEFAULT_SPEC_TEMPLATE);
    const spec = parseYamlSpec(filePath);
    expect(spec.project.name).toBe('my-project');
    expect(spec.dirs).toEqual([]);
    expect(spec.config).toEqual({ system: {}, global: {}, project: {} });
  });
});

describe('validateYamlSpec', () => {
  it('accepts empty config sections as valid (an empty scope is valid)', () => {
    expect(() => validateYamlSpec({ project: { name: 'ok-project' }, config: {} })).not.toThrow();
  });

  it('throws when the document root is not an object', () => {
    expect(() => validateYamlSpec('not-an-object')).toThrow(YamlSpecError);
  });

  it('throws when project.name is not kebab-case', () => {
    expect(() => validateYamlSpec({ project: { name: 'Not_Kebab_Case' } })).toThrow(YamlSpecError);
  });

  it('aggregates multiple issues into a single error', () => {
    try {
      validateYamlSpec({
        project: { name: 'BAD NAME' },
        namespaces: [123],
        dirs: [{ type: 'bogus-type' }],
      });
      expect.fail('expected validateYamlSpec to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(YamlSpecError);
      const yamlSpecError = error as YamlSpecError;
      expect(yamlSpecError.issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
