# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting — the **Security** tab of this
repository, then **Report a vulnerability**. That opens a private thread visible
only to the maintainer.

That feature is a public-repository one, so while this repository is private it
is not there. Until then, email **sain.abdallah@gmail.com** with `siftql
security` in the subject.

Please include a runnable repro: the query, the input it runs against, the
options passed, and what happens. For anything resource-related, the input size
and the observed time or memory matter — a report saying "this is slow" without
a measurement is hard to act on.

I will acknowledge a report and say whether it is in scope. This is a personal
project, not a funded one, so I cannot promise a response time; I can promise
that I will not quietly ignore it.

## Supported versions

`0.1.0` is pre-release and **not yet published to npm**. Until a release is
tagged, the supported version is whatever is currently on `main`.

## What is in scope

siftql parses untrusted query text and evaluates it against untrusted data, so
input-driven failures are the interesting ones:

- **Denial of service** — any input, query or record, that causes runaway time
  or memory, with `regexGuard` left at its default. The regex engine is a
  Thompson NFA rather than a backtracking matcher specifically so a
  user-supplied pattern cannot blow up; a pattern that defeats that is in
  scope, as is any query that gets past the structural limits in
  `src/limits.ts`.
- **Prototype pollution** or any write to an object the caller did not hand in.
- **Escaping the failure boundary** — a raw `RangeError`, a stack overflow, or
  any error that is not a `SiftQLError` reaching the caller.
- **Cross-engine leakage** — one `createEngine()` instance observing or altering
  another's registry or options.
- **A silently wrong answer** driven by crafted input: a record that matches
  when it should not, or a permissive clause surviving a filter that should have
  dropped it. This package exists to avoid quiet wrongness, so treat it with the
  same seriousness as a crash.

## What is not in scope

- **Backtracking under `regexGuard: false`.** That option runs patterns this
  matcher refuses on `RegExp` instead, so catastrophic backtracking comes back
  with it — a 17-character pattern can take seconds. The default refuses those
  patterns; turning the guard off is an explicit acceptance of `RegExp`'s cost
  model, not a defect.
- **`spans()` reporting no ranges on a pattern that matches everywhere.** A
  step budget caps that walk, so its measured cost is linear; past the budget
  it returns no positions and the highlight names the field without
  underlining inside it. Recorded under Known limitations in
  [CHANGELOG.md](CHANGELOG.md). Bounded-but-degraded is a limitation;
  unbounded is a vulnerability, and the line between them is whether the work
  has a ceiling.
- **A crash from an AST you hand-built that `parse()` would never produce.**
  Malformed input to the AST-in path is a programming error and is refused
  loudly by design.
- Anything requiring the attacker to already control the calling application.
- Issues in dev dependencies that do not ship. The published package has **zero
  runtime dependencies**, so its supply-chain surface is its own source.

## Disclosure

If you would like credit, say so and I will name you in the changelog entry for
the fix. If you would rather not be named, that is fine too.
