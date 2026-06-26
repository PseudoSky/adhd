/**
 * Unit tests for the source-language routing helpers.
 *
 * Coverage goals:
 *   1. `languageOfSource` maps every recognised extension correctly.
 *   2. `languageOfSource` returns `undefined` for unknown extensions.
 *   3. `pluginConsumesSource` routes correctly for declared and default language.
 *   4. `sourcesForPlugin` filters a mixed file list per plugin language.
 *   5. `effectiveLanguage` honours the declared value and defaults to `'ts'`.
 *
 * Plugin-level declaration tests (language:'ts' on each shipped plugin) live
 * in each plugin's own spec file to avoid cross-package build dependencies.
 */

import { describe, it, expect } from 'vitest'
import {
  languageOfSource,
  pluginConsumesSource,
  sourcesForPlugin,
  effectiveLanguage,
} from '../lib/source-language'
import type { LanguageAwarePlugin } from '../lib/source-language'

// ---------------------------------------------------------------------------
// languageOfSource
// ---------------------------------------------------------------------------

describe('languageOfSource', () => {
  describe('TypeScript extensions → "ts"', () => {
    it.each([
      ['src/api.ts',  'ts'],
      ['src/api.tsx', 'ts'],
      ['src/api.mts', 'ts'],
      ['src/api.cts', 'ts'],
      // Case-insensitive
      ['src/Api.TS',  'ts'],
      ['src/Api.MTS', 'ts'],
    ])('%s → %s', (file, expected) => {
      expect(languageOfSource(file)).toBe(expected)
    })
  })

  describe('Python extensions → "py"', () => {
    it.each([
      ['src/api.py', 'py'],
      ['src/api.PY', 'py'],
    ])('%s → %s', (file, expected) => {
      expect(languageOfSource(file)).toBe(expected)
    })
  })

  describe('Rust extensions → "rust"', () => {
    it.each([
      ['src/lib.rs',  'rust'],
      ['src/main.RS', 'rust'],
    ])('%s → %s', (file, expected) => {
      expect(languageOfSource(file)).toBe(expected)
    })
  })

  describe('Go extensions → "go"', () => {
    it.each([
      ['main.go',  'go'],
      ['MAIN.GO',  'go'],
    ])('%s → %s', (file, expected) => {
      expect(languageOfSource(file)).toBe(expected)
    })
  })

  describe('Java extensions → "java"', () => {
    it.each([
      ['src/Api.java',  'java'],
      ['src/Api.JAVA',  'java'],
    ])('%s → %s', (file, expected) => {
      expect(languageOfSource(file)).toBe(expected)
    })
  })

  describe('Unknown / unregistered extensions → undefined', () => {
    it.each([
      ['README.md'],
      ['schema.json'],
      ['Makefile'],
      ['src/api.rb'],
      ['src/api.kt'],
      // bare filename, no extension
      ['src/api'],
    ])('%s → undefined', (file) => {
      expect(languageOfSource(file)).toBeUndefined()
    })
  })

  it('handles absolute paths', () => {
    expect(languageOfSource('/home/user/project/src/api.ts')).toBe('ts')
    expect(languageOfSource('/home/user/project/src/service.py')).toBe('py')
  })

  it('handles a filename with no directory component', () => {
    expect(languageOfSource('api.ts')).toBe('ts')
  })

  // Regression guard: ensure a multi-dot filename uses the LAST extension only.
  it('uses the final extension in multi-dot filenames', () => {
    expect(languageOfSource('api.generated.ts')).toBe('ts')
    expect(languageOfSource('api.test.py')).toBe('py')
    // '.ts.bak' is not a known extension
    expect(languageOfSource('api.ts.bak')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// effectiveLanguage
// ---------------------------------------------------------------------------

describe('effectiveLanguage', () => {
  it('returns the declared language when set', () => {
    expect(effectiveLanguage({ language: 'py' })).toBe('py')
    expect(effectiveLanguage({ language: 'ts' })).toBe('ts')
    expect(effectiveLanguage({ language: 'rust' })).toBe('rust')
    expect(effectiveLanguage({ language: 'go' })).toBe('go')
    expect(effectiveLanguage({ language: 'java' })).toBe('java')
  })

  it('defaults to "ts" when language is omitted (back-compat)', () => {
    expect(effectiveLanguage({})).toBe('ts')
  })
})

// ---------------------------------------------------------------------------
// pluginConsumesSource
// ---------------------------------------------------------------------------

describe('pluginConsumesSource', () => {
  const tsPlugin: LanguageAwarePlugin  = { language: 'ts' }
  const pyPlugin: LanguageAwarePlugin  = { language: 'py' }
  const defaultPlugin: LanguageAwarePlugin = {}

  describe('positive matches', () => {
    it('ts plugin consumes .ts', () => expect(pluginConsumesSource(tsPlugin, 'api.ts')).toBe(true))
    it('ts plugin consumes .tsx', () => expect(pluginConsumesSource(tsPlugin, 'api.tsx')).toBe(true))
    it('ts plugin consumes .mts', () => expect(pluginConsumesSource(tsPlugin, 'api.mts')).toBe(true))
    it('ts plugin consumes .cts', () => expect(pluginConsumesSource(tsPlugin, 'api.cts')).toBe(true))
    it('py plugin consumes .py', () => expect(pluginConsumesSource(pyPlugin, 'service.py')).toBe(true))
  })

  describe('negative matches — language mismatch', () => {
    it('ts plugin rejects .py', () => expect(pluginConsumesSource(tsPlugin, 'service.py')).toBe(false))
    it('py plugin rejects .ts', () => expect(pluginConsumesSource(pyPlugin, 'api.ts')).toBe(false))
    it('py plugin rejects .tsx', () => expect(pluginConsumesSource(pyPlugin, 'api.tsx')).toBe(false))
  })

  describe('negative matches — unknown extension', () => {
    it('never routes README.md', () => expect(pluginConsumesSource(tsPlugin, 'README.md')).toBe(false))
    it('never routes schema.json', () => expect(pluginConsumesSource(pyPlugin, 'schema.json')).toBe(false))
    it('never routes Makefile', () => expect(pluginConsumesSource(tsPlugin, 'Makefile')).toBe(false))
  })

  describe('default language ("ts")', () => {
    it('routes .ts when language is omitted', () =>
      expect(pluginConsumesSource(defaultPlugin, 'api.ts')).toBe(true))
    it('routes .tsx when language is omitted', () =>
      expect(pluginConsumesSource(defaultPlugin, 'api.tsx')).toBe(true))
    it('rejects .py when language is omitted', () =>
      expect(pluginConsumesSource(defaultPlugin, 'service.py')).toBe(false))
  })
})

// ---------------------------------------------------------------------------
// sourcesForPlugin
// ---------------------------------------------------------------------------

describe('sourcesForPlugin', () => {
  // A realistic mixed directory listing.
  const mixed = [
    'packages/api/src/api.ts',
    'packages/api/src/utils.mts',
    'packages/svc/src/service.py',
    'packages/svc/src/helper.py',
    'packages/core/src/lib.rs',
    'cmd/main.go',
    'README.md',
    'schema.json',
  ]

  it('returns only TS files for a ts plugin', () => {
    expect(sourcesForPlugin({ language: 'ts' }, mixed)).toEqual([
      'packages/api/src/api.ts',
      'packages/api/src/utils.mts',
    ])
  })

  it('returns only .py files for a py plugin', () => {
    expect(sourcesForPlugin({ language: 'py' }, mixed)).toEqual([
      'packages/svc/src/service.py',
      'packages/svc/src/helper.py',
    ])
  })

  it('returns only .rs files for a rust plugin', () => {
    expect(sourcesForPlugin({ language: 'rust' }, mixed)).toEqual([
      'packages/core/src/lib.rs',
    ])
  })

  it('returns only .go files for a go plugin', () => {
    expect(sourcesForPlugin({ language: 'go' }, mixed)).toEqual(['cmd/main.go'])
  })

  it('returns empty array when no files match', () => {
    expect(sourcesForPlugin({ language: 'java' }, mixed)).toEqual([])
  })

  it('returns empty array for an empty file list', () => {
    expect(sourcesForPlugin({ language: 'ts' }, [])).toEqual([])
  })

  it('never includes files with unrecognised extensions', () => {
    expect(sourcesForPlugin({ language: 'ts' }, ['README.md', 'schema.json'])).toEqual([])
  })

  it('defaults to ts routing when language is omitted (back-compat)', () => {
    expect(sourcesForPlugin({}, mixed)).toEqual([
      'packages/api/src/api.ts',
      'packages/api/src/utils.mts',
    ])
  })

  it('accepts a readonly array without mutating it', () => {
    const readonly = Object.freeze(['api.ts', 'svc.py']) as readonly string[]
    expect(sourcesForPlugin({ language: 'ts' }, readonly)).toEqual(['api.ts'])
  })

  it('preserves insertion order of matched files', () => {
    const files = ['z.ts', 'a.ts', 'm.ts']
    expect(sourcesForPlugin({ language: 'ts' }, files)).toEqual(['z.ts', 'a.ts', 'm.ts'])
  })

  // Falsifiability check: if the filter is broken (all-pass), the ts result
  // would include .py / .go / .md files — prove those are absent.
  it('does not bleed non-ts files into a ts plugin result', () => {
    const result = sourcesForPlugin({ language: 'ts' }, mixed)
    for (const f of result) {
      expect(languageOfSource(f)).toBe('ts')
    }
  })
})
