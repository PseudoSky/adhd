# source language

Polyglot source-language routing helpers for apigen's `serve` command. When watching a directory with multiple host languages (TypeScript, Python, Rust, Go, Java), these helpers route each file to the correct plugin.

## Exports

### `languageOfSource(file: string): PluginLanguage | undefined`

Derives the canonical `PluginLanguage` tag from a file's extension.

Returns `undefined` for unrecognized extensions — callers should treat this as "no plugin will consume this file."

```ts
import { languageOfSource } from '@adhd/apigen-core-client';

languageOfSource('src/api.ts');    // => 'ts'
languageOfSource('src/api.tsx');   // => 'ts'
languageOfSource('src/api.mts');   // => 'ts'
languageOfSource('src/api.cts');   // => 'ts'
languageOfSource('src/api.py');    // => 'py'
languageOfSource('src/api.rs');    // => 'rust'
languageOfSource('src/api.go');    // => 'go'
languageOfSource('src/api.java');  // => 'java'
languageOfSource('README.md');     // => undefined
```

Case-insensitive: `.TS` → `'ts'`, `.PY` → `'py'`.

### `pluginConsumesSource(plugin, file): boolean`

Returns `true` when a plugin should consume `file` — the file's extension-derived language matches the plugin's effective language.

```ts
import { pluginConsumesSource } from '@adhd/apigen-core-client';

pluginConsumesSource({ language: 'ts' }, 'src/api.ts');   // => true
pluginConsumesSource({ language: 'ts' }, 'src/api.py');   // => false
pluginConsumesSource({ language: 'py' }, 'src/api.py');   // => true
pluginConsumesSource({}, 'src/api.ts');                   // => true  (defaults to 'ts')
pluginConsumesSource({}, 'README.md');                    // => false (unknown extension)
```

### `sourcesForPlugin(plugin, files): string[]`

Filters a list of file paths to the subset a plugin should consume. Primary entry-point for the `serve` command's dispatch loop.

```ts
import { sourcesForPlugin } from '@adhd/apigen-core-client';

const all = ['src/api.ts', 'src/utils.mts', 'src/api.py', 'README.md'];

sourcesForPlugin({ language: 'ts' }, all);
// => ['src/api.ts', 'src/utils.mts']

sourcesForPlugin({ language: 'py' }, all);
// => ['src/api.py']
```

Preserves insertion order. Readonly arrays accepted.

### `effectiveLanguage(plugin): PluginLanguage`

Returns the effective language for a plugin — the declared `language` if set, or `'ts'` as the default for backward compatibility.

```ts
import { effectiveLanguage } from '@adhd/apigen-core-client';

effectiveLanguage({ language: 'py' });  // => 'py'
effectiveLanguage({});                   // => 'ts'
```

### `LanguageAwarePlugin`

The minimal plugin shape routing helpers need. Both v1 `OutputPlugin` and v2 `Plugin` satisfy this interface.

```ts
interface LanguageAwarePlugin {
  language?: PluginLanguage;
}
```

### `PluginLanguage`

```ts
type PluginLanguage = 'ts' | 'py' | 'rust' | 'go' | 'java';
```

## Extension Mapping

| Extension | Language |
|-----------|----------|
| `.ts`, `.tsx`, `.mts`, `.cts` | `'ts'` |
| `.py` | `'py'` |
| `.rs` | `'rust'` |
| `.go` | `'go'` |
| `.java` | `'java'` |

New host languages should be registered in the `EXTENSION_MAP` in `src/lib/source-language.ts` and in the `PluginLanguage` union type in `src/lib/types.ts`.

## See Also

- [Plugin reference](./plugin.md) — `PluginLanguage`, v1/v2 plugin contracts
