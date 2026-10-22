## 0.0.4 (2026-10-22)

### 🩹 Fixes

- **nx-test:** pre-push runs tier S only; tier P/H/X specs live in the e2e lane ([71039a60](https://github.com/PseudoSky/adhd/commit/71039a60))

### ❤️ Thank You

- pseudosky

## 0.0.3 (2026-10-21)

This was a version bump only for policy to align it with other projects, there were no code changes.

## 0.0.2 (2026-10-19)

### 🚀 Features

- **policy:** serve takes an injectable host transport and handshake timeout ([6e27d320](https://github.com/PseudoSky/adhd/commit/6e27d320))
- **policy:** run, serve and mcp-json verbs fronting a bin: source through the policy Layer (T09) ([c4c2b46c](https://github.com/PseudoSky/adhd/commit/c4c2b46c))
- **policy:** adhd-policy, adhd-policy-mcp and adhd-policy-http bins over the client with a baked operation surface (T06) ([ead861c6](https://github.com/PseudoSky/adhd/commit/ead861c6))
- **policy:** scaffold policy domain, policy-core-client, policy entrypoint and apigen-plugin-policy ([e6cfb9ec](https://github.com/PseudoSky/adhd/commit/e6cfb9ec))

### 🩹 Fixes

- **policy:** policy:test builds its own dist before running (4041424f) ([f65fa1b2](https://github.com/PseudoSky/adhd/commit/f65fa1b2))
- **policy:** installed-layout dist lookup, tamper-evident atomic mcp-json, serve --name, strict flags and port, signals only for verbs, strict dereference, doctor exit 2 (E1-E6, E8-E13) ([5d326d8b](https://github.com/PseudoSky/adhd/commit/5d326d8b))
- **apigen-engine-gateway:** user-chosen operation ids, verbatim passthrough of arguments and tool definitions, skip bad tools, follow host and upstream shutdown (G2-G8) ([0cf7897d](https://github.com/PseudoSky/adhd/commit/0cf7897d))

### ❤️ Thank You

- pseudosky