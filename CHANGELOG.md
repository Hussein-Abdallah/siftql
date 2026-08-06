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
- A linear-time regex matcher (Thompson NFA + Pike VM), so a user-supplied
  pattern can never backtrack catastrophically. Backreferences and lookaround
  are refused, since neither can be matched in guaranteed linear time, as are
  the `u` and `v` flags, whose code-point semantics this matcher does not
  implement; `regexGuard: false` runs the first two on `RegExp` for callers who
  accept the risk.
- `Highlight.ranges` — exact spans for a matched value. A user regex is reported
  this way rather than as a `RegExp`, because a `RegExp` is something the
  CONSUMER runs, on the backtracking engine, in the `exec` loop the contract
  tells them to write. Wildcards and plain terms still carry `query`, since
  their patterns are built from escaped literal text and cannot blow up.
- `matchKeys` option to match against object keys.

[unreleased]: https://github.com/Hussein-Abdallah/siftql/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hussein-Abdallah/siftql/releases/tag/v0.1.0
