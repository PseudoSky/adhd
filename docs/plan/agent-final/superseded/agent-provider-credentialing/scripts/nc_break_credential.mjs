#!/usr/bin/env node
/**
 * nc_break_credential.mjs — negative-control MUTATE for [audit-credentialing.3].
 *
 * Reintroduces a credential-resolution bug into the openai provider so the audit
 * can prove the live [openai_compat_roundtrip] test has TEETH: the unconditional
 * credential-flow assertions (key sourced from .env → resolved apiKey) must turn
 * RED after this mutation, EVEN WHEN the LM Studio box is unreachable.
 *
 * It rewrites every `credentialEnv` token in openai.ts to a non-existent env var
 * name, so the provider resolves an empty/wrong key while the rest of the wiring
 * is untouched. Restore is `git checkout -- providers/openai.ts` (driven by the
 * audit runner). Exits non-zero if it changed nothing — a no-op mutate would be a
 * false "teeth" pass.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "packages/ai/agent-mcp/src/providers/openai.ts";
const src = readFileSync(FILE, "utf8");

// Break the credential source: any read of config.credentialEnv now points at a
// var that cannot exist, so the sourced key is undefined/empty.
const broken = src.replaceAll("credentialEnv", "__NC_BROKEN_CREDENTIAL_ENV__");

if (broken === src) {
  console.error(
    "nc_break_credential: no `credentialEnv` token found in openai.ts — " +
    "the provider does not source the credential from credentialEnv, so the " +
    "negative control cannot prove teeth. (Has the impl landed?)"
  );
  process.exit(1);
}

writeFileSync(FILE, broken);
console.error("nc_break_credential: mutated openai.ts (credentialEnv -> __NC_BROKEN_CREDENTIAL_ENV__).");
process.exit(0);
