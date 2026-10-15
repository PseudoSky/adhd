// BudgetPlugin responseSize — the emitted tool result never exceeds the cap, truncation
// notice included.
//
// Header (author-regression):
//   - item 977e0ca6 (fix pre-state 6e29bff1): enforceResponseSize appended the truncation
//     notice after filling the whole cap, so the emitted text exceeded the limit that
//     triggered truncation. AC: output never exceeds the cap including the notice;
//     boundary cases cap-1, cap, cap+1, and a cap smaller than the notice.
//   - Failure mode: a warning-mode truncation returns text longer than `maximum`.
//   - Tier: S (unit). The plugin is driven through its real HookRegistry
//     `transform:tool_result` hook. No DB, process, or network is touched (db: null).
//   - Fidelity-gap: N/A (tier S).
//   - regression:977e0ca6
//
// The two cap-1 / cap boundary tests are no-regression guards: they pass before the fix
// too. The regression assertions are cap+1, the sub-notice cap, and the multi-part case.

import { describe, it, expect, beforeEach } from 'vitest';
import { HookRegistry } from '@adhd/agent-base-types';
import type { ExecutionContext, PostToolCallPayload } from '@adhd/agent-base-types';
import { createPlugin, pluginConfigSchema } from '../index.js';

function makeCtx(): ExecutionContext {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    agentName: 'test-agent',
    agentDefinition: {
      name: 'test-agent',
      version: 1,
      provider: { type: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: '',
      mcpServers: {},
      permissions: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
}

function responseSizePlugin(cap: { maximum: number; mode: 'warning' | 'block'; message?: string }) {
  return createPlugin({
    db: null,
    config: pluginConfigSchema.parse({
      tool: { overrides: { read_file: { caps: [{ field: 'responseSize', ...cap }] } } },
    }),
  });
}

function payloadFor(content: unknown[]): PostToolCallPayload {
  return {
    executionContext: makeCtx(),
    toolName: 'read_file',
    callId: 'call-1',
    toolInput: {},
    result: { content },
    isError: false,
    estResultTokens: 0,
  };
}

/** Total characters across every text part of the emitted tool result. */
function emittedTextLength(payload: PostToolCallPayload): number {
  const content = (payload.result as { content: { type: string; text?: string }[] }).content;
  return content
    .filter((part) => part.type === 'text')
    .reduce((sum, part) => sum + (part.text ?? '').length, 0);
}

function emittedText(payload: PostToolCallPayload): string {
  const content = (payload.result as { content: { type: string; text?: string }[] }).content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

describe('responseSize notice reserve (977e0ca6)', () => {
  let hooks: HookRegistry;

  beforeEach(() => {
    hooks = new HookRegistry();
  });

  // Boundary: content exactly one under the cap is never truncated and carries no notice.
  it('cap-1: content one char under the limit is passed through unchanged, no notice', async () => {
    const plugin = responseSizePlugin({ maximum: 100, mode: 'warning' });
    await plugin.install(hooks);
    const body = 'x'.repeat(99);
    const payload = payloadFor([{ type: 'text', text: body }]);

    await hooks.emit('transform:tool_result', payload);

    expect(emittedText(payload)).toBe(body);
    expect(emittedText(payload)).not.toContain('[truncated');
  });

  // Boundary: content exactly at the cap is not truncated.
  it('cap: content exactly at the limit is passed through unchanged, no notice', async () => {
    const plugin = responseSizePlugin({ maximum: 100, mode: 'warning' });
    await plugin.install(hooks);
    const body = 'x'.repeat(100);
    const payload = payloadFor([{ type: 'text', text: body }]);

    await hooks.emit('transform:tool_result', payload);

    expect(emittedText(payload)).toBe(body);
    expect(emittedText(payload)).not.toContain('[truncated');
  });

  // Regression: one char over the cap must still truncate, and the emitted text (content
  // plus notice) must still be within the cap. Pre-fix the output was ~100 chars + notice.
  it('cap+1: truncated output including the notice is never longer than the cap', async () => {
    const plugin = responseSizePlugin({ maximum: 100, mode: 'warning' });
    await plugin.install(hooks);
    const payload = payloadFor([{ type: 'text', text: 'x'.repeat(101) }]);

    await hooks.emit('transform:tool_result', payload);

    expect(emittedText(payload)).toContain('[truncated');
    expect(emittedTextLength(payload)).toBeLessThanOrEqual(100);
  });

  // Regression: a multi-part result is split at the cap; the notice is part of the budget,
  // so the summed text across parts stays within the cap.
  it('multi-part result: summed text across parts, notice included, stays within the cap', async () => {
    const plugin = responseSizePlugin({ maximum: 200, mode: 'warning' });
    await plugin.install(hooks);
    const payload = payloadFor([
      { type: 'text', text: 'a'.repeat(150) },
      { type: 'text', text: 'b'.repeat(150) },
    ]);

    await hooks.emit('transform:tool_result', payload);

    expect(emittedText(payload)).toContain('[truncated');
    expect(emittedTextLength(payload)).toBeLessThanOrEqual(200);
  });

  // Regression: a cap smaller than the notice itself. The notice is clipped to the cap so
  // the emitted text still never exceeds it. Pre-fix the notice alone was appended in full.
  it('cap smaller than the notice: emitted text is clipped to the cap', async () => {
    const plugin = responseSizePlugin({ maximum: 40, mode: 'warning' });
    await plugin.install(hooks);
    const payload = payloadFor([{ type: 'text', text: 'x'.repeat(500) }]);

    await hooks.emit('transform:tool_result', payload);

    expect(emittedTextLength(payload)).toBeLessThanOrEqual(40);
  });

  // Block mode shares the same invariant: the replacement message is clipped to the cap.
  it('block mode: a replacement message longer than the cap is clipped to it', async () => {
    const plugin = responseSizePlugin({
      maximum: 30,
      mode: 'block',
      message: 'm'.repeat(200),
    });
    await plugin.install(hooks);
    const payload = payloadFor([{ type: 'text', text: 'x'.repeat(500) }]);

    await hooks.emit('transform:tool_result', payload);

    expect(payload.isError).toBe(true);
    expect(emittedTextLength(payload)).toBeLessThanOrEqual(30);
  });
});
