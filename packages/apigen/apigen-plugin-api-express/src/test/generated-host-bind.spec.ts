/** Generated Express host must bind loopback (backlog 5989ed90 S9; `host-default-localhost`). Pure string check, binds no port. */
import { describe, expect, it } from 'vitest';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

describe('[host-default-localhost] generated Express routes.ts', () => {
  it('app.listen passes an explicit loopback host (bare listen(port) binds every interface)', () => {
    const input = { packages: [], outputDir: '', options: { port: 4100 } } as unknown as PluginInput;
    const { content } = generate(input).files[0];
    expect(content).toContain("app.listen(4100, '127.0.0.1')");
    expect(content).not.toMatch(/app\.listen\(4100\)/);
  });
});
