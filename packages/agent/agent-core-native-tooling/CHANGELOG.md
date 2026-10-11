## 0.0.3 (2026-10-11)

### 🩹 Fixes

- **agent-mcp:** preserve CRLF line endings across fs edit_file/write_file (8dd148cf R3-EOL AC1-AC4) ([ae270f99](https://github.com/PseudoSky/adhd/commit/ae270f99))

### ❤️ Thank You

- pseudosky

## 0.0.2 (2026-10-07)

### 🚀 Features

- **nx-build:** release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069) ([35bbcbf0](https://github.com/PseudoSky/adhd/commit/35bbcbf0))
- **agent:** pass the adopted shell server's ALLOW_PATTERNS through ([f74e9b05](https://github.com/PseudoSky/adhd/commit/f74e9b05))
- **agent-mcp,agent-core-native-tooling:** portable multi-root fs + caller-supplied cwd + global allowed-root map (ADR-0008 D4/D7/D8) ([99f43c07](https://github.com/PseudoSky/adhd/commit/99f43c07))
- **agent-mcp:** single task-time resolution for nativeTooling, merge precedence (NAT-TOOL-4) ([740f8325](https://github.com/PseudoSky/adhd/commit/740f8325))
- **agent-core-native-tooling:** adopt fs + tumf shell + srt; retire authored shell (NAT-TOOL-8) ([db17316f](https://github.com/PseudoSky/adhd/commit/db17316f))

### 🩹 Fixes

- **agent-mcp:** assert pinned node fs launch + pinned shell, drop npm registry from srt allowlist, connectTimeoutMs type, docs (c9f0a791) ([b9ab73bc](https://github.com/PseudoSky/adhd/commit/b9ab73bc))
- **agent-core-native-tooling:** launch fs server via pinned dep with node, pin shell server (c9f0a791) ([7c03b553](https://github.com/PseudoSky/adhd/commit/7c03b553))
- **agent-core-native-tooling:** wire typecheck-spec ratchet; fix 4 spec type errors ([a49d4fbe](https://github.com/PseudoSky/adhd/commit/a49d4fbe))
- **agent-core-native-tooling:** shell.root under the portable-hint contract; harden alias lookup; legacy dispatch-self env fallback ([cb62e203](https://github.com/PseudoSky/adhd/commit/cb62e203))
- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-mcp:** retain legacy mcp-shell security.yaml; restore f141baad guard (NAT-TOOL-4) ([102414c6](https://github.com/PseudoSky/adhd/commit/102414c6))
- **agent-core-native-tooling:** matchPermission matches tool NAMES, never command text ([be2c0041](https://github.com/PseudoSky/adhd/commit/be2c0041))
- **agent-core-native-tooling:** resolve workspace dep from built declaration; drop re-basing --baseUrl ([d97a8836](https://github.com/PseudoSky/adhd/commit/d97a8836))

### ❤️ Thank You

- pseudosky

## 0.0.1

Initial release. Core resolver + thin tool-name permission matcher for the
standardized native toolset (ADR-0008 D2/D4/D5): `resolveNativeTooling`,
`matchPermission`, and the fs/shell/dispatch server catalog. CommonJS-only
(`adhd ADR-0003`).
