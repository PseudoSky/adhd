---
package: "@adhd/apigen-plugin-cli-output"
path: "/Users/nix/dev/node/adhd/packages/apigen/apigen-plugin-cli-output"
root: adhd
language: node
self_internal: false
current_scope_behavior: none
env_vars: ["APIGEN_<PLUGINID>_<FIELD>"]
writes: [{path: "cli.ts", kind: "unknown", purpose: "Generated CLI entrypoint (code output)"}]
config_files: []
supported_by_env: no
gaps: [G1, G5]
value: low
effort: high
recommend: skip
---

## Current state

**Environment Variables:**
- `APIGEN_<PLUGINID>_<FIELD>` · read at line 214 during envelope field binding · no default · env var names are dynamically generated from schema metadata (x-apigen-envelope) and pluginId/field values

**Writes:**
- `cli.ts` · unknown · generated TypeScript code output (PluginOutput.files, line 244); written to provided output directory

**Config Files:**
- None. Configuration is entirely provided via PluginInput (options, packages, schemas).

**Scope/Path Behavior:**
- No hardcoded paths. Uses `input.outputDir` (line 97) for relative import path resolution.
- No home-directory, no XDG, no cwd-relative writes.
- No persistence layer (database, cache, logs, state files).

## Proposed `EnvironmentSpec`

This package is a code-generation plugin with minimal runtime-configuration surface. The env vars it reads (`APIGEN_*`) are emitted into generated CLI code, not consumed by the plugin itself. Adoption is not recommended; spec provided for reference only:

```typescript
export const environmentSpec: EnvironmentSpec<{
  envelope?: Record<string, string>;
}> = {
  envPrefixOverride: 'APIGEN',
  fields: {
    // Envelope fields are dynamic, keyed by pluginId + field name.
    // A fixed EnvironmentSpec cannot express this pattern.
    // Would require runtime schema-driven config, which env does not support.
  },
  // No directories or files.
};
```

## Gap detail

- **G1** Dynamic env-var names (`APIGEN_<PLUGINID>_<FIELD>`) derived from x-apigen-envelope schema metadata at runtime; `APIGEN_*` prefix is non-standard and not guarded by `isEnvNameAllowed` under the `ADHD_*` model. Envelope field bindings (lines 156–220) are schema-driven, not known at compile time.
- **G5** Envelope field set is open and arbitrary (any field in x-apigen-envelope → any env var name); cannot be expressed as fixed dot-path FieldSpecs.

## File-location table

| Current path | Kind | Purpose | Proposed env key |
|---|---|---|---|
| `cli.ts` (generated output) | code | Generated CLI entrypoint | (external file output, not env-managed) |
| `process.env['APIGEN_<PLUGINID>_<FIELD>']` | — | Envelope field binding fallback | Not adoptable (dynamic) |
