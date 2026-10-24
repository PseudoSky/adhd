## Unreleased

Initial scaffold of `@adhd/stealth-core-browser`.

- Removed the unimplemented `ProfileClient.getOpenTabs()` stub (it only warned and returned `[]`); use `listPageTargets()` for the open tabs of a running Chrome.
