/**
 * 50e8c966 AC1 — cleanGitEnv strips every GIT_* key and keeps the rest.
 * Run: node --test tools/nx-plugins/lib/git-env.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanGitEnv, scrubProcessGitEnv } = require('./git-env.js');

test('50e8c966 AC1: cleanGitEnv drops every GIT_* key and keeps PATH', () => {
  const out = cleanGitEnv({ GIT_DIR: 'x', GIT_INDEX_FILE: 'y', GIT_WORK_TREE: 'w', GIT_COMMON_DIR: 'c', GIT_PREFIX: 'p', PATH: 'p' });
  assert.deepEqual(Object.keys(out).filter((k) => k.startsWith('GIT_')), []);
  assert.equal(out.PATH, 'p');
});

test('50e8c966 AC1: cleanGitEnv does not mutate its input and layers deliberate extras after the scrub', () => {
  const base = { GIT_DIR: 'x', HOME: '/h' };
  const out = cleanGitEnv(base, { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' });
  assert.equal(base.GIT_DIR, 'x');
  assert.equal(out.GIT_DIR, undefined);
  assert.equal(out.GIT_AUTHOR_DATE, '2020-01-01T00:00:00Z');
  assert.equal(out.HOME, '/h');
});

test('50e8c966 AC1: scrubProcessGitEnv removes GIT_* from process.env in place', () => {
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = '/nope';
    process.env.GIT_INDEX_FILE = '/nope/index';
    scrubProcessGitEnv();
    assert.equal(process.env.GIT_DIR, undefined);
    assert.equal(process.env.GIT_INDEX_FILE, undefined);
    assert.ok(process.env.PATH);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
