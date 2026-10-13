# Approvals

DEP-APPROVAL: granted

Approved dependencies of @adhd/stealth-browser (entrypoint/stealth-browser) only:

- node-html-parser
- xpath
- @xmldom/xmldom

granted-by: user (AskUserQuestion answer in run dispatch-2026-10-12-ca18)

Scope: these three packages in entrypoint/stealth-browser. Any other new dependency requires a fresh approval.

## Amendment (three-package split)

Dependencies `turndown`, `pdfjs-dist` and `commander` for `@adhd/stealth-search` (entrypoint/stealth-search) need no approval gate: they are commodity dependencies of an owned package, and sox packages are owned (`APPROVAL-split.md`). The earlier grant above applies to `packages/stealth/stealth-core-browser` (the renamed runner).
