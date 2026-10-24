# check-test-wiring (exit 1)

Command: node tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs
EXIT 1. Full output (the gate prints nothing else):

```
✖ projects with test files but NO `test` target (their tests can NEVER run):
   packages/agent/agent-store-runtime  (12 spec file(s))
   packages/agent/agent-store-prompts  (8 spec file(s))
  Fix: add a `test` target (see packages/agent/agent-store-runtime/project.json for the shape).
```
