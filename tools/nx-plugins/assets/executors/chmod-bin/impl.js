'use strict';
/**
 * chmod-bin — sets the executable bit (0o755) on every file `package.json`'s
 * `bin` field points at.
 *
 * BUG-NXASSETS-001: this logic used to live inside the `assets` copy
 * executor (`executors/copy/impl.js`). `assets` is `cache: true`, and an nx
 * cached target's executor BODY never runs at all on a cache hit — only its
 * declared `outputs` are restored. `assets`'s outputs are (correctly, per
 * BUG-026) scoped to the files it actually copies (README/CHANGELOG/skill),
 * which never include the bin path — the bin file is `build`'s output, not
 * this target's, and claiming it here would reintroduce BUG-026's
 * destructive whole-directory-swap restore. So on an `assets` cache hit the
 * chmod simply never happened, and a cached/restored bin file that lost its
 * executable bit (or one produced by a build tool that never sets it, e.g.
 * `@nx/vite:build`/`@nx/js:tsc`) stayed non-executable indefinitely.
 *
 * Fix: pull the chmod out into its OWN target, deliberately `cache: false`
 * (see `plugin.js`) — the syscall cost is a stat+chmod per bin entry
 * (typically one file), sub-millisecond, and the check is idempotent (skips
 * files that already have the bit). An uncacheable target's body runs on
 * EVERY invocation, so there is no cache-hit window in which this can be
 * skipped. `assets` depends on it (`plugin.js`'s `dependsOn`), so nx's task
 * graph pulls it in transitively for every existing consumer of `assets`
 * with no changes needed to any individual project.json. (DEBT-024: the one
 * `test` target that consumes `assets` is `entrypoint/backlog/project.json`'s,
 * `dependsOn: ["^build","build","assets"]`. The global
 * `targetDefaults.test.dependsOn` is `["lint","^build"]` and never included
 * `assets` — so this propagation is scoped to `assets` consumers, not to
 * "every test".)
 */
const { existsSync, readFileSync, chmodSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');

async function run(_options, context) {
  return withMetrics('assets-chmod-bin', context, async () => {
    const projRoot = context.projectsConfigurations.projects[context.projectName].root;
    const src = join(context.root, projRoot);
    const pkgPath = join(src, 'package.json');
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};

    // `pkg.bin` may be declared in STRING form ("bin": "./cli.js") or OBJECT
    // form ({ name: path }). Normalize to the object shape, keyed by the
    // package name's basename for the string form — npm's own convention.
    let binMap = null;
    if (typeof pkg.bin === 'string') {
      const pkgName = typeof pkg.name === 'string' ? pkg.name : '';
      const key = pkgName.includes('/') ? pkgName.slice(pkgName.lastIndexOf('/') + 1) : pkgName;
      if (key) binMap = { [key]: pkg.bin };
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      binMap = pkg.bin;
    }
    if (!binMap) return { success: true };

    for (const [name, relPath] of Object.entries(binMap)) {
      const binFile = join(src, relPath);
      if (!existsSync(binFile)) {
        console.error('assets-chmod-bin: bin[' + name + '] -> ' + relPath + ' does not exist, skipping chmod');
        continue;
      }
      const mode = statSync(binFile).mode;
      if ((mode & 0o111) !== 0o111) {
        chmodSync(binFile, mode | 0o755);
        console.log('assets-chmod-bin: chmod +x ' + relPath + ' (bin[' + name + '])');
      }
    }
    return { success: true };
  });
}
module.exports = run;
module.exports.default = run;
