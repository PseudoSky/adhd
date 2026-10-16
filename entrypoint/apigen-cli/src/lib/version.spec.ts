// guards: the CLI reports a hand-maintained version literal instead of the package.json version
// tier: S
// cites: BUG apigen-cli --version hard-coded 0.1.0 (task fix(apigen-cli): report the real package version) AC1
// tags: regression:apigen-cli-version-literal
// teeth: the old code had no readPackageVersion, so this file cannot compile against it (import of ./version fails); the behavioural red against the old '0.1.0' literal is recorded in src/test/e2e/version.e2e.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackageVersion } from './version';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

describe('readPackageVersion (source)', () => {
  it("equals this package's own package.json version", () => {
    expect(manifest.name).toBe('@adhd/apigen-cli');
    expect(readPackageVersion(pathToFileURL(__filename).href)).toBe(manifest.version);
  });

  it('fails loudly when no @adhd/apigen-cli manifest is reachable', () => {
    expect(() => readPackageVersion('file:///nonexistent-root/x/y/z.js')).toThrow(/unable to determine version/);
  });
});
