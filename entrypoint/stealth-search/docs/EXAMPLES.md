# Examples

Every file under `examples/`, with its scenario. Each `run({ api })` takes the operations as an injected dependency (pass `import * as api from '@adhd/stealth-search'`) and returns the text it prints, so a unit test can hand in fakes. Outcomes such as `empty`, `hitl` or `rate_limited` are data on the result; a thrown failure is a typed error listed in [ERRORS.md](ERRORS.md).

| File | Scenario |
| --- | --- |
| [`examples/search-web.ts`](../examples/search-web.ts) | Search DuckDuckGo with a `site:` qualifier and print the numbered hits, branching on the `outcome` instead of catching an exception. |
| [`examples/fetch-page.ts`](../examples/fetch-page.ts) | Read a URL as markdown with the `fetch` provider, window by window, continuing from each result's `nextOffset`. |
| [`examples/providers.ts`](../examples/providers.ts) | List every provider with its strategies, then read the GitHub provider's guide and its qualifier examples. |
| [`examples/tripwire.ts`](../examples/tripwire.ts) | List the providers a captcha, rate limit or ban has tripped and clear each one after solving the wall by hand. |
| [`examples/chrome-lifecycle.ts`](../examples/chrome-lifecycle.ts) | Start a dedicated Chrome on port 9333 when none answers, check that it is idle, and shut it down. |
| [`examples/page-targets.ts`](../examples/page-targets.ts) | List the open pages of the controlled Chrome and read the url, title, cookie count and history of one without evaluating script in it. |
| [`examples/types.ts`](../examples/types.ts) | The `ExampleDeps` type that injects the eleven operations into every example. |
| [`examples/manifest.json`](../examples/manifest.json) | The list of README code blocks that the example tests verify (id, block index and source). |
| [`examples/tsconfig.json`](../examples/tsconfig.json) | The type-check configuration of the example files. |

The README code blocks are listed in `examples/manifest.json`; `test/unit/examples/examples.spec.ts` checks that each TypeScript block is a line of one of these files and that each command line names a real operation and flags.
