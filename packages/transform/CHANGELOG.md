# Changelog

All notable changes to `@adhd/transform` are documented in this file.
This project adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> No user-facing changes pending in this release cycle.

## [2.2.1] — 2026-05-14

### Added
- **`Transform` merged export** — single import giving access to all 155 functions across 10 modules. Spread order: Functions → Objects → Stats → Collections → Filters → Texts → Humanize → Date → Regex → Structures.
- **`Differ` class** with `Differ.map(obj1, obj2)` for deep object diffs, plus `compareValues`, `compareArrays`, `getArrayDiffData`, and four status constants (`VALUE_CREATED`, `VALUE_UPDATED`, `VALUE_DELETED`, `VALUE_UNCHANGED`).
- **`Counter` (structures)** — standalone class with `increment`/`decrement`/`reset`/`toJson` and optional `countBy` key extractor.
- **`Counter` (stats)** — Map subclass with `add()` and `setData()` for histogram-like counting.
- **`flowPipe`** — left-to-right function composition that handles argument spread.
- **`splitPipe`** — fan-out composition applying each function to the same input.
- **`allPaths` `PathMatcher` parameter** — custom matcher function to control when path traversal stops.
- **`regex.mergePatterns`** — merges values into a regex alternation pattern.

### Changed
- **Collision resolution**: `Objects.objectDifference` renamed from `difference` (avoids `Collections.difference`). `Stats.minMax` renamed from `range` (avoids `Collections.range`). Both original names remain on their modules.
- **`formatDate`** now supports full IANA timezone tokens (`z`, `zz`, `Z`, `ZZ`, `ZZZZ`).

### Fixed
- `isMatch` function correctly handles nested object matching.
- Build and publish pipeline stability improvements.

## [2.2.0] — 2024-12-14

### Added
- **Regex module** with `escapePattern`, `mergePatterns`, and `rangeToRegex`.
- `normalizeBetween` for normalizing single values to a new range.
- `Counter` class (stats/Map variant) with `add()` and `setData()` methods.

### Changed
- Metrics and parser accuracy improved across stats module.

## [2.1.1] — 2024-12-12

### Changed
- Improved TypeScript type definitions across all modules.
- Build now includes sourcemaps for easier debugging.

## [2.1.0] — 2024-08-12

### Added
- **`allPaths(obj, matcher?)`** — enumerates every primitive-holding path in a nested object.
- Publishing configuration for npm distribution.

## [2.0.0] — 2024-08-12

### Added
- Initial release of `@adhd/transform`.
- **10 modules**: Collections, Filters, Functions, Objects, Stats, Texts, Humanize, Date, Regex, Structures.
- Data structures: `Stack<T>`, `Queue<T>` with optional typed event callbacks.
- Function composition: `compose`, `flow`, `partial`, `throttle`.
- Path utilities: `get`, `set`, `getAll`, `makeGetter`, `makeSetter`.
- Type checks: 33 filter functions (`isArray`, `isString`, `isDefined`, `isEqual`, etc.).
- Array utilities: `difference`, `intersection`, `flattenDeep`, `keyBy`, `uniqueBy`, `range`, etc.
- Object utilities: `deepCopy`, `deepEquals`, `omit`, `pick`, `groupBy`, `zipObject`.
- Stats: `normalize`, `minMax`, `histogram`, `mostCommon`, `randomRange`.
- Date formatting: `formatDate`, `humanDuration`, `timeFromNow`, `fromNow`.
- String utilities: `capitalize`, `hyphenCase`, `words`, `percent`.

[unreleased]: https://github.com/PseudoSky/adhd/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/PseudoSky/adhd/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/PseudoSky/adhd/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/PseudoSky/adhd/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/PseudoSky/adhd/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/PseudoSky/adhd/releases/tag/v2.0.0
