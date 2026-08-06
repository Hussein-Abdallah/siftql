# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Note: the AST is a **documented public contract**. Any change to an exported node
shape is a breaking change and requires a major version bump.

## [Unreleased]

## [0.1.0] - Unreleased

Initial release.

### Added

- Hand-written tokenizer and recursive-descent/Pratt parser (`parse`).
- `serialize` with parse/serialize round-trip guarantees.
- In-memory engine: `filter`, `test`, `highlight`.
- Field groups: `status:(open OR closed)` applies one field to a list of values,
  with dates and times needing no quoting inside them.
- `builders` for constructing an AST without writing query text, so a value can
  never inject structure.
- Extensible value-type registry with built-in `string`, `number`, `boolean`,
  `null`, `regex`, `wildcard`, and `datetime` types.
- `createEngine({ types })` for per-instance type registries.
- Real chronological date/time comparison, including timezone offsets, mixed
  precision, `dateFormat` declarations, and a pluggable `parseDate` hook.
- Half-open, inclusive, exclusive, and mixed-inclusivity ranges.
- Tolerant parsing mode for search-as-you-type.
- A structural screen for catastrophic regex backtracking, plus a pattern-length
  cap. The screen is a heuristic and is bypassable; see the README for what it
  does and does not catch.
- `matchKeys` option to match against object keys.

[unreleased]: https://github.com/Hussein-Abdallah/siftql/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hussein-Abdallah/siftql/releases/tag/v0.1.0
