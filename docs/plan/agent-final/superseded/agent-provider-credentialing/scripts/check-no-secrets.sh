#!/usr/bin/env bash
# check-no-secrets.sh — proves [dod.7]: zero LM Studio (and provider) secrets in
# any git-tracked file, and that the .env destinations are gitignored.
#
# Strategy (no secret is ever hardcoded in this script):
#   1. If a local ~/.adhd/agent-mcp/.env (or packages/ai/agent-mcp/.env) holds a
#      LMSTUDIO_API_KEY value, assert that literal value appears in NO tracked file.
#   2. Assert generic provider-secret patterns are absent from tracked files.
#   3. Scan docs/mcp-env/PROPOSAL.md explicitly (the file the requester flagged).
#   4. Assert the .env secret destinations are gitignored.
# Exit 0 = clean; exit 1 = a secret/leak/un-ignored destination was found.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

fail=0
note() { echo "FAIL(no-secrets): $*"; fail=1; }

# Collect tracked files once.
tracked="$(git ls-files)"

# ── 1. The actual LM Studio key value, read from the local (gitignored) .env ──
keyval=""
for envf in "$HOME/.adhd/agent-mcp/.env" "packages/ai/agent-mcp/.env" ".adhd/agent-mcp/.env"; do
  if [ -f "$envf" ]; then
    v="$(grep -E '^LMSTUDIO_API_KEY=' "$envf" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
    if [ -n "$v" ]; then keyval="$v"; break; fi
  fi
done
if [ -n "$keyval" ]; then
  # The real value must appear in ZERO tracked files.
  if printf '%s\n' "$tracked" | xargs -I{} grep -lF -- "$keyval" {} 2>/dev/null | grep -q .; then
    note "the live LMSTUDIO_API_KEY value appears in tracked file(s):"
    printf '%s\n' "$tracked" | xargs -I{} grep -lF -- "$keyval" {} 2>/dev/null
  fi
else
  echo "WARNING(no-secrets): no local LMSTUDIO_API_KEY found in ~/.adhd/agent-mcp/.env — value-scan skipped; pattern scan still runs."
fi

# ── 2. Generic provider-secret patterns in tracked files ──────────────────────
# Real keys only — exclude documentation placeholders (… ellipsis, sk-lm-..., sk-...).
pat='sk-ant-(api|oat)[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{24,}'
hits="$(printf '%s\n' "$tracked" | xargs grep -nIE -- "$pat" 2>/dev/null \
        | grep -vE 'sk-ant-(api|oat)…|sk-lm-\.\.\.|sk-\.\.\.|sk-ant-api…|sk-ant-oat…')"
if [ -n "$hits" ]; then
  note "real provider-secret pattern in tracked file(s):"
  echo "$hits"
fi

# ── 3. Explicit scan of the requester-flagged file ────────────────────────────
prop="docs/mcp-env/PROPOSAL.md"
if [ -f "$prop" ]; then
  ph="$(grep -nIE -- "$pat" "$prop" 2>/dev/null | grep -vE 'sk-ant-(api|oat)…|sk-lm-\.\.\.|sk-\.\.\.')"
  if [ -n "$ph" ]; then note "$prop still carries a secret-shaped token:"; echo "$ph"; fi
  if [ -n "$keyval" ] && grep -qF -- "$keyval" "$prop" 2>/dev/null; then
    note "$prop contains the live LMSTUDIO_API_KEY value"
  fi
fi

# ── 4. The .env secret destinations must be gitignored ────────────────────────
for dest in ".adhd/agent-mcp/.env" "packages/ai/agent-mcp/.env"; do
  if ! git check-ignore -q "$dest"; then
    note "secret destination is NOT gitignored: $dest"
  fi
done

if [ "$fail" -eq 0 ]; then echo "OK(no-secrets): no tracked secrets; .env destinations gitignored."; fi
exit "$fail"
