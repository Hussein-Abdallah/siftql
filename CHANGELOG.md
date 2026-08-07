# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Note: the AST is a **documented public contract**. Any change to an exported node
shape is a breaking change and requires a major version bump.

## 0.1.0 — unreleased

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
  pattern can never backtrack catastrophically. Refused, because none can be
  matched in guaranteed linear time: backreferences, lookaround, and a
  quantifier whose body can match the empty string (`(a*)*`, `(?:a?)+`). The `u`
  and `v` flags are refused too, since this matcher works on UTF-16 code units
  and accepting them while ignoring code-point semantics would give silently
  different answers. `regexGuard: false` runs every pattern this matcher refuses — all four
  classes above, including `u`/`v` — on `RegExp` instead, for callers who
  accept both the backtracking cost and the change in code-point semantics. Patterns `RegExp` itself rejects —
  `a{2}{3}`, `^*`, `{2}`, `(?<>x)` — are rejected here too, so a query cannot
  mean one thing under the guard and another without it.
- `Highlight.ranges` — exact spans inside a matched value. Every built-in
  reports positions rather than a `RegExp`: a `RegExp` is something the CONSUMER
  runs, on the backtracking engine, and no flag set reproduces what this package
  matches anyway (matching folds with `toLowerCase`; `/s/iu` matches `ſ` where
  siftql does not, and `/k/i` refuses the Kelvin sign where it does).
  `Highlight.query` remains for custom types.
- `matchKeys` option to match against object keys.
- Structural limits, all exported: `MAX_CLAUSES` (2,000), `MAX_DEPTH` (200),
  `MAX_FIELD_SEGMENTS` (32), `MAX_WILDCARD_SEGMENTS` (512), `MAX_AST_NODES`
  (500,000) and `MAX_AST_DEPTH` (2,200). `parse()` enforces the node budget
  itself, so a query it accepts is always one `serialize()` and the evaluator
  can walk.

### Known limitations

- `spans()` — and so `highlight()` on a regex clause — gives up on a pattern
  that matches at every position while keeping a match alive to the right
  (`(?:.*;)?`). The walk would be quadratic, so a step budget of `4n + 1000`
  caps it; measured cost therefore stays linear (~2x per doubling of the value,
  to 32,000 characters), but past the budget it reports NO ranges. The field
  still matches and the highlight still names it — `ranges` is simply absent,
  so a UI underlines nothing. That is the limitation: not the cost, the missing
  positions.
- A tolerant engine never throws for a query that is incomplete or malformed. It
  still throws past a structural limit above, which guards resources rather than
  describing something half-typed.
- `serialize()` round-trips every tree the STRICT parser produces. A tolerant
  tree does not round-trip: `recovered` markers have no spelling in query text.
  Pass the tree itself to `test`/`filter`/`highlight` rather than its text.
- The reserved v0.2 modifier nodes (`BoostModifier`, `RequiredModifier`,
  `FuzzyModifier`, `ProximityModifier`) can be built, type-checked and printed,
  but their printed form is syntax the v0.1 parser is required to reject.

