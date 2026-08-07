# compile-cli — REAL compile CLI BIN

**Phase:** cli · **Kind:** work · **Depends on:** platform-markdown-emit · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-cli.test.ts`

---

## Goal

A real CLI bin (`src/cli/compile.js`, mapped in `package.json` `bin`) drives
`compileAgent` end-to-end: `agent-registry compile <slug> --platform claude_code`
prints platform-shaped markdown to stdout; `--format json` / `--platform
claude_api` prints JSON; `--context '{...}'` selects conditioned components;
`--out-dir <d>` writes files; `--all --category <c>` compiles a whole category.
This is the entrypoint for the behavioral `[dod.5]` — a real process, asserted by
exit code + stdout. Mirrors `USAGE.md` "Compiling to Markdown".

---

## Semantic Distillation

- **Primitive:** ADD `cli/compile.ts` — an argv parser + dispatcher calling
  `compileAgent`.
- **Reference Pattern:** `[ref:cli-bin]`, `[ref:compile-agent]`,
  `[inv:platform-shaped-observable]`.
- **Delta Spec:**
  - parse `compile <slug>` plus `--platform <p>` (default `claude_code`),
    `--context '{...}'`, `--format json`, `--out-dir <d>`, `--all --category <c>`,
    `--db <path>` (so tests point at a seeded tmp DB).
  - default: write the compiled `content` to stdout; `--out-dir`: write
    `<slug>.md` files; exit non-zero with a clear message on unknown slug/platform.
  - Test (`compile-cli.test.ts`): SPAWN the built bin as a child process
    (`node .../cli/compile.js compile <slug> --platform claude_code --db <tmp>`)
    against a seeded DB; assert the child EXITS 0 and stdout begins with `---`
    frontmatter and contains the resolved `tools:` line; assert `--format json`
    yields a parseable object. Key on the child's EXIT CODE, not on a `grep`.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compile-cli.1] CLI parses --platform/--context/--out-dir/--all

- [compile-cli.2] CLI drives compile and asserts stdout markdown
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/compile.ts"]
mutates:    ["packages/ai/agent-compiler/src/cli/compile.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/compile-cli.test.ts"]
```

---

## Commit points

- `feat(agent-compiler): compile CLI bin prints platform output to stdout`

## Notes for executor

- The test MUST spawn the bin as a child process and key on its exit code +
  stdout — importing the module in-process does not prove the bin works
  (CLAUDE.md verification standard, `[inv:real-rows-not-mocks]`).
- `compile-cli` and `composed-prompt-caching` both depend on
  `platform-markdown-emit` and both touch `index.ts`; serialize through the barrel.
