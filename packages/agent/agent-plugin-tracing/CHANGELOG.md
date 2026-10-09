## Unreleased

### 🚀 Features

- **agent-plugin-tracing:** re-export the sox-telemetry log-channel API (createLogChannel, createRedactor, identityRedactor, DEFAULT_REDACTION_RULES, BodyCapture, captureBody, withLogContext, currentLogContext + types) (c536ce29 TRC-AC21)

## 0.0.2 (2026-10-07)

### 🚀 Features

- **agent-mcp:** default-load agent-plugin-tracing with typed tracing config, reuse existing telemetry provider, audit script + docs (0f760dcd, 5dff26e6) ([0891a3bc](https://github.com/PseudoSky/adhd/commit/0891a3bc))
- **agent-plugin-tracing:** scaffold and implement tracing plugin over sox-telemetry (6ae794fe TRACE-3) ([08129f4f](https://github.com/PseudoSky/adhd/commit/08129f4f))

### 🩹 Fixes

- **agent-plugin-tracing:** post-merge review fixes F1/F2/F3/F6/F7 + deterministic tests (6ae794fe) ([4c6dc6d4](https://github.com/PseudoSky/adhd/commit/4c6dc6d4))

### ❤️ Thank You

- pseudosky