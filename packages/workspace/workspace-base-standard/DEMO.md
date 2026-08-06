# Demo — @adhd/workspace-base-standard

This walks through the four capabilities this package ships, using only its
public API against real files on disk.

## 1. Read the workspace taxonomy

```ts
import { readTaxonomy } from '@adhd/workspace-base-standard';

const taxonomy = readTaxonomy(process.cwd()); // repo root
console.log(Object.keys(taxonomy.groups));
// -> ['apigen', 'agent', 'data', 'dispatch', 'environment', 'ui-react', 'workspace']
```

## 2. Check a project directory against the workspace standard

```ts
import { checkProject } from '@adhd/workspace-base-standard';

const results = checkProject('/path/to/packages/foo/foo-base-bar', ['domain:foo', 'pkg-kind:base'], {
  mode: 'dev',
});

for (const r of results) {
  console.log(`[${r.severity}] ${r.rule}: ${r.message}`);
}
// e.g. [error] required-file-present: Required file "DEMO.md" is missing from ...
```

Run it against this package's own directory. As of this writing it does
**not** fully pass its own standard yet — and that's expected, not a bug:

```bash
node -e "
const { checkProject } = require('./dist/index.js');
const results = checkProject(process.cwd(), ['domain:workspace', 'pkg-kind:base']);
console.log(JSON.stringify(results, null, 2));
"
```

```json
[
  { "rule": "required-target-present", "severity": "error", "message": "Required target \"test\" is missing from project.json. ..." },
  { "rule": "required-target-present", "severity": "error", "message": "Required target \"typecheck\" is missing from project.json. ..." },
  { "rule": "required-target-present", "severity": "error", "message": "Required target \"demo\" is missing from project.json. ..." },
  { "rule": "required-target-present", "severity": "error", "message": "Required target \"verify\" is missing from project.json. ..." }
]
```

Why: this package's own `project.json` only declares `build`, `lint`, and
`nx-release-publish` as **explicit** target keys — `test` (via the
`@nx/vite/plugin` `createNodes`) and `verify-dist-load` (via
`tools/nx-plugins/build/plugin.js`) work today, but only as Nx-plugin
*inferred* targets, and `checkProject` reads `project.json` as plain JSON
by design (see `checker.ts`'s doc comment and this package's own
`CLAUDE.md` — it stays Nx-free on purpose). `typecheck`/`demo`/`verify`
(the bare name, distinct from `verify-dist-load`) have no inferred-target
equivalent anywhere in this repo yet at all; wiring real targets for those
— and reconciling inferred vs. declared targets in this checker — is
`PKG-WS-NX-ADAPTER`'s job, not this package's. This package ships the
*standard* and the *checker*; it does not yet enforce itself against it,
because the enforcement point doesn't exist yet. Don't "fix" this by
inventing thin project.json target keys here just to turn the count to
zero — that's the adapter package's decision to make once it exists.

## 3. Apply an idempotent managed region

```ts
import { applyManagedRegion } from '@adhd/workspace-base-standard';

let readme = '# My Package\n\nHand-written intro.\n';
readme = applyManagedRegion(readme, 'targets-table', '| build | ✅ |\n| test | ✅ |');
// readme now has a managed region appended, with markers.

// Re-applying with a NEW body replaces only that region — the hand-written
// intro (and anything else outside the markers) survives byte-for-byte.
readme = applyManagedRegion(readme, 'targets-table', '| build | ✅ |\n| test | ✅ |\n| demo | ✅ |');
```

## 4. Round-trip commit provenance through a CHANGELOG note

```ts
import { parseCommitTrailers, renderChangelogProvenanceNote, parseChangelogProvenanceNote } from '@adhd/workspace-base-standard';

const commitMessage = `feat(workspace-base-standard): add provenance module

Work-Item: backlog:FEAT-PROVENANCE-001
Dispatcher: plan-orchestrator
Author: typescript-pro:v1
Model: claude/opus`;

const trailer = parseCommitTrailers(commitMessage)!;
const note = renderChangelogProvenanceNote(trailer);
console.log(note);
// -> ‹work:backlog:FEAT-PROVENANCE-001 · dispatcher:plan-orchestrator · author:typescript-pro:v1 · model:claude/opus›

console.log(parseChangelogProvenanceNote(note));
// -> { workItem: 'backlog:FEAT-PROVENANCE-001', dispatcher: 'plan-orchestrator', author: 'typescript-pro:v1', model: 'claude/opus' }
```

## Running the real thing

Every capability above is exercised by this package's own test suite
against real fixture directories on disk (no mocked `fs`):

```bash
npx nx affected -t test --uncommitted
```

See `src/checker.spec.ts` for the real-fixture proof that `checkProject`
flags a project missing `DEMO.md`, and `src/provenance.spec.ts` for the
full commit-trailer round-trip proof.
