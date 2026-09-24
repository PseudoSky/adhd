## 2.2.1 (2026-09-24)


### 🩹 Fixes

- **agent-core-provider:** normalize model keys in estimateCostUsd (agent-mcp-005)

- **eslintrc:** exclude vite.config.ts from dependency-checks source scan + module-boundary lint

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)

- **workspace:** correct nx project names in package.json build scripts

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.1.9 (2026-07-26)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.8 (2026-07-25)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.7 (2026-07-25)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.6 (2026-07-24)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.5 (2026-07-24)

This was a version bump only for agent-core-provider to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-23)


### 🚀 Features

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### 🩹 Fixes

- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN


### ❤️  Thank You

- pseudosky

## 2.1.3 (2026-07-23)


### 🚀 Features

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### 🩹 Fixes

- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN


### ❤️  Thank You

- pseudosky