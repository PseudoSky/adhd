/**
 * A2 — exactly ONE producer of the agent-mcp self launch config.
 *
 * Before this fix dispatch-cli authored its OWN self config
 * (`buildDispatchSelfServer`/`resolveAgentMcpLaunch`) with a different default
 * argv (`-y @adhd/agent-mcp` vs `-y @adhd/agent-mcp@latest`) and a different
 * env-var pair (`ADHD_DISPATCH_AGENT_MCP_*` vs `ADHD_AGENT_MCP_*`). It now
 * delegates to the shared `buildDispatchSelf`. These assertions FAIL if the
 * second producer (or its divergent default/env) reappears.
 */
import { describe, expect, it } from 'vitest';

import { buildDispatchSelf } from '@adhd/agent-core-native-tooling';
import type { McpServerConfig } from '@adhd/agent-base-types';

import { buildDispatchSelfServer } from '../lib/core.js';

function stdio(c: McpServerConfig): Extract<McpServerConfig, { transport: 'stdio' }> {
  if (c.transport !== 'stdio') throw new Error('expected a stdio config');
  return c;
}

describe('A2 — ONE agent-mcp self producer (dispatch-cli delegates)', () => {
  it('buildDispatchSelfServer returns EXACTLY the shared producer output (one canonical default argv)', () => {
    expect(buildDispatchSelfServer({})).toEqual(buildDispatchSelf({}));
    expect(stdio(buildDispatchSelfServer({})).args).toEqual([
      '-y',
      '@adhd/agent-mcp@latest',
    ]);
  });

  it('honors the ONE canonical env pair (ADHD_AGENT_MCP_*)', () => {
    const env = {
      ADHD_AGENT_MCP_COMMAND: 'node',
      ADHD_AGENT_MCP_ARGS: '/x/dist.js serve',
    } as NodeJS.ProcessEnv;
    expect(buildDispatchSelfServer(env)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['/x/dist.js', 'serve'],
    });
  });

  it('the LEGACY pair (ADHD_DISPATCH_AGENT_MCP_*) is honoured as a FALLBACK (#8, one-release compat)', () => {
    const legacy = {
      ADHD_DISPATCH_AGENT_MCP_COMMAND: 'node',
      ADHD_DISPATCH_AGENT_MCP_ARGS: '/legacy.js serve',
    } as unknown as NodeJS.ProcessEnv;
    expect(buildDispatchSelfServer(legacy)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['/legacy.js', 'serve'],
    });
  });

  it('the canonical pair WINS over the legacy pair when both are set (#8)', () => {
    const both = {
      ADHD_AGENT_MCP_COMMAND: 'node',
      ADHD_AGENT_MCP_ARGS: '/canonical.js',
      ADHD_DISPATCH_AGENT_MCP_COMMAND: 'ignored',
      ADHD_DISPATCH_AGENT_MCP_ARGS: '/legacy.js',
    } as unknown as NodeJS.ProcessEnv;
    expect(buildDispatchSelfServer(both)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['/canonical.js'],
    });
  });

  it('NEGATIVE CONTROL: with NEITHER pair set the canonical default applies (no second default survives)', () => {
    const empty = {} as NodeJS.ProcessEnv;
    expect(buildDispatchSelfServer(empty)).toEqual(buildDispatchSelf({}));
    expect(stdio(buildDispatchSelfServer(empty)).args).toEqual([
      '-y',
      '@adhd/agent-mcp@latest',
    ]);
  });
});
