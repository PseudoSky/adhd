#!/usr/bin/env node
/**
 * run-via-agentmcp.mjs — Convenience wrapper to execute run-via-agentmcp.ts via tsx.
 *
 * Prerequisites: run ingest-and-run.ts (or run.mjs) first to create demo/tmp/registry.db.
 *
 * Usage (from any directory):
 *   node docs/plan/agent-registry/demo/run-via-agentmcp.mjs
 *
 * Or directly via tsx:
 *   node_modules/.bin/tsx --tsconfig tsconfig.base.json \
 *       docs/plan/agent-registry/demo/run-via-agentmcp.ts
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../');
const SCRIPT    = path.join(__dirname, 'run-via-agentmcp.ts');
const TSX       = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const TSCONFIG  = path.join(REPO_ROOT, 'tsconfig.base.json');

const result = spawnSync(TSX, ['--tsconfig', TSCONFIG, SCRIPT], {
    stdio:   'inherit',
    cwd:     REPO_ROOT,
    env:     process.env,
    timeout: 180_000,
});

process.exit(result.status ?? 1);
