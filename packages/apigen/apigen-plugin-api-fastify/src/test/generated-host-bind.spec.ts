/** Generated Fastify host names its loopback host explicitly (backlog 5989ed90 S9; `host-default-localhost`). Pure string check, binds no port. */
import { describe, expect, it } from 'vitest';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

describe('[host-default-localhost] generated Fastify routes.ts', () => {
  it("listen() pins host 'localhost' instead of relying on a framework default", () => {
    const input = { packages: [], outputDir: '', options: { port: 5100 } } as unknown as PluginInput;
    const { content } = generate(input).files[0];
    expect(content).toContain("await app.listen({ port: 5100, host: 'localhost' })");
  });
});
