## What this changes

<!-- And the issue it came from. Please open an issue first for anything beyond
     a typo or an obvious fix — the constraints below are not visible in a diff,
     and it is a bad outcome for everyone if this has to be declined for a
     reason you had no way to see. -->

Closes #

## Checks

- [ ] `npm run verify` passes (lint, format, typecheck, tests + coverage, build)
- [ ] `dependencies` in `package.json` is still empty
- [ ] New tests were made to **fail on purpose** — the bug was reintroduced by
      hand and they went red. A test that passes either way is worse than none,
      because it looks like coverage.

## The AST contract

Skip this section if you did not touch `src/types.ts` or `src/serialize.ts`.

- [ ] **I1** — every leaf can still be printed from its own typed fields
- [ ] **I2** — nodes are still pure JSON: no `RegExp`, `Date`, or functions
- [ ] **I3** — no published union grew a member
- [ ] **I4** — `parse(serialize(parse(q)))` still equals `parse(q)`

## Behavioural diff

<!-- For any change under src/. Run `npm run diff` and paste the summary line.

     Differences are expected when the change is deliberate — the question is
     not "were there any?" but "is every one of them intended?". Say which, and
     why. If it reports none, say that too; for a behaviour change that is
     itself a finding worth explaining. -->

```
$ npm run diff

```

Every difference above is intentional because:
