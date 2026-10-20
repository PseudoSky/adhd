// guards: `apigen --version` from the built CJS and ESM bundles reports a literal rather than package.json's version
// tier: P
// gap: This cannot be observed at tier S because the lookup of package.json relative to the bundle only exists once rolldown has inlined src/lib/version.ts into dist/index.js and dist/index.mjs and the file is run as a real node process.
// cites: BUG apigen-cli --version hard-coded 0.1.0 (task fix(apigen-cli): report the real package version) AC1
// tags: regression:apigen-cli-version-literal, contract
// teeth: red: npx vitest run --config vitest.e2e.config.ts src/test/e2e/version.e2e.ts (built from src/index.ts with .version('0.1.0')) -> exit 1; AssertionError: expected '0.1.0' to be '0.2.11'
// fidelity gap: runs the in-repo dist, where the build writes dist/package.json beside the bundle (the published layout, first candidate); the npm publish/install round trip itself is not exercised.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
const PKG_ROOT = path.resolve(__dirname, '..', '..', '..');
const expected = (
  JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

describe('built apigen --version', () => {
  for (const file of ['index.js', 'index.mjs']) {
    it(`${file} reports the package.json version`, async () => {
      const { stdout } = await execFileAsync(process.execPath, [path.join(PKG_ROOT, 'dist', file), '--version']);
      expect(stdout.trim()).toBe(expected);
    }, 30_000);
  }
});
