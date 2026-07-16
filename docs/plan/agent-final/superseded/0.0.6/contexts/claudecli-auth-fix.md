# State: claudecli-auth-fix

## Goal

Fix `ClaudeCliProvider.buildSubprocessEnv` catch block: log the keychain error at warn level and capture it for later use. If `chat()` fails (empty result or `is_error: true`), include the keychain failure reason in the thrown `PROVIDER_AUTH_ERROR` message. Fix `AnthropicProvider` with `useClaudeOauth:true`: on keychain failure, degrade to env vars before throwing `PROVIDER_AUTH_ERROR`.

## Semantic distillation

Two separate bugs:

1. **claudecli**: `buildSubprocessEnv` silently catches keychain errors (`catch {}`). When the subprocess subsequently fails because it lacks credentials, the error surface shows only a generic CLI failure — the actual root cause (keychain ACL denial) is invisible. Fix: log + capture the error, propagate it into the thrown message.

2. **anthropic**: `useClaudeOauth:true` calls `getAccessToken()` which calls `readKeychainCreds()`. If that throws (keychain locked, macOS trust not granted), the provider immediately fails with the raw keychain error. Fix: fall back to `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env vars, throw `PROVIDER_AUTH_ERROR` with recovery instruction only if both fallbacks are absent.

See [inv:claudecli-auth-recovery] and [def:ProviderAuthError] in `_shared.md` for the exact recovery message text.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/providers/claudecli.ts`
- `packages/ai/agent-mcp/src/providers/anthropic.ts`

**read_only:**
- `packages/ai/agent-mcp/src/logger.ts` (pino logger — import and use for warn)
- `packages/ai/agent-mcp/src/validation/errors.ts` (ToolError class)

## Contract

**Modified: `packages/ai/agent-mcp/src/providers/claudecli.ts`**

In `buildSubprocessEnv()`, replace the empty catch block:
```typescript
let keychainError: string | undefined;

try {
  const { stdout } = await execFileAsync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(stdout.trim()) as {
    claudeAiOauth?: { accessToken?: string };
  };
  const token = parsed.claudeAiOauth?.accessToken;
  if (token) env["ANTHROPIC_AUTH_TOKEN"] = token;
} catch (err) {
  keychainError = err instanceof Error ? err.message : String(err);
  logger.warn({ keychainError }, "claudecli: keychain read failed; subprocess will use inherited env");
}

return { env, keychainError };
```

Note: `buildSubprocessEnv` signature changes to return `{ env: NodeJS.ProcessEnv; keychainError?: string }`.

In `chat()`, after calling `buildSubprocessEnv`:
```typescript
const { env: subEnv, keychainError } = await this.buildSubprocessEnv();
```

At the end of `chat()`, before returning, check if the result is an auth failure:
```typescript
// If the CLI reported an error OR returned empty result, surface auth info
if (!finalResult) {
  throw new ToolError(
    "PROVIDER_AUTH_ERROR",
    `Claude CLI returned empty result${keychainError ? `. Keychain error: ${keychainError}` : ""}. ` +
    `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
  );
}
```

**Modified: `packages/ai/agent-mcp/src/providers/anthropic.ts`**

In `chat()`, the `useClaudeOauth` path:
```typescript
if (this.config.useClaudeOauth) {
  try {
    const authToken = await getAccessToken();
    this.client = new Anthropic({ authToken });
  } catch (keychainErr) {
    // Keychain failed — try env var fallbacks before giving up
    const keychainMsg = keychainErr instanceof Error ? keychainErr.message : String(keychainErr);
    logger.warn({ keychainMsg }, "AnthropicProvider: keychain read failed, trying env var fallbacks");

    const apiKey = process.env["ANTHROPIC_API_KEY"] || undefined;
    const authToken = process.env["ANTHROPIC_AUTH_TOKEN"] || undefined;

    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    } else if (authToken) {
      this.client = new Anthropic({ authToken });
    } else {
      throw new ToolError(
        "PROVIDER_AUTH_ERROR",
        `Anthropic keychain read failed: ${keychainMsg}. ` +
        `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
      );
    }
  }
}
```

## Acceptance criteria

[claudecli-auth-fix.1] `buildSubprocessEnv` catch block in `claudecli.ts` is no longer empty (logs warn and captures error)

[claudecli-auth-fix.2] `PROVIDER_AUTH_ERROR` is thrown in `claudecli.ts` when `finalResult` is empty

[claudecli-auth-fix.3] `PROVIDER_AUTH_ERROR` is thrown in `anthropic.ts` when keychain fails and no env var fallback exists

[claudecli-auth-fix.4] The recovery instruction text appears in `claudecli.ts` (contains `setup-token` or `authTokenEnv`)

[claudecli-auth-fix.5] The recovery instruction text appears in `anthropic.ts` (contains `setup-token` or `authTokenEnv`)

## Commit points

**R2 (post-guard):**
```
fix(agent-mcp): claudecli auth error surface; anthropic keychain graceful degradation
```

## Notes

- The `buildSubprocessEnv` return type change (adding `keychainError`) requires updating the call site in `chat()`. It is the only caller.
- Import `logger` from `"../logger.js"` in `claudecli.ts` if not already imported.
- Import `ToolError` from `"../validation/errors.js"` in `claudecli.ts` if not already imported.
- The empty-result guard in `chat()` fires when `finalResult === ""` after the for-await loop exits normally without a `"result"` event. The current code returns an assistant message with `content: ""` in this case — the new code throws instead.
- `AnthropicProvider.chat()` currently sets `this.client` in the constructor (non-OAuth path). For OAuth, it sets `this.client` at the start of each `chat()` call. The fix wraps only the OAuth path in a try-catch — the constructor path is unaffected.
- See [def:ProviderAuthError] and [inv:claudecli-auth-recovery] in `_shared.md` for the exact recovery message text that audit checks verify.
