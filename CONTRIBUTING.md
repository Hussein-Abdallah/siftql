# Contributing to siftql

Thanks for looking at this. Bug reports are genuinely welcome — a reproducible
wrong answer is the most useful thing anyone can send.

## Where the project is

`0.1.0`, not yet published to npm. The API is stabilising, so it can still
change in response to a good argument.

## Issues first, then code

**Open an issue before writing a pull request.** This is not gatekeeping — it is
that the constraints below are not visible in a diff, and it is a bad outcome
for everyone when someone spends a weekend on a change that has to be declined
for a reason they had no way to see.

Small, obvious fixes (a typo, a broken link, a test that is wrong) can go
straight to a PR.

## Hard constraints

A change that breaks one of these cannot be merged, however good it is
otherwise.

**Zero runtime dependencies.** `package.json` has no `dependencies` field, and
it stays that way. Anything the package needs at runtime is written here, in `src/`.
Dev dependencies are fine.

**The AST is a public contract.** Every exported name in `src/types.ts` is
semver-major surface. Four invariants govern it, stated in full at the top of
that file:

- **I1 — Structural completeness.** Every leaf carries enough typed fields for
  `serialize()` to rebuild its text without the source string. There is no `raw`
  slice on any node, deliberately.
- **I2 — Pure JSON.** No `RegExp`, no `Date`, no functions, no numbers parsed
  from text, so an AST survives `structuredClone`, `JSON.stringify` and a worker
  boundary.
- **I3 — No published union ever grows.** Adding a member to a union breaks
  every exhaustive `switch` a consumer has written. A semantically adjacent
  feature lands as a sibling optional slot instead.
- **I4 — Round-trip law.** `parse(serialize(parse(q)))` equals `parse(q)`
  ignoring `location`, for every `q` the parser accepts. `serialize()`
  normalises exactly five things, each provably carrying no AST-visible
  information; the list is in `src/types.ts`.

**The failure boundary is split, and the split is deliberate.** A malformed
_query_ throws — it is a programming error, and swallowing it hides a bug.
The one exception is `tolerant: true`, where a malformed query is repaired and
marked instead, because a search box must not blank out mid-keystroke. A dirty _value_ in the data follows the `onValueError` policy, because bad
rows in real data are normal and should not take down a search box.

## Verifying a change

```
npm run verify
```

That runs lint, a Prettier check, `tsc --noEmit`, the test suite with coverage,
and the build. CI runs the same gate on Node 18, 20, 22 and 24.

Two further harnesses exist, and a change to `src/` should go through the first:

```
npm run diff        # behavioural diff against HEAD~1, or any ref you pass
npm run mutants     # measures whether that diff can actually see changes
                    # (needs a clean tree; commit first)
```

`npm run diff` runs a large generated corpus through both your working tree and
an earlier commit, and reports every disagreement. It asserts nothing, so it
catches changes nobody thought to look for. **A difference is not automatically
a defect** — deliberate changes show up too. The question it answers is "is
every difference one I meant?", and the answer belongs in the PR description.

## Writing tests

The property harness is `test/properties.test.ts`; raise its sample count with
`SIFTQL_PROPERTY_RUNS=5000 npm test`.

Two failure modes have cost this project more time than any defect, and a review
will ask about both:

**Confirmatory tests.** A test that exercises the one shape that cannot fail.
A quadratic-walk benchmark here used a string leaf — the only leaf type that
never reached the quadratic branch — and the property built on it was blind to
the bug it existed to catch, for two rounds.

**Vacuous properties.** A property whose loop body stops executing, because the
code it probed moved to a different hook, stays green and reports nothing.
Assert that each property did a non-zero amount of meaningful work.

The useful check on a new test: **make it fail on purpose.** Revert the fix, or
introduce the bug by hand, and confirm the test actually goes red. A test that
passes either way is worse than no test, because it looks like coverage.

## Comments

Comments explain what the code does and why. They are not a record of how the
code got that way — no "this used to", no "changed in response to". Git holds
that history.

**A comment that states a bound or a guarantee must be measured before it is
written.** A substantial share of every audit round's findings here have been
comments that confidently described behaviour the code did not have.

## Reporting a bug

A report needs a repro someone else can run, the actual output, and the expected
output. A finding without a runnable repro is not yet a finding — it is a
suspicion, and the fastest way to get it fixed is to remove the guesswork.

For anything with security impact, **do not open a public issue** — see
[SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE), the same terms the
project is distributed under.
