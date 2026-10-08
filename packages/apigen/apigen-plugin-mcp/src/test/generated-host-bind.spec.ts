/** Generated MCP http host must bind loopback (backlog 5989ed90 S9; `host-default-localhost`). Pure string check, binds no port. */
import { describe, expect, it } from 'vitest';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

describe('[host-default-localhost] generated MCP http server', () => {
  it.each(['streaming-http', 'sse'])('listen() passes an explicit loopback host for %s', (transport) => {
    const input = { packages: [], outputDir: '', options: { transport, port: 3100 } } as unknown as PluginInput;
    const content = generate(input).files.map((f) => f.content).join('\n');
    expect(content).toMatch(/httpServer\.listen\(3100, '127\.0\.0\.1',/);
    expect(content).not.toMatch(/httpServer\.listen\(3100, \(\)/);
  });
});
